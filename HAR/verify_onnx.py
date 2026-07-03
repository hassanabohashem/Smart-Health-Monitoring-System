"""Verify the tf2onnx-converted har_wisdm.onnx matches the shipped TFLite
numerically (same input -> same outputs), and print the ONNX I/O contract."""
import numpy as np
import onnxruntime as ort
import tensorflow as tf

import os
ROOT = os.path.dirname(os.path.abspath(__file__))
ONNX = os.path.join(ROOT, "har_wisdm.onnx")
TFL = os.path.join(ROOT, "android", "har_model_float.tflite")

sess = ort.InferenceSession(ONNX, providers=["CPUExecutionProvider"])
print("ONNX INPUTS :", [(i.name, i.shape, i.type) for i in sess.get_inputs()])
print("ONNX OUTPUTS:", [(o.name, o.shape, o.type) for o in sess.get_outputs()])
in_name = sess.get_inputs()[0].name

# Random raw-unit window [1,200,6]: accel ~m/s^2, gyro ~rad/s. (Distribution
# is irrelevant for a conversion-fidelity check — both models get the same x.)
rng = np.random.default_rng(0)
x = np.concatenate([
    rng.uniform(-12, 12, (1, 200, 3)),  # ax,ay,az
    rng.uniform(-5, 5, (1, 200, 3)),    # gx,gy,gz
], axis=-1).astype(np.float32)

onnx_out = sess.run(None, {in_name: x})

interp = tf.lite.Interpreter(model_path=TFL)
interp.allocate_tensors()
inp = interp.get_input_details()[0]
interp.set_tensor(inp["index"], x)
interp.invoke()
tfl_out = [interp.get_tensor(o["index"]) for o in interp.get_output_details()]

def by_shape(outs):
    return {tuple(np.asarray(o).shape): np.asarray(o) for o in outs}

oo, ot = by_shape(onnx_out), by_shape(tfl_out)
print("\nshapes -> onnx:", list(oo), " tflite:", list(ot))
worst = 0.0
for shp in oo:
    if shp in ot:
        d = float(np.max(np.abs(oo[shp] - ot[shp])))
        worst = max(worst, d)
        tag = "probs(softmax-4)" if shp[-1] == 4 else "is_real(sigmoid)" if shp[-1] == 1 else "?"
        print(f"  {shp} {tag}: max|onnx-tflite|={d:.2e}  onnx={oo[shp].ravel()[:4]}  tfl={ot[shp].ravel()[:4]}")
print(f"\nWORST DIFF = {worst:.2e}  =>", "MATCH (faithful)" if worst < 1e-3 else "MISMATCH - investigate")
