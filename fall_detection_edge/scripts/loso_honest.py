"""
loso_honest.py
--------------
Honest Leave-One-Subject-Out evaluation for the wrist FusionNet.

What the OLD `audit_wrist_fusionnet.py` did wrong:
  - Loaded the already-trained model ONCE before the subject loop.
  - For each "held-out" subject, only refit a StandardScaler.
  - Each subject's data was already in the training set — not LOSO.

What this script does:
  - For each of the 13 wrist subjects, pulls that subject as TEST.
  - From the remaining 12, picks 2 as VAL (deterministic, by sorted next-after-test).
  - Trains a fresh FusionNet from scratch on the 10 train subjects.
  - Selects best checkpoint by VAL AUC.
  - Tunes threshold on VAL (target recall >= 0.95, max F1 subject to that).
  - Reports TEST metrics at the val-tuned threshold.
  - Aggregates across all 13 folds.

Output: `output/results/wrist_loso_honest.json`
"""
import os, sys, time, json, random
import numpy as np
import torch
import torch.nn as nn
import torch.optim as optim
from torch.utils.data import DataLoader
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import (accuracy_score, precision_score, recall_score,
                              f1_score, roc_auc_score, confusion_matrix)

sys.path.append(os.path.join(os.path.dirname(__file__), '..'))
from models.fusion_model import BarometerFusionNet
from train_wrist_honest import (
    FusionDataset, evaluate, best_threshold_on_val,
    EPOCHS, BATCH_SIZE, LEARNING_RATE, WEIGHT_DECAY, AUG_FACTOR, DEVICE,
)

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DATA_DIR = os.path.join(ROOT, "data", "fused", "D2")
RESULT_DIR = os.path.join(ROOT, "output", "results")
os.makedirs(RESULT_DIR, exist_ok=True)

# Use slightly fewer epochs for LOSO since we have 13 folds — early-stopping-ish.
LOSO_EPOCHS = 60
SEED = 42


def train_one_fold(Xtr, ytr, Xv, yv, fold_seed):
    """Train one model from scratch. Returns best state_dict + best val AUC."""
    random.seed(fold_seed); np.random.seed(fold_seed)
    torch.manual_seed(fold_seed); torch.cuda.manual_seed_all(fold_seed)

    # Fit scaler on train only
    n_tr, seq, ch = Xtr.shape
    scaler = StandardScaler()
    scaler.fit(Xtr.reshape(-1, ch))
    Xtr = scaler.transform(Xtr.reshape(-1, ch)).reshape(n_tr, seq, ch)
    Xv  = scaler.transform(Xv.reshape(-1, ch)).reshape(len(yv), seq, ch)

    Xtr = np.transpose(Xtr, (0, 2, 1))
    Xv  = np.transpose(Xv,  (0, 2, 1))

    tr_imu  = torch.tensor(Xtr[:, :6, :], dtype=torch.float32)
    tr_baro = torch.tensor(Xtr[:, 6:, :], dtype=torch.float32)
    tr_y    = torch.tensor(ytr, dtype=torch.long)
    v_imu   = torch.tensor(Xv[:, :6, :], dtype=torch.float32)
    v_baro  = torch.tensor(Xv[:, 6:, :], dtype=torch.float32)
    v_y     = torch.tensor(yv, dtype=torch.long)

    train_ds = FusionDataset(tr_imu, tr_baro, tr_y, augment_data=True, aug_factor=AUG_FACTOR)
    val_ds   = FusionDataset(v_imu,  v_baro,  v_y,  augment_data=False)

    train_loader = DataLoader(train_ds, batch_size=BATCH_SIZE, shuffle=True, num_workers=0)
    val_loader   = DataLoader(val_ds,   batch_size=BATCH_SIZE, shuffle=False, num_workers=0)

    n_falls = int((ytr == 1).sum())
    n_adls  = int((ytr == 0).sum())
    weight_fall = n_adls / max(1, n_falls)
    cw = torch.tensor([1.0, weight_fall], dtype=torch.float32, device=DEVICE)

    model = BarometerFusionNet(imu_channels=6, baro_channels=1).to(DEVICE)
    optimizer = optim.Adam(model.parameters(), lr=LEARNING_RATE, weight_decay=WEIGHT_DECAY)
    criterion = nn.CrossEntropyLoss(weight=cw)
    scheduler = optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=LOSO_EPOCHS, eta_min=1e-6)

    best_state = None
    best_val_auc = -1.0
    best_val_probs = None
    best_val_labels = None

    for epoch in range(1, LOSO_EPOCHS + 1):
        model.train()
        for imu, baro, y_ in train_loader:
            imu = imu.to(DEVICE); baro = baro.to(DEVICE); y_ = y_.to(DEVICE)
            optimizer.zero_grad()
            loss = criterion(model(imu, baro), y_)
            loss.backward()
            optimizer.step()
        scheduler.step()

        if epoch % 4 == 0 or epoch == LOSO_EPOCHS:
            metrics, val_probs, val_labels = evaluate(model, val_loader, threshold=0.5)
            if metrics['auc'] > best_val_auc:
                best_val_auc = metrics['auc']
                best_state = {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}
                best_val_probs = val_probs
                best_val_labels = val_labels

    return best_state, best_val_auc, best_val_probs, best_val_labels, scaler


def evaluate_test_subject(state, scaler, Xte_raw, yte):
    """Apply trained model + scaler to held-out subject. Return raw probs + labels."""
    n, seq, ch = Xte_raw.shape
    Xte = scaler.transform(Xte_raw.reshape(-1, ch)).reshape(n, seq, ch)
    Xte = np.transpose(Xte, (0, 2, 1))
    te_imu  = torch.tensor(Xte[:, :6, :], dtype=torch.float32)
    te_baro = torch.tensor(Xte[:, 6:, :], dtype=torch.float32)
    te_y    = torch.tensor(yte, dtype=torch.long)
    test_ds = FusionDataset(te_imu, te_baro, te_y, augment_data=False)
    test_loader = DataLoader(test_ds, batch_size=BATCH_SIZE, shuffle=False, num_workers=0)

    model = BarometerFusionNet(imu_channels=6, baro_channels=1).to(DEVICE)
    model.load_state_dict(state)
    model.eval()

    probs, labels = [], []
    with torch.no_grad():
        for imu, baro, y_ in test_loader:
            imu = imu.to(DEVICE); baro = baro.to(DEVICE)
            p = torch.softmax(model(imu, baro), dim=1)[:, 1].cpu().numpy()
            probs.extend(p); labels.extend(y_.numpy())
    return np.array(probs), np.array(labels)


def main():
    print(f"\n{'='*72}")
    print(f"  HONEST LOSO EVALUATION — Wrist FusionNet")
    print(f"{'='*72}")
    print(f"  Device: {DEVICE}  |  Epochs/fold: {LOSO_EPOCHS}  |  Aug factor: {AUG_FACTOR}")

    X = np.load(os.path.join(DATA_DIR, "X.npy"))
    y = np.load(os.path.join(DATA_DIR, "y.npy"))
    subjects = np.load(os.path.join(DATA_DIR, "subjects.npy"))
    unique = sorted(set(subjects.tolist()))
    print(f"  Total: {len(y)} samples, subjects: {len(unique)}")
    print(f"  Subjects: {', '.join(unique)}")

    # Pre-filter: subjects that can serve as val/test (need both classes for AUC).
    valid_subjects = []
    for s in unique:
        m = (subjects == s)
        if int((y[m] == 1).sum()) > 0 and int((y[m] == 0).sum()) > 0:
            valid_subjects.append(s)
    skipped_subjects = [s for s in unique if s not in valid_subjects]
    print(f"  Val/test eligible subjects ({len(valid_subjects)}): {', '.join(valid_subjects)}")
    print(f"  ADL-only subjects (excluded from val/test, kept in train): "
          f"{', '.join(skipped_subjects) if skipped_subjects else 'none'}\n")

    fold_results = []
    all_probs = np.zeros(len(y), dtype=np.float64)
    all_used  = np.zeros(len(y), dtype=bool)
    out_path = os.path.join(RESULT_DIR, "wrist_loso_honest.json")

    overall_t0 = time.time()
    for i, test_subj in enumerate(valid_subjects):
        # Pick val subjects from valid_subjects only (need both classes for AUC).
        others_valid = [s for s in valid_subjects if s != test_subj]
        idx = valid_subjects.index(test_subj)
        val_subj = []
        offset = 1
        while len(val_subj) < 2 and offset < len(valid_subjects):
            cand = valid_subjects[(idx + offset) % len(valid_subjects)]
            if cand != test_subj and cand not in val_subj:
                val_subj.append(cand)
            offset += 1
        # Train: everything else (all `unique` subjects except test/val).
        # ADL-only subjects (S04, S10, S11, S12) are kept in train — they enrich
        # the negative-class pool with extra subject diversity.
        train_subj = sorted([s for s in unique if s != test_subj and s not in val_subj])

        train_mask = np.isin(subjects, train_subj)
        val_mask   = np.isin(subjects, val_subj)
        test_mask  = (subjects == test_subj)

        Xtr, ytr = X[train_mask], y[train_mask].astype(np.int64)
        Xv,  yv  = X[val_mask],   y[val_mask].astype(np.int64)
        Xte, yte = X[test_mask],  y[test_mask].astype(np.int64)

        n_falls_te = int((yte == 1).sum())
        n_adls_te  = int((yte == 0).sum())
        if n_falls_te == 0 or n_adls_te == 0:
            print(f"  [{i+1:>2}/{len(valid_subjects)}] {test_subj}: SKIP (degenerate test: F={n_falls_te}, A={n_adls_te})")
            continue
        n_falls_v = int((yv == 1).sum())
        n_adls_v  = int((yv == 0).sum())
        if n_falls_v == 0 or n_adls_v == 0:
            print(f"  [{i+1:>2}/{len(valid_subjects)}] {test_subj}: SKIP (degenerate val: F={n_falls_v}, A={n_adls_v})")
            continue

        t0 = time.time()
        state, best_val_auc, val_probs, val_labels, scaler = train_one_fold(
            Xtr.copy(), ytr, Xv.copy(), yv, fold_seed=SEED + i
        )
        # Tune threshold on VAL
        chosen_th, _ = best_threshold_on_val(val_probs, val_labels,
                                              target_recall=0.95, prefer="f1")
        # Eval on held-out test subject
        test_probs, test_labels = evaluate_test_subject(state, scaler, Xte.copy(), yte)
        test_preds = (test_probs >= chosen_th).astype(int)
        try:
            test_auc = roc_auc_score(test_labels, test_probs)
        except ValueError:
            test_auc = float("nan")
        tn, fp, fn, tp = confusion_matrix(test_labels, test_preds, labels=[0, 1]).ravel()
        m = {
            "test_subject": test_subj,
            "val_subjects": val_subj,
            "n_train": int(train_mask.sum()),
            "n_val":   int(val_mask.sum()),
            "n_test":  int(test_mask.sum()),
            "n_falls_test": n_falls_te,
            "n_adls_test":  n_adls_te,
            "best_val_auc": float(best_val_auc),
            "chosen_threshold": float(chosen_th),
            "test_auc": float(test_auc),
            "test_accuracy": float(accuracy_score(test_labels, test_preds)),
            "test_precision": float(precision_score(test_labels, test_preds, zero_division=0)),
            "test_recall": float(recall_score(test_labels, test_preds, zero_division=0)),
            "test_f1": float(f1_score(test_labels, test_preds, zero_division=0)),
            "test_fpr": float(fp / (fp + tn) if (fp + tn) else 0.0),
            "tp": int(tp), "fp": int(fp), "fn": int(fn), "tn": int(tn),
            "elapsed_sec": float(time.time() - t0),
        }
        fold_results.append(m)
        all_probs[test_mask] = test_probs
        all_used[test_mask] = True

        print(f"  [{i+1:>2}/{len(valid_subjects)}] {test_subj} (val={'+'.join(val_subj)})  "
              f"n={m['n_test']:>3} (F={n_falls_te:>2}, A={n_adls_te:>3})  "
              f"AUC={test_auc:.4f}  Rec={m['test_recall']*100:>5.1f}%  "
              f"FPR={m['test_fpr']*100:>5.1f}%  F1={m['test_f1']*100:>5.1f}%  "
              f"th={chosen_th:.2f}  ({m['elapsed_sec']:.0f}s)")

        # Persist after every fold so a crash doesn't lose the work.
        with open(out_path, "w") as f:
            json.dump({"folds_so_far": fold_results, "in_progress": True}, f, indent=2)

    overall_t = time.time() - overall_t0

    # Aggregate
    if fold_results:
        macro_auc = float(np.nanmean([f["test_auc"] for f in fold_results]))
        macro_rec = float(np.mean([f["test_recall"] for f in fold_results]))
        macro_prec = float(np.mean([f["test_precision"] for f in fold_results]))
        macro_f1   = float(np.mean([f["test_f1"] for f in fold_results]))
        macro_fpr  = float(np.mean([f["test_fpr"] for f in fold_results]))

        # Pooled (concatenate all held-out probs, evaluate at no single threshold — AUC only)
        pooled_y = y[all_used]
        pooled_p = all_probs[all_used]
        try:
            pooled_auc = float(roc_auc_score(pooled_y, pooled_p))
        except ValueError:
            pooled_auc = float("nan")

        print(f"\n  {'-'*72}")
        print(f"  HONEST LOSO AGGREGATE ({len(fold_results)} folds)")
        print(f"  {'-'*72}")
        print(f"  Macro AUC:       {macro_auc:.4f}")
        print(f"  Macro Recall:    {macro_rec*100:.1f}%")
        print(f"  Macro Precision: {macro_prec*100:.1f}%")
        print(f"  Macro F1:        {macro_f1*100:.1f}%")
        print(f"  Macro FPR:       {macro_fpr*100:.1f}%")
        print(f"  Pooled AUC:      {pooled_auc:.4f}  (concat of all held-out probs)")
        print(f"  Total time:      {overall_t:.1f}s ({overall_t/60:.1f}m)")

    # Persist
    out = {
        "method": "honest_loso",
        "epochs_per_fold": LOSO_EPOCHS,
        "aug_factor": AUG_FACTOR,
        "n_subjects": len(unique),
        "n_folds": len(fold_results),
        "macro_auc": macro_auc if fold_results else None,
        "macro_recall": macro_rec if fold_results else None,
        "macro_precision": macro_prec if fold_results else None,
        "macro_f1": macro_f1 if fold_results else None,
        "macro_fpr": macro_fpr if fold_results else None,
        "pooled_auc": pooled_auc if fold_results else None,
        "total_time_sec": overall_t,
        "folds": fold_results,
    }
    out_path = os.path.join(RESULT_DIR, "wrist_loso_honest.json")
    with open(out_path, "w") as f:
        json.dump(out, f, indent=2)
    print(f"\n  Results JSON: {out_path}")


if __name__ == "__main__":
    main()
