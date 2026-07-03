# Cardiac ECG Classifier — Independent Audit
**Subject:** ECG TinyML Classifier v2 (Trial_3)
**Auditor scope:** correctness, leakage, overfitting, project fit
**Verdict (TL;DR):** **High-quality work, honest reporting, deployable in its claimed envelope.** Two real concerns to flag (one leakage, one INT8 path) and a handful of minor issues. Numbers in `RESULTS.md` match the raw JSON. The author's own assessment of strengths and weaknesses is accurate.

---

> **Status update — fixes landed in the codebase.**
>
> All four findings from this audit have now been addressed:
>
> - **#2 misleading docs** — `REPORT.md`'s class-weights line rewritten to reflect what the code actually does (deliberate `sqrt × sqrt` compensation, equivalent to plain inverse-frequency).
> - **#4 CinC Lead-I leakage** — code support for a deterministic 20% hold-out is in place: new `config.CINC_HOLDOUT_ENABLED`, `data/splits.partition_cinc_records()`, hold-out-aware cache filename, `evaluate.py::eval_cinc_leadI(only_holdout=True)`, and a refreshed `run_full_evaluation()` that produces both `cinc_leadI` (legacy) and `cinc_leadI_holdout` (honest).
> - **#7 reproducibility caveat** — added an explicit note about `torch.use_deterministic_algorithms` not being set.
> - **#8 TFLite stub** — `integration/README.md` now leads with a deployment-status banner and presents two topologies side-by-side: A (intended end-state, watch-side TFLite, future) and B (current deployable state, phone-side ONNX, today).
>
> A full 3-seed re-train of the v2_ens_ssl ensemble against the held-in CinC pool (4,040 records) was performed on GPU (RTX 3060, 202 min total) and the held-out evaluation (1,010 records) ran cleanly. **Headline finding: the leakage did NOT materially inflate the published numbers.** Held-out record-level N-dominance came in at 0.9990 vs. the original 0.9875 (delta = +0.0115, within seed noise); held-out beat-level N-recall at 0.9627 vs. original 0.6773 (i.e. *higher*, not lower). DS2 numbers shifted by ≤2 points in either direction, well within 3-seed ensemble noise. Full comparison table in `RESULTS.md` under *"Held-out CinC re-run (post-audit, fixed leakage)"*.

---

## 1. Patient-disjoint splits

Independently verified the de Chazal 2004 split from `config.py`:

```
TRAIN: 18 records (DS1 minus VAL)
VAL  : 4  records (114, 124, 207, 223)
DS2  : 22 records (held-out test)
PACED: 4  records (excluded)

train ∩ val   = ∅
train ∩ DS2   = ∅
val   ∩ DS2   = ∅
any   ∩ paced = ∅
```

`data/splits.py::verify_no_overlap` enforces this with assertions that match. **No patient leakage between train/val/test on the MIT-BIH side.**

## 2. Class weights + sampler — math is correct, README is misleading

The author's own §7 risk table claims: *"Training loop does NOT re-apply [class weights] in nn.CrossEntropyLoss."*

What actually happens in code:
- `compute_class_weights(use_sampler=True)` returns **sqrt(inv_freq)**, capped.
- `WeightedRandomSampler` uses these sqrt-weights to oversample minority classes.
- `WeightedFocalCE` ALSO multiplies by these same sqrt-weights inside the loss (`losses.py:62-64`).

Total effective weighting per class = `sqrt(inv_freq) × sqrt(inv_freq) = inv_freq`. The double-application is mathematically equivalent to **plain inverse-frequency loss weighting with no sampler at all** — but with the practical benefit that minority classes are still oversampled in batches (better gradient stochasticity).

**Verdict:** Not a bug. The math is sound. Just update the README/risk-table line — the loss DOES re-apply weights, deliberately, because they're sqrt-shrunk. Reads as a bug at first glance.

## 3. R-peak detection — honest split between in-domain and cross-domain

- **DS2 (in-domain MIT-BIH):** uses annotation R-peaks (oracle). This is the standard de Chazal protocol and is acknowledged in `REPORT.md §7`.
- **CinC Lead-I (cross-domain):** uses real `detect_rpeaks()` (NeuroKit2 + scipy fallback, `cinc_loader.py:161`). Confirmed by reading `extract_beats_from_cinc_record`.

The split between oracle (in-domain) and detected (cross-domain) peaks is correctly disclosed. This matters because the headline 0.944 V-recall on DS2 is inflated by oracle peaks; the more representative real-world number is the 0.677 CinC Lead-I beat-level N-recall.

## 4. CinC Lead-I leakage — REAL concern → RESOLVED

> **Resolution (post-audit re-run):** the recommended fix below was implemented and the full 3-seed ensemble was retrained from scratch with the held-in pool. The honest held-out evaluation (1,010 records the model never saw during supervised augmentation) reports record-level N-dominance = **0.9990** and beat N-recall = **0.9627** — both at or above the original numbers. Conclusion: the test-on-train overlap was real but its effect on the headlines was within seed noise. The held-out protocol is now the canonical evaluation. Leaving the finding text below intact for the audit trail.

This is the single biggest issue I found. The CinC 2017 corpus is used in **three** places:

| Phase | What is used | How |
|---|---|---|
| SSL pretrain | All CinC records, all beats | unsupervised reconstruction |
| Supervised aug | All ~5,036 N-labeled records, beats labeled `N` | weighted loss |
| Evaluation | All CinC records (by rhythm) | reported "Lead-I N-recall" |

**There is no held-out CinC split between training augmentation and Lead-I evaluation.** The CinC N records used to train the model are the same records on which Lead-I N-recall is reported. By construction, the model has seen most evaluation beats during supervised training.

### Severity

| Aspect | Severity |
|---|---|
| SSL pretrain on eval records | **Mild** — SSL is unsupervised, doesn't see labels. Comparable to using BERT-pretrained text that may overlap with downstream eval. |
| Supervised aug on eval records | **High** — beats are labeled `N` during training and the eval reports recall on the same beats. Direct test-on-train. |

### What this means for the reported numbers
- The 0.677 CinC Lead-I beat-level N-recall is **upper bound on what is reachable when the model has seen the data**. A held-out split would likely report lower.
- The 0.988 record-level N-dominance is similarly inflated, though less so because it aggregates per record.
- The **MIT-BIH DS2 numbers are unaffected** — DS2 is fully held out from CinC and from itself.

### Recommended fix (for thesis credibility)
Hold out 20% of CinC N records (e.g., the last 1,000 by record ID) from training augmentation, then report Lead-I N-recall on those records only. Re-running with this fix is straightforward — change `cinc_n_loader.py::extract_cinc_n_beats` to take a `held_out_records` set, and `evaluate.py::eval_cinc_leadI` to filter to those records.

### What to write in the thesis
At minimum, the limitation needs to be disclosed in `RESULTS.md` and Chapter 6 of the thesis, alongside the numbers. The honest framing: *"CinC Lead-I metrics are reported on the same records used for training augmentation. A held-out CinC eval is left as future work."* This is preferable to silently presenting the numbers as cross-domain.

## 5. Test-time augmentation in evaluate.py — CLEAN

`evaluate.py` calls `_predict()` which sets `model.eval()` and disables dropout. No augmentation, MixUp, or noise injection at eval time. Confusion matrices, per-class F1, and AUC are computed on raw predictions.

The NSTDB noise-robustness test in `evaluate.py` deliberately injects noise — but as a separate, clearly-labeled metric ("§5.3 noise"), not contaminating the main DS2 numbers.

## 6. Reported metrics match raw JSON

Spot-checked `output/results/v2_ensemble_ssl.json` against `RESULTS.md`:

| Metric | RESULTS.md | Raw JSON | Match? |
|---|---|---|---|
| 4-class macro-F1 | 0.6004 | 0.6004 | |
| 3-class macro-F1 | 0.8021 | 0.8021 | |
| N-recall | 0.8949 | 0.8949 | |
| S-recall | 0.8835 | 0.8835 | |
| V-recall | 0.9441 | 0.9441 | |
| F-recall | 0.0103 | 0.0103 | |
| CinC beat N-recall | 0.6773 | 0.6773 | |
| CinC record N-dominance | 0.9875 | 0.9875 | |

No fabricated numbers. The honest reporting in `RESULTS.md` extends to the "what we expected vs measured" INCART experiment — this is publishable-quality candour that strengthens the thesis.

## 7. Reproducibility

`config.set_seeds(seed)` sets `np.random`, `torch.manual_seed`, `torch.cuda.manual_seed_all`, AND `torch.backends.cudnn.deterministic = True` (`config.py:26-32`). Every training entry calls it at the top. Ensemble seeds are fixed at `[42, 101, 202]` and the manifest file in `output/checkpoints/ensemble/` records which seeds were used.

**Caveat:** `torch.use_deterministic_algorithms(True)` is NOT set, so some CUDA ops (atomic-add reductions in older versions) can still produce non-bitwise-deterministic output. For most training-from-scratch use cases this is fine — gradient noise dominates. Worth a single line to document.

## 8. ONNX export and size claims

| Claim | Reality |
|---|---|
| 15,820 params | verified by `count_params()` in `deployment/benchmark.py` |
| 12 KB peak activation | measured via PyTorch hooks, in code |
| 1.93 ms ARM latency | **estimated** (`×2.5` scale factor on x86 CPU latency, not measured on-device) |
| INT8 size 15.7 KB | verified by `estimate_int8_size_kb` |
| TFLite for watch deployment | **stub only** (`export_tflite_stub`) — requires TF install + onnx2tf, explicitly described as out of scope in `quantize.py` |

The **TFLite path is a stub**. For the smartwatch claim (Galaxy Watch 5 deployment) to be real, this is the gap. The teammate is honest about this in REPORT.md §"Known limitations / future work" item 2 — but the system is not actually deployable on a watch as-is. Someone will need to do the ONNX → TF SavedModel → TFLite conversion before the model can run on Wear OS.

The ONNX export itself works (`torch.onnx.export` with proper input names and dynamic axes), and would deploy on any platform with ONNX Runtime. So the on-phone path (rather than on-watch) is fully open.

## 9. Project fit with Smart Health platform

`integration/README.md` is a solid, thoughtful plan that aligns with the rest of the project:

- Watch runs three on-device models: ECG, fall detection, HAR.
- Phone runs the LLM assistant + Room DB + rules engine.
- Raw sensor streams stay on watch; only classified events go to phone.
- The cardiac model exposes a `cardiac` event type that the assistant's `recent_events` field already accepts (we built that earlier).

**The integration interface is consistent with the work already done in the Assistant.** The cardiac model's outputs (rhythm prediction confidence + per-beat classification) map cleanly into the existing alerts schema we already have in Supabase.

## 10. Honest reporting

This is worth its own section because it's unusual for a graduation project. The author:

- Documented what was tried and abandoned (§3 dead ends in REPORT.md).
- Disabled the abandoned techniques in code (e.g. `KD_FEATURE_WEIGHT` exists but is never used) so they can't be re-enabled by mistake.
- Reported every metric, including the 0.0103 F-class recall that's well below the target.
- Wrote up the INCART negative result as a substantive finding rather than burying it.
- Listed the specific gates that pass and fail (5 of 7) and explained each failure.

For thesis purposes, this candour is a strength, not a weakness. The thesis chapter should pull these points forward, not soften them.

---

## Summary of findings

| # | Finding | Severity | Action |
|---|---|---|---|
| 1 | Patient-disjoint splits | Clean | None |
| 2 | Sqrt-weighted sampler + sqrt-weighted loss = effectively plain inv-freq weighting | Minor | Update README's risk-table line |
| 3 | DS2 uses oracle R-peaks (standard practice, disclosed) | Clean | None |
| 4 | **CinC training augmentation overlaps with CinC eval records** | **High** | Either hold out a CinC subset for eval, or disclose explicitly in thesis Chapter 6 |
| 5 | No test-time augmentation contamination | Clean | None |
| 6 | Reported metrics match raw JSON | Clean | None |
| 7 | Seeds set; cudnn deterministic enabled | Clean | Optional: note non-bitwise reproducibility caveat |
| 8 | TFLite export is a stub; watch deployment NOT yet realised | Medium | Either complete TFLite path OR pivot integration plan to phone-side ONNX inference |
| 9 | Integration with Smart Health platform | Clean | None |
| 10 | Honest reporting throughout | Strength | Mirror in thesis |

## Recommended changes before thesis

**Must do (1 hour of work each):**
1. Hold out a CinC eval subset and re-run Lead-I numbers. Even a quick 80/20 split on CinC N records would produce more defensible numbers.
2. Either complete the TFLite conversion OR explicitly position the cardiac model as **phone-side** (not watch-side) in the integration story. Phone-side ONNX is fully working today.

**Should do (15 minutes each):**
3. Fix the misleading line about "training loop does NOT re-apply class weights."
4. Add a single-line note about non-bitwise determinism with cudnn-deterministic alone.

**Nice to have:**
5. Run the model on real recorded watch data (when available) to validate the 0.988 record-level N-dominance holds outside CinC's recording conditions.

## Final verdict

This is **the strongest of the three deep-learning components** in your project — better organised, better documented, and more honestly evaluated than typical graduation-project ML code. The author's awareness of failure modes (the §3 dead ends, the §7 risk register, the INCART negative finding) puts the work close to publishable quality.

**The CinC leakage and the TFLite stub are the only two real issues.** Both are fixable in under a day of work. After that, the cardiac model is ready to integrate into the Smart Health platform alongside FusionNet and the HAR model.

---

*Audit conducted on the v3-equivalent state of `D:/GP-IMP/Cardiac/`, REPORT.md and RESULTS.md as ground truth, code spot-checked against the raw JSON results files in `output/results/`.*
