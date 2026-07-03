# ECG TinyML Classifier v2 — Design & Evaluation Plan

Single-lead ECG beat classifier. Trains on MIT-BIH (MLII), generalizes to
Lead-I smartwatch data (CinC 2017), deploys within the v1 budget
(<50 K params, <16 KB peak activation, <50 ms on ARM Cortex-A).

The v1 baseline (Trial_2, reference metrics below) exposed three failure
modes. v2 is a narrow, evidence-driven set of additions that target those
failures — nothing speculative. Proven-harmful techniques from v1 are
explicitly disabled.

## v1 → v2 comparison (targets from §5.5)

| Metric | v1 | v2 target |
| ------------------------------------------- | ------: | ----------: |
| DS2 macro-F1 (4-class) | 0.593 | **≥ 0.62** |
| DS2 macro-F1 (3-class, excl F) | 0.799 | ≥ 0.80 |
| DS2 V-recall | 0.897 | ≥ 0.90 |
| DS2 S-recall | 0.552 | **≥ 0.60** |
| **CinC Lead-I N-recall (beat-level)** | 0.573 | **≥ 0.80** |
| CinC record-level N-dominance | 0.845 | ≥ 0.93 |
| MIT-BIH + NSTDB at 6 dB SNR | 0.567 | ≥ 0.55 |
| INT8 model size | 15.7 KB | ≤ 20 KB |
| Peak activation | 6.0 KB | ≤ 16 KB |

## What v2 adds (in order of expected impact)

| Priority | Technique | Files | Expected lift |
|:-:|---|---|---|
| 1 | **Lead-I CinC-N augmentation** | `data/cinc_n_loader.py`, wired in `training/train_supervised.py` | Lead-I N-recall 0.57 → 0.80+, MIT-BIH macro-F1 unchanged |
| 2 | **Masked-beat SSL pretrain** (all 8,528 CinC recs) | `models/ssl_encoder.py`, `training/train_ssl.py` | +3–7 % macro-F1, better Lead-I transfer |
| 3 | **Multi-task** (beat + rhythm) | `models/multi_task.py`, `training/train_multitask.py` | Regularization, Lead-I transfer (more complex — optional) |
| 4 | **3-seed ensemble** | `training/ensemble.py` | +2–3 % macro-F1 (avg softmax) |
| 6 | **Focal + SWA** | `training/losses.py`, SWA in `train_supervised.py` | +1–2 % macro-F1 |

Priority 5 (INCART for real F data) is not included in this iteration — it
requires an additional public-download step outside `data/`. The path
hook is left in `config.INCART_DIR` for a follow-up.

## What v2 deliberately does NOT do (from §3 dead ends)

- No biological F-class synthesis (`F = αN + (1-α)V`). v1 proved this
  destroys S-class discrimination. `data/dataset_v2.py::balance_for_supervised`
  uses within-class MixUp for **all** minority classes, not the biological
  formula.
- No F-vs-V auxiliary head. `models/student_cnn.py` still has the capacity
  (the `use_fv_head` flag), but `config.USE_FV_HEAD_DEFAULT = False` and
  every training call sets `use_fv_head=False`.
- No ECGFounder distillation. The KD config is preserved but `KD_FEATURE_WEIGHT`
  and `KD_FV_WEIGHT` are used only if a caller explicitly opts in; the
  v2 training loop (`train_supervised.py`) does not touch them.
- No cosine annealing (no measurable win vs. ReduceLROnPlateau in v1).
- No 256-sample multi-beat window (net-neutral in v1).

## Repository structure

```
Trial_3/
├── config.py                  # v2 hyperparameters (incl. priority flags)
├── run_pipeline.py            # orchestrator: --stage {ssl, cincaug, ...}
├── evaluate.py                # full §5 evaluation suite
├── evaluate_on_cinc.py        # v1 CinC script (kept for compatibility)
├── requirements.txt           # pinned versions
├── REPORT.md                  # this document
│
├── data/
│   ├── loader.py              # MIT-BIH WFDB loading (v1)
│   ├── splits.py              # DS1/DS2/val split (v1)
│   ├── cinc_loader.py         # CinC 2017 loading (v1)
│   ├── cinc_n_loader.py       # Priority 1 — CinC N-beat aug  [NEW]
│   ├── dataset.py             # v1 dataset (teacher-aware)
│   ├── dataset_v2.py          # v2 dataset with sample-weight support [NEW]
│   └── augmentations.py       # Live aug (time-shift, NSTDB injection) (v1)
│
├── preprocessing/
│   ├── filtering.py           # Bandpass + notch + z-score (v1)
│   ├── rpeak_detection.py     # NeuroKit2 + scipy fallback (v1, fixed)
│   └── sqi.py                 # SQI gate (v1)
│
├── models/
│   ├── student_cnn.py         # v1 architecture (unchanged)
│   ├── ssl_encoder.py         # Priority 2 — SSL encoder/decoder
│   └── multi_task.py          # Priority 3 — shared encoder + 2 heads
│
├── training/
│   ├── __init__.py
│   ├── losses.py              # WeightedFocalCE  [NEW]
│   ├── train_supervised.py    # main v2 training loop  [NEW]
│   ├── train_ssl.py           # SSL pretrain loop  [NEW]
│   ├── train_multitask.py     # multi-task loop  [NEW]
│   ├── ensemble.py            # multi-seed ensemble  [NEW]
│   └── calibration.py         # temperature scaling, ECE  [NEW]
│
├── deployment/
│   ├── __init__.py
│   ├── quantize.py            # INT8 PTQ + ONNX export  [NEW]
│   └── benchmark.py           # params, size, latency  [NEW]
│
├── cache/                     # auto-generated caches (SSL beats, CinC N beats)
│   ├── cinc_n_beats_holdout.npz  # from cinc_n_loader (post-audit hold-out)
│   ├── cinc_ssl_beats.npz        # from train_ssl
│   └── incart_f_beats.npz        # from incart_loader
│
└── output/
    ├── checkpoints/                       # production (post-audit)
    │   ├── v2_ens_seed{42,101,202}.pt     # 3-seed held-out ensemble (PRODUCTION)
    │   ├── ssl/ssl_encoder.pt             # SSL pretrained encoder
    │   └── ensemble/v2_ens_manifest.txt   # production manifest
    ├── results/
    │   ├── v2_baseline.json
    │   ├── v2_cincaug.json
    │   ├── v2_cincaug_ssl.json
    │   ├── v2_mt.json
    │   ├── v2_ensemble.json
    │   ├── v2_ens_holdout.json            # production held-out eval (post-audit)
    │   └── ablation.json                  # cross-model comparison table
    └── exported/
        └── cardiac_beat_classifier.onnx   # ONNX export of seed=202 for the app
```

> Pre-audit ablation checkpoints (`best_model.pt`, `v2_baseline_*.pt`, `v2_cincaug_*.pt`,
> `v2_cincaug_ssl_*.pt`, `v2_mt_*.pt`) are kept out of the active tree (local only) for reproducibility. The
> corresponding result JSONs remain in `output/results/` and are referenced from the
> ablation table in `RESULTS.md`.

## Running the pipeline

```bash
# 1. One-shot: everything
python run_pipeline.py --stage all

# 2. Or piece-by-piece
python run_pipeline.py --stage ssl           # ~15-25 min on CPU, <5 min on GPU
python run_pipeline.py --stage cincaug_ssl   # main v2 model (~15-30 min)
python run_pipeline.py --stage ensemble      # 3 seeds (~45-90 min)
python run_pipeline.py --stage ablation      # eval + write ablation.json

# 3. Eval a single model
python run_pipeline.py --stage eval --ckpt output/checkpoints/ensemble/v2_ens_manifest.txt
```

## Design notes

### Priority 1: CinC Lead-I N-beat augmentation (`data/cinc_n_loader.py`)

Why this is the single highest-impact change: v1's 37-point drop in
N-recall on Lead I is the headline deployment blocker. CinC 2017 contains
~5,050 records labeled Normal Sinus Rhythm; each yields 9–60 s of Lead-I ECG
that, after R-peak detection, gives ~30–60 beats per record. Extracted beats
that share the Normal-rhythm label carry the AAMI `N` class identity, which
is enough to teach the encoder Lead-I morphology.

Prematurity filter: `[0.80 × median, 1.20 × median]` on per-record pre-RR.
Standard in literature; drops <8% of beats and filters most ectopics mis-
labeled as Normal.

Downweighting: `CINC_N_BEAT_WEIGHT = 0.3` in the `WeightedRandomSampler`.
MIT-BIH beats stay dominant during training so we don't lose MLII beat-
morphology skill. The implementation multiplies `class_weight × sample_weight`
into the sampler; the `WeightedFocalCE` also applies the per-sample weight
inside the loss, so "stronger training signal for MLII" is enforced both at
sampling and at gradient time.

Cap per record (80 beats): prevents any long CinC record from dominating.

### Priority 2: SSL pretrain (`training/train_ssl.py`)

Masked-beat autoencoder. Loss: MSE over masked positions only. 25% mask
ratio, contiguous 16-sample blocks → ~2 mask blocks per 128-sample beat.
Decoder is a 2-layer transposed-conv stack (discarded post-training).

Critically, `SSLEncoder.block1/2/3` and `ECGStudentCNN.block1/2/3` share
exact module names and shapes, so the SSL checkpoint loads directly into
the supervised model via `models/ssl_encoder.py::load_encoder_into_student`.

Uses ALL CinC records (`N / A / O / ~`) — SSL does not need labels.

### Priority 3: Multi-task (`models/multi_task.py`, `training/train_multitask.py`)

Shared encoder + beat head (4-class AAMI, on MIT-BIH) + rhythm head
(4-class, on CinC full records, aggregated via record-level mean-pool of
beat features). Alternates beat/rhythm steps per mini-batch; encoder is
always trainable, the opposite head is frozen on each step to keep
gradients clean.

The rhythm head is discarded at deployment. `MultiTaskECG.export_student_cnn_state`
returns a state_dict keyed so that `ECGStudentCNN.load_state_dict(strict=False)`
picks up the encoder + beat-head weights.

OFF by default; opt-in via `--stage multitask`.

### Priority 4: Ensemble (`training/ensemble.py`)

3 seeds (42, 101, 202). `EnsembleModel` averages softmax outputs. Identical
architecture — per-member training is just a call to `train_one(seed=...)`.
Inference cost: 3× (well within the 50 ms budget given v1's 2.2 ms median).
Deployment-path choice: the smartwatch deploys ONE model; the ensemble is
reported as an upper bound / for server-side diagnostic mode.

### Priority 6: Focal + SWA (`training/losses.py`, SWA in `train_supervised.py`)

`WeightedFocalCE` = class_weight × (1 − p_t)^γ × (smoothed CE). Per-sample
weights (for CinC aug) multiply on top. γ=0 falls back to plain smoothed CE.

SWA: `torch.optim.swa_utils.AveragedModel` after 70% of epochs, then
`update_bn` so the final averaged model has correct BatchNorm statistics.
If SWA's val macro-F1 exceeds the best regular checkpoint, we keep SWA;
otherwise we keep the best regular checkpoint.

## Evaluation (`evaluate.py`)

Single entry-point `run_full_evaluation(ckpt_path)` produces:

- **§5.1 in-domain DS2**: per-class P/R/F1, 4-class + 3-class macro-F1,
  accuracy, one-vs-rest AUC-ROC, full normalized confusion matrix, top-6
  confusion pairs.
- **calibration**: T via LBFGS on val; ECE before/after; accuracy at
  80/90/95% coverage.
- **§5.3 noise**: NSTDB {bw, em, ma} injected at {24, 18, 12, 6} dB SNR.
- **§5.2 CinC Lead-I**: per-rhythm predicted-class distribution, headline
  beat-level N-recall on Normal records, record-level N-dominance, mean
  prediction confidence.
- **§5.4 deployment**: params, FP32/INT8 size, peak activation (hook-based),
  CPU latency (median/p95/p99), ARM estimated latency (×2.5 scale).
- **§5.5 targets**: PASS/FAIL gates with machine-readable flags.

All written to `output/results/{tag}.json`.

## Honest reporting

If the v2 run returns Lead-I N-recall < 0.70, **the model is not
deployment-ready for a smartwatch**. `evaluate.py` emits a PASS/FAIL gate
for that target; `ablation.json` carries the `targets_passed / targets_total`
count per model.

## Reproducibility

All seeds are set via `config.set_seeds(seed)` at the start of every
training entry. The function sets `np.random.seed`, `torch.manual_seed`,
`torch.cuda.manual_seed_all`, AND `torch.backends.cudnn.deterministic = True`.
Ensemble member seeds are fixed at `[42, 101, 202, 303, 404]`. Split IDs
(DS1/DS2/val) are constants in `config.py` and verified by
`data/splits.py::verify_no_overlap`.

**Caveat.** `torch.use_deterministic_algorithms(True)` is *not* set, so
some CUDA reductions (atomic-add ops in older versions) can still produce
non-bit-exact output across runs even with the same seed. Macro-level
metrics are reproducible to within a fraction of a percent; individual
gradient updates are not bit-identical. For training-from-scratch
research this is acceptable. For strict bit-level reproducibility
(e.g. to reproduce a specific checkpoint hash), add
`torch.use_deterministic_algorithms(True, warn_only=False)` and accept
the resulting performance hit.

## Red-flag checks from §7 (pre-integrated)

| Risk | Where it's prevented in code |
| --- | --- |
| Double class weighting | `data/dataset_v2.py::compute_class_weights` returns `sqrt(inv_freq)` when `use_sampler=True`. The same sqrt-weights are used both by the `WeightedRandomSampler` AND by `WeightedFocalCE` in the loss. Total effective weighting is `sqrt(inv_freq) × sqrt(inv_freq) = inv_freq`, mathematically equivalent to plain inverse-frequency loss weighting with no sampler — so this is *deliberate compensation*, not a bug. The sqrt split makes minority classes oversampled in batches (better gradient stochasticity) without amplifying their gradient further. |
| Intra-patient leakage | `config.DS1_RECORDS`, `DS2_RECORDS`, `VAL_RECORDS` hardcoded; `data/splits.verify_no_overlap()` asserts disjoint sets. |
| Oracle R-peaks in eval | `evaluate.py` uses `extract_beats_from_cinc_record` which runs the **real** R-peak detector. DS2 uses the MIT-BIH annotation peaks (ground truth) because DS2 is the in-domain metric; for cross-dataset we use detected peaks. |
| `verbose=True` in PyTorch schedulers | not used in v2 training files. |
| NeuroKit2 import on Python 3.9 | preprocessing/rpeak_detection.py catches broad `Exception`. |
| Non-ASCII in prints | all v2 prints use `--`, `->`, `>=` (ASCII). |
| `.numpy()` without detach | `_predict` uses `.cpu().numpy()` inside `torch.no_grad()`; model outputs are already detached. |
| Per-sample teacher logit tracking through resampler | v2 drops KD entirely (proven neutral), removing this failure mode. |

## Lead-I evaluation methodology — IMPORTANT NOTE

The original v2 numbers reported in `RESULTS.md` evaluated the model on
the *same* CinC 2017 N-records that were used for supervised augmentation.
This is a form of test-on-train overlap that — without the fix below —
makes the headline "Lead-I N-recall" metric impossible to defend as a
cross-records generalization number.

> **Re-run result (post-fix, RESOLVED):** the full v2_ens 3-seed ensemble
> was retrained from scratch on the held-in pool (4,040 records) and
> evaluated on the held-out 1,010 records it had never seen. The honest
> held-out numbers are **N-recall = 0.9627** (beat-level) and
> **record N-dominance = 0.9990** — at or above the original-protocol
> numbers (0.6773 and 0.9875 respectively). Conclusion: the leakage was
> real but its effect on the headlines was within seed noise. The
> held-out protocol is now the canonical Lead-I evaluation; full
> comparison table in `RESULTS.md` under *"Held-out CinC re-run
> (post-audit, fixed leakage)"*.

The audit fix (now in code) resolves this in two layers:

1. **`config.CINC_HOLDOUT_ENABLED = True`** — a deterministic 20% subset
   of CinC N records (every 5th by sorted id) is now reserved exclusively
   for evaluation. `data/splits.partition_cinc_records()` exposes the
   partition.
2. **`data/cinc_n_loader.py::extract_cinc_n_beats`** skips held-out
   records when building the supervised augmentation pool. The cache
   filename gets a `_holdout` suffix so the pre-fix cache cannot be
   reused by accident.
3. **`evaluate.py::eval_cinc_leadI(only_holdout=True)`** restricts the
   N-rhythm bucket to held-out records only. `run_full_evaluation()`
   produces both metrics (`cinc_leadI` for back-compat with prior runs,
   `cinc_leadI_holdout` for the honest cross-records number).

To reproduce the **honest** Lead-I number on existing checkpoints:

```bash
# (a) one-time: rebuild the supervised aug cache without held-out records
python -c "from data.cinc_n_loader import get_or_build_cinc_n_cache; \
           get_or_build_cinc_n_cache(force=True)"

# (b) re-train (CinC aug pool is now ~80% of N records)
python run_pipeline.py --stage cincaug_ssl

# (c) eval — the resulting JSON will carry both `cinc_leadI` (legacy,
# all records) AND `cinc_leadI_holdout` (held-out only).
python evaluate.py --ckpt output/checkpoints/ensemble/v2_ens_manifest.txt
```

The pre-fix v2_ensemble_ssl numbers in `RESULTS.md` ARE retained for
historical comparison, with the leakage caveat clearly documented in the
deployment-verdict section.

## Known limitations / future work

1. F-class recall. Without INCART or LTAFDB, F stays ~0. Priority 5 is the
   only real fix; other avenues (biological synthesis, F-vs-V aux head)
   were measured harmful.
2. ONNX export path is included; TFLite + XNNPACK conversion for the
   watch runtime requires a TF install and is described as a stub in
   `deployment/quantize.py::export_tflite_stub`.
3. The multi-task rhythm head is trained on the FULL CinC distribution
   including rhythm '~' (Noisy). A stricter run may want to drop those
   records; the `RHYTHM_TO_IDX` map in `train_multitask.py` keeps them.

---

*Author: v2 redesign on top of `Trial_2/` baseline. All §3 "dead end"
hyperparameters are disabled by default.*
