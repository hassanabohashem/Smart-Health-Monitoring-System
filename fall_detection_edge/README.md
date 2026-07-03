# Multi-Modal Edge Fall Detection (fall_detection_edge)

This directory contains the edge fall detection system built for deployment on wearable devices. The system uses a **Multi-Modal Dual-Stream CNN (FusionNet)** that fuses 6-axis IMU data and 1-axis Barometer data to achieve high recall and low false-alarm rates.

## Technical Profile

- **Architecture**: Dual-Stream 1D CNN (FusionNet).
  - **Stream A**: 6-axis IMU (Accelerometer + Gyroscope) at 100 Hz.
  - **Stream B**: 1-axis Barometer (atmospheric pressure) at 100 Hz.
- **Model Parameters**: **~466,000 parameters** (~1.87 MB ONNX).
- **F1 Score**: **86.1%** (honest wrist-only subject-disjoint LOSO evaluation).
- **Recall**: **83.0%** (unseen subjects).
- **False Positive Rate**: **3.5%** (low false-alarm rate achieved via barometer altitude-drop verification).

---

## Repository Structure

```
fall_detection_edge/
├── dashboard.html             # Interactive HTML web dashboard demo
├── README.md                  # This root entry point document
│
├── docs/                      # Detailed system reports & audits
│   ├── REPORT.md              # Technical design report & implementation details
│   └── AUDIT_REPORT.md        # Independent audit findings and verification fixes
│
├── scripts/                   # Python scripts for training, evaluation, and serving
│   ├── README.md              # Scripts detailed overview
│   ├── train_wrist_honest.py  # Subject-disjoint training of the wrist model
│   ├── loso_honest.py         # Leave-One-Subject-Out (LOSO) cross-validation
│   ├── export_honest_onnx.py  # Exports trained model checkpoints to single-file ONNX
│   ├── fuse_barometer_data.py # Barometer and IMU data alignment and fusing preprocessing
│   └── api_server.py          # FastAPI mock server for real-time web/app inference
│
├── models/                    # Trained PyTorch checkpoint models & ONNX targets
├── data/                      # Raw and preprocessed sensor datasets (ignored by Git)
├── output/                    # Evaluation logs and JSON results
└── venv/                      # Python virtual environment folder (ignored by Git)
```

---

## Key Scripts & Usage

### 1. Subject-Disjoint Training
To train the wrist model honestly with a subject-disjoint split:
```bash
python scripts/train_wrist_honest.py
```
This saves:
- `models/fusion/FusionNet_Wrist_honest.pth` (model weights)
- `models/fusion/scaler_Wrist_honest.joblib` (fitted preprocessing scaler)
- `output/results/wrist_honest.json` (resulting metrics)

### 2. Leave-One-Subject-Out (LOSO) Cross-Validation
To run the full 13-fold subject-disjoint cross-validation:
```bash
python scripts/loso_honest.py
```
This evaluates generalization performance across unseen subjects and aggregates the results into `output/results/wrist_loso_honest.json`.

### 3. Export to ONNX
To export the trained PyTorch checkpoint to single-file ONNX for React Native integration:
```bash
python scripts/export_honest_onnx.py
```
This produces `models/onnx/FusionNet_Wrist_honest.onnx` (1.86 MB).

### 4. Interactive Web Demo Dashboard
The root contains [**dashboard.html**](file:///d:/GP-IMP/fall_detection_edge/dashboard.html). You can open it directly in a web browser to:
- Load dummy IMU and Barometer sensor signals.
- Send them to the local `api_server.py`.
- Visualize raw signals and live fall probabilities side-by-side.

To run the local backend server for the dashboard:
```bash
python scripts/api_server.py
```

---

## Documentation (in `docs/`)

- [**REPORT.md**](file:///d:/GP-IMP/fall_detection_edge/docs/REPORT.md): Complete final report summarizing system design, FusionNet architecture, multi-modal features, and evaluation methodology.
- [**AUDIT_REPORT.md**](file:///d:/GP-IMP/fall_detection_edge/docs/AUDIT_REPORT.md): Detailed audit notes documenting the mitigation of subject leakage issues, threshold tuning fixes, and the honest baseline re-run metrics.
