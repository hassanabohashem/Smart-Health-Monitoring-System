"""
Deployment benchmarks: params, FP32/INT8 size, peak activation, CPU latency,
ARM Cortex-A estimated latency. Matches v1's §5.4 table schema.
"""
import os
import sys
import time
import numpy as np
import torch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from config import (DEVICE, BEAT_WINDOW_SAMPLES, RR_FEATURE_DIM,
                     ARM_LATENCY_SCALE, MAX_PARAMS, MAX_MODEL_SIZE_FP32_KB,
                     MAX_MODEL_SIZE_INT8_KB, MAX_ACTIVATION_MEMORY_KB,
                     MAX_INFERENCE_LATENCY_MS)


def count_params(model):
    return sum(p.numel() for p in model.parameters() if p.requires_grad)


def fp32_size_kb(model):
    pb = sum(p.numel() * p.element_size() for p in model.parameters())
    bb = sum(b.numel() * b.element_size() for b in model.buffers())
    return (pb + bb) / 1024.0


def int8_size_est_kb(model):
    """Rough est: FP32 / 4 (per-channel weight quant + small scale overhead)."""
    return fp32_size_kb(model) / 4.0


def peak_activation_kb(model, input_shapes=None, batch_size=1):
    """Hook-based peak activation measurement (all layers, largest tensor)."""
    if input_shapes is None:
        input_shapes = [(batch_size, BEAT_WINDOW_SAMPLES, 1),
                         (batch_size, RR_FEATURE_DIM)]

    peaks = [0]

    def hook(mod, inp, out):
        def _size(t):
            if isinstance(t, torch.Tensor):
                return t.numel() * t.element_size()
            return 0
        if isinstance(out, torch.Tensor):
            peaks[0] = max(peaks[0], _size(out))
        elif isinstance(out, (list, tuple)):
            for t in out:
                if isinstance(t, torch.Tensor):
                    peaks[0] = max(peaks[0], _size(t))

    handles = []
    for m in model.modules():
        if len(list(m.children())) == 0:
            handles.append(m.register_forward_hook(hook))

    model.eval()
    x_beat = torch.randn(*input_shapes[0])
    x_rr = torch.randn(*input_shapes[1])
    with torch.no_grad():
        try:
            model(x_beat, x_rr)
        except TypeError:
            model(x_beat)

    for h in handles:
        h.remove()
    return peaks[0] / 1024.0


def cpu_latency_ms(model, n_iter=200, warmup=20):
    """Batch-1 CPU inference latency: median / p95 / p99."""
    model = model.cpu().eval()
    x_beat = torch.randn(1, BEAT_WINDOW_SAMPLES, 1)
    x_rr = torch.randn(1, RR_FEATURE_DIM)

    with torch.no_grad():
        for _ in range(warmup):
            try: model(x_beat, x_rr)
            except TypeError: model(x_beat)

        times = []
        for _ in range(n_iter):
            t0 = time.perf_counter()
            try: model(x_beat, x_rr)
            except TypeError: model(x_beat)
            times.append((time.perf_counter() - t0) * 1000)

    arr = np.asarray(times)
    return {
        'cpu_median_ms': float(np.median(arr)),
        'cpu_mean_ms': float(arr.mean()),
        'cpu_p95_ms': float(np.percentile(arr, 95)),
        'cpu_p99_ms': float(np.percentile(arr, 99)),
    }


def full_benchmark(model, verbose=True):
    """Returns dict with all deployment metrics and PASS/FAIL flags."""
    params = count_params(model)
    fp32_kb = fp32_size_kb(model)
    int8_kb = int8_size_est_kb(model)
    act_kb = peak_activation_kb(model)
    lat = cpu_latency_ms(model)
    arm_med = lat['cpu_median_ms'] * ARM_LATENCY_SCALE
    arm_p95 = lat['cpu_p95_ms'] * ARM_LATENCY_SCALE

    result = {
        'total_params': params,
        'trainable_params': params,
        'fp32_size_kb': fp32_kb,
        'int8_size_kb_est': int8_kb,
        'peak_activation_kb': act_kb,
        **lat,
        'arm_estimated_median_ms': arm_med,
        'arm_estimated_p95_ms': arm_p95,
        'pass_params': params < MAX_PARAMS,
        'pass_fp32_size': fp32_kb < MAX_MODEL_SIZE_FP32_KB,
        'pass_int8_size': int8_kb < MAX_MODEL_SIZE_INT8_KB,
        'pass_activation': act_kb < MAX_ACTIVATION_MEMORY_KB,
        'pass_latency': arm_med < MAX_INFERENCE_LATENCY_MS,
    }

    if verbose:
        print(f"\n--- Deployment benchmark ---")
        print(f"  Parameters:            {params:,}  ({'PASS' if result['pass_params'] else 'FAIL'})")
        print(f"  Model size (FP32):     {fp32_kb:.1f} KB  ({'PASS' if result['pass_fp32_size'] else 'FAIL'})")
        print(f"  Est INT8 size:         {int8_kb:.1f} KB  ({'PASS' if result['pass_int8_size'] else 'FAIL'})")
        print(f"  Peak activation:       {act_kb:.1f} KB  ({'PASS' if result['pass_activation'] else 'FAIL'})")
        print(f"  CPU latency (median):  {lat['cpu_median_ms']:.3f} ms")
        print(f"  CPU latency (p95):     {lat['cpu_p95_ms']:.3f} ms")
        print(f"  ARM est (median):      {arm_med:.3f} ms  ({'PASS' if result['pass_latency'] else 'FAIL'})")
    return result
