"""
On-the-fly data augmentation for IMU windows, applied to RAW physical-unit
windows (before the model's internal normalization). Augmentations simulate the
real-world variation a wrist watch sees, which is what makes the model robust to
noise and to slightly different ways of moving / wearing the watch.

  - jitter      : additive Gaussian sensor noise
  - scaling     : small global amplitude change
  - rotation    : random small 3-D rotation applied consistently to the accel
                  triplet and the gyro triplet (models watch worn at a slightly
                  different orientation)
  - time shift  : small circular shift along the time axis

Implemented with NumPy inside a tf.keras.utils.Sequence so the logic is easy to
read and reason about.
"""

from __future__ import annotations

import numpy as np
import tensorflow as tf

import config as C


def _rotation_matrix(rng: np.random.Generator, max_deg: float) -> np.ndarray:
    """Random rotation matrix from small Euler angles in [-max_deg, max_deg]."""
    ax, ay, az = np.deg2rad(rng.uniform(-max_deg, max_deg, size=3))
    cx, sx = np.cos(ax), np.sin(ax)
    cy, sy = np.cos(ay), np.sin(ay)
    cz, sz = np.cos(az), np.sin(az)
    rx = np.array([[1, 0, 0], [0, cx, -sx], [0, sx, cx]])
    ry = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]])
    rz = np.array([[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]])
    return (rz @ ry @ rx).astype(np.float32)


def augment_batch(batch: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    """Augment a (B, WINDOW, 6) batch. Returns a new array (input unchanged)."""
    out = batch.copy()
    b = out.shape[0]

    # Rotation: one small rotation per sample, applied to accel (0:3) and gyro
    # (3:6). Kept modest (±10°) so the gravity-direction cue that distinguishes
    # postures survives, while still teaching robustness to wrist orientation.
    for i in range(b):
        rmat = _rotation_matrix(rng, max_deg=C.AUG_ROTATION_DEG)
        out[i, :, 0:3] = out[i, :, 0:3] @ rmat.T
        out[i, :, 3:6] = out[i, :, 3:6] @ rmat.T

    # Global amplitude scaling, one factor per sample.
    scale = rng.uniform(0.95, 1.05, size=(b, 1, 1)).astype(np.float32)
    out *= scale

    # Additive Gaussian jitter. Std is per-channel-group: accel ~ m/s^2, gyro ~ rad/s.
    accel_std = C.AUG_ACCEL_NOISE
    gyro_std = C.AUG_GYRO_NOISE
    out[:, :, 0:3] += rng.normal(0.0, accel_std, size=out[:, :, 0:3].shape).astype(np.float32)
    out[:, :, 3:6] += rng.normal(0.0, gyro_std, size=out[:, :, 3:6].shape).astype(np.float32)

    # Small circular time shift, one shift per sample.
    for i in range(b):
        shift = int(rng.integers(-C.TARGET_HZ // 2, C.TARGET_HZ // 2 + 1))  # +-0.5 s
        if shift:
            out[i] = np.roll(out[i], shift, axis=0)

    return out


class AugmentedSequence(tf.keras.utils.Sequence):
    """Yields augmented training batches each epoch; shuffles between epochs."""

    def __init__(self, x, y, batch_size, seed=C.SEED, augment=True):
        super().__init__()
        self.x = x
        self.y = y
        self.batch_size = batch_size
        self.augment = augment
        self.rng = np.random.default_rng(seed)
        self._order = np.arange(len(x))
        self.rng.shuffle(self._order)

    def __len__(self):
        return int(np.ceil(len(self.x) / self.batch_size))

    def __getitem__(self, idx):
        sel = self._order[idx * self.batch_size : (idx + 1) * self.batch_size]
        xb = self.x[sel]
        yb = self.y[sel]
        if self.augment:
            xb = augment_batch(xb, self.rng)
        return xb, yb

    def on_epoch_end(self):
        self.rng.shuffle(self._order)
