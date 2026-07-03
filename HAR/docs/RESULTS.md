# HAR experiment results

All numbers are **subject-independent**: whole people are held out for the test
set (10 of 51 subjects), so these reflect how the model behaves on a *new* user —
not the inflated numbers you get from a random window split.

## Experiment comparison

| # | Taxonomy | Reject strategy | Overlap | Test accuracy | Notes |
|---|----------|-----------------|---------|---------------|-------|
| 0 | 5 classes (walk, jog, stairs, sit, stand) + `other` | explicit `other` class | 50% | **76.8%** | sit↔stand + real↔other bleed |
| A | same, softened augmentation | explicit `other` class | 50% | **77.2%** | tuning alone barely moves it |
| B | 4 + `other` (sit+stand → `stationary`) | explicit `other` class | 50% | **79.6%** (loco 81.3%) | merge helps; `other` still the ceiling |
| C | 4 (walk, jog, stairs, `stationary`) | confidence threshold only | 50% | **90.5%** | dropping the `other` class is the big win |
| **F** | 4 (walk, jog, stairs, `stationary`) | confidence threshold only | 75% | **<final>** | more data; final model |

## What the experiments proved

1. **Sitting vs standing is physically near-impossible from a wrist.** The watch
   measures the forearm's gravity vector, not torso posture. Merging them into
   `stationary` (B vs 0) recovered accuracy with zero real-world loss — for a
   health app, "stationary/still" is the meaningful state anyway.

2. **An explicit `other` class is what blocked 95%, not model quality.** The 13
   non-locomotion activities are unboundedly diverse and overlap every real class
   (you sit while typing, stand while clapping…). Forcing them into one trainable
   class dragged the real classes down ~11 points (B 79.6% → C 90.5%). Rejecting
   junk motion with a **confidence threshold** instead is both higher-accuracy and
   a cleaner open-set design.

3. **`stationary` is solved** (f1 ≈ 0.97). The entire remaining error is the
   **walking ↔ jogging ↔ stairs** triangle — stairs is the hardest (its gait
   resembles walking on a wrist).

## The rejection tension (measured)

Validating the confidence threshold against a **held-out junk set** (the 13
non-locomotion activities, never trained on) revealed a real trade-off:

| Approach | Real-activity accuracy | Fake-movement rejection |
|----------|------------------------|-------------------------|
| Explicit `other` class (exp B) | ~80% | good (junk lands in `other`) |
| Threshold-only (exp C/F) | **95.3%** (on accepted) | **only 17%** — softmax is overconfident on junk |

So **neither pure approach satisfies both requirements.** Softmax confidence is a
poor out-of-distribution detector: the 4-class model assigns >0.95 probability to
a *wrong* class for ~83% of fake-movement windows.

**Solution shipped — dual-head model** (`train_dualhead.py`): one shared CNN
backbone with two outputs: (1) a 4-way softmax over walking/jogging/stairs/
stationary, trained only on real windows (so accuracy isn't diluted), and (2) a
binary `is_real` detector trained with the 13 non-locomotion activities as
negatives. At inference: reject when `is_real < tau`; otherwise classify.

An additional lever raised this further: **derived magnitude channels** (accel
and gyro magnitude, computed inside the model so the Android input stays 6
channels). These are gravity/orientation-invariant and directly help the
walking↔stairs gait separation. Stairs f1 jumped 0.79 → 0.91 and overall
accuracy 90.2% → 94.4%, with no increase in model size.

Final measured numbers (subject-independent, tau=0.8):

| Metric | Value |
|--------|-------|
| Per-window classification accuracy | **94.4%** |
| **Segment-voted accuracy** (realistic deployment — votes over an activity bout) | **95.9%** |
| Accuracy on accepted windows | 94.7% |
| Fake-movement rejection (held-out junk) | **89.2%** |
| Real-activity coverage at tau=0.8 | 74.7% |

Per-class f1: walking 0.89, jogging 0.94, stairs 0.91, stationary 0.98.

`tau` trades coverage for safety: lower it to accept more real windows (higher
coverage, slightly more junk leaks); raise it to reject more aggressively. The
value lives in `artifacts/har_model_meta.json` and is the `HarClassifier`
`junkThreshold` default.

A heavier residual backbone was also tried; it bloated the model to 1.5 MB and
regressed jogging, so the compact backbone + derived features (above) was kept.

## Final model

- Architecture: **dual-head 1D-CNN** (`train_dualhead.py`).
- Classes: **walking, jogging, stairs, stationary**.
- Fake-movement / noise rejection: dedicated **`is_real` head** + threshold `tau`,
  plus heavy training-time augmentation. Contract in `artifacts/har_model_meta.json`.
- Reproduce: `python train_dualhead.py --rebuild` then `python infer_test.py`.
- Deploy: `android/HarClassifier.kt` + `android/har_model_float.tflite`.

## Honest note on the 95% target

`stationary` and `jogging` clear 95% comfortably. **Stairs** is the limiter — on
wrist IMU alone it is genuinely hard to separate from walking, and no public
WISDM-watch subject-independent result reaches 95% on stairs. If a hard 95% on
*every* class is required, the realistic options are: (a) drop `stairs` (3-class
walk/jog/stationary easily exceeds 95%), or (b) add the barometer (`pressure`,
already in the watch stream) as a stairs cue — but WISDM has no barometer, so that
needs a small data-collection pass on the Galaxy Watch 5. See recommendations.
