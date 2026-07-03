"""
PhysioNet/CinC 2017 Challenge dataset loader for cross-dataset validation.

CinC 2017 contains ~8,500 single-lead (Lead I) AliveCor handheld ECG recordings
sampled at 300 Hz, each 9-60 seconds long. Each recording has ONE rhythm-level
label (record-level, not beat-level):

    N = Normal Sinus Rhythm
    A = Atrial Fibrillation
    O = Other rhythm
    ~ = Noisy

Because our classifier predicts AAMI beat-level classes (N/S/V/F), while CinC
gives rhythm-level labels, we evaluate via a rhythm-to-beat-aggregation mapping:

    CinC 'N' (Normal Sinus Rhythm):
        Expected beat distribution: ~100% N-class (maybe 1% ectopic).
        Primary validation signal: "what fraction of predicted beats are N?"
        This is our honest Lead I N-recall.

    CinC 'A' (Atrial Fibrillation):
        Expected beat distribution: morphology is mostly normal QRS but RR
        intervals are highly irregular, so our S-class (supraventricular
        ectopic / premature atrial) is the closest AAMI analog. Expect
        elevated S predictions.

    CinC 'O' (Other) and '~' (Noisy):
        Ambiguous. Not used for primary metric but reported.

Labels file: REFERENCE.csv  (each line: "A00001,N"   "A00002,A"  etc.)
Audio files: A0xxxx.mat (MATLAB-format, single variable 'val' with int16 data)
             A0xxxx.hea (WFDB-style header for completeness)
"""
import os
import sys
import numpy as np
from scipy.io import loadmat
from scipy.signal import resample_poly
from math import gcd

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from config import (CINC2017_DIR, TARGET_FS, BEAT_WINDOW_LEFT,
                     BEAT_WINDOW_RIGHT, BEAT_WINDOW_SAMPLES)

CINC_FS = 300  # CinC 2017 sampling rate (Hz)

# Mapping from CinC rhythm label -> which AAMI-beat class we'd EXPECT to see
CINC_EXPECTED_AAMI = {
    'N': 'N',    # Normal rhythm -> mostly N beats
    'A': 'S',    # AF -> closest AAMI analog is S (irregular supra-ventricular)
    'O': None,   # Other -> ambiguous, no clean mapping
    '~': None,   # Noisy -> should be rejected by SQI gate
}


def load_cinc_reference(cinc_dir=None):
    """Load REFERENCE.csv -> dict {record_id: rhythm_label}.

    Returns:
        dict mapping record id (e.g. 'A00001') to rhythm label (one of 'N','A','O','~')
    """
    if cinc_dir is None:
        cinc_dir = CINC2017_DIR
    ref_path = os.path.join(cinc_dir, "REFERENCE.csv")
    if not os.path.exists(ref_path):
        # The release ships as training2017/REFERENCE.csv after extraction
        ref_path = os.path.join(cinc_dir, "training2017", "REFERENCE.csv")
    if not os.path.exists(ref_path):
        raise FileNotFoundError(f"REFERENCE.csv not found in {cinc_dir}")

    labels = {}
    with open(ref_path, 'r') as f:
        for line in f:
            line = line.strip()
            if not line or ',' not in line:
                continue
            rec, lbl = line.split(',', 1)
            labels[rec.strip()] = lbl.strip()
    return labels


def _locate_mat_file(rec_id, cinc_dir):
    """Find the .mat file for a record id (can be under training2017/ or root)."""
    for base in (cinc_dir, os.path.join(cinc_dir, "training2017")):
        p = os.path.join(base, rec_id + ".mat")
        if os.path.exists(p):
            return p
    raise FileNotFoundError(f"{rec_id}.mat not found under {cinc_dir}")


def load_cinc_record(rec_id, cinc_dir=None, target_fs=TARGET_FS):
    """Load a single CinC 2017 record.

    Args:
        rec_id: record id (e.g. 'A00001')
        cinc_dir: root directory (defaults to config.CINC2017_DIR)
        target_fs: resample the signal to this rate (default 128 Hz to match MIT-BIH pipeline)

    Returns:
        dict with:
            'signal':  1D float32 at target_fs
            'orig_fs': 300 (original CinC rate)
            'duration_s': float
            'record_id': str
    """
    if cinc_dir is None:
        cinc_dir = CINC2017_DIR

    mat_path = _locate_mat_file(rec_id, cinc_dir)
    data = loadmat(mat_path)
    # CinC stores signal in the 'val' key as int16
    signal = np.asarray(data['val'], dtype=np.float32).squeeze()
    # Convert from ADC units; typical AliveCor range is [-32768, 32767]
    # Center and normalize roughly
    signal = signal / 1000.0  # keeps amplitude in a reasonable range

    # Resample to target_fs
    if target_fs != CINC_FS:
        g = gcd(int(CINC_FS), int(target_fs))
        up = int(target_fs) // g
        down = int(CINC_FS) // g
        signal = resample_poly(signal, up, down).astype(np.float32)

    return {
        'signal': signal,
        'orig_fs': CINC_FS,
        'duration_s': len(signal) / target_fs,
        'record_id': rec_id,
    }


def extract_beats_from_cinc_record(rec_id, cinc_dir=None, target_fs=TARGET_FS,
                                     notch_freq=50):
    """Load a CinC record, filter, detect R-peaks, extract beat windows.

    All beats from a record share the rhythm label of the record.

    Returns:
        dict with:
            beats:       ndarray (n_beats, BEAT_WINDOW_SAMPLES) -- extracted beats
            rr_features: ndarray (n_beats, 4)
            record_id:   str
            rhythm:      str (the CinC rhythm label)
            n_rpeaks:    int
            n_valid:     int (subset of rpeaks that produced valid windows)
    """
    from preprocessing.filtering import preprocess_signal
    from preprocessing.rpeak_detection import detect_rpeaks
    from data.loader import extract_beats, compute_rr_features

    rec = load_cinc_record(rec_id, cinc_dir=cinc_dir, target_fs=target_fs)
    signal = rec['signal']

    # Preprocess (bandpass + notch)
    try:
        signal_filt = preprocess_signal(signal, target_fs, notch_freq=notch_freq)
    except Exception:
        signal_filt = signal

    # R-peak detection
    rpeaks = detect_rpeaks(signal_filt, target_fs)
    if len(rpeaks) == 0:
        return {
            'beats': np.empty((0, BEAT_WINDOW_SAMPLES), dtype=np.float32),
            'rr_features': np.empty((0, 4), dtype=np.float32),
            'record_id': rec_id,
            'n_rpeaks': 0,
            'n_valid': 0,
        }

    rr_all = compute_rr_features(rpeaks.tolist(), target_fs)

    beats, valid_idx = extract_beats(signal_filt, rpeaks.tolist(),
                                       BEAT_WINDOW_LEFT, BEAT_WINDOW_RIGHT)
    rr = rr_all[valid_idx] if len(valid_idx) else rr_all[:0]

    return {
        'beats': beats.astype(np.float32),
        'rr_features': rr.astype(np.float32),
        'record_id': rec_id,
        'n_rpeaks': len(rpeaks),
        'n_valid': len(valid_idx),
    }


def load_cinc_split(rhythm_filter=None, max_records=None, cinc_dir=None,
                      verbose=True):
    """Load CinC records, optionally filtered by rhythm label.

    Args:
        rhythm_filter: list/set of labels to keep (e.g. ['N', 'A']); None = all
        max_records: cap on number of records (for faster eval runs)
        cinc_dir: override directory
        verbose: print progress

    Returns:
        dict with concatenated beats + per-beat rhythm labels
    """
    if cinc_dir is None:
        cinc_dir = CINC2017_DIR

    labels = load_cinc_reference(cinc_dir=cinc_dir)
    rec_items = sorted(labels.items())

    if rhythm_filter is not None:
        rec_items = [(r, l) for r, l in rec_items if l in rhythm_filter]
    if max_records is not None:
        rec_items = rec_items[:max_records]

    all_beats = []
    all_rr = []
    all_record_ids = []
    all_rhythms = []

    for i, (rec_id, rhythm) in enumerate(rec_items):
        try:
            result = extract_beats_from_cinc_record(rec_id, cinc_dir=cinc_dir)
        except Exception as e:
            if verbose:
                print(f"  {rec_id}: FAILED -- {e}")
            continue
        n = result['n_valid']
        if verbose and i % 200 == 0:
            print(f"  [{i+1}/{len(rec_items)}] {rec_id} ({rhythm}): {n} beats")
        if n == 0:
            continue
        all_beats.append(result['beats'])
        all_rr.append(result['rr_features'])
        all_record_ids.extend([rec_id] * n)
        all_rhythms.extend([rhythm] * n)

    if not all_beats:
        return {
            'beats': np.empty((0, BEAT_WINDOW_SAMPLES), dtype=np.float32),
            'rr_features': np.empty((0, 4), dtype=np.float32),
            'record_ids_per_beat': [],
            'rhythm_per_beat': [],
        }

    return {
        'beats': np.concatenate(all_beats, axis=0),
        'rr_features': np.concatenate(all_rr, axis=0),
        'record_ids_per_beat': all_record_ids,
        'rhythm_per_beat': all_rhythms,
    }
