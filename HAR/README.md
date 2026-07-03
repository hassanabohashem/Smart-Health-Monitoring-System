# HAR model — Human Activity Recognition for Galaxy Watch 5 → phone app

Trains a Human Activity Recognition model on the **WISDM** watch dataset
(accelerometer + gyroscope) and deploys it as a **TFLite** model inside the phone
app, fed by the Galaxy Watch 5 sensor stream described in
`../wear_app/docs/README_watch_mobile_integration.md`.

```
HAR/
├── README.md                  # This root entry point document
├── har_wisdm.onnx             # tf2onnx-converted ONNX model for phone-side ONNX integration
├── verify_onnx.py             # script to verify ONNX matches TFLite outputs
│
├── docs/                      # Technical documentation & reports
│   └── RESULTS.md             # Detailed experiment results & taxonomic analysis
│
├── training/                  # Python pipeline (parse → window → train → export)
│   ├── config.py              # all knobs: classes, window, augmentation, paths
│   ├── data_prep.py           # WISDM raw → aligned 20 Hz 6-channel windows (cached)
│   ├── augment.py             # on-the-fly noise / scale / rotation / shift
│   ├── model.py               # compact 1D-CNN, normalization baked in
│   ├── train_dualhead.py      # trains the production dual-head model
│   ├── train.py               # legacy single-head training loop
│   ├── infer_test.py          # verify TFLite == Keras
│   └── requirements.txt
│
├── android/                   # phone-app Kotlin helper deliverables
│   ├── HarClassifier.kt
│   └── README_phone_integration.md
│
└── artifacts/                 # generated: .tflite, meta json, keras model, cache
```

## Quick start

```bash
cd training
pip install -r requirements.txt
python train_dualhead.py --rebuild   # builds cache, trains the DUAL-HEAD model, exports TFLite
python infer_test.py                 # sanity-check the exported TFLite (both heads)
```

`train.py` (single-head) is kept for the experiment history; **`train_dualhead.py`
is the one that produces the shipped model** (4-class classifier + `is_real`
fake-movement detector).

Outputs land in `artifacts/`:
- `har_model_float.tflite` — deploy this (≈0.6 MB)
- `har_model_int8.tflite` — quantized (≈0.18 MB)
- `har_model_meta.json` — input/output contract + tuned threshold + metrics

Then follow `android/README_phone_integration.md` to wire it into the phone app.

## Design decisions

- **Data:** WISDM **watch** accel + gyro (wrist placement matches Galaxy Watch 5).
  Accel and gyro are sampled independently; both are linearly resampled onto one
  common **20 Hz** grid and aligned into 6-channel windows `[ax,ay,az,gx,gy,gz]`.
- **Rate handling:** trained at 20 Hz (WISDM-native — no fabricated samples). The
  phone downsamples the watch's 50 Hz `imuHighRate` → 20 Hz before inference.
- **Window:** 10 s (200 samples), 50% overlap. Configurable in `config.py`.
- **Model:** compact 1D-CNN (~165 k params, 0.6 MB float). Per-channel
  standardization is a baked-in layer, so the phone feeds **raw** sensor units.
- **Honest evaluation:** **subject-wise** split — whole people held out for
  val/test. Random within-subject splitting leaks and inflates accuracy.
- **Noise / fake-movement handling:** the shipped **dual-head** model has a
  dedicated `is_real` detector trained on the 13 non-locomotion activities as
  negatives (rejects fake movements far better than a softmax threshold, which
  stays overconfident on junk), plus heavy augmentation. See `RESULTS.md`.

## Configuration flags (config.py)

| Flag | Meaning |
|------|---------|
| `MERGE_STILL` | Merge sitting + standing into one `stationary` class. Recommended for a wrist device — see results below. |
| `INCLUDE_OTHER_CLASS` | If `True`, add an explicit `other` reject class built from the 13 non-locomotion WISDM activities. If `False`, reject via confidence threshold only (open-set). |
| `WINDOW_SEC` / `STEP_SEC` | Window length and hop. |
| `AUG_*` | Augmentation strength. |

## Results (subject-independent test set)

See `docs/RESULTS.md` for the full experiment comparison and the rationale behind the
final taxonomy.
