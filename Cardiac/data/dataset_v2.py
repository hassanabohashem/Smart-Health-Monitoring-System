"""
v2 dataset + loaders.

Differences from v1 dataset.py:
  * Supports per-sample weights so CinC Lead-I N-beats can be downweighted
    relative to MIT-BIH beats.
  * Returns (beat, rr, label, sample_weight). No teacher tensors
    (v1 KD was proven NEUTRAL and is removed to simplify v2).
"""
import os
import sys
import numpy as np
import torch
from torch.utils.data import Dataset, DataLoader, WeightedRandomSampler
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from config import (BATCH_SIZE, N_UNDERSAMPLE_RATIO, CLASS_WEIGHT_CAP,
                     NUM_CLASSES, CLASS_TO_IDX, BEAT_WINDOW_SAMPLES,
                     RR_FEATURE_DIM, SEED_NUMPY, MIXUP_TARGET_COUNT)
from data.augmentations import augment_beat, mixup_beats
from preprocessing.filtering import zscore_normalize


class ECGBeatDatasetV2(Dataset):
    """Emits (beat[128,1], rr[4], label, sample_weight)."""

    def __init__(self, beats, rr_features, labels, sample_weights=None,
                 augment=False, normalize=True,
                 all_beats_by_class=None, all_rr_by_class=None):
        self.beats = beats.astype(np.float32)
        self.rr_features = rr_features.astype(np.float32)
        self.labels = labels.astype(np.int64)
        if sample_weights is None:
            sample_weights = np.ones(len(self.labels), dtype=np.float32)
        self.sample_weights = sample_weights.astype(np.float32)
        self.augment = augment
        self.normalize = normalize
        self.all_beats_by_class = all_beats_by_class
        self.all_rr_by_class = all_rr_by_class
        self.rng = np.random.default_rng(SEED_NUMPY)

    def __len__(self):
        return len(self.labels)

    def __getitem__(self, idx):
        beat = self.beats[idx].copy()
        rr = self.rr_features[idx].copy()
        label = int(self.labels[idx])
        weight = float(self.sample_weights[idx])

        if self.augment:
            if (label != CLASS_TO_IDX['N'] and self.all_beats_by_class is not None
                    and self.rng.random() < 0.2):
                pool = self.all_beats_by_class.get(label)
                pool_rr = self.all_rr_by_class.get(label)
                if pool is not None and len(pool) > 1:
                    j = self.rng.integers(0, len(pool))
                    beat, rr = mixup_beats(beat, pool[j], rr, pool_rr[j],
                                             rng=self.rng)
            beat, rr = augment_beat(beat, rr, rng=self.rng)

        if self.normalize:
            beat = zscore_normalize(beat)

        return (torch.from_numpy(beat).float().unsqueeze(-1),
                torch.from_numpy(rr).float(),
                torch.tensor(label, dtype=torch.long),
                torch.tensor(weight, dtype=torch.float32))


def balance_for_supervised(beats, rr_features, labels, sample_weights=None,
                             rng=None, verbose=True):
    """Undersample N, MixUp-oversample S/V/F up to MIXUP_TARGET_COUNT.

    When sample_weights is provided, MixUp children inherit the MEAN of their
    parents' weights; undersampled N beats keep their original weights.

    Returns:
        dict with 'beats', 'rr_features', 'labels', 'sample_weights'.
    """
    if rng is None:
        rng = np.random.default_rng(SEED_NUMPY)
    if sample_weights is None:
        sample_weights = np.ones(len(labels), dtype=np.float32)

    if verbose:
        print(f"  Before balancing: {dict(sorted(Counter(labels.tolist()).items()))}")

    out_b, out_r, out_l, out_w = [], [], [], []
    class_indices = {c: np.where(labels == c)[0] for c in range(NUM_CLASSES)}

    # --- N undersampling ---
    n_idx = class_indices.get(CLASS_TO_IDX['N'], np.array([]))
    if len(n_idx) > 0:
        n_keep = int(len(n_idx) * N_UNDERSAMPLE_RATIO)
        sel = rng.choice(n_idx, size=n_keep, replace=False)
        out_b.append(beats[sel])
        out_r.append(rr_features[sel])
        out_l.extend([CLASS_TO_IDX['N']] * n_keep)
        out_w.append(sample_weights[sel])

    # --- Minority MixUp ---
    for cls in ['S', 'V', 'F']:
        ci = CLASS_TO_IDX[cls]
        idx = class_indices.get(ci, np.array([]))
        if len(idx) == 0:
            continue
        # keep originals
        out_b.append(beats[idx])
        out_r.append(rr_features[idx])
        out_l.extend([ci] * len(idx))
        out_w.append(sample_weights[idx])

        n_syn = max(0, MIXUP_TARGET_COUNT - len(idx))
        if n_syn == 0 or len(idx) < 2:
            continue

        n_class = len(idx)
        syn_b = np.zeros((n_syn, beats.shape[1]), dtype=np.float32)
        syn_r = np.zeros((n_syn, rr_features.shape[1]), dtype=np.float32)
        syn_w = np.ones(n_syn, dtype=np.float32)

        for i in range(n_syn):
            k = rng.integers(2, min(4, n_class + 1))
            sel = rng.choice(n_class, size=k, replace=False)
            w = rng.dirichlet(np.ones(k))
            syn_b[i] = np.average(beats[idx][sel], axis=0, weights=w)
            syn_b[i] += rng.normal(0, 0.015, size=syn_b[i].shape)
            syn_r[i] = np.average(rr_features[idx][sel], axis=0, weights=w)
            syn_w[i] = np.average(sample_weights[idx][sel], weights=w)

        out_b.append(syn_b)
        out_r.append(syn_r)
        out_l.extend([ci] * n_syn)
        out_w.append(syn_w)

    beats_out = np.concatenate(out_b, axis=0)
    rr_out = np.concatenate(out_r, axis=0)
    labels_out = np.array(out_l, dtype=np.int64)
    weights_out = np.concatenate(out_w, axis=0).astype(np.float32)

    perm = rng.permutation(len(labels_out))
    beats_out = beats_out[perm]
    rr_out = rr_out[perm]
    labels_out = labels_out[perm]
    weights_out = weights_out[perm]

    if verbose:
        print(f"  After balancing:  {dict(sorted(Counter(labels_out.tolist()).items()))}")

    return {
        'beats': beats_out, 'rr_features': rr_out,
        'labels': labels_out, 'sample_weights': weights_out,
    }


def compute_class_weights(labels, use_sampler=True):
    """sqrt-inverse-frequency (with sampler) to avoid double-weighting minority classes."""
    counts = Counter(labels.tolist() if hasattr(labels, 'tolist') else labels)
    total = sum(counts.values())
    w = torch.zeros(NUM_CLASSES, dtype=torch.float32)
    for c in range(NUM_CLASSES):
        count = counts.get(c, 1)
        raw = total / (NUM_CLASSES * count)
        w[c] = min(np.sqrt(raw) if use_sampler else raw, CLASS_WEIGHT_CAP)
    return w


def create_dataloaders_v2(train_data, val_data, test_data=None,
                            batch_size=BATCH_SIZE, verbose=True):
    """Create v2 dataloaders. train_data may carry a 'sample_weights' field."""
    if verbose:
        print("Balancing training data (v2)...")
    sw_in = train_data.get('sample_weights')
    balanced = balance_for_supervised(
        train_data['beats'], train_data['rr_features'],
        train_data['label_indices'] if 'label_indices' in train_data else train_data['labels'],
        sample_weights=sw_in, verbose=verbose,
    )

    b = balanced['beats']
    r = balanced['rr_features']
    l = balanced['labels']
    w = balanced['sample_weights']

    beats_by_class, rr_by_class = {}, {}
    for c in range(NUM_CLASSES):
        mask = l == c
        if mask.any():
            beats_by_class[c] = b[mask]
            rr_by_class[c] = r[mask]

    class_weights = compute_class_weights(l)
    if verbose:
        print(f"  Class weights: {class_weights.tolist()}")

    # Per-sample composition weight for WeightedRandomSampler:
    # combine class-weight with the per-sample (CinC-aug) weight.
    sample_comp = class_weights[l].numpy() * w
    sampler = WeightedRandomSampler(weights=sample_comp.tolist(),
                                      num_samples=len(l), replacement=True)

    train_ds = ECGBeatDatasetV2(b, r, l, sample_weights=w, augment=True,
                                  normalize=True,
                                  all_beats_by_class=beats_by_class,
                                  all_rr_by_class=rr_by_class)
    val_ds = ECGBeatDatasetV2(val_data['beats'], val_data['rr_features'],
                                val_data['label_indices'],
                                sample_weights=None, augment=False, normalize=True)

    train_loader = DataLoader(train_ds, batch_size=batch_size, sampler=sampler,
                                num_workers=0, drop_last=True)
    val_loader = DataLoader(val_ds, batch_size=batch_size, shuffle=False,
                              num_workers=0)
    test_loader = None
    if test_data is not None:
        test_ds = ECGBeatDatasetV2(test_data['beats'], test_data['rr_features'],
                                     test_data['label_indices'],
                                     augment=False, normalize=True)
        test_loader = DataLoader(test_ds, batch_size=batch_size, shuffle=False,
                                   num_workers=0)

    return train_loader, val_loader, test_loader, class_weights
