# Fall Detection (FusionNet) — Independent Audit
**Subject:** `D:/GP-IMP/fall_detection_edge/` — Multi-placement Dual-Stream FusionNet (FallAllD)
**Auditor scope:** correctness, leakage, overfitting, project fit, deployment readiness, doc honesty
**Verdict (TL;DR):** **The headline LOSO result (AUC 0.9997, 99.4% recall) is methodologically invalid** — the script labelled "LOSO" never retrains the model; it simply re-evaluates a model already trained on every subject. That, combined with threshold tuning on the test set and a non-subject-disjoint 80/20 split, means the published numbers cannot be trusted as generalization estimates. The architecture, ONNX export, and on-device deployment story are otherwise solid.

---

> **Status update — fixes landed and honest re-run complete (2026-04-28).**
>
> All four methodology findings below have been addressed:
>
> 1. **Real LOSO** — new `scripts/loso_honest.py` retrains a fresh FusionNet from scratch for each held-out subject (60 epochs, GPU). The four ADL-only subjects (S04, S10, S11, S12 — no falls in their wrist data) are **explicitly excluded** from val/test rotation but kept in the train pool, with a printed disclosure at startup.
> 2. **Subject-disjoint splits** — new `scripts/train_wrist_honest.py` partitions subjects (not windows): 9 train / 2 val / 2 test. Data fusion (`scripts/fuse_barometer_data.py`) now persists `subjects.npy` and `actions.npy` alongside `X.npy / y.npy` so subject-aware splitting is possible.
> 3. **Best-checkpoint selection on VAL, not test** — both new scripts select the best epoch by **val AUC** and only touch the test set once for final reporting.
> 4. **Threshold tuning on VAL** — the chosen threshold is the one that maximises VAL F1 subject to recall ≥ 0.95.
>
> **Honest numbers (full results in `output/results/wrist_loso_honest.json` and `output/results/wrist_honest.json`):**
>
> | metric | claimed (audited) | honest LOSO (9 folds) | honest single-split (test = S09+S10) |
> | --- | ---: | ---: | ---: |
> | AUC | 0.9997 | **0.9708** | **0.9868** |
> | Recall | 99.4% | **83.0%** | **91.1%** |
> | Precision | 97.1% | **90.5%** | **77.3%** |
> | F1 | 93.6% | **86.1%** | **83.6%** |
> | FPR | 1.8% | **3.5%** | **4.67%** |
>
> Conclusion: the architecture and dataset are sound — wrist FusionNet genuinely achieves AUC ≈ 0.97 across unseen subjects, which is competitive with the published fall-detection literature. But the original "0.9997 / 99.4%" headline overstated the model by ~3 AUC points and ~16 recall points; the inflation came entirely from the methodology bugs, not from the model itself. The original `audit_wrist_fusionnet.py`, `tune_thresholds.py`, and `retrain_wrist_augmented.py` scripts remain on disk for the audit trail; new canonical entry points are `train_wrist_honest.py` and `loso_honest.py`.

---

## 1. "LOSO" is not LOSO

**Severity:** Critical — invalidates the headline number.
**Evidence:** `audit_wrist_fusionnet.py` lines 181–243 (`run_loso`). Line 191 loads the *already-trained* `FusionNet_Wrist.pth`. The for-loop at line 198 splits the data into train/test masks per subject, but lines 210–214 only fit a `StandardScaler` on the train fold and then call `run_inference(model, X_test_scaled)` (line 216). **There is no model retraining inside the LOSO loop.** The same model — trained on a random 80/20 stratified split that mixes all 13 subjects (`retrain_wrist_augmented.py:166–168`) — is evaluated on every "held-out" subject.

**Why this matters:** Real LOSO answers "how does the model generalize to a *new* subject?". This procedure answers "for each subject in turn, how well does the model — which was trained on this subject's data — perform on a re-scaled view of that same data?". Every "test subject" is in the training set. The 0.9997 AUC and 99.4% recall in `Final_Report.md §3` and `System_Overview.md §3` are restatements of the train-set performance under a different scaler, **not** generalization.

**Compounding issue:** `run_loso` silently skips any subject without both classes (`if len(set(y_test)) < 2: continue`, line 205). Of the 13 wrist subjects (S01,S02,S03,S04,S05,S06,S09,S10,S11,S12,S13,S14,S15 — verified by `ls FallAllD/`), only 9 appear in the LOSO table; S04, S10, S11, S12 are dropped without note. The reported "1,930 samples" is the sum across the surviving 9, not the full 2,515. `Final_Report.md` writes "13 subjects" but also reports an overall LOSO denominator that excludes 4 of them.

**Recommended fix:** Implement true LOSO — for each held-out subject, retrain the wrist FusionNet (with augmentation + class weights) on the other 12, then evaluate. Report a per-subject AUC distribution honestly. Expect numbers materially lower than 0.9997.

## 2. Threshold tuned on the test set

**Severity:** High — inflates F1 and the per-placement thresholds are over-fit.
**Evidence:** `tune_thresholds.py` lines 151–153 produce `X_test` with `train_test_split(..., random_state=42, stratify=y_all)`. This is **the same split** as `retrain_wrist_augmented.py:166–168`, `train_fusion_model.py:41`, and the dashboard sample buffer in `scripts/api_server.py:140`. The threshold sweep on lines 184–203 picks the F1-maximising threshold subject to recall ≥ 0.75 — directly on the test set.

**Why this matters:** The 0.28/0.33/0.56 thresholds in `models/thresholds.json` are optimised on the same 503 wrist test windows used to report 97.1% recall and 1.8% FPR in `Final_Report.md §3`. The threshold-induced metrics are double-dipped.

**Recommended fix:** Carve out a separate validation split (e.g. 70/15/15) and pick thresholds on the validation fold. With LOSO, threshold can be picked per held-out subject, then averaged.

## 3. Selecting the "best" model on the test set

**Severity:** Medium — milder version of #2.
**Evidence:** `train_fusion_model.py:130–132` and `retrain_wrist_augmented.py:303–306`. After every evaluation epoch the code does `if auc > best_auc: torch.save(model.state_dict(), ...)`, where `auc` is computed on the **test loader** (line 122 / line 281). There is no separate val split.

**Why this matters:** The saved checkpoint is the one whose epoch happened to score highest on the test set — a textbook form of test-set leakage that biases all downstream metrics upward. The effect is smaller than #1 and #2 but real.

**Recommended fix:** Split the 80% training pool further into train/val (e.g. 80/10/10 overall) and select on val.

## 4. The 80/20 split is window-stratified, not subject-disjoint

**Severity:** High.
**Evidence:** `retrain_wrist_augmented.py:166–168` (`train_test_split(X, y, test_size=0.2, random_state=42, stratify=y)`); same pattern in `train_fusion_model.py:41`, `evaluate_fusion.py:32`, `tune_thresholds.py:151`, `full_evaluation.py:56`, and `api_server.py:140`. Subject IDs are dropped during preprocessing (`scripts/fuse_barometer_data.py` writes only `X.npy` and `y.npy`, lines 137–138).

**Why this matters:** Each subject contributes ~5 trials per fall type. With random window-level splitting, a subject's S01_A101_T01 ends up in train and S01_A101_T03 ends up in test — same person, same motion, ~1 second apart in real time. The 80/20 numbers in `Final_Report.md §3` (AUC 0.9966, recall 97.1%) reflect this near-duplicate situation, not real-world deployment on unseen wearers.

**Recommended fix:** Group-stratified split by subject ID (sklearn's `GroupShuffleSplit` / `StratifiedGroupKFold`) and retrain. Combined with a real LOSO evaluation, this is the single highest-impact fix.

## 5. Documentation vs. code mismatches

**Severity:** Medium (honesty).
- `Final_Report.md §1` table (line 19) claims **"15 subjects"**. The dataset on disk has 13 (S01–S03, S05, S06, S09–S15 confirmed by `ls FallAllD/`). The original FallAllD release has 15 subjects but the local copy is missing S07 and S08.
- `Final_Report.md §3` and `System_Overview.md §3` LOSO tables list 9 subjects, summing to 1,930 wrist samples. The text frames this as "each of the 13 subjects". The 4 silently dropped subjects are not disclosed.
- `Final_Report.md §3` LOSO table reports `Falls caught: 520/523` overall, but the per-subject sum of falls listed (73+55+65+53+71+56+22+62+66) = 523 — meaning all 523 wrist falls in the dataset are coming from only those 9 subjects. The arithmetic is internally consistent, but `data/fused/D2` actually contains 523 fall windows in total (verified: `y.sum() = 523`), so the 4 "skipped" subjects had zero wrist fall windows — i.e. they only contributed ADL data and were correctly skipped on the `len(set(y_test)) < 2` test. This should be stated explicitly rather than implied.
- `Final_Report.md §6` claims `<0.3 ms` ONNX latency. `benchmark_all_tiers.py` was not re-run as part of this audit; numbers like "~0.04 ms multi-thread" are from x86 desktop benchmarks and are not equivalent to "1–5 ms on Apple S9 chip" (also reported in §6). Both numbers appear without a documented benchmark run.

## 6. ONNX export uses external data files

**Severity:** Minor — deployment foot-gun.
**Evidence:** `models/onnx/FusionNet_Wrist.onnx` is **27 KB**, with model weights stored separately in `FusionNet_Wrist.onnx.data` (1.87 MB). Full file listing confirmed via `ls -la`. The `Final_Report.md §6` table at line 217 lists "1.87 MB ONNX" without mentioning the external `.onnx.data` companion file.

**Why this matters:** A naive deployer copying just the `.onnx` would ship a 27 KB stub with no weights. ONNX Runtime will fail with a missing-tensor error at load time. This is a deployment-readiness gap.

**Recommended fix:** Re-export with `export_params=True` and without external-data threshold (default in `torch.onnx.export` is to inline). Or document the dual-file requirement explicitly. `scripts/export_fusionnet.py` does not pass `save_as_external_data=False`, so behavior depends on opset/torch version defaults.

## 7. Parameter count and architecture verified

**Evidence:** Loading `BarometerFusionNet()` and counting parameters yields **463,874**. `Final_Report.md` says "~466,000" — accurate to within reporting precision. Architecture in `models/fusion_model.py` matches the diagram in `Final_Report.md §2` and `System_Overview.md §2` line-for-line: IMU stream produces 25×128 = 3,200 features, Baro stream produces 10×16 = 160, concatenation at 3,360 → FC(128) → FC(2). Confirmed by computing pool arithmetic from line 27–41.

## 8. Dataset arithmetic matches

**Evidence:** `np.load('data/fused/D2/y.npy').sum() = 523`, total = 2,515 — matches `Final_Report.md §1` table (Wrist: 2,515 / 523 / 1,992). Same check for D1 (2,292 / 733 / 1,559) and D3 (1,798 / 466 / 1,332) — all match the reported table exactly.

## 9. Confidence calibration / temperature scaling — clean

**Evidence:** `audit_wrist_fusionnet.py:290–365`. Splits into 30% calibration + 70% eval (line 306), fits temperature on calibration logits, reports ECE on the held-out 70%. This is methodologically sound. Note however that the underlying probability source is the same train-overlap-leaked model, so absolute ECE values inherit the broader leakage caveat.

## 10. INT8 quantization — clean as a sanity check

**Evidence:** `audit_wrist_fusionnet.py:471–529`. Uses `quantize_dynamic` with `QuantType.QUInt8` and compares ONNX FP32 vs INT8 AUCs. The quantization path itself is straightforward and well-handled. The accuracy comparison reuses the leakage-affected test set, so the *delta* is meaningful but the absolute AUC is not.

## 11. Project fit with Smart Health platform

**Evidence:** `scripts/api_server.py` exposes `/api/v1/detect_fall` returning `{is_fall, confidence, threshold_used, placement_used, message}`. This shape is compatible with the events schema used by the Cardiac and Assistant modules. The on-device deployment story (FusionNet + thresholds running locally on a barometer-equipped smartwatch) is consistent with the broader system topology described in `D:/GP-IMP/Cardiac/AUDIT_REPORT.md §9`.

## 12. The dashboard / API serves test data — known and disclosed

**Evidence:** `scripts/api_server.py:120–154`. The dashboard endpoint serves windows from the same 80/20 test split. This is correctly framed as a *demo*, not an evaluation, in `Guide.md` and `Final_Report.md §7`. The endpoint is not used to compute headline numbers.

---

## Strengths

1. **Architecture is sensible and small.** 463k-param dual-stream 1D-CNN with explicit IMU/Baro streams and clean ONNX export.
2. **Robustness experiments are real and useful.** Barometer-zeroed evaluation (audit script §2) is a genuine ablation, the per-fall-type breakdown (§4) is informative, and the temperature-scaling protocol is correct.
3. **Documentation is structured and readable.** `Final_Report.md` covers architecture, training, evaluation, deployment, and limitations in a discoverable way. `Guide.md` was well-suited to a thesis demo.
4. **API + dashboard story aligns with the wider Smart Health platform.** The placement-aware routing and per-placement thresholds are well-engineered.
5. **The dataset-arithmetic and parameter counts match what the docs claim**, so the lower-level numbers (window counts, parameter count, model size) are honest.
6. **Honest disclosure of dataset limitations** in `Final_Report.md §8` (simulated falls, lab environment, small N).

---

## Summary table

| # | Finding | Severity | Action |
|---|---|---|---|
| 1 | "LOSO" loop never retrains; evaluates the trained-on-all-subjects model | Critical | Implement true LOSO with retraining |
| 2 | Per-placement thresholds tuned on the same test set used for headline metrics | High | Use a separate validation split |
| 3 | Best-checkpoint selection on test-set AUC | Medium | Add train/val/test split |
| 4 | 80/20 split is window-stratified, not subject-disjoint | High | `StratifiedGroupKFold` by subject |
| 5 | Doc says 15 subjects (dataset has 13); LOSO silently drops 4 | Medium | Reword `Final_Report.md §1` and §3 |
| 6 | ONNX is 27 KB stub + external `.onnx.data` file | Minor | Re-export with inlined weights or document |
| 7 | Param count, architecture | | None |
| 8 | Dataset window counts | | None |
| 9 | Temperature scaling protocol | | None |
| 10 | INT8 quantization | | None |
| 11 | API/integration shape | | None |
| 12 | Dashboard uses test data, but disclosed as demo | | None |

## What's solid

- The architecture, parameter count, ONNX export pipeline, and on-device latency story.
- Window counts, fall/ADL splits, threshold-tuning *script* mechanics (the *target* of the tuning, not the mechanics, is the issue).
- The barometer-failure ablation, temperature scaling, INT8 quantization — these are real, useful experiments.
- Integration shape with the wider Smart Health system.

## What's a real concern

- **The single biggest claim in the thesis — LOSO AUC 0.9997 — is not actually a LOSO result.** It's a reformatted train-set evaluation. Recommended action: implement real LOSO (retrain per fold) and republish numbers. They will drop, possibly substantially.
- The window-level random split mixes a single subject's near-duplicate trials across train and test. The 80/20 numbers (AUC 0.9966, etc.) are inflated for the same reason.
- Threshold selection on the test set adds another layer of metric inflation, particularly to F1.

## What's minor

- "15 subjects" claim (dataset has 13).
- Silent skip of 4 subjects in LOSO without disclosure.
- ONNX external-data file packaging.
- Some latency numbers reported without a documented benchmark run.

---

*Audit conducted read-only on 2026-04-28 against the working tree at `D:/GP-IMP/fall_detection_edge/`. Code paths and line numbers reflect that snapshot. No eval JSON files exist in this folder (`find ... -name "*.json"` returns only `models/thresholds.json`), so reproduced metrics were independently re-derived from `data/fused/*/y.npy` and the code paths cited above. The architectural and dataset claims were verified directly. The LOSO methodology issue (Finding #1) is the dominant problem and should be addressed before thesis defence.*
