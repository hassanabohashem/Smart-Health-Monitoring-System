"""
Compact 1D-CNN for 6-channel IMU HAR, designed to be TFLite-friendly and fast
on a phone.

Key design choice: the per-channel standardization is baked in as the first
layer (a Keras Normalization layer adapted on the training set). The exported
TFLite model therefore consumes RAW physical units (accel m/s^2, gyro rad/s) in
the exact [ax, ay, az, gx, gy, gz] channel order the watch streams. The Android
side does zero normalization math, which removes a whole class of train/serve
skew bugs.
"""

from __future__ import annotations

import keras
import numpy as np
import tensorflow as tf
from tensorflow.keras import layers, models

import config as C


@keras.saving.register_keras_serializable(package="har")
def _derive_features(x):
    """Append gravity/orientation-invariant magnitude channels.

    Input  (B, T, 6) = [ax,ay,az,gx,gy,gz]
    Output (B, T, 8) with accel-magnitude and gyro-magnitude appended.
    Computed inside the graph so the Android input contract stays 6 channels.
    """
    acc = x[..., 0:3]
    gyr = x[..., 3:6]
    acc_mag = tf.sqrt(tf.reduce_sum(tf.square(acc), axis=-1, keepdims=True) + 1e-6)
    gyr_mag = tf.sqrt(tf.reduce_sum(tf.square(gyr), axis=-1, keepdims=True) + 1e-6)
    return tf.concat([x, acc_mag, gyr_mag], axis=-1)


def _res_block(x, filters, kernel):
    """Conv1D residual block: (conv-bn-relu)x2 + projected skip, then relu."""
    skip = x
    if x.shape[-1] != filters:
        skip = layers.Conv1D(filters, 1, padding="same", use_bias=False)(x)
        skip = layers.BatchNormalization()(skip)
    y = layers.Conv1D(filters, kernel, padding="same", use_bias=False)(x)
    y = layers.BatchNormalization()(y)
    y = layers.ReLU()(y)
    y = layers.Conv1D(filters, kernel, padding="same", use_bias=False)(y)
    y = layers.BatchNormalization()(y)
    y = layers.Add()([y, skip])
    return layers.ReLU()(y)


def _resnet_backbone(inp, derive, norm):
    """Residual conv feature extractor with derived magnitude channels."""
    x = derive(inp)                 # (T, 8)
    x = norm(x)
    x = layers.Conv1D(64, 7, padding="same", use_bias=False)(x)
    x = layers.BatchNormalization()(x)
    x = layers.ReLU()(x)

    x = _res_block(x, 64, 5)
    x = _res_block(x, 64, 5)
    x = layers.MaxPooling1D(2)(x)
    x = layers.Dropout(0.2)(x)

    x = _res_block(x, 128, 3)
    x = _res_block(x, 128, 3)
    x = layers.MaxPooling1D(2)(x)
    x = layers.Dropout(0.3)(x)

    x = _res_block(x, 128, 3)
    x = layers.GlobalAveragePooling1D()(x)
    x = layers.Dropout(0.4)(x)
    x = layers.Dense(128, activation="relu")(x)
    x = layers.Dropout(0.4)(x)
    return x


def _compact_backbone(inp, derive, norm):
    """Compact conv feature extractor on derived (8-channel) features.

    Same proven stack as the original dual-head, just fed the 8-channel input
    (raw 6 + accel/gyro magnitudes). Stays small (~0.6 MB) and TFLite-clean.
    """
    x = derive(inp)
    x = norm(x)
    x = layers.Conv1D(64, 5, padding="same", use_bias=False)(x)
    x = layers.BatchNormalization()(x)
    x = layers.ReLU()(x)
    x = layers.Conv1D(64, 5, padding="same", use_bias=False)(x)
    x = layers.BatchNormalization()(x)
    x = layers.ReLU()(x)
    x = layers.MaxPooling1D(2)(x)
    x = layers.Dropout(0.2)(x)

    x = layers.Conv1D(128, 3, padding="same", use_bias=False)(x)
    x = layers.BatchNormalization()(x)
    x = layers.ReLU()(x)
    x = layers.Conv1D(128, 3, padding="same", use_bias=False)(x)
    x = layers.BatchNormalization()(x)
    x = layers.ReLU()(x)
    x = layers.MaxPooling1D(2)(x)
    x = layers.Dropout(0.3)(x)

    x = layers.Conv1D(128, 3, padding="same", use_bias=False)(x)
    x = layers.BatchNormalization()(x)
    x = layers.ReLU()(x)
    x = layers.GlobalAveragePooling1D()(x)
    x = layers.Dropout(0.4)(x)
    x = layers.Dense(128, activation="relu")(x)
    x = layers.Dropout(0.4)(x)
    return x


def _backbone(inp, norm):
    """Shared conv feature extractor. Returns a 128-d feature vector tensor."""
    x = norm(inp)
    x = layers.Conv1D(64, 5, padding="same", use_bias=False)(x)
    x = layers.BatchNormalization()(x)
    x = layers.ReLU()(x)
    x = layers.Conv1D(64, 5, padding="same", use_bias=False)(x)
    x = layers.BatchNormalization()(x)
    x = layers.ReLU()(x)
    x = layers.MaxPooling1D(2)(x)
    x = layers.Dropout(0.2)(x)

    x = layers.Conv1D(128, 3, padding="same", use_bias=False)(x)
    x = layers.BatchNormalization()(x)
    x = layers.ReLU()(x)
    x = layers.Conv1D(128, 3, padding="same", use_bias=False)(x)
    x = layers.BatchNormalization()(x)
    x = layers.ReLU()(x)
    x = layers.MaxPooling1D(2)(x)
    x = layers.Dropout(0.3)(x)

    x = layers.Conv1D(128, 3, padding="same", use_bias=False)(x)
    x = layers.BatchNormalization()(x)
    x = layers.ReLU()(x)
    x = layers.GlobalAveragePooling1D()(x)
    x = layers.Dropout(0.4)(x)
    x = layers.Dense(128, activation="relu")(x)
    x = layers.Dropout(0.4)(x)
    return x


def build_dual_head_model(train_x: np.ndarray) -> tf.keras.Model:
    """Dual-head HAR model.

    Outputs:
      probs   : 4-way softmax over the real activities (walking/jogging/stairs/
                stationary). Trained ONLY on real windows (junk windows are masked
                out via sample_weight=0) so junk never dilutes the classifier.
      is_real : sigmoid "this is a real tracked activity, not junk / fake movement".
                Trained on real (1) vs the 13 non-locomotion activities (0).

    At inference: reject when is_real < tau (tuned); otherwise argmax(probs).
    """
    derive = layers.Lambda(_derive_features, name="derive_features",
                           output_shape=(C.WINDOW, C.N_CHANNELS + 2))
    # Adapt normalization on the DERIVED (8-channel) features.
    norm = layers.Normalization(axis=-1, name="standardize")
    norm.adapt(derive(train_x))

    inp = layers.Input(shape=(C.WINDOW, C.N_CHANNELS), name="imu_window")
    feat = _compact_backbone(inp, derive, norm)
    probs = layers.Dense(C.N_CLASSES, activation="softmax", name="probs")(feat)
    is_real = layers.Dense(1, activation="sigmoid", name="is_real")(feat)

    model = models.Model(inp, {"probs": probs, "is_real": is_real}, name="har_dualhead")
    model.compile(
        optimizer=tf.keras.optimizers.Adam(C.LEARNING_RATE),
        loss={
            "probs": tf.keras.losses.SparseCategoricalCrossentropy(),
            "is_real": "binary_crossentropy",
        },
        loss_weights={"probs": 1.0, "is_real": 1.0},
        metrics={"probs": "accuracy", "is_real": "accuracy"},
    )
    return model


def build_model(train_x: np.ndarray) -> tf.keras.Model:
    """Build and return a compiled 1D-CNN.

    train_x is used only to adapt the normalization layer's mean/variance; pass
    the TRAINING split (never val/test) to avoid leakage.
    """
    norm = layers.Normalization(axis=-1, name="standardize")
    norm.adapt(train_x)  # learns per-channel mean/var from training windows

    inp = layers.Input(shape=(C.WINDOW, C.N_CHANNELS), name="imu_window")
    x = norm(inp)

    # Block 1
    x = layers.Conv1D(64, 5, padding="same", use_bias=False)(x)
    x = layers.BatchNormalization()(x)
    x = layers.ReLU()(x)
    x = layers.Conv1D(64, 5, padding="same", use_bias=False)(x)
    x = layers.BatchNormalization()(x)
    x = layers.ReLU()(x)
    x = layers.MaxPooling1D(2)(x)
    x = layers.Dropout(0.2)(x)

    # Block 2
    x = layers.Conv1D(128, 3, padding="same", use_bias=False)(x)
    x = layers.BatchNormalization()(x)
    x = layers.ReLU()(x)
    x = layers.Conv1D(128, 3, padding="same", use_bias=False)(x)
    x = layers.BatchNormalization()(x)
    x = layers.ReLU()(x)
    x = layers.MaxPooling1D(2)(x)
    x = layers.Dropout(0.3)(x)

    # Block 3
    x = layers.Conv1D(128, 3, padding="same", use_bias=False)(x)
    x = layers.BatchNormalization()(x)
    x = layers.ReLU()(x)
    x = layers.GlobalAveragePooling1D()(x)
    x = layers.Dropout(0.4)(x)

    x = layers.Dense(128, activation="relu")(x)
    x = layers.Dropout(0.4)(x)
    out = layers.Dense(C.N_CLASSES, activation="softmax", name="probs")(x)

    model = models.Model(inp, out, name="har_cnn")
    model.compile(
        optimizer=tf.keras.optimizers.Adam(C.LEARNING_RATE),
        loss="sparse_categorical_crossentropy",
        metrics=["accuracy"],
    )
    return model
