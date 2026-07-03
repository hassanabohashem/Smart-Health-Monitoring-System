"""
Data preparation for WISDM watch HAR.

Pipeline per subject:
  1. Read the raw accelerometer and gyroscope text files.
  2. Split into contiguous (subject, activity) segments.
  3. Resample accel and gyro INDEPENDENTLY onto one common 20 Hz time grid
     (they are sampled separately, with different timestamps), using linear
     interpolation over the real nanosecond timestamps.
  4. Slide a WINDOW-sample window with STEP hop over each segment, producing
     6-channel windows [ax, ay, az, gx, gy, gz].
  5. Label each window via letter_to_class(); cap "other" windows per subject.

Outputs a cached .npz with:
    X       float32 (N, WINDOW, 6)   -- raw physical units (accel m/s^2, gyro rad/s)
    y       int64   (N,)             -- class index into CLASS_NAMES
    groups  int64   (N,)             -- subject id (for subject-wise splitting)

Run standalone to (re)build the cache and print class/subject distribution:
    python data_prep.py
"""

from __future__ import annotations

import re
import sys
from collections import Counter
from pathlib import Path

import numpy as np
import pandas as pd

import config as C

# Raw line example:  1600,A,90426708196641,7.091625,-0.5916671,8.195502;
_SUBJECT_RE = re.compile(r"data_(\d+)_")


def _read_raw_file(path: Path) -> pd.DataFrame:
    """Parse one WISDM raw sensor file into a tidy DataFrame.

    Columns: subject (int), activity (str), t_ns (int64), x, y, z (float32).
    Robust to the trailing ';', blank lines, and occasional malformed rows.
    """
    rows = []
    with open(path, "r", encoding="utf-8", errors="ignore") as fh:
        for line in fh:
            line = line.strip().rstrip(";").strip()
            if not line:
                continue
            parts = line.split(",")
            if len(parts) != 6:
                continue
            subj, act, t_ns, x, y, z = parts
            try:
                rows.append((int(subj), act, int(t_ns), float(x), float(y), float(z)))
            except ValueError:
                continue  # skip malformed numeric fields
    df = pd.DataFrame(rows, columns=["subject", "activity", "t_ns", "x", "y", "z"])
    return df


def _segments(df: pd.DataFrame):
    """Yield (activity, sub_df) for each contiguous run of the same activity.

    The raw files are ordered by activity (each performed for ~3 min), so a
    simple change-point split on the activity column recovers the segments.
    """
    if df.empty:
        return
    change = df["activity"].ne(df["activity"].shift()).cumsum()
    for _, seg in df.groupby(change, sort=False):
        yield seg["activity"].iloc[0], seg


def _resample_to_grid(seg: pd.DataFrame, grid_ns: np.ndarray) -> np.ndarray | None:
    """Linear-interpolate a segment's x/y/z onto grid_ns. Returns (len(grid), 3)."""
    t = seg["t_ns"].to_numpy(dtype=np.float64)
    # Clean: sort by time and drop non-increasing timestamps (WISDM has a few).
    order = np.argsort(t, kind="stable")
    t = t[order]
    keep = np.concatenate(([True], np.diff(t) > 0))
    t = t[keep]
    if t.size < 2:
        return None
    out = np.empty((grid_ns.size, 3), dtype=np.float32)
    for j, axis in enumerate(("x", "y", "z")):
        v = seg[axis].to_numpy(dtype=np.float64)[order][keep]
        out[:, j] = np.interp(grid_ns, t, v).astype(np.float32)
    return out


def _common_grid(accel: pd.DataFrame, gyro: pd.DataFrame) -> np.ndarray | None:
    """Uniform 20 Hz grid (ns) spanning the time range common to accel & gyro."""
    a_t, g_t = accel["t_ns"].to_numpy(), gyro["t_ns"].to_numpy()
    if a_t.size < 2 or g_t.size < 2:
        return None
    start = max(a_t.min(), g_t.min())
    end = min(a_t.max(), g_t.max())
    span_ns = end - start
    step_ns = 1e9 / C.TARGET_HZ
    n = int(span_ns // step_ns)
    if n < C.WINDOW:                       # not even one full window of overlap
        return None
    return start + np.arange(n, dtype=np.float64) * step_ns


def _subject_id(path: Path) -> int:
    m = _SUBJECT_RE.search(path.name)
    return int(m.group(1)) if m else -1


def build_windows(verbose: bool = True):
    """Build (X, y, groups). Caches to CACHE_NPZ."""
    rng = np.random.default_rng(C.SEED)
    accel_files = sorted(C.RAW_WATCH_ACCEL.glob("data_*_accel_watch.txt"))
    if not accel_files:
        raise FileNotFoundError(f"No accel files under {C.RAW_WATCH_ACCEL}")

    X_list, y_list, g_list, s_list = [], [], [], []   # s_list = activity-bout (segment) id
    jX_list, jg_list = [], []          # junk (non-locomotion) windows, never trained on
    per_subject_skipped = Counter()
    seg_id = 0                          # unique per (subject, activity) contiguous bout

    for af in accel_files:
        subj = _subject_id(af)
        gf = C.RAW_WATCH_GYRO / f"data_{subj}_gyro_watch.txt"
        if not gf.exists():
            if verbose:
                print(f"  subject {subj}: no gyro file, skipping")
            continue

        accel_df = _read_raw_file(af)
        gyro_df = _read_raw_file(gf)
        if accel_df.empty or gyro_df.empty:
            continue

        # Index segments by activity for both sensors.
        accel_segs = {act: seg for act, seg in _segments(accel_df)}
        gyro_segs = {act: seg for act, seg in _segments(gyro_df)}

        other_windows_this_subject = []   # collected then capped

        for act in accel_segs:
            if act not in gyro_segs:
                continue
            grid = _common_grid(accel_segs[act], gyro_segs[act])
            if grid is None:
                continue
            a = _resample_to_grid(accel_segs[act], grid)   # (T, 3)
            g = _resample_to_grid(gyro_segs[act], grid)     # (T, 3)
            if a is None or g is None:
                continue
            sig = np.concatenate([a, g], axis=1)            # (T, 6)

            cls = C.letter_to_class(act)
            is_other = cls == C.OTHER_CLASS
            cls_idx = None if is_other else C.CLASS_TO_IDX[cls]

            # Slide windows.
            T = sig.shape[0]
            starts = range(0, T - C.WINDOW + 1, C.STEP)
            produced = False
            for s in starts:
                w = sig[s : s + C.WINDOW]                   # (WINDOW, 6)
                if is_other:
                    other_windows_this_subject.append(w)   # collected, capped below
                else:
                    X_list.append(w)
                    y_list.append(cls_idx)
                    g_list.append(subj)
                    s_list.append(seg_id)
                    produced = True
            if produced:
                seg_id += 1                                 # next bout gets a new id

        # Cap "other" windows for this subject to limit imbalance.
        if other_windows_this_subject:
            ow = np.stack(other_windows_this_subject)
            if ow.shape[0] > C.MAX_OTHER_WINDOWS_PER_SUBJECT:
                sel = rng.choice(
                    ow.shape[0], C.MAX_OTHER_WINDOWS_PER_SUBJECT, replace=False
                )
                per_subject_skipped[subj] = ow.shape[0] - sel.size
                ow = ow[sel]
            # Always record junk windows (for threshold tuning / rejection metrics).
            for w in ow:
                jX_list.append(w)
                jg_list.append(subj)
            # Only add them as a trainable class in closed-set mode.
            if C.INCLUDE_OTHER_CLASS:
                other_idx = C.CLASS_TO_IDX[C.OTHER_CLASS]
                for w in ow:
                    X_list.append(w)
                    y_list.append(other_idx)
                    g_list.append(subj)

        if verbose:
            print(f"  subject {subj}: cumulative windows = {len(X_list)}")

    X = np.stack(X_list).astype(np.float32)
    y = np.asarray(y_list, dtype=np.int64)
    groups = np.asarray(g_list, dtype=np.int64)
    seg = np.asarray(s_list, dtype=np.int64)

    jX = np.stack(jX_list).astype(np.float32) if jX_list else np.empty((0, C.WINDOW, C.N_CHANNELS), np.float32)
    jg = np.asarray(jg_list, dtype=np.int64)

    C.OUT_DIR.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(C.CACHE_NPZ, X=X, y=y, groups=groups, seg=seg)
    np.savez_compressed(C.JUNK_NPZ, X=jX, groups=jg)

    if verbose:
        print("\n=== Build complete ===")
        print(f"X: {X.shape}  y: {y.shape}  groups: {len(set(groups.tolist()))} subjects")
        dist = Counter(y.tolist())
        for i, name in enumerate(C.CLASS_NAMES):
            print(f"  {name:10s}: {dist.get(i, 0)} windows")
        print(f"  {'[junk]':10s}: {jX.shape[0]} windows (held out, never trained on)")
        capped = sum(per_subject_skipped.values())
        if capped:
            print(f"  ('other' windows dropped by per-subject cap: {capped})")
        print(f"Cached -> {C.CACHE_NPZ}")
    return X, y, groups


def load_windows(rebuild: bool = False):
    """Load cached windows, building them if needed."""
    if rebuild or not C.CACHE_NPZ.exists():
        return build_windows()
    d = np.load(C.CACHE_NPZ)
    return d["X"], d["y"], d["groups"]


def load_junk():
    """Load the held-out non-locomotion ('junk') windows + subject groups."""
    if not C.JUNK_NPZ.exists():
        build_windows()
    d = np.load(C.JUNK_NPZ)
    return d["X"], d["groups"]


def load_segments():
    """Load the per-window activity-bout id array (parallel to X from load_windows)."""
    if not C.CACHE_NPZ.exists():
        build_windows()
    return np.load(C.CACHE_NPZ)["seg"]


if __name__ == "__main__":
    rebuild = "--rebuild" in sys.argv
    build_windows() if rebuild else load_windows()
