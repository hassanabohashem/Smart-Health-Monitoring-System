"""
Sanity-check that the exported dual-head TFLite model matches the Keras model.
Run after train_dualhead.py:

    python infer_test.py

Checks both heads (probs + is_real) match Keras, and prints the tensor contract
the Android side needs.
"""

from __future__ import annotations

import numpy as np
import tensorflow as tf

import config as C
import model  # noqa: F401  -- registers _derive_features for model reload
from data_prep import load_windows


def main():
    X, y, _ = load_windows()
    rng = np.random.default_rng(C.SEED)
    sel = rng.choice(len(X), size=min(500, len(X)), replace=False)
    xs, ys = X[sel], y[sel]

    # safe_mode=False: the model contains a Lambda (derived-feature) layer.
    keras_model = tf.keras.models.load_model(C.MODEL_KERAS, safe_mode=False)
    k_out = keras_model.predict(xs, verbose=0)
    k_probs, k_real = k_out["probs"], k_out["is_real"].ravel()

    interp = tf.lite.Interpreter(model_path=str(C.MODEL_TFLITE_FLOAT))
    interp.allocate_tensors()
    inp = interp.get_input_details()[0]
    outs = interp.get_output_details()
    print("TFLite input :", inp["shape"], inp["dtype"].__name__)
    # Map outputs by last-dim size: 4 => probs, 1 => is_real.
    probs_idx = next(o["index"] for o in outs if o["shape"][-1] == C.N_CLASSES)
    real_idx = next(o["index"] for o in outs if o["shape"][-1] == 1)
    for o in outs:
        print("TFLite output:", o["shape"], o["dtype"].__name__, "name=", o["name"])

    t_probs = np.zeros_like(k_probs)
    t_real = np.zeros_like(k_real)
    for i in range(len(xs)):
        interp.set_tensor(inp["index"], xs[i : i + 1].astype(np.float32))
        interp.invoke()
        t_probs[i] = interp.get_tensor(probs_idx)[0]
        t_real[i] = interp.get_tensor(real_idx)[0][0]

    probs_diff = float(np.max(np.abs(k_probs - t_probs)))
    real_diff = float(np.max(np.abs(k_real - t_real)))
    k_acc = float(np.mean(k_probs.argmax(1) == ys))
    t_acc = float(np.mean(t_probs.argmax(1) == ys))
    print(f"Max |keras-tflite| probs diff:   {probs_diff:.2e}")
    print(f"Max |keras-tflite| is_real diff: {real_diff:.2e}")
    print(f"Keras  probs accuracy: {k_acc*100:.2f}%   TFLite: {t_acc*100:.2f}%")
    assert probs_diff < 1e-3 and real_diff < 1e-3, "TFLite diverges from Keras!"
    print("OK: dual-head TFLite matches Keras.")


if __name__ == "__main__":
    main()
