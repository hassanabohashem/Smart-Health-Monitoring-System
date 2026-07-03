"""
train_wrist_honest.py
---------------------
Fixes the methodological problems identified in AUDIT_REPORT.md:

  - Subject-disjoint train/val/test split (no subject's windows appear in
    more than one partition).
  - Best-checkpoint selection by VAL AUC (never touches the test set).
  - Threshold tuning on VAL, frozen before test evaluation.
  - Test set is touched ONCE for final reporting.

Default split (deterministic, seed=42):
  - 13 wrist subjects: S01, S02, S03, S04, S05, S06, S09, S10, S11, S12, S13, S14, S15
  - Test  (held out, 2 subjects):  randomly drawn from the 13
  - Val   (held out, 2 subjects):  randomly drawn from the 11 remaining
  - Train (9 subjects):            the rest

Output:
  - models/fusion/FusionNet_Wrist_honest.pth          (model trained on `train`)
  - models/fusion/scaler_Wrist_honest.joblib          (fit on train only)
  - output/results/wrist_honest.json                  (val + test metrics + chosen threshold)
"""
import os, sys, time, json, random
import numpy as np
import torch
import torch.nn as nn
import torch.optim as optim
from torch.utils.data import Dataset, DataLoader
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import (accuracy_score, precision_score, recall_score,
                              f1_score, roc_auc_score, confusion_matrix)
import joblib

sys.path.append(os.path.join(os.path.dirname(__file__), '..'))
from models.fusion_model import BarometerFusionNet

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
ROOT      = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DATA_DIR  = os.path.join(ROOT, "data", "fused", "D2")
MODEL_DIR = os.path.join(ROOT, "models", "fusion")
RESULT_DIR = os.path.join(ROOT, "output", "results")
os.makedirs(MODEL_DIR, exist_ok=True)
os.makedirs(RESULT_DIR, exist_ok=True)

SEED          = 42
N_TEST_SUBJ   = 2
N_VAL_SUBJ    = 2
EPOCHS        = 80
BATCH_SIZE    = 64
LEARNING_RATE = 0.0005
WEIGHT_DECAY  = 1e-4
AUG_FACTOR    = 4

DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")


# ---------------------------------------------------------------------------
# Augmentations (same as retrain_wrist_augmented.py for apples-to-apples)
# ---------------------------------------------------------------------------
def _gauss(x, sigma=0.05):
    return x + np.random.normal(0, sigma, x.shape).astype(np.float32)

def _scale(x, lo=0.85, hi=1.15):
    s = np.random.uniform(lo, hi, size=(1, x.shape[1])).astype(np.float32)
    return x * s

def _time_warp(x, sigma=0.2):
    seq = x.shape[0]
    warp = np.cumsum(np.random.normal(1.0, sigma, seq))
    warp = np.clip(warp / warp[-1] * (seq - 1), 0, seq - 1)
    out = np.zeros_like(x)
    idx = np.arange(seq)
    for c in range(x.shape[1]):
        out[:, c] = np.interp(idx, warp, x[:, c])
    return out

def _mag_warp(x, sigma=0.1, knots=4):
    seq = x.shape[0]
    orig = np.linspace(0, seq - 1, knots + 2)
    rand = np.random.normal(1.0, sigma, (knots + 2, x.shape[1])).astype(np.float32)
    curve = np.zeros_like(x)
    steps = np.arange(seq)
    for c in range(x.shape[1]):
        curve[:, c] = np.interp(steps, orig, rand[:, c])
    return x * curve

def augment(x):
    x = x.copy()
    x = _gauss(x, np.random.uniform(0.02, 0.08))
    if np.random.random() < 0.7: x = _scale(x)
    if np.random.random() < 0.5: x = _time_warp(x, np.random.uniform(0.1, 0.3))
    if np.random.random() < 0.4: x = _mag_warp(x)
    return x


class FusionDataset(Dataset):
    def __init__(self, X_imu, X_baro, y, augment_data=False, aug_factor=1):
        self.X_imu = X_imu       # tensor (N,6,200)
        self.X_baro = X_baro     # tensor (N,1,200)
        self.y = y               # tensor (N,) long
        self.aug = augment_data
        self.aug_factor = aug_factor if augment_data else 1
        self.n_real = len(y)

    def __len__(self):
        return self.n_real * self.aug_factor

    def __getitem__(self, idx):
        real = idx % self.n_real
        imu = self.X_imu[real].numpy()
        baro = self.X_baro[real].numpy()
        if self.aug and idx >= self.n_real:
            comb = np.vstack([imu, baro])              # (7, 200)
            comb = augment(comb.T).T                    # transpose, augment, transpose
            imu, baro = comb[:6, :], comb[6:, :]
        return (torch.tensor(imu, dtype=torch.float32),
                torch.tensor(baro, dtype=torch.float32),
                self.y[real])


# ---------------------------------------------------------------------------
# Subject-disjoint splitting
# ---------------------------------------------------------------------------
def split_subjects(unique_subjects, n_test, n_val, seed=42):
    rng = random.Random(seed)
    shuffled = sorted(unique_subjects)
    rng.shuffle(shuffled)
    test_subj = sorted(shuffled[:n_test])
    val_subj  = sorted(shuffled[n_test:n_test + n_val])
    train_subj = sorted(shuffled[n_test + n_val:])
    return train_subj, val_subj, test_subj


# ---------------------------------------------------------------------------
# Train / eval helpers
# ---------------------------------------------------------------------------
def evaluate(model, loader, threshold=0.5):
    model.eval()
    probs, preds, labels = [], [], []
    with torch.no_grad():
        for imu, baro, y in loader:
            imu = imu.to(DEVICE); baro = baro.to(DEVICE)
            out = model(imu, baro)
            p = torch.softmax(out, dim=1)[:, 1].cpu().numpy()
            probs.extend(p)
            labels.extend(y.numpy())
    probs = np.array(probs); labels = np.array(labels)
    preds = (probs >= threshold).astype(int)
    auc = roc_auc_score(labels, probs) if len(set(labels)) > 1 else float("nan")
    tn, fp, fn, tp = confusion_matrix(labels, preds, labels=[0, 1]).ravel()
    return {
        "auc": float(auc),
        "accuracy": float(accuracy_score(labels, preds)),
        "precision": float(precision_score(labels, preds, zero_division=0)),
        "recall": float(recall_score(labels, preds, zero_division=0)),
        "f1": float(f1_score(labels, preds, zero_division=0)),
        "fpr": float(fp / (fp + tn) if (fp + tn) else 0.0),
        "tp": int(tp), "fp": int(fp), "fn": int(fn), "tn": int(tn),
        "n": int(len(labels)),
    }, probs, labels


def best_threshold_on_val(probs, labels, target_recall=0.95, prefer="f1"):
    """Sweep thresholds; pick the one that maximises F1 subject to recall >= target."""
    sweep = np.arange(0.05, 0.95, 0.01)
    best, best_th = None, 0.5
    for th in sweep:
        preds = (probs >= th).astype(int)
        rec = recall_score(labels, preds, zero_division=0)
        f1 = f1_score(labels, preds, zero_division=0)
        prec = precision_score(labels, preds, zero_division=0)
        if rec < target_recall:
            continue
        score = f1 if prefer == "f1" else prec
        if best is None or score > best:
            best = score
            best_th = th
    if best is None:
        # No threshold meets target recall; fall back to argmax-F1 unconstrained.
        for th in sweep:
            preds = (probs >= th).astype(int)
            f1 = f1_score(labels, preds, zero_division=0)
            if best is None or f1 > best:
                best, best_th = f1, th
    return float(best_th), float(best)


def main():
    # Reproducibility
    random.seed(SEED)
    np.random.seed(SEED)
    torch.manual_seed(SEED)
    torch.cuda.manual_seed_all(SEED)

    print(f"\n{'=' * 72}")
    print(f"  HONEST WRIST FusionNet TRAINING (subject-disjoint splits)")
    print(f"{'=' * 72}")
    print(f"  Device: {DEVICE}")
    print(f"  Seed:   {SEED}")

    # Load
    X = np.load(os.path.join(DATA_DIR, "X.npy"))           # (N, 200, 7)
    y = np.load(os.path.join(DATA_DIR, "y.npy"))           # (N,)
    subjects = np.load(os.path.join(DATA_DIR, "subjects.npy"))  # (N,) U3
    unique = sorted(set(subjects.tolist()))
    print(f"  Total: {len(y)} samples, {(y==1).sum()} falls, {(y==0).sum()} ADLs")
    print(f"  Subjects ({len(unique)}): {', '.join(unique)}")

    # Split (subject-disjoint)
    train_s, val_s, test_s = split_subjects(unique, N_TEST_SUBJ, N_VAL_SUBJ, seed=SEED)
    print(f"\n  Train subjects ({len(train_s)}): {', '.join(train_s)}")
    print(f"  Val   subjects ({len(val_s)}): {', '.join(val_s)}")
    print(f"  Test  subjects ({len(test_s)}): {', '.join(test_s)}")

    train_mask = np.isin(subjects, train_s)
    val_mask   = np.isin(subjects, val_s)
    test_mask  = np.isin(subjects, test_s)
    assert (train_mask & val_mask).sum() == 0
    assert (val_mask & test_mask).sum() == 0
    assert (train_mask & test_mask).sum() == 0

    Xtr, ytr = X[train_mask], y[train_mask].astype(np.int64)
    Xv,  yv  = X[val_mask],   y[val_mask].astype(np.int64)
    Xte, yte = X[test_mask],  y[test_mask].astype(np.int64)
    print(f"\n  Train: {len(ytr)} samples ({(ytr==1).sum()} falls / {(ytr==0).sum()} ADLs)")
    print(f"  Val:   {len(yv)} samples ({(yv==1).sum()} falls / {(yv==0).sum()} ADLs)")
    print(f"  Test:  {len(yte)} samples ({(yte==1).sum()} falls / {(yte==0).sum()} ADLs)")

    # Fit scaler ON TRAIN ONLY
    n_tr, seq, ch = Xtr.shape
    scaler = StandardScaler()
    scaler.fit(Xtr.reshape(-1, ch))
    Xtr = scaler.transform(Xtr.reshape(-1, ch)).reshape(n_tr, seq, ch)
    Xv  = scaler.transform(Xv.reshape(-1, ch)).reshape(len(yv), seq, ch)
    Xte = scaler.transform(Xte.reshape(-1, ch)).reshape(len(yte), seq, ch)

    scaler_path = os.path.join(MODEL_DIR, "scaler_Wrist_honest.joblib")
    joblib.dump(scaler, scaler_path)
    print(f"\n  Saved scaler: {scaler_path}")

    # Transpose to (N, C, T)
    Xtr = np.transpose(Xtr, (0, 2, 1))
    Xv  = np.transpose(Xv,  (0, 2, 1))
    Xte = np.transpose(Xte, (0, 2, 1))

    def to_tensors(X, y):
        return (torch.tensor(X[:, :6, :], dtype=torch.float32),
                torch.tensor(X[:, 6:, :], dtype=torch.float32),
                torch.tensor(y, dtype=torch.long))

    tr_imu, tr_baro, tr_y = to_tensors(Xtr, ytr)
    v_imu,  v_baro,  v_y  = to_tensors(Xv,  yv)
    te_imu, te_baro, te_y = to_tensors(Xte, yte)

    train_ds = FusionDataset(tr_imu, tr_baro, tr_y, augment_data=True, aug_factor=AUG_FACTOR)
    val_ds   = FusionDataset(v_imu,  v_baro,  v_y,  augment_data=False)
    test_ds  = FusionDataset(te_imu, te_baro, te_y, augment_data=False)

    train_loader = DataLoader(train_ds, batch_size=BATCH_SIZE, shuffle=True,  num_workers=0)
    val_loader   = DataLoader(val_ds,   batch_size=BATCH_SIZE, shuffle=False, num_workers=0)
    test_loader  = DataLoader(test_ds,  batch_size=BATCH_SIZE, shuffle=False, num_workers=0)

    print(f"  Effective train samples: {len(train_ds)} ({len(ytr)} real × {AUG_FACTOR} aug)")

    # Class weights from TRAIN
    n_falls_tr = int((ytr == 1).sum())
    n_adls_tr  = int((ytr == 0).sum())
    weight_fall = n_adls_tr / max(1, n_falls_tr)
    cw = torch.tensor([1.0, weight_fall], dtype=torch.float32, device=DEVICE)
    print(f"  Class weights: ADL=1.00, Fall={weight_fall:.2f}")

    # Model
    model = BarometerFusionNet(imu_channels=6, baro_channels=1).to(DEVICE)
    optimizer = optim.Adam(model.parameters(), lr=LEARNING_RATE, weight_decay=WEIGHT_DECAY)
    criterion = nn.CrossEntropyLoss(weight=cw)
    scheduler = optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=EPOCHS, eta_min=1e-6)

    best_val_auc = -1.0
    best_path = os.path.join(MODEL_DIR, "FusionNet_Wrist_honest.pth")

    print(f"\n  {'Ep':>3}  {'Loss':>8}  {'val_AUC':>7}  {'val_F1':>7}  {'val_Rec':>7}  {'val_FPR':>7}  {'LR':>10}")
    print(f"  {'-'*68}")
    t0 = time.time()
    for epoch in range(1, EPOCHS + 1):
        model.train()
        running = 0.0
        for imu, baro, y_ in train_loader:
            imu = imu.to(DEVICE); baro = baro.to(DEVICE); y_ = y_.to(DEVICE)
            optimizer.zero_grad()
            out = model(imu, baro)
            loss = criterion(out, y_)
            loss.backward()
            optimizer.step()
            running += loss.item()
        scheduler.step()

        if epoch % 2 == 0 or epoch == 1 or epoch == EPOCHS:
            metrics, _, _ = evaluate(model, val_loader, threshold=0.5)
            lr_now = optimizer.param_groups[0]['lr']
            print(f"  {epoch:>3}  {running/len(train_loader):>8.4f}  "
                  f"{metrics['auc']:>7.4f}  {metrics['f1']*100:>6.1f}%  "
                  f"{metrics['recall']*100:>6.1f}%  {metrics['fpr']*100:>6.1f}%  "
                  f"{lr_now:>10.6f}")
            if metrics['auc'] > best_val_auc:
                best_val_auc = metrics['auc']
                torch.save(model.state_dict(), best_path)

    print(f"\n  Best VAL AUC: {best_val_auc:.4f}")
    print(f"  Model saved: {best_path}")
    print(f"  Training time: {time.time() - t0:.1f}s")

    # Reload best checkpoint
    model.load_state_dict(torch.load(best_path, map_location=DEVICE))
    model.eval()

    # Tune threshold on VAL
    val_metrics_th50, val_probs, val_labels = evaluate(model, val_loader, threshold=0.5)
    chosen_threshold, val_score_at_best = best_threshold_on_val(
        val_probs, val_labels, target_recall=0.95, prefer="f1"
    )
    val_metrics_chosen, _, _ = evaluate(model, val_loader, threshold=chosen_threshold)
    print(f"\n  Chosen threshold: {chosen_threshold:.3f}  "
          f"(VAL F1 at threshold = {val_score_at_best:.4f}, "
          f"VAL recall = {val_metrics_chosen['recall']:.4f}, "
          f"VAL FPR = {val_metrics_chosen['fpr']:.4f})")

    # Final TEST evaluation (touch test set ONCE)
    test_metrics, test_probs, test_labels = evaluate(model, test_loader, threshold=chosen_threshold)
    print(f"\n  {'='*72}")
    print(f"  FINAL TEST METRICS (subject-disjoint, threshold tuned on val)")
    print(f"  {'='*72}")
    print(f"  Test subjects:   {', '.join(test_s)}")
    print(f"  AUC:             {test_metrics['auc']:.4f}")
    print(f"  Accuracy:        {test_metrics['accuracy']*100:.1f}%")
    print(f"  Precision:       {test_metrics['precision']*100:.1f}%")
    print(f"  Recall:          {test_metrics['recall']*100:.1f}%")
    print(f"  F1:              {test_metrics['f1']*100:.1f}%")
    print(f"  FPR:             {test_metrics['fpr']*100:.1f}%")
    print(f"  TP/FP/FN/TN:     {test_metrics['tp']}/{test_metrics['fp']}/{test_metrics['fn']}/{test_metrics['tn']}")

    # Persist results
    out = {
        "split": {
            "train_subjects": train_s,
            "val_subjects": val_s,
            "test_subjects": test_s,
            "seed": SEED,
        },
        "n_train": int(len(ytr)),
        "n_val": int(len(yv)),
        "n_test": int(len(yte)),
        "best_val_auc": float(best_val_auc),
        "chosen_threshold": float(chosen_threshold),
        "val_metrics_at_chosen_threshold": val_metrics_chosen,
        "test_metrics_at_chosen_threshold": test_metrics,
        "epochs": EPOCHS,
        "aug_factor": AUG_FACTOR,
    }
    out_path = os.path.join(RESULT_DIR, "wrist_honest.json")
    with open(out_path, "w") as f:
        json.dump(out, f, indent=2)
    print(f"\n  Results JSON: {out_path}")


if __name__ == "__main__":
    main()
