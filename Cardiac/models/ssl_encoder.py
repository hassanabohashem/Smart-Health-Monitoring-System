"""
Priority 2 -- SSL masked-beat autoencoder for CinC 2017 pre-training.

Architecture:
  Encoder  = ECGStudentCNN backbone (block1, block2, block3, gap) -- SAME
             modules that are used in the supervised model, so the
             pretrained state_dict loads directly into it at fine-tune time.
  Decoder  = Small transposed-conv stack that upsamples the (B, 48) latent
             back to (B, 128) reconstruction.

Training task:
  Input a 128-sample beat with 25% of its samples masked out (contiguous
  blocks of 16 samples each). Predict the masked samples. MSE loss is
  computed on the masked positions only.

The decoder is discarded after SSL. Only the encoder transfers.
"""
import os
import sys
import torch
import torch.nn as nn
import torch.nn.functional as F

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from config import (BEAT_WINDOW_SAMPLES, CONV1_CHANNELS, CONV1_KERNEL,
                     CONV2_CHANNELS, CONV2_KERNEL, CONV3_CHANNELS, CONV3_KERNEL,
                     SSL_DECODER_CHANNELS)
from models.student_cnn import ConvBlock


class SSLEncoder(nn.Module):
    """Encoder identical to ECGStudentCNN's convolutional trunk.

    Returns a (batch, CONV3_CHANNELS, T) feature map (NOT yet global-pooled).
    The supervised head does GAP on the SAME tensor, so the state_dict is
    name-compatible with ECGStudentCNN.
    """

    def __init__(self):
        super().__init__()
        self.block1 = ConvBlock(1, CONV1_CHANNELS, CONV1_KERNEL, pool_size=2)
        self.block2 = ConvBlock(CONV1_CHANNELS, CONV2_CHANNELS, CONV2_KERNEL, pool_size=2)
        self.block3 = ConvBlock(CONV2_CHANNELS, CONV3_CHANNELS, CONV3_KERNEL, pool_size=0)

    def forward(self, x_beat):
        # x_beat: (B, 128, 1) -> (B, 1, 128)
        x = x_beat.permute(0, 2, 1)
        x = self.block1(x)        # (B, 24, 64)
        x = self.block2(x)        # (B, 48, 32)
        x = self.block3(x)        # (B, 48, 32)
        return x


class SSLDecoder(nn.Module):
    """Small transposed-conv upsampler 32 -> 64 -> 128.

    Input:  (B, 48, 32)
    Output: (B, 1, 128)
    """

    def __init__(self, in_channels=CONV3_CHANNELS, hidden=SSL_DECODER_CHANNELS):
        super().__init__()
        self.up1 = nn.ConvTranspose1d(in_channels, hidden, kernel_size=4,
                                        stride=2, padding=1)  # 32 -> 64
        self.bn1 = nn.BatchNorm1d(hidden)
        self.up2 = nn.ConvTranspose1d(hidden, hidden, kernel_size=4,
                                        stride=2, padding=1)  # 64 -> 128
        self.bn2 = nn.BatchNorm1d(hidden)
        self.head = nn.Conv1d(hidden, 1, kernel_size=3, padding=1)

    def forward(self, x):
        x = F.relu(self.bn1(self.up1(x)))
        x = F.relu(self.bn2(self.up2(x)))
        x = self.head(x)  # (B, 1, 128)
        return x


class SSLModel(nn.Module):
    """Encoder + decoder, used only during SSL pre-training."""

    def __init__(self):
        super().__init__()
        self.encoder = SSLEncoder()
        self.decoder = SSLDecoder()

    def forward(self, x_beat_masked):
        feat = self.encoder(x_beat_masked)            # (B, 48, 32)
        recon = self.decoder(feat)                     # (B, 1, 128)
        return recon.permute(0, 2, 1)                  # (B, 128, 1)


def mask_beats(beats, mask_ratio, block_len, rng):
    """Apply contiguous block masking to (N, 128, 1) beats in-place-safe.

    Args:
        beats: (N, 128, 1) float32 ndarray
        mask_ratio: fraction of samples to mask (0.0-1.0)
        block_len: samples per contiguous mask block
        rng: numpy Generator

    Returns:
        masked_beats: (N, 128, 1), same shape; masked samples set to 0.0
        mask:         (N, 128) bool, True where masked (loss-relevant)
    """
    import numpy as np
    N, T, _ = beats.shape
    n_mask = int(round(T * mask_ratio))
    n_blocks = max(1, n_mask // block_len)

    masked = beats.copy()
    mask = np.zeros((N, T), dtype=bool)

    for i in range(N):
        for _ in range(n_blocks):
            start = int(rng.integers(0, T - block_len + 1))
            masked[i, start:start + block_len, 0] = 0.0
            mask[i, start:start + block_len] = True

    return masked, mask


def load_encoder_into_student(ssl_ckpt_path, student_model, strict=False,
                                verbose=True):
    """Transfer SSL-pretrained encoder weights into a ECGStudentCNN.

    The encoder's 3 conv blocks share layer names (block1, block2, block3)
    with the supervised model, so a filtered load_state_dict works directly.
    """
    ckpt = torch.load(ssl_ckpt_path, map_location='cpu', weights_only=False)
    ssl_state = ckpt.get('encoder_state_dict', ckpt.get('model_state_dict', ckpt))
    student_state = student_model.state_dict()

    loaded = 0
    for k, v in ssl_state.items():
        # encoder may be prefixed "encoder." if the checkpoint saved the full SSLModel
        key = k.replace('encoder.', '') if k.startswith('encoder.') else k
        if key in student_state and student_state[key].shape == v.shape:
            student_state[key] = v
            loaded += 1

    missing = student_model.load_state_dict(student_state, strict=False)
    if verbose:
        print(f"  SSL transfer: {loaded} tensors loaded into student")
        if missing.missing_keys:
            print(f"    missing: {missing.missing_keys[:5]}{'...' if len(missing.missing_keys) > 5 else ''}")
    return student_model
