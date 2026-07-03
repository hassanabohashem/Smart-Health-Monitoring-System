"""
Priority 5 -- INCART F-class augmentation.

Background:
  MIT-BIH has only 391 F (fusion) beats across 2 patients (records 208 and
  213). The inter-patient evaluation on DS2 has 388 F beats from 3 patients.
  The v1 + v2 baselines all produce F-F1 ~= 0 because a 2-patient training
  distribution cannot generalize to unseen patients with fusion morphology.

  INCART (St. Petersburg Institute of Cardiological Technics 12-lead
  Arrhythmia DB) is a PhysioNet database of 75 half-hour, 12-lead recordings
  at 257 Hz from 32 Holter patients, carefully annotated at the beat level
  using the same AAMI conventions as MIT-BIH. It contains ~1,000 additional
  F beats from different patients — exactly what we need to fix the F data
  wall.

Approach:
  1. Walk INCART records, extract lead-II (or first available channel).
  2. Map annotations to AAMI classes; keep ONLY F beats (don't add N/S/V
     because MIT-BIH already has enough and this keeps the aug narrowly
     scoped to the F data wall).
  3. Resample signal 257 Hz -> 128 Hz, extract 128-sample windows, compute
     RR features.
  4. Splice into DS1 training only. Never touch DS2, never touch val.
"""
import os
import sys
import numpy as np
import wfdb
from math import gcd
from scipy.signal import resample_poly

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from config import (INCART_DIR, AAMI_MAPPING, EXCLUDED_SYMBOLS,
                     NON_BEAT_SYMBOLS, CLASS_TO_IDX, TARGET_FS,
                     BEAT_WINDOW_LEFT, BEAT_WINDOW_RIGHT,
                     BEAT_WINDOW_SAMPLES, CACHE_DIR)
from data.loader import (map_annotations_to_aami, compute_rr_features,
                           extract_beats, downsample_signal)

INCART_FS = 257          # INCART native sampling rate
INCART_CACHE_PATH = os.path.join(CACHE_DIR, "incart_f_beats.npz")


def list_incart_records(data_dir=None):
    """Return all INCART record IDs (I01..I75 minus any missing)."""
    if data_dir is None:
        data_dir = INCART_DIR
    records_file = os.path.join(data_dir, "RECORDS")
    if os.path.exists(records_file):
        with open(records_file) as f:
            return [ln.strip() for ln in f if ln.strip()]
    # fallback: glob .dat files
    return sorted(set(os.path.splitext(f)[0] for f in os.listdir(data_dir)
                        if f.endswith('.dat')))


def extract_incart_f_beats(data_dir=None, target_class='F', target_fs=TARGET_FS,
                             verbose=True, channel=0):
    """Extract F (fusion) beats from INCART records.

    Returns dict:
        beats:        (n, BEAT_WINDOW_SAMPLES) float32
        rr_features:  (n, 4) float32
        labels:       (n,) int64  (all = CLASS_TO_IDX['F'] if target_class='F')
        record_ids:   list of str, length n
        stats:        per-record counts
    """
    if data_dir is None:
        data_dir = INCART_DIR

    recs = list_incart_records(data_dir)
    cls_idx = CLASS_TO_IDX[target_class]

    all_beats, all_rr, all_record_ids = [], [], []
    stats = {'n_records': 0, 'n_records_with_target': 0,
              'n_target_beats': 0, 'n_failed': 0}

    for rec_id in recs:
        stats['n_records'] += 1
        rec_path = os.path.join(data_dir, rec_id)
        if not os.path.exists(rec_path + ".dat"):
            stats['n_failed'] += 1
            continue
        try:
            record = wfdb.rdrecord(rec_path)
            ann = wfdb.rdann(rec_path, 'atr')
        except Exception:
            stats['n_failed'] += 1
            continue

        if record.p_signal is None or record.p_signal.size == 0:
            stats['n_failed'] += 1
            continue

        ch = min(channel, record.p_signal.shape[1] - 1)
        signal = record.p_signal[:, ch].astype(np.float64)

        beat_samples, beat_labels, _ = map_annotations_to_aami(ann)
        if not beat_samples:
            continue

        # Downsample to target_fs
        signal_ds = downsample_signal(signal, INCART_FS, target_fs)
        scale = target_fs / INCART_FS
        beat_samples_ds = [int(round(s * scale)) for s in beat_samples]

        rr = compute_rr_features(beat_samples_ds, target_fs)
        beats, valid_idx = extract_beats(signal_ds, beat_samples_ds,
                                           BEAT_WINDOW_LEFT, BEAT_WINDOW_RIGHT)
        if len(valid_idx) == 0:
            continue

        # Keep only beats of target class (F by default)
        valid_labels = [beat_labels[i] for i in valid_idx]
        keep_mask = np.array([lbl == target_class for lbl in valid_labels],
                              dtype=bool)
        if keep_mask.sum() == 0:
            continue

        kept_beats = beats[keep_mask]
        kept_rr = rr[valid_idx][keep_mask]
        all_beats.append(kept_beats.astype(np.float32))
        all_rr.append(kept_rr.astype(np.float32))
        all_record_ids.extend([rec_id] * int(keep_mask.sum()))
        stats['n_records_with_target'] += 1
        stats['n_target_beats'] += int(keep_mask.sum())

        if verbose and stats['n_records'] % 10 == 0:
            print(f"  [{stats['n_records']}/{len(recs)}] "
                  f"{stats['n_target_beats']} {target_class} beats so far "
                  f"(from {stats['n_records_with_target']} records)")

    if not all_beats:
        return {
            'beats': np.empty((0, BEAT_WINDOW_SAMPLES), dtype=np.float32),
            'rr_features': np.empty((0, 4), dtype=np.float32),
            'labels': np.empty(0, dtype=np.int64),
            'record_ids': [],
            'stats': stats,
        }

    beats_all = np.concatenate(all_beats, axis=0)
    rr_all = np.concatenate(all_rr, axis=0)
    labels_all = np.full(len(beats_all), cls_idx, dtype=np.int64)

    if verbose:
        print(f"  INCART {target_class}-beat extraction complete.")
        print(f"    records processed:        {stats['n_records']}")
        print(f"    records with {target_class} beats:    {stats['n_records_with_target']}")
        print(f"    total {target_class} beats:          {stats['n_target_beats']}")

    return {
        'beats': beats_all, 'rr_features': rr_all, 'labels': labels_all,
        'record_ids': all_record_ids, 'stats': stats,
    }


def get_or_build_incart_f_cache(cache_path=None, force=False, verbose=True):
    """Cache F beats to disk for reuse."""
    if cache_path is None:
        cache_path = INCART_CACHE_PATH
    if (not force) and os.path.exists(cache_path):
        if verbose:
            print(f"  Loading cached INCART F beats from {cache_path}")
        data = np.load(cache_path, allow_pickle=True)
        return {
            'beats':       data['beats'],
            'rr_features': data['rr_features'],
            'labels':      data['labels'],
            'record_ids':  list(data['record_ids']),
            'stats':       data['stats'].item() if data['stats'].shape == () else {},
        }

    if verbose:
        print(f"  Building INCART F-beat cache...")
    result = extract_incart_f_beats(verbose=verbose)
    os.makedirs(os.path.dirname(cache_path), exist_ok=True)
    np.savez_compressed(
        cache_path,
        beats=result['beats'], rr_features=result['rr_features'],
        labels=result['labels'],
        record_ids=np.array(result['record_ids']),
        stats=np.array(result['stats'], dtype=object),
    )
    if verbose:
        print(f"  Cached {len(result['beats'])} INCART F beats -> {cache_path}")
    return result


def splice_incart_f_into_data(train_data, incart_f_data, f_sample_weight=1.0,
                                verbose=True):
    """Merge INCART F beats into a DS1-format dict.

    train_data: dict with 'beats', 'rr_features', 'label_indices'
        (and optionally 'sample_weights' from cinc_n_loader).
    """
    import numpy as np
    old_beats = train_data['beats']
    old_rr = train_data['rr_features']
    old_labels = train_data.get('label_indices', train_data.get('labels'))
    old_w = train_data.get('sample_weights',
                             np.ones(len(old_labels), dtype=np.float32))

    f_beats = incart_f_data['beats']
    f_rr = incart_f_data['rr_features']
    f_labels = incart_f_data['labels']
    f_w = np.full(len(f_labels), f_sample_weight, dtype=np.float32)

    merged = {
        'beats': np.concatenate([old_beats, f_beats], axis=0),
        'rr_features': np.concatenate([old_rr, f_rr], axis=0),
        'label_indices': np.concatenate([old_labels, f_labels], axis=0),
        'sample_weights': np.concatenate([old_w, f_w], axis=0).astype(np.float32),
    }
    if verbose:
        print(f"  Prev:        {len(old_beats)} beats")
        print(f"  INCART F:    {len(f_beats)} beats (sample_weight={f_sample_weight})")
        print(f"  Merged:      {len(merged['beats'])} beats")
    return merged


if __name__ == "__main__":
    r = get_or_build_incart_f_cache(force=False)
    print(f"\nINCART F pool: {len(r['beats'])} beats from "
          f"{len(set(r['record_ids']))} records")
    print(f"Stats: {r['stats']}")
