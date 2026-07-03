"""
Export a single seed of the held-out v2_ens ensemble to ONNX for in-app
inference. Picks seed=202 (best val_f1=0.4839 of the 3 seeds in the
post-holdout retrain).

Output: `output/exported/cardiac_beat_classifier.onnx`
"""
import os
import sys
from pathlib import Path

import torch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from config import CHECKPOINT_DIR, BEAT_WINDOW_SAMPLES, RR_FEATURE_DIM
from models.student_cnn import build_student_model

OUT_DIR = ROOT / "output" / "exported"
OUT_DIR.mkdir(parents=True, exist_ok=True)
OUT_PATH = OUT_DIR / "cardiac_beat_classifier.onnx"

# Pick seed=202 — highest best_val_f1 among the 3 ensemble members.
CHECKPOINT = Path(CHECKPOINT_DIR) / "v2_ens_seed202.pt"


def main():
    if not CHECKPOINT.exists():
        sys.exit(f"ERROR: checkpoint not found at {CHECKPOINT}")
    print(f"Loading {CHECKPOINT.name}...")
    ck = torch.load(CHECKPOINT, map_location="cpu", weights_only=False)
    model = build_student_model(use_fv_head=False, kd_proj_dim=None, verbose=False)
    model.load_state_dict(ck["model_state_dict"], strict=False)
    model.eval()
    print(
        f"  Param count: {sum(p.numel() for p in model.parameters()):,}\n"
        f"  Best val_f1 reported in checkpoint: {ck.get('best_val_f1', 'unknown')}"
    )

    x_beat = torch.randn(1, BEAT_WINDOW_SAMPLES, 1)
    x_rr = torch.randn(1, RR_FEATURE_DIM)
    print(f"  Input shapes: beat={tuple(x_beat.shape)}, rr={tuple(x_rr.shape)}")

    # Sanity check forward pass before export
    with torch.no_grad():
        out = model(x_beat, x_rr)
        if isinstance(out, tuple):
            out = out[0]
        print(f"  Output shape: {tuple(out.shape)}  (expected (B, 4) for AAMI N/S/V/F)")

    print(f"Exporting to {OUT_PATH}...")
    torch.onnx.export(
        model,
        (x_beat, x_rr),
        str(OUT_PATH),
        input_names=["beat", "rr"],
        output_names=["logits"],
        opset_version=13,
        dynamic_axes={"beat": {0: "B"}, "rr": {0: "B"}, "logits": {0: "B"}},
    )
    size_kb = OUT_PATH.stat().st_size / 1024.0
    print(f"  ONNX written: {size_kb:.1f} KB")
    print("\nUsage from the app:")
    print("  Inputs  : beat (B, 128, 1) float32; rr (B, 4) float32")
    print("  Outputs : logits (B, 4) — AAMI classes [N, S, V, F]")


if __name__ == "__main__":
    main()
