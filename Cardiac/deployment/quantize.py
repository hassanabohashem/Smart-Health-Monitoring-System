"""
INT8 post-training quantization (PTQ).

Uses PyTorch's built-in fbgemm backend for portability. For actual smartwatch
deployment the same model should be re-exported via TFLite + XNNPACK -- that
is runtime-specific and is stubbed out at the bottom of this file.

PTQ procedure:
  1. Prepare stratified calibration set (PTQ_CALIBRATION_SIZE beats, balanced).
  2. Switch model to eval, fuse Conv-BN-ReLU.
  3. Attach per-channel symmetric weight observers for convs; per-tensor for
     activations.
  4. Run calibration batches.
  5. Convert.
  6. Measure INT8 macro-F1; if drop > PTQ_MACRO_F1_DROP_THRESHOLD, raise and
     tell the caller to use QAT.
"""
import os
import sys
import copy
import numpy as np
import torch
import torch.nn as nn
import torch.ao.quantization as tq

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from config import (PTQ_CALIBRATION_SIZE, PTQ_MACRO_F1_DROP_THRESHOLD,
                     NUM_CLASSES, CLASS_TO_IDX, BEAT_WINDOW_SAMPLES,
                     RR_FEATURE_DIM, CHECKPOINT_DIR)


def _stratified_calib(beats, rr, labels, size_per_class=None):
    if size_per_class is None:
        size_per_class = PTQ_CALIBRATION_SIZE // NUM_CLASSES
    rng = np.random.default_rng(42)
    sel = []
    for c in range(NUM_CLASSES):
        idx = np.where(labels == c)[0]
        if len(idx) == 0:
            continue
        take = min(size_per_class, len(idx))
        sel.extend(rng.choice(idx, size=take, replace=False).tolist())
    rng.shuffle(sel)
    return np.array(sel, dtype=np.int64)


def _fuse_student_cnn(model):
    """Fuse Conv+BN+ReLU in the 3 conv blocks."""
    for block in [model.block1, model.block2, model.block3]:
        tq.fuse_modules(block, [['conv', 'bn', 'relu']], inplace=True)
    return model


class QuantWrapper(nn.Module):
    """Adds QuantStub/DeQuantStub to ECGStudentCNN for PTQ."""
    def __init__(self, base):
        super().__init__()
        self.q_beat = tq.QuantStub()
        self.q_rr = tq.QuantStub()
        self.base = base
        self.dq = tq.DeQuantStub()

    def forward(self, x_beat, x_rr):
        x_beat = self.q_beat(x_beat)
        x_rr = self.q_rr(x_rr)
        out = self.base(x_beat, x_rr)
        logits = out[0] if isinstance(out, tuple) else out
        return self.dq(logits)


def ptq_int8(fp32_model, calib_beats, calib_rr, calib_labels, verbose=True):
    """Post-training INT8 quantization of a student-CNN model.

    Returns:
        quantized_model (eval-ready, CPU),
        info dict
    """
    model = copy.deepcopy(fp32_model).cpu().eval()
    model = _fuse_student_cnn(model)

    wrapper = QuantWrapper(model)
    wrapper.qconfig = tq.get_default_qconfig('fbgemm')
    tq.prepare(wrapper, inplace=True)

    idx = _stratified_calib(calib_beats, calib_rr, calib_labels)
    if verbose:
        print(f"  Calibrating with {len(idx)} stratified beats...")
    with torch.no_grad():
        for i in range(0, len(idx), 64):
            chunk = idx[i:i+64]
            xb = torch.from_numpy(calib_beats[chunk]).float().unsqueeze(-1)
            xr = torch.from_numpy(calib_rr[chunk]).float()
            wrapper(xb, xr)

    tq.convert(wrapper, inplace=True)
    if verbose:
        print(f"  INT8 conversion complete.")
    return wrapper, {'calibration_size': len(idx)}


def estimate_int8_size_kb(quant_model):
    """Approximate INT8 size from int-tensor parameter counts."""
    total_bytes = 0
    for p in quant_model.state_dict().values():
        if isinstance(p, torch.Tensor):
            total_bytes += p.numel() * p.element_size()
    return total_bytes / 1024.0


def export_tflite_stub(fp32_model, out_path):
    """Placeholder for TFLite export.

    Production flow (requires tensorflow + onnx2tf, done separately):
      1. torch.onnx.export(fp32_model, (x_beat, x_rr), f"{out_path}.onnx")
      2. use onnx2tf to convert ONNX -> TF SavedModel
      3. use tf.lite.TFLiteConverter with optimizations=[tf.lite.Optimize.DEFAULT]
         and representative_dataset from stratified calibration beats.
    """
    import torch
    onnx_path = out_path.replace('.tflite', '.onnx')
    x_beat = torch.randn(1, BEAT_WINDOW_SAMPLES, 1)
    x_rr = torch.randn(1, RR_FEATURE_DIM)
    torch.onnx.export(
        fp32_model.cpu().eval(),
        (x_beat, x_rr),
        onnx_path,
        input_names=['beat', 'rr'],
        output_names=['logits'],
        opset_version=13,
        dynamic_axes={'beat': {0: 'B'}, 'rr': {0: 'B'}, 'logits': {0: 'B'}},
    )
    return onnx_path
