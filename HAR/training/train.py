"""
Train the HAR 1D-CNN with an honest subject-wise split, evaluate, and export to
TFLite (float + dynamic-range int8) plus a metadata JSON that is the input/output
contract for the Android side.

    python train.py                # uses cached windows (builds them if missing)
    python train.py --rebuild      # force-rebuild the window cache first

Reproducible: all randomness is seeded from config.SEED.
"""

from __future__ import annotations

import json
import sys

import numpy as np
import tensorflow as tf
from sklearn.metrics import classification_report, confusion_matrix
from sklearn.utils.class_weight import compute_class_weight

import config as C
from augment import AugmentedSequence
from data_prep import load_junk, load_windows
from model import build_model


def subject_wise_split(groups: np.ndarray):
    """Split SUBJECTS (not windows) into train/val/test. Returns boolean masks."""
    rng = np.random.default_rng(C.SEED)
    subjects = np.array(sorted(set(groups.tolist())))
    rng.shuffle(subjects)

    n = len(subjects)
    n_test = max(1, int(round(n * C.TEST_SUBJECT_FRACTION)))
    n_val = max(1, int(round(n * C.VAL_SUBJECT_FRACTION)))
    test_s = set(subjects[:n_test].tolist())
    val_s = set(subjects[n_test : n_test + n_val].tolist())
    train_s = set(subjects[n_test + n_val :].tolist())

    train_mask = np.isin(groups, list(train_s))
    val_mask = np.isin(groups, list(val_s))
    test_mask = np.isin(groups, list(test_s))
    return train_mask, val_mask, test_mask, (train_s, val_s, test_s)


def export_tflite(model: tf.keras.Model, x_repr: np.ndarray):
    """Export float and dynamic-range int8 TFLite models."""
    conv = tf.lite.TFLiteConverter.from_keras_model(model)
    C.MODEL_TFLITE_FLOAT.write_bytes(conv.convert())

    conv_q = tf.lite.TFLiteConverter.from_keras_model(model)
    conv_q.optimizations = [tf.lite.Optimize.DEFAULT]
    C.MODEL_TFLITE_INT8.write_bytes(conv_q.convert())

    print(f"  float TFLite: {C.MODEL_TFLITE_FLOAT.stat().st_size/1024:.0f} KB")
    print(f"  int8  TFLite: {C.MODEL_TFLITE_INT8.stat().st_size/1024:.0f} KB")


def tune_threshold(
    real_probs: np.ndarray, real_y: np.ndarray, junk_probs: np.ndarray
) -> float:
    """Pick the confidence threshold balancing two goals on the validation set:
      - accept & correctly classify real-activity windows (useful coverage)
      - reject junk / fake-movement windows (the held-out non-locomotion set)

    Score = 0.5 * (real windows accepted AND correct) + 0.5 * (junk rejected).
    """
    real_pred = real_probs.argmax(axis=1)
    real_max = real_probs.max(axis=1)
    junk_max = junk_probs.max(axis=1) if len(junk_probs) else np.array([1.0])

    best_thr, best_score = C.DEFAULT_CONFIDENCE_THRESHOLD, -1.0
    for thr in np.round(np.arange(0.30, 0.96, 0.05), 2):
        useful_accept = np.mean((real_max >= thr) & (real_pred == real_y))
        junk_reject = np.mean(junk_max < thr)
        score = 0.5 * useful_accept + 0.5 * junk_reject
        if score > best_score:
            best_score, best_thr = score, float(thr)
    return best_thr


def main():
    if "--rebuild" in sys.argv:
        from data_prep import build_windows

        build_windows()

    tf.keras.utils.set_random_seed(C.SEED)

    X, y, groups = load_windows()
    junk_X, junk_g = load_junk()
    tr, va, te, (train_s, val_s, test_s) = subject_wise_split(groups)
    print(f"Subjects -> train {len(train_s)} | val {len(val_s)} | test {len(test_s)}")
    print(f"Windows  -> train {tr.sum()} | val {va.sum()} | test {te.sum()}")

    x_train, y_train = X[tr], y[tr]
    x_val, y_val = X[va], y[va]
    x_test, y_test = X[te], y[te]

    # Junk windows split by the SAME held-out subjects (never used in training).
    junk_val = junk_X[np.isin(junk_g, list(val_s))]
    junk_test = junk_X[np.isin(junk_g, list(test_s))]

    model = build_model(x_train)
    model.summary()

    weights = compute_class_weight(
        "balanced", classes=np.arange(C.N_CLASSES), y=y_train
    )
    class_weight = {i: float(w) for i, w in enumerate(weights)}
    print("Class weights:", {C.CLASS_NAMES[i]: round(w, 2) for i, w in class_weight.items()})

    train_seq = AugmentedSequence(x_train, y_train, C.BATCH_SIZE, augment=True)

    callbacks = [
        tf.keras.callbacks.EarlyStopping(
            monitor="val_accuracy", patience=C.EARLY_STOP_PATIENCE,
            restore_best_weights=True, mode="max"
        ),
        tf.keras.callbacks.ReduceLROnPlateau(
            monitor="val_loss", factor=0.5, patience=5, min_lr=1e-5
        ),
    ]

    model.fit(
        train_seq,
        validation_data=(x_val, y_val),
        epochs=C.EPOCHS,
        class_weight=class_weight,
        callbacks=callbacks,
        verbose=2,
    )

    # ---- Evaluation on held-out subjects -------------------------------- #
    print("\n=== TEST (held-out subjects) ===")
    test_probs = model.predict(x_test, batch_size=256, verbose=0)
    test_pred = test_probs.argmax(axis=1)
    test_acc = float(np.mean(test_pred == y_test))
    print(f"Overall 6-class accuracy: {test_acc*100:.2f}%")
    print(classification_report(y_test, test_pred, target_names=C.CLASS_NAMES, digits=4))
    print("Confusion matrix (rows=true, cols=pred):")
    print("        " + " ".join(f"{n[:6]:>6s}" for n in C.CLASS_NAMES))
    cm = confusion_matrix(y_test, test_pred, labels=np.arange(C.N_CLASSES))
    for i, row in enumerate(cm):
        print(f"{C.CLASS_NAMES[i][:7]:>7s} " + " ".join(f"{v:6d}" for v in row))

    # Locomotion-only accuracy (excludes the 'other' reject class) — the number
    # users actually feel when doing a real activity.
    loco_mask = y_test != C.CLASS_TO_IDX.get(C.OTHER_CLASS, -1)
    loco_acc = float(np.mean(test_pred[loco_mask] == y_test[loco_mask]))
    print(f"Locomotion-only accuracy (5 classes): {loco_acc*100:.2f}%")

    # ---- Confidence threshold + fake-movement rejection ----------------- #
    val_probs = model.predict(x_val, batch_size=256, verbose=0)
    val_junk_probs = (
        model.predict(junk_val, batch_size=256, verbose=0)
        if len(junk_val) else np.empty((0, C.N_CLASSES), np.float32)
    )
    thr = tune_threshold(val_probs, y_val, val_junk_probs)
    print(f"\nTuned confidence threshold (on val): {thr}")

    # Rejection metrics on the HELD-OUT TEST junk (fake movements the model was
    # never trained on): how often is junk correctly rejected?
    junk_reject_rate = None
    if len(junk_test):
        junk_test_probs = model.predict(junk_test, batch_size=256, verbose=0)
        junk_reject_rate = float(np.mean(junk_test_probs.max(axis=1) < thr))
        # Coverage: fraction of real test activities still accepted at this thr.
        real_accept = float(np.mean(test_probs.max(axis=1) >= thr))
        # Accuracy on the real windows that ARE accepted.
        acc_mask = test_probs.max(axis=1) >= thr
        acc_when_accepted = (
            float(np.mean(test_pred[acc_mask] == y_test[acc_mask])) if acc_mask.any() else 0.0
        )
        print(f"Fake-movement rejection rate (held-out junk): {junk_reject_rate*100:.1f}%")
        print(f"Real-activity acceptance (coverage) at thr:   {real_accept*100:.1f}%")
        print(f"Accuracy on accepted real windows:            {acc_when_accepted*100:.2f}%")

    # ---- Save artifacts ------------------------------------------------- #
    C.OUT_DIR.mkdir(parents=True, exist_ok=True)
    model.save(C.MODEL_KERAS)
    print(f"\nSaved Keras model -> {C.MODEL_KERAS}")
    export_tflite(model, x_train[:256])

    meta = {
        "description": "WISDM watch HAR 1D-CNN. Input is a raw IMU window in "
        "physical units; normalization is baked into the model.",
        "input": {
            "shape": [1, C.WINDOW, C.N_CHANNELS],
            "dtype": "float32",
            "sample_rate_hz": C.TARGET_HZ,
            "window_samples": C.WINDOW,
            "window_seconds": C.WINDOW_SEC,
            "channels": C.CHANNELS,
            "channel_units": {"accel": "m/s^2 (incl. gravity)", "gyro": "rad/s"},
            "note": "Channel order is fixed: ax,ay,az,gx,gy,gz. Feed 20 Hz samples "
            "(downsample the watch's 50 Hz imuHighRate to 20 Hz first).",
        },
        "output": {
            "shape": [1, C.N_CLASSES],
            "dtype": "float32",
            "type": "softmax probabilities",
            "class_names": C.CLASS_NAMES,
        },
        "inference": {
            "argmax_then_reject": True,
            "confidence_threshold": thr,
            "reject_rule": "If argmax class == 'other' OR max_prob < threshold, "
            "report no confident activity (uncertain).",
        },
        "metrics": {
            "test_subjects": sorted(test_s),
            "overall_accuracy": round(test_acc, 4),
            "locomotion_accuracy": round(loco_acc, 4),
            "fake_movement_rejection_rate": (
                round(junk_reject_rate, 4) if junk_reject_rate is not None else None
            ),
        },
    }
    C.MODEL_META_JSON.write_text(json.dumps(meta, indent=2))
    print(f"Saved meta  -> {C.MODEL_META_JSON}")


if __name__ == "__main__":
    main()
