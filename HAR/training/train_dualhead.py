"""
Train the DUAL-HEAD HAR model:
  - head `probs`   : 4-way activity classifier (walking/jogging/stairs/stationary),
                     trained only on real windows.
  - head `is_real` : binary junk / fake-movement detector, trained on real (1) vs
                     the 13 non-locomotion WISDM activities (0).

This satisfies both goals at once: classification accuracy stays high (junk does
not dilute the softmax) and fake movements are explicitly rejected by the
`is_real` head.

    python train_dualhead.py --rebuild

Requires MERGE_STILL=True and INCLUDE_OTHER_CLASS=False in config.py (the 4 real
classes; junk handled by the detector head, not as a class).
"""

from __future__ import annotations

import json
import sys

import numpy as np
import tensorflow as tf
from sklearn.metrics import classification_report, confusion_matrix

import config as C
from augment import augment_batch
from data_prep import load_junk, load_segments, load_windows
from model import build_dual_head_model
from train import subject_wise_split


class DualHeadSequence(tf.keras.utils.Sequence):
    """Yields augmented batches of (X, {probs, is_real}, {sample weights})."""

    def __init__(self, x, y_cls, y_real, sw_cls, sw_real, batch_size, seed=C.SEED):
        super().__init__()
        self.x = x
        self.y_cls = y_cls
        self.y_real = y_real
        self.sw_cls = sw_cls
        self.sw_real = sw_real
        self.bs = batch_size
        self.rng = np.random.default_rng(seed)
        self.order = np.arange(len(x))
        self.rng.shuffle(self.order)

    def __len__(self):
        return int(np.ceil(len(self.x) / self.bs))

    def __getitem__(self, idx):
        sel = self.order[idx * self.bs : (idx + 1) * self.bs]
        xb = augment_batch(self.x[sel], self.rng)
        return (
            xb,
            {"probs": self.y_cls[sel], "is_real": self.y_real[sel]},
            {"probs": self.sw_cls[sel], "is_real": self.sw_real[sel]},
        )

    def on_epoch_end(self):
        self.rng.shuffle(self.order)


def tune_tau(real_isreal: np.ndarray, junk_isreal: np.ndarray) -> float:
    """Pick the is_real threshold balancing real acceptance and junk rejection."""
    best_tau, best = 0.5, -1.0
    for tau in np.round(np.arange(0.10, 0.91, 0.05), 2):
        real_accept = np.mean(real_isreal >= tau)
        junk_reject = np.mean(junk_isreal < tau) if len(junk_isreal) else 0.0
        score = 0.5 * real_accept + 0.5 * junk_reject
        if score > best:
            best, best_tau = score, float(tau)
    return best_tau


def main():
    if "--rebuild" in sys.argv:
        from data_prep import build_windows
        build_windows()

    assert C.MERGE_STILL and not C.INCLUDE_OTHER_CLASS, (
        "Dual-head expects MERGE_STILL=True and INCLUDE_OTHER_CLASS=False in config.py"
    )

    tf.keras.utils.set_random_seed(C.SEED)
    X, y, groups = load_windows()
    seg = load_segments()
    jX, jg = load_junk()
    tr, va, te, (train_s, val_s, test_s) = subject_wise_split(groups)
    print(f"Subjects -> train {len(train_s)} | val {len(val_s)} | test {len(test_s)}")

    # Real splits
    xr_tr, yr_tr = X[tr], y[tr]
    xr_va, yr_va = X[va], y[va]
    xr_te, yr_te, seg_te = X[te], y[te], seg[te]
    # Junk splits by the same held-out subjects
    j_tr = jX[np.isin(jg, list(train_s))]
    j_va = jX[np.isin(jg, list(val_s))]
    j_te = jX[np.isin(jg, list(test_s))]
    print(f"Real windows  -> train {len(xr_tr)} | val {len(xr_va)} | test {len(xr_te)}")
    print(f"Junk windows  -> train {len(j_tr)} | val {len(j_va)} | test {len(j_te)}")

    # Build combined TRAIN set (real + junk).
    x_all = np.concatenate([xr_tr, j_tr], axis=0)
    y_cls = np.concatenate([yr_tr, np.zeros(len(j_tr), np.int64)])          # junk class = dummy
    y_real = np.concatenate([np.ones(len(xr_tr)), np.zeros(len(j_tr))]).astype(np.float32)
    sw_cls = np.concatenate([np.ones(len(xr_tr)), np.zeros(len(j_tr))]).astype(np.float32)  # mask junk
    # Balance is_real head (real vs junk counts differ).
    n_pos, n_neg = len(xr_tr), max(1, len(j_tr))
    w_pos, w_neg = (n_pos + n_neg) / (2 * n_pos), (n_pos + n_neg) / (2 * n_neg)
    sw_real = np.concatenate([np.full(n_pos, w_pos), np.full(n_neg, w_neg)]).astype(np.float32)

    model = build_dual_head_model(xr_tr)

    seq = DualHeadSequence(x_all, y_cls, y_real, sw_cls, sw_real, C.BATCH_SIZE)
    val_data = (
        xr_va,  # validate classifier on real windows
        {"probs": yr_va, "is_real": np.ones(len(xr_va), np.float32)},
    )
    callbacks = [
        tf.keras.callbacks.EarlyStopping(
            monitor="val_probs_accuracy", patience=C.EARLY_STOP_PATIENCE,
            restore_best_weights=True, mode="max"
        ),
        tf.keras.callbacks.ReduceLROnPlateau(
            monitor="val_loss", factor=0.5, patience=5, min_lr=1e-5
        ),
    ]
    model.fit(seq, validation_data=val_data, epochs=C.EPOCHS, callbacks=callbacks, verbose=2)

    # ---- Evaluation ----------------------------------------------------- #
    print("\n=== TEST (held-out subjects) ===")
    out_te = model.predict(xr_te, batch_size=256, verbose=0)
    probs_te, real_te = out_te["probs"], out_te["is_real"]
    pred = probs_te.argmax(axis=1)
    cls_acc = float(np.mean(pred == yr_te))
    print(f"Classification accuracy (real test windows): {cls_acc*100:.2f}%")
    print(classification_report(yr_te, pred, target_names=C.CLASS_NAMES, digits=4))
    print("Confusion matrix (rows=true, cols=pred):")
    cm = confusion_matrix(yr_te, pred, labels=np.arange(C.N_CLASSES))
    print("        " + " ".join(f"{n[:6]:>6s}" for n in C.CLASS_NAMES))
    for i, row in enumerate(cm):
        print(f"{C.CLASS_NAMES[i][:7]:>7s} " + " ".join(f"{v:6d}" for v in row))

    # Segment-level (temporally-voted) accuracy: how the app actually behaves,
    # since an activity bout lasts many seconds. Majority-vote the per-window
    # predictions within each activity bout.
    seg_correct = seg_total = 0
    for s in np.unique(seg_te):
        m = seg_te == s
        votes = pred[m]
        voted = np.bincount(votes, minlength=C.N_CLASSES).argmax()
        true = yr_te[m][0]
        seg_total += 1
        seg_correct += int(voted == true)
    seg_acc = seg_correct / max(1, seg_total)
    print(f"Segment-level (voted) accuracy: {seg_acc*100:.2f}%  over {seg_total} bouts")

    # Tune tau on val, then report rejection on held-out test junk.
    real_va_isreal = model.predict(xr_va, batch_size=256, verbose=0)["is_real"]
    junk_va_isreal = (
        model.predict(j_va, batch_size=256, verbose=0)["is_real"] if len(j_va) else np.array([])
    )
    tau = tune_tau(real_va_isreal.ravel(), junk_va_isreal.ravel())

    junk_te_isreal = (
        model.predict(j_te, batch_size=256, verbose=0)["is_real"].ravel() if len(j_te) else np.array([])
    )
    junk_reject = float(np.mean(junk_te_isreal < tau)) if len(junk_te_isreal) else None
    real_accept = float(np.mean(real_te.ravel() >= tau))
    # End-to-end: accuracy on accepted real windows.
    acc_mask = real_te.ravel() >= tau
    e2e_acc = float(np.mean(pred[acc_mask] == yr_te[acc_mask])) if acc_mask.any() else 0.0
    print(f"\nis_real threshold tau (tuned on val): {tau}")
    print(f"Fake-movement rejection rate (held-out junk): {junk_reject*100:.1f}%")
    print(f"Real-activity acceptance (coverage):          {real_accept*100:.1f}%")
    print(f"Accuracy on accepted real windows:            {e2e_acc*100:.2f}%")

    # ---- Save artifacts ------------------------------------------------- #
    C.OUT_DIR.mkdir(parents=True, exist_ok=True)
    model.save(C.MODEL_KERAS)
    conv = tf.lite.TFLiteConverter.from_keras_model(model)
    C.MODEL_TFLITE_FLOAT.write_bytes(conv.convert())
    conv_q = tf.lite.TFLiteConverter.from_keras_model(model)
    conv_q.optimizations = [tf.lite.Optimize.DEFAULT]
    C.MODEL_TFLITE_INT8.write_bytes(conv_q.convert())
    print(f"\nSaved model + TFLite ({C.MODEL_TFLITE_FLOAT.stat().st_size/1024:.0f} KB float).")

    meta = {
        "description": "WISDM watch HAR dual-head 1D-CNN. Input is a raw IMU window "
        "in physical units; normalization is baked in. Two outputs: 4-way activity "
        "softmax + binary real-vs-junk detector.",
        "input": {
            "shape": [1, C.WINDOW, C.N_CHANNELS],
            "dtype": "float32",
            "sample_rate_hz": C.TARGET_HZ,
            "window_samples": C.WINDOW,
            "window_seconds": C.WINDOW_SEC,
            "channels": C.CHANNELS,
            "channel_units": {"accel": "m/s^2 (incl. gravity)", "gyro": "rad/s"},
            "note": "Feed 20 Hz samples (downsample the watch's 50 Hz imuHighRate "
            "to 20 Hz). Channel order fixed: ax,ay,az,gx,gy,gz.",
        },
        "outputs": {
            "probs": {"shape": [1, C.N_CLASSES], "type": "softmax", "class_names": C.CLASS_NAMES},
            "is_real": {"shape": [1, 1], "type": "sigmoid",
                        "meaning": "P(real tracked activity). Reject as junk/fake movement if < tau."},
        },
        "inference": {
            "is_real_threshold_tau": tau,
            "rule": "If is_real < tau -> reject (no confident activity). "
            "Else activity = argmax(probs).",
        },
        "metrics": {
            "test_subjects": sorted(test_s),
            "classification_accuracy": round(cls_acc, 4),
            "segment_voted_accuracy": round(seg_acc, 4),
            "fake_movement_rejection_rate": round(junk_reject, 4) if junk_reject is not None else None,
            "real_activity_coverage": round(real_accept, 4),
            "accuracy_on_accepted": round(e2e_acc, 4),
        },
    }
    C.MODEL_META_JSON.write_text(json.dumps(meta, indent=2))
    print(f"Saved meta -> {C.MODEL_META_JSON}")


if __name__ == "__main__":
    main()
