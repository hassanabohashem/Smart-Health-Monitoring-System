"""
WFDB record loading, AAMI annotation mapping, beat extraction, and RR-feature computation.

Loads MIT-BIH records, maps annotation symbols to AAMI superclasses,
extracts fixed-length beat windows centered on R-peaks, computes RR-interval features,
and downsamples to target sampling rate (128 Hz).
"""
import os
import sys
import numpy as np
import wfdb
from scipy.signal import resample_poly
from math import gcd

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from config import (MITDB_DIR, AAMI_MAPPING, EXCLUDED_SYMBOLS, NON_BEAT_SYMBOLS,
                     CLASS_TO_IDX, ORIGINAL_FS, TARGET_FS,
                     BEAT_WINDOW_SAMPLES, BEAT_WINDOW_LEFT, BEAT_WINDOW_RIGHT,
                     TEACHER_INPUT_FS, TEACHER_INPUT_SAMPLES,
                     TEACHER_BEAT_WINDOW_LEFT, TEACHER_BEAT_WINDOW_RIGHT)


def load_record(record_id, data_dir=None):
    """Load a WFDB record and its annotations.

    Returns:
        signal: ndarray of shape (n_samples, n_channels)
        annotation: wfdb Annotation object
        fields: dict with record metadata
    """
    if data_dir is None:
        data_dir = MITDB_DIR
    record_path = os.path.join(data_dir, str(record_id))
    record = wfdb.rdrecord(record_path)
    annotation = wfdb.rdann(record_path, 'atr')
    return record.p_signal, annotation, {
        'fs': record.fs,
        'sig_name': record.sig_name,
        'n_sig': record.n_sig,
        'record_id': record_id,
    }


def map_annotations_to_aami(annotation):
    """Map wfdb annotation symbols to AAMI classes.

    Returns:
        beat_samples: list of R-peak sample indices
        beat_labels: list of AAMI class strings ('N', 'S', 'V', 'F')
        skipped: dict counting skipped symbol types
    """
    beat_samples = []
    beat_labels = []
    skipped = {}

    for i, symbol in enumerate(annotation.symbol):
        if symbol in NON_BEAT_SYMBOLS:
            continue
        if symbol in EXCLUDED_SYMBOLS:
            skipped[symbol] = skipped.get(symbol, 0) + 1
            continue
        if symbol in AAMI_MAPPING:
            beat_samples.append(annotation.sample[i])
            beat_labels.append(AAMI_MAPPING[symbol])
        else:
            skipped[symbol] = skipped.get(symbol, 0) + 1

    return beat_samples, beat_labels, skipped


def downsample_signal(signal, orig_fs, target_fs):
    """Downsample signal using polyphase resampling.

    Args:
        signal: 1D or 2D array (n_samples,) or (n_samples, n_channels)
        orig_fs: Original sampling rate
        target_fs: Target sampling rate

    Returns:
        Downsampled signal
    """
    g = gcd(int(orig_fs), int(target_fs))
    up = int(target_fs) // g
    down = int(orig_fs) // g
    if signal.ndim == 1:
        return resample_poly(signal, up, down)
    return np.column_stack([
        resample_poly(signal[:, ch], up, down) for ch in range(signal.shape[1])
    ])


def compute_rr_features(beat_samples_resampled, fs):
    """Compute RR-interval features for each beat.

    Features (4-dim):
        - pre_rr:  RR interval before this beat (seconds)
        - post_rr: RR interval after this beat (seconds)
        - ratio:   pre_rr / post_rr
        - local_mean_rr: mean RR over last 10 beats (seconds)

    Returns:
        rr_features: ndarray of shape (n_beats, 4)
    """
    n = len(beat_samples_resampled)
    rr_features = np.zeros((n, 4), dtype=np.float32)

    for i in range(n):
        # Pre-RR
        if i > 0:
            pre_rr = (beat_samples_resampled[i] - beat_samples_resampled[i - 1]) / fs
        else:
            pre_rr = 0.8  # default ~75 bpm
        # Post-RR
        if i < n - 1:
            post_rr = (beat_samples_resampled[i + 1] - beat_samples_resampled[i]) / fs
        else:
            post_rr = 0.8
        # Ratio
        ratio = pre_rr / max(post_rr, 1e-6)
        # Local mean RR over last 10 beats
        start_idx = max(0, i - 10)
        if i > start_idx:
            local_intervals = np.diff(beat_samples_resampled[start_idx:i + 1]) / fs
            local_mean = np.mean(local_intervals)
        else:
            local_mean = 0.8

        rr_features[i] = [pre_rr, post_rr, ratio, local_mean]

    return rr_features


def extract_beats(signal_1d, beat_samples, window_left, window_right):
    """Extract fixed-length beat windows centered on R-peaks.

    Args:
        signal_1d: 1D signal array
        beat_samples: list of R-peak sample indices
        window_left: samples before R-peak
        window_right: samples after R-peak

    Returns:
        beats: ndarray of shape (n_valid_beats, window_left + window_right)
        valid_indices: indices of beats that fit within signal bounds
    """
    total_len = window_left + window_right
    beats = []
    valid_indices = []

    for i, peak in enumerate(beat_samples):
        start = peak - window_left
        end = peak + window_right
        if start < 0 or end > len(signal_1d):
            continue
        beats.append(signal_1d[start:end])
        valid_indices.append(i)

    if len(beats) == 0:
        return np.empty((0, total_len), dtype=np.float32), []

    return np.array(beats, dtype=np.float32), valid_indices


def extract_teacher_windows(signal_1d, beat_samples_original, orig_fs,
                              teacher_fs=TEACHER_INPUT_FS,
                              window_samples=TEACHER_INPUT_SAMPLES,
                              left=TEACHER_BEAT_WINDOW_LEFT,
                              right=TEACHER_BEAT_WINDOW_RIGHT):
    """Extract 10-second windows at 500 Hz centered on each R-peak, for ECGFounder.

    ECGFounder's 1-lead variant expects (batch, 1, 5000) inputs (10s @ 500 Hz).
    We resample the ORIGINAL MIT-BIH signal (360 Hz) to 500 Hz and cut 10s
    windows around each R-peak. Beats near the signal boundary get zero-padded.

    Args:
        signal_1d: 1D raw signal at orig_fs (MIT-BIH is 360 Hz)
        beat_samples_original: R-peak indices in the ORIGINAL signal domain
        orig_fs: original sampling rate (360 for MIT-BIH)
        teacher_fs: ECGFounder target sampling rate (500 Hz)
        window_samples: teacher input length (5000)
        left: samples before R-peak in teacher domain (e.g. 2000 = 4s)
        right: samples after R-peak in teacher domain (e.g. 3000 = 6s)

    Returns:
        teacher_beats: ndarray (n_beats, window_samples), float32,
                       zero-padded near edges. Already z-score normalized
                       (per ECGFounder's preprocessing convention).
    """
    # Resample the whole record once to teacher_fs
    signal_teacher = downsample_signal(signal_1d, orig_fs, teacher_fs)
    scale = teacher_fs / orig_fs
    teacher_beats = np.zeros((len(beat_samples_original), window_samples),
                              dtype=np.float32)

    for i, peak_orig in enumerate(beat_samples_original):
        peak_teacher = int(round(peak_orig * scale))
        start = peak_teacher - left
        end = peak_teacher + right
        # Handle boundary cases with zero padding
        src_start = max(start, 0)
        src_end = min(end, len(signal_teacher))
        dst_start = src_start - start
        dst_end = dst_start + (src_end - src_start)
        teacher_beats[i, dst_start:dst_end] = signal_teacher[src_start:src_end]

        # Per-window z-score normalization (ECGFounder convention)
        w = teacher_beats[i]
        mean = w.mean()
        std = w.std() + 1e-8
        teacher_beats[i] = (w - mean) / std

    return teacher_beats


def load_and_extract_record(record_id, channel=0, data_dir=None, orig_fs=None,
                             target_fs=None, extract_teacher=False):
    """Full pipeline for one record: load → map → downsample → extract beats + RR.

    Args:
        record_id: MIT-BIH record number
        channel: which channel to use (0=MLII typically, 1=secondary)
        data_dir: override data directory
        orig_fs: override original sampling rate
        target_fs: override target sampling rate

    Returns:
        dict with keys: beats, labels, label_indices, rr_features, record_id, skipped
    """
    if orig_fs is None:
        orig_fs = ORIGINAL_FS
    if target_fs is None:
        target_fs = TARGET_FS

    signal, annotation, fields = load_record(record_id, data_dir)

    # Use primary channel (typically MLII)
    ch = min(channel, signal.shape[1] - 1)
    signal_1d = signal[:, ch].astype(np.float64)

    # Map annotations
    beat_samples, beat_labels, skipped = map_annotations_to_aami(annotation)

    if len(beat_samples) == 0:
        return {
            'beats': np.empty((0, BEAT_WINDOW_SAMPLES), dtype=np.float32),
            'labels': [],
            'label_indices': [],
            'rr_features': np.empty((0, 4), dtype=np.float32),
            'record_id': record_id,
            'skipped': skipped,
        }

    # Downsample signal
    signal_ds = downsample_signal(signal_1d, orig_fs, target_fs)

    # Rescale beat sample indices to target sampling rate
    scale_factor = target_fs / orig_fs
    beat_samples_ds = [int(round(s * scale_factor)) for s in beat_samples]

    # Compute RR features at target sampling rate
    rr_features = compute_rr_features(beat_samples_ds, target_fs)

    # Extract beat windows
    beats, valid_indices = extract_beats(
        signal_ds, beat_samples_ds, BEAT_WINDOW_LEFT, BEAT_WINDOW_RIGHT
    )

    # Filter labels and RR features to valid beats
    valid_labels = [beat_labels[i] for i in valid_indices]
    valid_label_indices = [CLASS_TO_IDX[l] for l in valid_labels]
    valid_rr = rr_features[valid_indices]

    result = {
        'beats': beats,
        'labels': valid_labels,
        'label_indices': np.array(valid_label_indices, dtype=np.int64),
        'rr_features': valid_rr,
        'record_id': record_id,
        'skipped': skipped,
    }

    # Optional: also extract 10-second windows at 500 Hz for ECGFounder teacher
    if extract_teacher:
        # Use the ORIGINAL-domain R-peak indices (valid ones only) for teacher
        valid_beat_samples_orig = [beat_samples[i] for i in valid_indices]
        teacher_beats = extract_teacher_windows(
            signal_1d, valid_beat_samples_orig, orig_fs
        )
        result['teacher_beats'] = teacher_beats

    return result


def load_dataset_split(record_ids, channel=0, data_dir=None, verbose=True,
                        extract_teacher=False):
    """Load all records in a split, concatenate beats and features.

    Returns:
        dict with keys: beats, labels, label_indices, rr_features,
                        record_ids_per_beat, [teacher_beats]
    """
    all_beats = []
    all_labels = []
    all_label_indices = []
    all_rr = []
    all_record_ids = []
    all_teacher = [] if extract_teacher else None

    for rec_id in record_ids:
        result = load_and_extract_record(rec_id, channel=channel, data_dir=data_dir,
                                           extract_teacher=extract_teacher)
        n = len(result['labels'])
        if verbose:
            print(f"  Record {rec_id}: {n} beats, skipped={result['skipped']}")
        if n == 0:
            continue
        all_beats.append(result['beats'])
        all_labels.extend(result['labels'])
        all_label_indices.append(result['label_indices'])
        all_rr.append(result['rr_features'])
        all_record_ids.extend([rec_id] * n)
        if extract_teacher:
            all_teacher.append(result['teacher_beats'])

    out = {
        'beats': np.concatenate(all_beats, axis=0) if all_beats else np.empty((0, BEAT_WINDOW_SAMPLES)),
        'labels': all_labels,
        'label_indices': np.concatenate(all_label_indices) if all_label_indices else np.array([], dtype=np.int64),
        'rr_features': np.concatenate(all_rr, axis=0) if all_rr else np.empty((0, 4)),
        'record_ids_per_beat': all_record_ids,
    }
    if extract_teacher and all_teacher:
        out['teacher_beats'] = np.concatenate(all_teacher, axis=0)
    return out


def print_class_distribution(label_indices, prefix=""):
    """Print class distribution for a dataset split."""
    from collections import Counter
    counts = Counter(label_indices.tolist() if hasattr(label_indices, 'tolist') else label_indices)
    total = sum(counts.values())
    print(f"{prefix}Class distribution ({total} total beats):")
    for cls_name, idx in sorted(CLASS_TO_IDX.items(), key=lambda x: x[1]):
        c = counts.get(idx, 0)
        pct = 100.0 * c / total if total > 0 else 0
        print(f"  {cls_name} (idx={idx}): {c:>6d} ({pct:5.1f}%)")
