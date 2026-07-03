"""
Priority 1 -- Lead-I CinC Normal-beat augmentation.

Background (from v1 failure analysis):
  MIT-BIH is recorded on MLII (modified chest lead II). CinC 2017 is Lead I
  (smartwatch analog). The v1 model dropped N-recall from 0.96 on MIT-BIH
  MLII to 0.573 on CinC Lead I -- a 37 pp domain gap.

Approach:
  Extract all beats from CinC records labeled 'N' (Normal Sinus Rhythm),
  treat them as AAMI 'N' training samples, and add to DS1. A prematurity
  filter (RR inside [0.80, 1.20] x record-median-RR) suppresses the small
  minority of ectopic beats that slip into 'N'-labeled records.

Output: cache of (beats, rr_features, labels) that the main supervised
training script can splice into DS1.

Key design choices:
  * Per-record RR median filter: drops <8% of beats in typical records.
  * Cap per record (CINC_N_MAX_BEATS_PER_RECORD) to prevent any single
    record from dominating the augmentation pool.
  * Sample-weight CINC_N_BEAT_WEIGHT (<1.0) downweights CinC beats relative
    to MIT-BIH to preserve MLII beat-morphology learning.
"""
import os
import sys
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from config import (CINC2017_DIR, BEAT_WINDOW_SAMPLES, CLASS_TO_IDX,
                     CINC_PREMATURITY_RR_LOW, CINC_PREMATURITY_RR_HIGH,
                     CINC_N_MAX_RECORDS, CINC_N_MAX_BEATS_PER_RECORD,
                     CINC_N_CACHE_PATH, TARGET_FS)
from data.cinc_loader import load_cinc_reference, extract_beats_from_cinc_record


def prematurity_filter(rr_features, low=CINC_PREMATURITY_RR_LOW,
                        high=CINC_PREMATURITY_RR_HIGH):
    """Keep only beats whose pre-RR is within [low, high] * median pre-RR.

    rr_features columns: [pre_rr, post_rr, ratio, local_mean_rr]
    Returns a boolean mask of shape (n,).
    """
    if len(rr_features) == 0:
        return np.zeros(0, dtype=bool)
    pre_rr = rr_features[:, 0]
    # Use valid (non-default) pre-RRs for median estimation
    valid = (pre_rr > 0.3) & (pre_rr < 2.0)
    if valid.sum() < 5:
        return np.ones(len(rr_features), dtype=bool)
    med = np.median(pre_rr[valid])
    mask = (pre_rr >= low * med) & (pre_rr <= high * med)
    return mask


def extract_cinc_n_beats(cinc_dir=None, max_records=None,
                          max_beats_per_record=None, verbose=True,
                          rng=None):
    """Walk CinC 'N' records, extract filtered beats, return concatenated pools.

    Returns dict:
        beats:        (n, BEAT_WINDOW_SAMPLES) float32
        rr_features:  (n, 4) float32
        labels:       (n,) int64, all = CLASS_TO_IDX['N']
        record_ids:   list of str, length n
        stats:        dict with per-step counts
    """
    if cinc_dir is None:
        cinc_dir = CINC2017_DIR
    if max_records is None:
        max_records = CINC_N_MAX_RECORDS
    if max_beats_per_record is None:
        max_beats_per_record = CINC_N_MAX_BEATS_PER_RECORD
    if rng is None:
        rng = np.random.default_rng(42)

    labels_map = load_cinc_reference(cinc_dir=cinc_dir)
    n_records = [r for r, lbl in labels_map.items() if lbl == 'N']
    n_records.sort()

    # Audit fix: hold out 20% of N records from supervised augmentation so
    # the Lead-I N-recall metric in evaluate.py can be reported on records
    # the model never saw during supervised training.
    from data.splits import partition_cinc_records
    held_in, held_out = partition_cinc_records(n_records)
    if held_out and verbose:
        print(f"  [holdout] supervised aug uses {len(held_in)} N records "
              f"({len(held_out)} held out for eval)")
    n_records = held_in

    if max_records is not None:
        n_records = n_records[:max_records]

    stats = {
        'n_records_total': len(n_records),
        'n_records_processed': 0,
        'n_beats_raw': 0,
        'n_beats_after_prematurity': 0,
        'n_beats_after_cap': 0,
        'n_failed_records': 0,
        'n_records_held_out': len(held_out),
        'held_out_records': sorted(held_out),
    }

    all_beats = []
    all_rr = []
    all_record_ids = []

    for i, rec_id in enumerate(n_records):
        try:
            data = extract_beats_from_cinc_record(rec_id, cinc_dir=cinc_dir,
                                                    target_fs=TARGET_FS)
        except Exception as e:
            stats['n_failed_records'] += 1
            continue
        if data['n_valid'] == 0:
            continue

        beats = data['beats']
        rr = data['rr_features']
        stats['n_beats_raw'] += len(beats)

        # Prematurity filter
        mask = prematurity_filter(rr)
        beats = beats[mask]
        rr = rr[mask]
        stats['n_beats_after_prematurity'] += len(beats)

        # Cap per record
        if max_beats_per_record is not None and len(beats) > max_beats_per_record:
            sel = rng.choice(len(beats), size=max_beats_per_record, replace=False)
            beats = beats[sel]
            rr = rr[sel]
        stats['n_beats_after_cap'] += len(beats)

        if len(beats) == 0:
            continue

        all_beats.append(beats)
        all_rr.append(rr)
        all_record_ids.extend([rec_id] * len(beats))
        stats['n_records_processed'] += 1

        if verbose and (i + 1) % 500 == 0:
            print(f"  [{i+1}/{len(n_records)}] processed; "
                  f"{stats['n_beats_after_cap']} beats collected")

    if not all_beats:
        return {
            'beats': np.empty((0, BEAT_WINDOW_SAMPLES), dtype=np.float32),
            'rr_features': np.empty((0, 4), dtype=np.float32),
            'labels': np.empty(0, dtype=np.int64),
            'record_ids': [],
            'stats': stats,
        }

    beats_all = np.concatenate(all_beats, axis=0).astype(np.float32)
    rr_all = np.concatenate(all_rr, axis=0).astype(np.float32)
    labels_all = np.full(len(beats_all), CLASS_TO_IDX['N'], dtype=np.int64)

    return {
        'beats': beats_all,
        'rr_features': rr_all,
        'labels': labels_all,
        'record_ids': all_record_ids,
        'stats': stats,
    }


def get_or_build_cinc_n_cache(cache_path=None, force=False, verbose=True):
    """Cache CinC N-beats to disk for reuse across runs.

    Returns the same dict structure as extract_cinc_n_beats().

    Audit fix: when CINC_HOLDOUT_ENABLED is True, the cache filename gets
    a `_holdout` suffix so we can keep both flavours side-by-side and so
    the legacy cache (without hold-out) is not silently reused.
    """
    from config import CINC_HOLDOUT_ENABLED
    if cache_path is None:
        cache_path = CINC_N_CACHE_PATH
        if CINC_HOLDOUT_ENABLED:
            base, ext = os.path.splitext(cache_path)
            cache_path = f"{base}_holdout{ext}"
    if (not force) and os.path.exists(cache_path):
        if verbose:
            print(f"  Loading cached CinC N beats from {cache_path}")
        data = np.load(cache_path, allow_pickle=True)
        return {
            'beats': data['beats'],
            'rr_features': data['rr_features'],
            'labels': data['labels'],
            'record_ids': list(data['record_ids']),
            'stats': data['stats'].item() if data['stats'].shape == () else {},
        }

    if verbose:
        print(f"  Building CinC N-beat cache (this takes a few minutes)...")
    result = extract_cinc_n_beats(verbose=verbose)
    os.makedirs(os.path.dirname(cache_path), exist_ok=True)
    np.savez_compressed(
        cache_path,
        beats=result['beats'],
        rr_features=result['rr_features'],
        labels=result['labels'],
        record_ids=np.array(result['record_ids']),
        stats=np.array(result['stats'], dtype=object),
    )
    if verbose:
        print(f"  Cached {len(result['beats'])} CinC N-beats to {cache_path}")
    return result


def splice_cinc_n_into_ds1(ds1_data, cinc_n_data, cinc_weight=0.3, verbose=True):
    """Splice CinC N-beats into DS1 and return augmented arrays.

    Returns:
        dict with 'beats', 'rr_features', 'label_indices', 'sample_weights'
    """
    import numpy as np
    ds1_beats = ds1_data['beats']
    ds1_rr = ds1_data['rr_features']
    ds1_labels = ds1_data['label_indices']
    ds1_weights = np.ones(len(ds1_labels), dtype=np.float32)

    cinc_beats = cinc_n_data['beats']
    cinc_rr = cinc_n_data['rr_features']
    cinc_labels = cinc_n_data['labels']
    cinc_weights = np.full(len(cinc_labels), cinc_weight, dtype=np.float32)

    merged_beats = np.concatenate([ds1_beats, cinc_beats], axis=0)
    merged_rr = np.concatenate([ds1_rr, cinc_rr], axis=0)
    merged_labels = np.concatenate([ds1_labels, cinc_labels], axis=0)
    merged_weights = np.concatenate([ds1_weights, cinc_weights], axis=0)

    if verbose:
        print(f"  DS1 original: {len(ds1_beats)} beats")
        print(f"  CinC N added: {len(cinc_beats)} beats (sample_weight={cinc_weight})")
        print(f"  Merged total: {len(merged_beats)} beats")

    return {
        'beats': merged_beats,
        'rr_features': merged_rr,
        'label_indices': merged_labels,
        'sample_weights': merged_weights,
    }


if __name__ == "__main__":
    # Standalone: build/refresh cache
    result = get_or_build_cinc_n_cache(force=False)
    print(f"\nCinC N-beat pool:")
    print(f"  Total beats:     {len(result['beats'])}")
    print(f"  Unique records:  {len(set(result['record_ids']))}")
    print(f"  Stats:           {result['stats']}")
