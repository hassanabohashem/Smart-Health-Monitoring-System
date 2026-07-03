"""
Post-training temperature scaling (Guo et al. 2017).

Single-parameter logit rescaling: T* = argmin NLL(z/T, y) on val set.
Reports ECE before/after and a coverage-vs-accuracy table.
"""
import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F


class TemperatureScaler(nn.Module):
    def __init__(self, init_T=1.0):
        super().__init__()
        self.T = nn.Parameter(torch.ones(1) * init_T)

    def forward(self, logits):
        return logits / self.T.clamp(min=0.05)


def fit_temperature(logits, labels, max_iter=200, lr=0.01):
    """Fit a single temperature via LBFGS on val logits. Returns float T."""
    logits = torch.as_tensor(logits, dtype=torch.float32)
    labels = torch.as_tensor(labels, dtype=torch.long)
    scaler = TemperatureScaler()
    nll = nn.CrossEntropyLoss()
    optim = torch.optim.LBFGS([scaler.T], lr=lr, max_iter=max_iter)

    def closure():
        optim.zero_grad()
        loss = nll(scaler(logits), labels)
        loss.backward()
        return loss
    optim.step(closure)
    return float(scaler.T.item())


def compute_ece(probs, labels, n_bins=15):
    """Expected Calibration Error."""
    conf = probs.max(axis=1)
    pred = probs.argmax(axis=1)
    correct = (pred == labels).astype(np.float32)
    bins = np.linspace(0.0, 1.0, n_bins + 1)
    ece = 0.0
    for i in range(n_bins):
        lo, hi = bins[i], bins[i+1]
        mask = (conf > lo) & (conf <= hi) if i > 0 else (conf >= lo) & (conf <= hi)
        if mask.sum() == 0:
            continue
        bin_acc = correct[mask].mean()
        bin_conf = conf[mask].mean()
        ece += (mask.sum() / len(conf)) * abs(bin_acc - bin_conf)
    return float(ece)


def coverage_accuracy(probs, labels, coverages=(0.80, 0.90, 0.95)):
    """Accuracy within top-confidence fraction of samples."""
    conf = probs.max(axis=1)
    pred = probs.argmax(axis=1)
    correct = (pred == labels)
    order = np.argsort(-conf)
    out = {}
    for cov in coverages:
        k = int(len(conf) * cov)
        out[f"acc_at_{int(cov*100)}_coverage"] = float(correct[order[:k]].mean())
    return out
