"""
Signal Quality Index (SQI) module for ECG signal quality gating.

Computes three statistical SQI features:
  - kSQI: kurtosis of the beat segment (clean QRS has high kurtosis)
  - pSQI: ratio of power in 5-15 Hz QRS band to total power
  - basSQI: baseline wander ratio (power below 1 Hz / total power)

Also includes a small learned SQI classifier (~2K params) that outputs
a quality score [0, 1] where 1 = clean signal.

Rejection rule: if SQI < threshold → output "Uncertain" instead of classification.
"""
import os
import sys
import numpy as np
from scipy.stats import kurtosis
from scipy.signal import welch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from config import TARGET_FS, SQI_REJECTION_THRESHOLD

import torch
import torch.nn as nn


def compute_ksqi(beat, fisher=True):
    """Compute kurtosis SQI.

    Clean QRS complexes have high kurtosis (peaky waveform).
    Noisy signals tend toward Gaussian (kurtosis ≈ 0 for Fisher).

    Args:
        beat: 1D array

    Returns:
        kSQI value (Fisher kurtosis)
    """
    return float(kurtosis(beat, fisher=fisher))


def compute_psqi(beat, fs=TARGET_FS, qrs_band=(5, 15)):
    """Compute power spectral density SQI.

    pSQI = power in QRS band (5-15 Hz) / total power.
    Clean ECG has dominant power in this band.

    Args:
        beat: 1D array
        fs: sampling frequency
        qrs_band: (low, high) frequency range for QRS power

    Returns:
        pSQI ratio [0, 1]
    """
    if len(beat) < 16:
        return 0.0
    nperseg = min(len(beat), 64)
    freqs, psd = welch(beat, fs=fs, nperseg=nperseg)
    total_power = np.trapz(psd, freqs) + 1e-10
    qrs_mask = (freqs >= qrs_band[0]) & (freqs <= qrs_band[1])
    qrs_power = np.trapz(psd[qrs_mask], freqs[qrs_mask]) if qrs_mask.any() else 0
    return float(qrs_power / total_power)


def compute_bassqi(beat, fs=TARGET_FS, bw_cutoff=1.0):
    """Compute baseline wander SQI.

    basSQI = power below bw_cutoff Hz / total power.
    High basSQI indicates excessive baseline wander (bad quality).

    Args:
        beat: 1D array
        fs: sampling frequency
        bw_cutoff: baseline wander cutoff frequency (Hz)

    Returns:
        basSQI ratio [0, 1] — lower is better
    """
    if len(beat) < 16:
        return 1.0
    nperseg = min(len(beat), 64)
    freqs, psd = welch(beat, fs=fs, nperseg=nperseg)
    total_power = np.trapz(psd, freqs) + 1e-10
    bw_mask = freqs <= bw_cutoff
    bw_power = np.trapz(psd[bw_mask], freqs[bw_mask]) if bw_mask.any() else 0
    return float(bw_power / total_power)


def compute_sqi_features(beat, fs=TARGET_FS):
    """Compute all 3 SQI features for a single beat.

    Returns:
        ndarray of shape (3,): [kSQI, pSQI, basSQI]
    """
    return np.array([
        compute_ksqi(beat),
        compute_psqi(beat, fs),
        compute_bassqi(beat, fs),
    ], dtype=np.float32)


class SQIClassifier(nn.Module):
    """Small learned SQI classifier (~2K parameters).

    Input: 3 SQI features → quality score [0, 1]

    Architecture:
      Dense(3, 16) → ReLU → Dense(16, 8) → ReLU → Dense(8, 1) → Sigmoid

    Total params: 3*16+16 + 16*8+8 + 8*1+1 = 64+16+128+8+8+1 = 225
    (Well under 2K budget; could increase if needed)
    """

    def __init__(self):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(3, 16),
            nn.ReLU(inplace=True),
            nn.Linear(16, 8),
            nn.ReLU(inplace=True),
            nn.Linear(8, 1),
            nn.Sigmoid()
        )

    def forward(self, x):
        """
        Args:
            x: (batch, 3) SQI features

        Returns:
            quality_score: (batch, 1) in [0, 1]
        """
        return self.net(x)

    def count_parameters(self):
        return sum(p.numel() for p in self.parameters() if p.requires_grad)


def rule_based_sqi(beat, fs=TARGET_FS, threshold=SQI_REJECTION_THRESHOLD):
    """Rule-based SQI gate using combined features.

    Simple weighted combination:
      score = 0.3 * normalized_kSQI + 0.5 * pSQI + 0.2 * (1 - basSQI)

    Args:
        beat: 1D array
        fs: sampling rate
        threshold: rejection threshold

    Returns:
        (accept: bool, score: float, features: ndarray)
    """
    feats = compute_sqi_features(beat, fs)
    k, p, b = feats

    # Normalize kSQI: clean ECG typically has kurtosis > 5
    k_norm = min(max(k, 0) / 10.0, 1.0)

    score = 0.3 * k_norm + 0.5 * p + 0.2 * (1.0 - b)
    accept = score >= threshold

    return accept, float(score), feats
