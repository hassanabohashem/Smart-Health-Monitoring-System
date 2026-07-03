"""
v2 pipeline orchestrator. Designed to be runnable end-to-end:

    python run_pipeline.py --stage all          # everything
    python run_pipeline.py --stage ssl          # just SSL pre-training
    python run_pipeline.py --stage baseline     # one model, no CinC aug (v1-style)
    python run_pipeline.py --stage cincaug      # v2-a: CinC aug only
    python run_pipeline.py --stage cincaug_ssl  # v2-b: + SSL init
    python run_pipeline.py --stage multitask    # v2-c: multi-task
    python run_pipeline.py --stage ensemble     # v2-d: 3-seed ensemble
    python run_pipeline.py --stage eval         # run full eval against all stages
    python run_pipeline.py --stage ablation     # writes ablation.json
"""
import os
import sys
import argparse
import json
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from config import (set_seeds, CHECKPOINT_DIR, RESULTS_DIR, SSL_CHECKPOINT,
                     ENSEMBLE_DIR, ENSEMBLE_SIZE)


# Stage outputs
OUT = {
    'ssl':          os.path.join(CHECKPOINT_DIR, 'ssl', 'ssl_encoder.pt'),
    'baseline':     os.path.join(CHECKPOINT_DIR, 'v2_baseline_seed42.pt'),
    'cincaug':      os.path.join(CHECKPOINT_DIR, 'v2_cincaug_seed42.pt'),
    'cincaug_ssl':  os.path.join(CHECKPOINT_DIR, 'v2_cincaug_ssl_seed42.pt'),
    'multitask':    os.path.join(CHECKPOINT_DIR, 'v2_mt_seed42.pt'),
    'ensemble':     os.path.join(ENSEMBLE_DIR, 'v2_ens_manifest.txt'),
}


def stage_ssl(verbose=True):
    from training.train_ssl import train_ssl
    print("\n### STAGE: SSL pre-training (Priority 2) ###")
    ckpt, _ = train_ssl(verbose=verbose)
    return ckpt


def stage_baseline(verbose=True):
    from training.train_supervised import train_one
    print("\n### STAGE: baseline (no CinC aug, no SSL) ###")
    path, metrics, _ = train_one(
        use_cinc_aug=False, ssl_ckpt=None,
        use_focal=True, use_swa=True,
        seed=42, tag='v2_baseline', verbose=verbose)
    return path, metrics


def stage_cincaug(verbose=True):
    from training.train_supervised import train_one
    print("\n### STAGE: CinC Lead-I aug (Priority 1) ###")
    path, metrics, _ = train_one(
        use_cinc_aug=True, ssl_ckpt=None,
        use_focal=True, use_swa=True,
        seed=42, tag='v2_cincaug', verbose=verbose)
    return path, metrics


def stage_cincaug_ssl(verbose=True):
    from training.train_supervised import train_one
    print("\n### STAGE: CinC aug + SSL init (Priority 1 + 2) ###")
    if not os.path.exists(SSL_CHECKPOINT):
        print(f"  SSL checkpoint missing at {SSL_CHECKPOINT} -- running SSL first.")
        stage_ssl(verbose=verbose)
    path, metrics, _ = train_one(
        use_cinc_aug=True, ssl_ckpt=SSL_CHECKPOINT,
        use_focal=True, use_swa=True,
        seed=42, tag='v2_cincaug_ssl', verbose=verbose)
    return path, metrics


def stage_multitask(verbose=True):
    from training.train_multitask import train_multitask
    print("\n### STAGE: Multi-task (Priority 3) ###")
    path, metrics, _ = train_multitask(seed=42, tag='v2_mt', verbose=verbose)
    return path, metrics


def stage_ensemble(use_ssl=True, verbose=True):
    from training.ensemble import train_ensemble
    print(f"\n### STAGE: Ensemble (Priority 4, size={ENSEMBLE_SIZE}) ###")
    ssl_ckpt = SSL_CHECKPOINT if use_ssl and os.path.exists(SSL_CHECKPOINT) else None
    ckpts = train_ensemble(base_tag='v2_ens', ssl_ckpt=ssl_ckpt,
                             use_cinc_aug=True, use_focal=True, use_swa=True,
                             verbose=verbose)
    # Write manifest
    os.makedirs(ENSEMBLE_DIR, exist_ok=True)
    manifest = os.path.join(ENSEMBLE_DIR, 'v2_ens_manifest.txt')
    with open(manifest, 'w') as f:
        for p in ckpts:
            f.write(p + "\n")
    print(f"  Ensemble manifest: {manifest}")
    return manifest


def stage_eval_single(ckpt_path, out_json, verbose=True):
    from scripts.evaluate import run_full_evaluation
    return run_full_evaluation(ckpt_path, out_json=out_json, verbose=verbose)


def stage_ablation(verbose=True):
    """Produces an ablation table across all trained models."""
    print("\n### STAGE: Ablation (full §8 comparison table) ###")
    rows = {}
    candidates = [
        ('v1_baseline', os.path.join(CHECKPOINT_DIR, 'best_model.pt')),
        ('v2_baseline', OUT['baseline']),
        ('v2_cincaug', OUT['cincaug']),
        ('v2_cincaug_ssl', OUT['cincaug_ssl']),
        ('v2_multitask', OUT['multitask']),
        ('v2_ensemble', OUT['ensemble']),
    ]
    for name, path in candidates:
        if not os.path.exists(path):
            print(f"  {name}: checkpoint missing -- skipping")
            continue
        print(f"\n>>> Evaluating: {name}  ({path})")
        try:
            results = stage_eval_single(
                path, os.path.join(RESULTS_DIR, f"{name}.json"),
                verbose=verbose)
        except Exception as e:
            print(f"  {name}: eval failed -- {e}")
            continue
        rows[name] = {
            'ds2_macro_f1_4': results['ds2']['macro_f1_4class'],
            'ds2_macro_f1_3': results['ds2']['macro_f1_3class'],
            'ds2_V_recall': results['ds2']['per_class']['V']['recall'],
            'ds2_S_recall': results['ds2']['per_class']['S']['recall'],
            'ds2_F_F1': results['ds2']['per_class']['F']['f1'],
            'ds2_accuracy': results['ds2']['accuracy'],
            'cinc_leadI_N_recall': results['cinc_leadI']['lead_i_n_recall_beat_level'],
            'cinc_record_N_dom': results['cinc_leadI']['record_level_n_dominance'],
            'nstdb_6dB': results['snr_robustness'].get('6'),
            'fp32_kb': (results.get('deployment') or {}).get('fp32_size_kb'),
            'params': (results.get('deployment') or {}).get('total_params'),
            'arm_median_ms': (results.get('deployment') or {}).get('arm_estimated_median_ms'),
            'targets_passed': sum(1 for v in results['targets'].values() if v),
            'targets_total': len(results['targets']),
        }

    out_path = os.path.join(RESULTS_DIR, 'ablation.json')
    with open(out_path, 'w') as f:
        json.dump(rows, f, indent=2, default=str)

    # Pretty print
    print(f"\n{'='*110}")
    print(f"v2 ABLATION SUMMARY")
    print(f"{'='*110}")
    cols = ['ds2_macro_f1_4', 'ds2_V_recall', 'ds2_S_recall', 'ds2_F_F1',
             'cinc_leadI_N_recall', 'cinc_record_N_dom', 'nstdb_6dB',
             'params', 'arm_median_ms', 'targets_passed']
    header = f"{'model':<22}" + ''.join(f"{c:>14}" for c in cols)
    print(header)
    print('-' * len(header))
    for name, r in rows.items():
        cells = []
        for c in cols:
            v = r.get(c)
            if v is None:
                cells.append(f"{'--':>14}")
            elif isinstance(v, float):
                cells.append(f"{v:>14.4f}")
            else:
                cells.append(f"{v:>14}")
        print(f"{name:<22}" + ''.join(cells))
    print(f"\nSaved: {out_path}")
    return rows


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument('--stage', type=str, default='all',
                    choices=['all', 'ssl', 'baseline', 'cincaug',
                             'cincaug_ssl', 'multitask', 'ensemble',
                             'eval', 'ablation'])
    p.add_argument('--ckpt', type=str, default=None,
                    help='For --stage eval: checkpoint or ensemble manifest')
    p.add_argument('--no-mt', action='store_true',
                    help='Skip multi-task in --stage all')
    p.add_argument('--no-ensemble', action='store_true',
                    help='Skip ensemble in --stage all')
    p.add_argument('--quiet', action='store_true')
    return p.parse_args()


def main():
    set_seeds()
    args = parse_args()
    verbose = not args.quiet
    t0 = time.time()

    if args.stage == 'ssl':
        stage_ssl(verbose=verbose)
    elif args.stage == 'baseline':
        stage_baseline(verbose=verbose)
    elif args.stage == 'cincaug':
        stage_cincaug(verbose=verbose)
    elif args.stage == 'cincaug_ssl':
        stage_cincaug_ssl(verbose=verbose)
    elif args.stage == 'multitask':
        stage_multitask(verbose=verbose)
    elif args.stage == 'ensemble':
        stage_ensemble(verbose=verbose)
    elif args.stage == 'eval':
        if args.ckpt is None:
            sys.exit("--stage eval requires --ckpt")
        out = os.path.join(RESULTS_DIR,
                            f"eval_{os.path.splitext(os.path.basename(args.ckpt))[0]}.json")
        stage_eval_single(args.ckpt, out, verbose=verbose)
    elif args.stage == 'ablation':
        stage_ablation(verbose=verbose)
    elif args.stage == 'all':
        stage_ssl(verbose=verbose)
        stage_baseline(verbose=verbose)
        stage_cincaug(verbose=verbose)
        stage_cincaug_ssl(verbose=verbose)
        if not args.no_mt:
            stage_multitask(verbose=verbose)
        if not args.no_ensemble:
            stage_ensemble(verbose=verbose)
        stage_ablation(verbose=verbose)

    print(f"\nTotal elapsed: {(time.time() - t0) / 60:.1f} min")


if __name__ == "__main__":
    main()
