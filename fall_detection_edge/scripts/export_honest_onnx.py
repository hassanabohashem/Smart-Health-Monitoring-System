"""
Export the honest-trained wrist FusionNet to a single-file ONNX
(no external `.onnx.data` companion) so the React-Native app can
bundle it as a single asset.
"""
import os, sys
from pathlib import Path

import torch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from models.fusion_model import BarometerFusionNet

CKPT = ROOT / "models" / "fusion" / "FusionNet_Wrist_honest.pth"
OUT_DIR = ROOT / "models" / "onnx"
OUT_DIR.mkdir(parents=True, exist_ok=True)
OUT = OUT_DIR / "FusionNet_Wrist_honest.onnx"


def main():
    if not CKPT.exists():
        sys.exit(f"ERROR: checkpoint not found at {CKPT}")
    print(f"Loading {CKPT.name}...")
    state = torch.load(CKPT, map_location="cpu", weights_only=True)
    model = BarometerFusionNet(imu_channels=6, baro_channels=1)
    model.load_state_dict(state)
    model.eval()
    n_params = sum(p.numel() for p in model.parameters())
    print(f"  Parameters: {n_params:,}")

    # Dummy inputs matching production shape: (1, 6, 200) IMU, (1, 1, 200) baro
    imu = torch.randn(1, 6, 200)
    baro = torch.randn(1, 1, 200)
    with torch.no_grad():
        out = model(imu, baro)
        print(f"  Output shape: {tuple(out.shape)}  (expected (B, 2))")

    print(f"Exporting to {OUT}...")
    torch.onnx.export(
        model,
        (imu, baro),
        str(OUT),
        input_names=["imu_input", "baro_input"],
        output_names=["fall_logits"],
        opset_version=13,
        dynamo=False,
        dynamic_axes={
            "imu_input": {0: "B"},
            "baro_input": {0: "B"},
            "fall_logits": {0: "B"},
        },
    )
    size_kb = OUT.stat().st_size / 1024.0
    print(f"  ONNX written: {size_kb:.1f} KB")
    if OUT.with_suffix(".onnx.data").exists():
        print("  WARNING: external `.onnx.data` file was created — model is too large for single-file export.")
    else:
        print("  Single-file ONNX (no external data companion) — bundleable as one asset.")


if __name__ == "__main__":
    main()
