"""
ONNX smoke test — validate the three bundled models load, expose the input
names the React-Native adapters expect, and produce output of the expected
shape on dummy input.

Run from project root:
    /d/GP-IMP/Cardiac/venv/Scripts/python.exe smart-health-54/scripts/onnx_smoke_test.py
"""
import os
import sys
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort

ROOT = Path(__file__).resolve().parents[1]
MODELS = ROOT / "src" / "assets" / "models"


def check(model_name: str, expected_inputs: dict, expected_output_shape: tuple,
          adapter_input_names: list[str]):
    path = MODELS / model_name
    print(f"\n{'=' * 72}")
    print(f"  {model_name}")
    print(f"{'=' * 72}")
    if not path.exists():
        print(f"  ❌ FILE MISSING at {path}")
        return False
    print(f"  Path: {path}  ({path.stat().st_size / 1024:.1f} KB)")

    # Validate ONNX structure
    try:
        proto = onnx.load(str(path))
        onnx.checker.check_model(proto)
        print(f"  ✅ ONNX structure valid (opset={proto.opset_import[0].version})")
    except Exception as e:
        print(f"  ❌ ONNX checker failed: {e}")
        return False

    # Inspect input/output names
    sess = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    actual_inputs = {i.name: list(i.shape) for i in sess.get_inputs()}
    actual_outputs = {o.name: list(o.shape) for o in sess.get_outputs()}
    print(f"  Inputs:  {actual_inputs}")
    print(f"  Outputs: {actual_outputs}")

    # Verify input names match adapter expectations
    print(f"  Adapter expects input names: {adapter_input_names}")
    missing = [n for n in adapter_input_names if n not in actual_inputs]
    extra = [n for n in actual_inputs if n not in adapter_input_names]
    if missing:
        print(f"  ❌ Adapter expects names that don't exist in model: {missing}")
        return False
    if extra:
        print(f"  ⚠️  Model has extra inputs the adapter doesn't feed: {extra}")
    else:
        print(f"  ✅ Input names match adapter")

    # Run forward pass with dummy data
    feeds = {}
    for name, shape_template in expected_inputs.items():
        # Replace dynamic dims (str) with concrete batch=1
        concrete = [1 if isinstance(d, str) else d for d in shape_template]
        feeds[name] = np.random.randn(*concrete).astype(np.float32)
        print(f"  Feed '{name}' shape: {concrete}")

    try:
        out = sess.run(None, feeds)
        out_shape = tuple(out[0].shape)
        print(f"  Output shape: {out_shape}  (expected {expected_output_shape})")
        if out_shape == expected_output_shape:
            print(f"  ✅ Forward pass succeeded with expected output shape")
            return True
        else:
            print(f"  ❌ Output shape mismatch")
            return False
    except Exception as e:
        print(f"  ❌ Forward pass failed: {e}")
        return False


def check_har() -> bool:
    """WISDM dual-head HAR: 1 raw input [*,200,6] -> probs(1,4) + is_real(1,1)."""
    name = "har_model.onnx"
    path = MODELS / name
    print(f"\n{'=' * 72}\n  {name} (WISDM dual-head)\n{'=' * 72}")
    if not path.exists():
        print(f"  ❌ FILE MISSING at {path}")
        return False
    print(f"  Path: {path}  ({path.stat().st_size / 1024:.1f} KB)")
    try:
        proto = onnx.load(str(path))
        onnx.checker.check_model(proto)
        print(f"  ✅ ONNX structure valid (opset={proto.opset_import[0].version})")
    except Exception as e:
        print(f"  ❌ ONNX checker failed: {e}")
        return False
    sess = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    ins = {i.name: list(i.shape) for i in sess.get_inputs()}
    outs = {o.name: list(o.shape) for o in sess.get_outputs()}
    print(f"  Inputs:  {ins}")
    print(f"  Outputs: {outs}")
    if len(ins) != 1:
        print(f"  ❌ expected exactly 1 input, got {len(ins)}")
        return False
    in_name, in_shape = next(iter(ins.items()))
    if list(in_shape)[-2:] != [200, 6]:
        print(f"  ❌ input tail expected [200, 6], got {in_shape}")
        return False
    print(f"  ✅ single input '{in_name}' [*,200,6] (adapter binds inputNames[0])")
    feed = {in_name: np.random.randn(1, 200, 6).astype(np.float32)}
    try:
        out = sess.run(None, feed)
        shapes = sorted(tuple(o.shape) for o in out)
        print(f"  Output shapes: {shapes}")
        if shapes == [(1, 1), (1, 4)]:
            print("  ✅ dual-head forward pass OK: is_real(1,1) + probs(1,4)")
            return True
        print(f"  ❌ expected [(1, 1), (1, 4)], got {shapes}")
        return False
    except Exception as e:
        print(f"  ❌ Forward pass failed: {e}")
        return False


def main():
    results = {}

    # Cardiac: beat (1,128,1) + rr (1,4) → logits (1,4)
    results["cardiac"] = check(
        "cardiac_beat_classifier.onnx",
        expected_inputs={"beat": [1, 128, 1], "rr": [1, 4]},
        expected_output_shape=(1, 4),
        adapter_input_names=["beat", "rr"],
    )

    # Fall: imu (1,6,200) + baro (1,1,200) → logits (1,2)
    results["fall"] = check(
        "fusion_net_wrist.onnx",
        expected_inputs={"imu_input": [1, 6, 200], "baro_input": [1, 1, 200]},
        expected_output_shape=(1, 2),
        adapter_input_names=["imu_input", "baro_input"],
    )

    # HAR (WISDM dual-head): single raw input [*,200,6] → two heads,
    # probs (1,4) + is_real (1,1). The adapter binds to inputNames[0] and
    # disambiguates outputs by length, so we just verify that contract.
    results["har"] = check_har()

    print("\n" + "=" * 72)
    print("  SUMMARY")
    print("=" * 72)
    for k, v in results.items():
        print(f"  {k:10s}  {'PASS' if v else 'FAIL'}")

    return 0 if all(results.values()) else 1


if __name__ == "__main__":
    import argparse
    p = argparse.ArgumentParser()
    p.add_argument("--har-only", action="store_true")
    args = p.parse_args()

    if args.har_only:
        path = MODELS / "har_model.onnx"
        sess = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
        names = {i.name: list(i.shape) for i in sess.get_inputs()}
        print(f"HAR inputs: {names}")
        feeds = {}
        for name, shape in names.items():
            concrete = [1 if isinstance(d, str) else d for d in shape]
            feeds[name] = np.random.randn(*concrete).astype(np.float32)
        out = sess.run(None, feeds)
        print(f"HAR output shape: {out[0].shape}")
        sys.exit(0)

    sys.exit(main())
