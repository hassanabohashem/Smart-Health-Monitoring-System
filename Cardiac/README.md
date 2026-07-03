# ECG TinyML Classifier (Cardiac Module)

This module implements a single-lead ECG beat classifier designed to detect cardiac anomalies. The model is optimized for resource-constrained hardware (TinyML), targeting smartwatch and edge device deployment.

## Technical Profile

- **Architecture**: Lightweight 1D Convolutional Neural Network (ECGStudentCNN).
- **Parameters**: **15,820 parameters** (~63 KB FP32).
- **Quantized Size**: **15.7 KB** INT8 (estimated).
- **Memory Footprint**: **< 12 KB** peak activation memory.
- **Latency**: **~1.93 ms** ARM Cortex-A equivalent CPU latency.
- **Data Split**: Patient-disjoint split on MIT-BIH database to prevent leakage.
- **Cross-Domain Generalization**: Self-Supervised Learning (SSL) pre-training on all 8,528 CinC 2017 records to adapt the feature representation for smartwatch Lead-I morphology.

---

## Repository Structure

The directory is organized as follows:

```
Cardiac/
├── config.py                  # Global hyperparameters & data paths configuration
├── run_pipeline.py            # Main orchestrator script to run pipeline stages
├── README.md                  # This entry point document
│
├── data/                      # Data loaders, split generation, and augmentations
├── preprocessing/             # Bandpass filtering, R-peak detection, and SQI gating
├── models/                    # Model architecture definitions (supervised & SSL)
├── training/                  # Training loops, loss functions, SWA, calibration
├── deployment/                # Post-Training Quantization (PTQ) & ONNX benchmarking
│
├── docs/                      # Detailed project documentation & reports
│   ├── REPORT.md              # Technical design report & implementation notes
│   ├── RESULTS.md             # Measured performance results & INCART findings
│   └── AUDIT_REPORT.md        # Independent audit findings and verification
│
├── scripts/                   # Utility & verification scripts
│   ├── evaluate.py            # Comprehensive §5 evaluation suite
│   ├── eval_holdout.py        # Runs evaluation on the deterministic 20% holdout set
│   ├── export_onnx_for_app.py # Exports production checkpoints to ONNX
│   └── update_results_md.py   # Results updater utility for RESULTS.md
│
├── output/                    # Checkpoints, model artifacts, and evaluation outputs
└── cache/                     # Preprocessed numpy cache files (ignored by Git)
```

---

## Running the Pipeline

All pipeline processes are coordinated via `run_pipeline.py`.

### 1. Run the Entire Pipeline
To run all stages sequentially (pre-training, baseline training, augmented training, ensembling, and ablation evaluation):
```bash
python run_pipeline.py --stage all
```

### 2. Stage-by-Stage Execution
- **Self-Supervised Pre-training**:
  ```bash
  python run_pipeline.py --stage ssl
  ```
- **Supervised Training (with Lead-I Augmentation & SSL init)**:
  ```bash
  python run_pipeline.py --stage cincaug_ssl
  ```
- **Ensemble Training (3 Seeds)**:
  ```bash
  python run_pipeline.py --stage ensemble
  ```
- **Generate Ablation Table**:
  ```bash
  python run_pipeline.py --stage ablation
  ```

### 3. Verification & Utilities (under `scripts/`)
- **Run held-out validation on ensemble**:
  ```bash
  python scripts/eval_holdout.py
  ```
- **Export model to ONNX format**:
  ```bash
  python scripts/export_onnx_for_app.py
  ```

---

## Key Documentation (in `docs/`)

- [**REPORT.md**](file:///d:/GP-IMP/Cardiac/docs/REPORT.md): Complete engineering design and decisions behind v2. Contains priorities, architectural rationale, and evaluation strategies.
- [**RESULTS.md**](file:///d:/GP-IMP/Cardiac/docs/RESULTS.md): Detailed comparison tables, ablation metrics, the INCART rare-class data wall analysis, and performance validation against the independent audit.
- [**AUDIT_REPORT.md**](file:///d:/GP-IMP/Cardiac/docs/AUDIT_REPORT.md): Independent evaluation report detailing resolution of data leakage concerns, class weighting math correctness, and TFLite smartwatch deployment status.
