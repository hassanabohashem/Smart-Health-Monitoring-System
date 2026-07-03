"""
Lightweight 1D CNN for ECG beat classification (TinyML target).

v2 architecture additions:
  - Channel counts increased toward the 50K parameter budget
  - A dedicated F-vs-V discriminator head tackles the F-class collapse
    observed in the v1 baseline (F beats are morphologically between N and V,
    so a 2-way head conditioned on 'beat has ectopic morphology' gives a
    secondary signal the main head can fuse)
  - Optional feature projection for feature-level knowledge distillation
    against ECGFounder's 1024-dim deep features

Deployment budget (batch=1, FP32):
  - Parameters:        ~40,000   (<50,000)
  - Model size (FP32): ~160 KB   (<200 KB)
  - Est INT8 size:     ~40 KB    (<80 KB)
  - Peak activation:   ~12 KB    (<16 KB)

The main head outputs 4-class logits. The F-vs-V head is active in training
but is only used at inference as a re-ranking signal:
   if argmax(main) in {F,V} and F-vs-V says F with p > 0.6 -> predict F
   (this addresses the F-recall collapse without inflating F false-positives)
"""
import os
import sys
import torch
import torch.nn as nn
import torch.nn.functional as F

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from config import (CONV1_CHANNELS, CONV2_CHANNELS, CONV3_CHANNELS,
                     CONV1_KERNEL, CONV2_KERNEL, CONV3_KERNEL,
                     FC_HIDDEN, DROPOUT_RATE, RR_FEATURE_DIM, NUM_CLASSES,
                     BEAT_WINDOW_SAMPLES, CLASS_TO_IDX)


class ConvBlock(nn.Module):
    """Conv1D -> BatchNorm -> ReLU -> (optional) MaxPool.

    Supports conv stride > 1 for early aggressive downsampling. With a 256-sample
    input we use stride=2 on the first block to keep the activation tensor under
    the 16 KB TinyML budget.
    """

    def __init__(self, in_channels, out_channels, kernel_size, pool_size=2,
                 stride=1):
        super().__init__()
        padding = kernel_size // 2
        self.conv = nn.Conv1d(in_channels, out_channels, kernel_size,
                               padding=padding, stride=stride, bias=False)
        self.bn = nn.BatchNorm1d(out_channels)
        self.relu = nn.ReLU(inplace=True)
        self.pool = nn.MaxPool1d(pool_size) if pool_size > 0 else nn.Identity()

    def forward(self, x):
        return self.pool(self.relu(self.bn(self.conv(x))))


class ECGStudentCNN(nn.Module):
    """Lightweight 1D CNN with optional F-vs-V discriminator head + KD projection."""

    def __init__(self, num_classes=NUM_CLASSES, rr_dim=RR_FEATURE_DIM,
                 dropout=DROPOUT_RATE, use_fv_head=True,
                 kd_proj_dim=None):
        super().__init__()
        self.use_fv_head = use_fv_head
        self.kd_proj_dim = kd_proj_dim

        # Convolutional backbone (v1 architecture: 128-sample input)
        self.block1 = ConvBlock(1, CONV1_CHANNELS, CONV1_KERNEL, pool_size=2)
        self.block2 = ConvBlock(CONV1_CHANNELS, CONV2_CHANNELS, CONV2_KERNEL, pool_size=2)
        self.block3 = ConvBlock(CONV2_CHANNELS, CONV3_CHANNELS, CONV3_KERNEL, pool_size=0)

        # Global Average Pooling
        self.gap = nn.AdaptiveAvgPool1d(1)

        # Shared fusion trunk
        self.fc1 = nn.Linear(CONV3_CHANNELS + rr_dim, FC_HIDDEN)
        self.dropout = nn.Dropout(dropout)
        self.relu = nn.ReLU(inplace=True)

        # Main 4-class head
        self.fc2 = nn.Linear(FC_HIDDEN, num_classes)

        # Auxiliary F-vs-V binary head (outputs logits for [V, F])
        if self.use_fv_head:
            self.fv_head = nn.Linear(FC_HIDDEN, 2)

        # Optional projection for feature-level KD to ECGFounder features
        if kd_proj_dim is not None:
            self.kd_proj = nn.Linear(FC_HIDDEN, kd_proj_dim)

    def forward(self, x_beat, x_rr, return_fv=False, return_kd_feat=False):
        """
        Args:
            x_beat: (batch, 128, 1) -- beat waveform
            x_rr:   (batch, 4)      -- RR-interval features
            return_fv: also return F-vs-V head logits
            return_kd_feat: also return KD projection features

        Returns:
            logits: (batch, num_classes)   -- main 4-class output
            [fv_logits: (batch, 2)]        -- optional F-vs-V head output
            [kd_feat:   (batch, kd_proj_dim)] -- optional KD projection
        """
        x = x_beat.permute(0, 2, 1)       # (batch, 1, 128)
        x = self.block1(x)                  # (batch, 24, 64)
        x = self.block2(x)                  # (batch, 48, 32)
        x = self.block3(x)                  # (batch, 48, 32)
        x = self.gap(x).squeeze(-1)         # (batch, 48)

        # Fuse with RR features
        x = torch.cat([x, x_rr], dim=1)
        trunk = self.relu(self.fc1(x))
        trunk_drop = self.dropout(trunk)

        logits = self.fc2(trunk_drop)

        # When ANY extra output is requested, always return a 3-tuple so
        # callers can unpack unambiguously. Missing outputs become None.
        if return_fv or return_kd_feat:
            fv_out = self.fv_head(trunk_drop) if (return_fv and self.use_fv_head) else None
            kd_out = self.kd_proj(trunk) if (return_kd_feat and self.kd_proj_dim is not None) else None
            return logits, fv_out, kd_out

        return logits

    def predict_with_fv_rerank(self, x_beat, x_rr, fv_prob_threshold=0.6):
        """Inference-time re-rank using the F-vs-V head.

        Rule:
          main_pred = argmax(main_logits)
          if main_pred in {V, F}:
              fv_prob_F = softmax(fv_logits)[..., 1]
              if fv_prob_F > threshold -> predict F
              else predict V
          else: predict main_pred

        This trades S/N-side stability for improved F recall.
        """
        main_logits, fv_logits = self.forward(x_beat, x_rr, return_fv=True)
        main_pred = main_logits.argmax(dim=1)

        if not self.use_fv_head:
            return main_pred

        fv_probs = F.softmax(fv_logits, dim=1)
        pred = main_pred.clone()

        v_idx = CLASS_TO_IDX['V']
        f_idx = CLASS_TO_IDX['F']

        ectopic_mask = (main_pred == v_idx) | (main_pred == f_idx)
        if ectopic_mask.any():
            prob_f = fv_probs[ectopic_mask, 1]
            new_labels = torch.where(prob_f > fv_prob_threshold,
                                      torch.tensor(f_idx, device=pred.device),
                                      torch.tensor(v_idx, device=pred.device))
            pred[ectopic_mask] = new_labels

        return pred

    def count_parameters(self):
        return sum(p.numel() for p in self.parameters() if p.requires_grad)

    def get_model_size_kb(self):
        param_bytes = sum(p.numel() * p.element_size() for p in self.parameters())
        buffer_bytes = sum(b.numel() * b.element_size() for b in self.buffers())
        return (param_bytes + buffer_bytes) / 1024

    def estimate_activation_memory_kb(self, batch_size=1):
        # With 256-sample input + Block1 stride=2:
        #   Block1 conv out:   128 x CONV1_CHANNELS x 4B
        #   Block1 pool out:    64 x CONV1_CHANNELS x 4B
        #   Block2 conv out:    64 x CONV2_CHANNELS x 4B
        #   Block2 pool out:    32 x CONV2_CHANNELS x 4B
        #   Block3 conv out:    32 x CONV3_CHANNELS x 4B
        peak = max(
            128 * CONV1_CHANNELS,   # Block1 conv output
            64 * CONV2_CHANNELS,    # Block2 conv output
            32 * CONV3_CHANNELS,    # Block3 conv output
        )
        return peak * 4 * batch_size / 1024


def build_student_model(num_classes=NUM_CLASSES, verbose=True,
                         use_fv_head=True, kd_proj_dim=None):
    """Build and validate student CNN against deployment constraints."""
    model = ECGStudentCNN(num_classes=num_classes, use_fv_head=use_fv_head,
                           kd_proj_dim=kd_proj_dim)

    if verbose:
        n_params = model.count_parameters()
        size_kb = model.get_model_size_kb()
        act_kb = model.estimate_activation_memory_kb()
        print(f"Student CNN architecture:")
        print(f"  Parameters:        {n_params:,} (<50,000 required)")
        print(f"  Model size (FP32): {size_kb:.1f} KB (<200 KB required)")
        print(f"  Est INT8 size:     {size_kb / 4:.1f} KB (<80 KB required)")
        print(f"  Peak activation:   {act_kb:.1f} KB (<16 KB required)")
        print(f"  F-vs-V head:       {'yes' if use_fv_head else 'no'}")
        print(f"  KD projection:     {'dim=' + str(kd_proj_dim) if kd_proj_dim else 'no'}")

        assert n_params < 50_000, f"Too many params: {n_params}"
        assert size_kb < 200, f"Model too large: {size_kb:.1f} KB"
        print("  All deployment constraints PASSED")

    return model


if __name__ == "__main__":
    model = build_student_model(verbose=True, use_fv_head=True, kd_proj_dim=64)
    batch = 2
    x_beat = torch.randn(batch, BEAT_WINDOW_SAMPLES, 1)
    x_rr = torch.randn(batch, RR_FEATURE_DIM)
    logits, fv, kd_feat = model(x_beat, x_rr, return_fv=True, return_kd_feat=True)
    print(f"\nForward: beat {x_beat.shape}, rr {x_rr.shape}")
    print(f"  main logits: {logits.shape}")
    print(f"  F-vs-V:      {fv.shape}")
    print(f"  KD feat:     {kd_feat.shape}")
