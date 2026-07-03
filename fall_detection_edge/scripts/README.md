# Scripts Reference

This directory contains the active Python scripts for the wrist
FusionNet fall-detection pipeline (post-audit).

> **Cleanup note (May 2026):** the original 30+ scripts covered
> alternative architectures (LiteFallNet, FallCRNN), other body
> placements (waist, neck), pre-audit broken-methodology training
> (fixed splits, best-on-test threshold tuning), and one-off
> experiments. After the audit, the pipeline was narrowed to a single
> honest LOSO-trained wrist FusionNet, and the orphaned scripts were
> deleted. Pre-audit broken-methodology scripts (`audit_wrist_fusionnet.py`,
> `retrain_wrist_augmented.py`, `tune_thresholds.py`,
> `train_fusion_model.py`, `overfit_check.py`) were removed from the active tree (local only).

## Active pipeline (5 scripts)

### 1. Data Preprocessing
| Script | Purpose |
|---|---|
| `fuse_barometer_data.py` | Merge FallAllD IMU + barometer into per-subject `(X, y, subjects, actions)` numpy arrays under `data/fused/D2/` |

### 2. Model Training (honest)
| Script | Purpose |
|---|---|
| `train_wrist_honest.py` | Train wrist FusionNet with subject-disjoint train/val/test splits. Saves `models/fusion/FusionNet_Wrist_honest.pth` and `scaler_Wrist_honest.joblib` |
| `loso_honest.py` | 9-fold leave-one-subject-out evaluation (4 ADL-only subjects excluded from rotation, retained in train pool). Writes `output/results/wrist_loso_honest.json` |

### 3. ONNX Export
| Script | Purpose |
|---|---|
| `export_honest_onnx.py` | Convert the honest checkpoint to a single-file ONNX (`models/onnx/FusionNet_Wrist_honest.onnx`) for the mobile app |

### 4. Deployment
| Script | Purpose |
|---|---|
| `api_server.py` | FastAPI dev server with multi-placement dashboard. Loads waist/neck `.pth` if present (broken-methodology, untrained post-audit) and the honest wrist checkpoint. Used for local testing only; production inference runs on-device via ONNX |

## Audit trail

For pre-audit methodology context (what was wrong with the original
training pipeline and how it was fixed), see
`fall_detection_edge/AUDIT_REPORT.md`.
