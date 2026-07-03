"""
Full v2 evaluation suite. Produces §5 deliverables in one run.

  1. In-domain DS2: per-class P/R/F1, macro-F1 (4-class and 3-class), AUC-ROC,
     normalized confusion matrix.
  2. Calibration: temperature scaling on val, ECE before/after, coverage curves.
  3. NSTDB-augmented DS2: macro-F1 at 24, 18, 12, 6 dB SNR.
  4. CinC 2017 Lead-I transfer (first-class): beat-level N-recall on Normal
     records, record-level dominance, per-rhythm predicted-class distribution.
  5. Deployment benchmark: params, size, peak activation, latency.
  6. Qualitative failure analysis: top confusion pairs.

Can be called for a single checkpoint OR an ensemble manifest.
"""
import os
import sys
import json
import argparse
import numpy as np
import torch
from collections import Counter, defaultdict
from sklearn.metrics import (f1_score, precision_recall_fscore_support,
                                roc_auc_score, confusion_matrix)

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from config import (set_seeds, DEVICE, NUM_CLASSES, AAMI_CLASSES, CLASS_TO_IDX,
                     NSTDB_SNR_LEVELS, CINC2017_DIR, CHECKPOINT_DIR,
                     RESULTS_DIR, BEAT_WINDOW_SAMPLES)
from data.splits import get_val_records, get_test_records
from data.loader import load_dataset_split
from data.cinc_loader import (load_cinc_reference, extract_beats_from_cinc_record,
                                 CINC_EXPECTED_AAMI)
from preprocessing.filtering import zscore_normalize
from models.student_cnn import build_student_model
from training.calibration import fit_temperature, compute_ece, coverage_accuracy
from deployment.benchmark import full_benchmark


def _load_model(ckpt_path, device):
    """Load a single student checkpoint."""
    model = build_student_model(use_fv_head=False, kd_proj_dim=None,
                                  verbose=False)
    ck = torch.load(ckpt_path, map_location=device, weights_only=False)
    state = ck.get('model_state_dict', ck)
    model.load_state_dict(state, strict=False)
    return model.to(device).eval()


def _load_model_or_ensemble(path, device):
    """If path is a manifest (.txt), build EnsembleModel. Else single model."""
    if path.endswith('.txt'):
        from training.ensemble import load_ensemble
        return load_ensemble(path, device=device), True
    return _load_model(path, device), False


@torch.no_grad()
def _predict(model, beats, rr, device, batch_size=256, normalize=True):
    if normalize:
        b = np.asarray([zscore_normalize(x) for x in beats], dtype=np.float32)
    else:
        b = beats.astype(np.float32)
    n = len(b)
    logits_all = np.zeros((n, NUM_CLASSES), dtype=np.float32)
    for i in range(0, n, batch_size):
        xb = torch.from_numpy(b[i:i+batch_size]).float().unsqueeze(-1).to(device)
        xr = torch.from_numpy(rr[i:i+batch_size]).float().to(device)
        out = model(xb, xr)
        l = out[0] if isinstance(out, tuple) else out
        logits_all[i:i+len(l)] = l.cpu().numpy()
    probs = np.exp(logits_all - logits_all.max(axis=1, keepdims=True))
    probs = probs / probs.sum(axis=1, keepdims=True)
    return logits_all, probs


def eval_ds2(model, device, verbose=True):
    """Section 5.1"""
    data = load_dataset_split(get_test_records(), verbose=False)
    logits, probs = _predict(model, data['beats'], data['rr_features'], device)
    preds = probs.argmax(axis=1)
    y = data['label_indices']

    macro_f1_4 = f1_score(y, preds, average='macro',
                            labels=list(range(NUM_CLASSES)), zero_division=0)
    mask3 = y != CLASS_TO_IDX['F']
    if mask3.any():
        macro_f1_3 = f1_score(y[mask3], preds[mask3], average='macro',
                                labels=[CLASS_TO_IDX['N'], CLASS_TO_IDX['S'], CLASS_TO_IDX['V']],
                                zero_division=0)
    else:
        macro_f1_3 = 0.0

    p, r, f, sup = precision_recall_fscore_support(
        y, preds, labels=list(range(NUM_CLASSES)), zero_division=0)
    per_class = {AAMI_CLASSES[c]: {
        'precision': float(p[c]), 'recall': float(r[c]),
        'f1': float(f[c]), 'support': int(sup[c])
    } for c in range(NUM_CLASSES)}

    # AUC one-vs-rest
    aucs = {}
    for c in range(NUM_CLASSES):
        y_bin = (y == c).astype(np.int32)
        if y_bin.sum() > 0 and y_bin.sum() < len(y_bin):
            aucs[AAMI_CLASSES[c]] = float(roc_auc_score(y_bin, probs[:, c]))

    cm = confusion_matrix(y, preds, labels=list(range(NUM_CLASSES)))
    cm_norm = cm / cm.sum(axis=1, keepdims=True).clip(min=1)
    # Top confusion pairs
    confusion_pairs = []
    for t in range(NUM_CLASSES):
        for pi in range(NUM_CLASSES):
            if t != pi and cm[t, pi] > 0:
                confusion_pairs.append({
                    'true': AAMI_CLASSES[t], 'pred': AAMI_CLASSES[pi],
                    'count': int(cm[t, pi]), 'frac': float(cm_norm[t, pi]),
                })
    confusion_pairs.sort(key=lambda d: -d['count'])

    accuracy = float((preds == y).mean())
    result = {
        'macro_f1_4class': float(macro_f1_4),
        'macro_f1_3class': float(macro_f1_3),
        'accuracy': accuracy,
        'per_class': per_class,
        'auc_per_class': aucs,
        'confusion_matrix': cm.tolist(),
        'confusion_matrix_normalized': cm_norm.tolist(),
        'top_confusion_pairs': confusion_pairs[:6],
        'logits': logits, 'probs': probs, 'y': y, 'preds': preds,
    }

    if verbose:
        print(f"\n--- DS2 evaluation ---")
        print(f"  macro-F1 (4-class): {macro_f1_4:.4f}")
        print(f"  macro-F1 (3-class): {macro_f1_3:.4f}")
        print(f"  accuracy:           {accuracy:.4f}")
        for c in AAMI_CLASSES:
            m = per_class[c]
            print(f"  {c}: P={m['precision']:.3f}  R={m['recall']:.3f}  "
                  f"F1={m['f1']:.3f}  n={m['support']}")
        print(f"  Top confusions:     " +
              ", ".join(f"{p['true']}->{p['pred']}:{p['count']}"
                        for p in confusion_pairs[:3]))
    return result


def eval_calibration(model, device, verbose=True):
    """Section 5.1 calibration part."""
    val_data = load_dataset_split(get_val_records(), verbose=False)
    logits, _ = _predict(model, val_data['beats'], val_data['rr_features'], device)
    y_val = val_data['label_indices']
    T = fit_temperature(logits, y_val)

    # Apply T to DS2 predictions for ECE/coverage
    ds2 = load_dataset_split(get_test_records(), verbose=False)
    test_logits, _ = _predict(model, ds2['beats'], ds2['rr_features'], device)
    y_test = ds2['label_indices']

    before_probs = np.exp(test_logits - test_logits.max(1, keepdims=True))
    before_probs /= before_probs.sum(1, keepdims=True)
    scaled = test_logits / T
    after_probs = np.exp(scaled - scaled.max(1, keepdims=True))
    after_probs /= after_probs.sum(1, keepdims=True)

    ece_b = compute_ece(before_probs, y_test)
    ece_a = compute_ece(after_probs, y_test)
    cov = coverage_accuracy(after_probs, y_test)

    result = {'temperature': T, 'ece_before': ece_b, 'ece_after': ece_a, **cov}
    if verbose:
        print(f"\n--- Calibration ---")
        print(f"  Temperature:        {T:.4f}")
        print(f"  ECE before:         {ece_b:.4f}")
        print(f"  ECE after:          {ece_a:.4f}")
        for k, v in cov.items():
            print(f"  {k}: {v:.4f}")
    return result


def eval_nstdb_noise(model, device, verbose=True):
    """Section 5.3 -- inject NSTDB noise at 4 SNR levels and re-score DS2."""
    from config import NSTDB_DIR
    nstdb_files = ['bw', 'em', 'ma']

    # Load NSTDB noise templates (resample to 128 Hz)
    try:
        import wfdb
        from data.loader import downsample_signal
        templates = []
        for n in nstdb_files:
            p = os.path.join(NSTDB_DIR, n)
            try:
                rec = wfdb.rdrecord(p)
                for ch in range(rec.p_signal.shape[1]):
                    t = downsample_signal(rec.p_signal[:, ch].astype(np.float32), 360, 128)
                    templates.append(t.astype(np.float32))
            except Exception:
                continue
    except Exception:
        templates = []

    ds2 = load_dataset_split(get_test_records(), verbose=False)
    y_test = ds2['label_indices']

    rng = np.random.default_rng(42)
    results = {}
    for snr_db in NSTDB_SNR_LEVELS:
        if not templates:
            results[str(snr_db)] = None
            continue
        # Add noise at target SNR per beat
        noisy = ds2['beats'].copy()
        for i in range(len(noisy)):
            sig = noisy[i]
            sig_p = float(np.mean(sig ** 2))
            t = templates[rng.integers(0, len(templates))]
            if len(t) <= BEAT_WINDOW_SAMPLES:
                continue
            start = rng.integers(0, len(t) - BEAT_WINDOW_SAMPLES)
            noise = t[start:start + BEAT_WINDOW_SAMPLES]
            noise_p = float(np.mean(noise ** 2)) + 1e-12
            target_noise_p = sig_p / (10 ** (snr_db / 10.0))
            if noise_p > 0:
                noise = noise * np.sqrt(target_noise_p / noise_p)
            noisy[i] = sig + noise

        _, probs = _predict(model, noisy, ds2['rr_features'], device)
        preds = probs.argmax(1)
        mf1 = f1_score(y_test, preds, average='macro',
                        labels=list(range(NUM_CLASSES)), zero_division=0)
        results[str(snr_db)] = float(mf1)

    if verbose:
        print(f"\n--- NSTDB noise robustness ---")
        for k, v in results.items():
            print(f"  {k} dB SNR: macro-F1 = {v if v is None else f'{v:.4f}'}")
    return results


def eval_cinc_leadI(model, device, max_records=None, verbose=True,
                    only_holdout=False):
    """Section 5.2 -- Lead-I transfer on CinC 2017.

    Args:
        only_holdout: if True, the N-rhythm bucket is restricted to records
            that were held out of supervised augmentation (per
            data.splits.partition_cinc_records). This is the audit-fix
            metric: it answers "how does the model do on N records it has
            never been trained on?". Other rhythm buckets are unaffected.
    """
    set_seeds()
    labels_map = load_cinc_reference()
    by_rhythm = defaultdict(list)
    for rec_id, rhythm in labels_map.items():
        by_rhythm[rhythm].append(rec_id)

    # Audit fix: optionally restrict the N bucket to held-out records.
    holdout_n = None
    if only_holdout:
        from data.splits import cinc_holdout_set
        holdout_n = cinc_holdout_set(by_rhythm.get('N', []))
        if verbose:
            print(f"  [holdout] eval_cinc_leadI restricting N rhythm to "
                  f"{len(holdout_n)} held-out records")
        by_rhythm['N'] = sorted(holdout_n)

    if max_records is not None:
        for r in by_rhythm:
            by_rhythm[r] = by_rhythm[r][:max_records]

    per_rhythm = {}
    per_record_dominant = defaultdict(list)

    for rhythm, recs in sorted(by_rhythm.items()):
        all_preds = []
        conf_vals = []
        for rec_id in recs:
            try:
                data = extract_beats_from_cinc_record(rec_id)
            except Exception:
                continue
            if data['n_valid'] == 0:
                continue
            _, probs = _predict(model, data['beats'], data['rr_features'],
                                  device, normalize=True)
            preds = probs.argmax(1)
            all_preds.extend(preds.tolist())
            conf_vals.extend(probs.max(1).tolist())
            dom = Counter(preds.tolist()).most_common(1)[0][0]
            per_record_dominant[rhythm].append(AAMI_CLASSES[dom])

        if not all_preds:
            per_rhythm[rhythm] = None
            continue

        preds_arr = np.array(all_preds)
        class_dist = {AAMI_CLASSES[c]: float((preds_arr == c).sum() / len(preds_arr))
                       for c in range(NUM_CLASSES)}
        per_rhythm[rhythm] = {
            'n_records': len([r for r in per_record_dominant[rhythm]]),
            'n_beats': len(preds_arr),
            'class_distribution': class_dist,
            'mean_max_confidence': float(np.mean(conf_vals)),
        }

    # Headline metric: Lead-I N-recall
    lead_i_n = per_rhythm.get('N', {}).get('class_distribution', {}).get('N')
    # Record-level N-dominance
    n_doms = per_record_dominant.get('N', [])
    record_n_dom = (sum(1 for d in n_doms if d == 'N') / len(n_doms)) if n_doms else None

    result = {
        'per_rhythm': per_rhythm,
        'lead_i_n_recall_beat_level': lead_i_n,
        'record_level_n_dominance': record_n_dom,
        'per_record_dominant_sample': {r: Counter(v) for r, v in per_record_dominant.items()},
        'eval_mode': 'holdout_only' if only_holdout else 'all_records',
        'holdout_n_record_count': len(holdout_n) if holdout_n is not None else None,
    }
    if verbose:
        print(f"\n--- CinC 2017 Lead-I transfer ---")
        for r in ['N', 'A', 'O', '~']:
            s = per_rhythm.get(r)
            if s is None:
                print(f"  {r}: (no data)")
                continue
            cd = s['class_distribution']
            print(f"  {r}  n_rec={s['n_records']:4d}  n_beat={s['n_beats']:6d}  "
                  f"N={cd['N']:.3f}  S={cd['S']:.3f}  V={cd['V']:.3f}  F={cd['F']:.3f}  "
                  f"conf={s['mean_max_confidence']:.3f}")
        print(f"\n  HEADLINE Lead-I N-recall (beat):     {lead_i_n:.4f}" if lead_i_n else "  HEADLINE: N/A")
        if record_n_dom is not None:
            print(f"  HEADLINE record-level N-dominance:   {record_n_dom:.4f}")
    return result


def run_full_evaluation(ckpt_path, out_json=None, cinc_max=None, verbose=True):
    """Single entry point for §5 evaluation. Returns a results dict."""
    set_seeds()
    device = torch.device(DEVICE)
    model, is_ensemble = _load_model_or_ensemble(ckpt_path, device)

    ds2 = eval_ds2(model, device, verbose=verbose)
    calib = eval_calibration(model, device, verbose=verbose)
    nstdb = eval_nstdb_noise(model, device, verbose=verbose)
    # Run CinC eval twice: once on all records (legacy, training-pool overlap),
    # once on the held-out subset only (audit fix — reports honest cross-domain
    # transfer). The "honest" number is `cinc_holdout`; `cinc` is kept for
    # back-compat with prior result schemas.
    cinc = eval_cinc_leadI(model, device, max_records=cinc_max,
                           verbose=verbose, only_holdout=False)
    from config import CINC_HOLDOUT_ENABLED
    cinc_holdout = None
    if CINC_HOLDOUT_ENABLED:
        if verbose:
            print("\n[CinC held-out evaluation — records NOT used for supervised aug]")
        cinc_holdout = eval_cinc_leadI(model, device, max_records=cinc_max,
                                       verbose=verbose, only_holdout=True)

    # Deployment: only on single checkpoints (ensemble deployed as 3x cost)
    deploy = None
    if not is_ensemble:
        deploy = full_benchmark(model, verbose=verbose)

    results = {
        'checkpoint': ckpt_path,
        'is_ensemble': is_ensemble,
        'ds2': {k: v for k, v in ds2.items()
                if k not in ('logits', 'probs', 'y', 'preds')},
        'calibration': calib,
        'snr_robustness': nstdb,
        'cinc_leadI': cinc,
        'cinc_leadI_holdout': cinc_holdout,
        'deployment': deploy,
    }

    # --- Target gates (§5.5) ---
    targets = {
        'DS2_macro_f1_4class >= 0.62': ds2['macro_f1_4class'] >= 0.62,
        'DS2_macro_f1_3class >= 0.80': ds2['macro_f1_3class'] >= 0.80,
        'DS2_V_recall >= 0.90': ds2['per_class']['V']['recall'] >= 0.90,
        'DS2_S_recall >= 0.60': ds2['per_class']['S']['recall'] >= 0.60,
        'CinC_N_recall_beat >= 0.80': (cinc['lead_i_n_recall_beat_level'] or 0) >= 0.80,
        'CinC_record_N_dom >= 0.93': (cinc['record_level_n_dominance'] or 0) >= 0.93,
        'NSTDB_6dB_macro_f1 >= 0.55': (nstdb.get('6') or 0) >= 0.55,
    }
    results['targets'] = targets

    if verbose:
        print(f"\n--- v2 target gates (§5.5) ---")
        for k, passed in targets.items():
            flag = 'PASS' if passed else 'FAIL'
            print(f"  [{flag}] {k}")

    if out_json is not None:
        os.makedirs(os.path.dirname(out_json), exist_ok=True)
        with open(out_json, 'w') as f:
            json.dump(results, f, indent=2, default=str)
        if verbose:
            print(f"\nResults written: {out_json}")

    return results


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument('--ckpt', type=str, required=True,
                    help='Checkpoint .pt path or ensemble manifest .txt')
    p.add_argument('--out', type=str, default=None,
                    help='Output JSON path (default: RESULTS_DIR/eval_<stem>.json)')
    p.add_argument('--cinc-max', type=int, default=None)
    return p.parse_args()


if __name__ == "__main__":
    args = parse_args()
    out = args.out or os.path.join(
        RESULTS_DIR, f"eval_{os.path.splitext(os.path.basename(args.ckpt))[0]}.json")
    run_full_evaluation(args.ckpt, out_json=out, cinc_max=args.cinc_max)
