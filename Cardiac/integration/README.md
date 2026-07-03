# ECG + Fall + HAR + LLM — Galaxy Watch 5 Integration Guide

This document specifies exactly which models live where, how they connect on the
Galaxy Watch 5 + Android phone system, and what file paths in this repo you need
to pull from when packaging the watch/phone apps.

> **Deployment status (current).** The ECG model is deployable **on the
> companion phone today** via ONNX Runtime — `torch.onnx.export` is wired up
> in `deployment/quantize.py` and produces a working `.onnx` file. The
> on-watch TFLite path is **not yet complete**: `export_tflite_stub` is
> literally a stub. To run on the watch, you need to convert ONNX → TF
> SavedModel → TFLite (via `onnx2tf` + `tf.lite.TFLiteConverter` with INT8
> calibration), which requires a TF install and is described as future work
> in `REPORT.md §"Known limitations"`. The architecture below describes the
> intended end state; the **practical state today is "phone-side ONNX"**,
> documented as Topology B.

---

## 1. System topology

### Topology A — intended end state (watch-side TFLite, future)

```
┌─────────────────────────────────────────────────────────────┐
│ Galaxy Watch 5 (Wear OS 4, Exynos W920, 1.5 GB RAM)         │
│                                                              │
│ RUNS ON WATCH (TFLite + XNNPACK, CPU):                      │
│   [1] ECG beat classifier   (this repo, 15.8 K params)      │
│   [2] Fall detection         (external model)               │
│   [3] HAR                    (external model)               │
└──────────┬──────────────────────────────────────────────────┘
           │ Wear OS Data Layer API (MessageClient / DataClient)
           ▼
┌─────────────────────────────────────────────────────────────┐
│ Companion Phone (Android)                                    │
│                                                              │
│ RUNS ON PHONE:                                               │
│   [4] LLM     (Smart Health AI assistant, cloud)            │
│   [5] Supabase (persistent event store + RLS)               │
│   [6] Rules engine + aggregation                             │
└─────────────────────────────────────────────────────────────┘
```

### Topology B — current deployable state (phone-side ONNX, today)

```
┌─────────────────────────────────────────────────────────────┐
│ Galaxy Watch 5                                               │
│                                                              │
│ RUNS ON WATCH:                                               │
│   - Raw ECG sampling (single-lead, 500 Hz)                   │
│   - 6-axis IMU + barometer streaming                         │
│   - Fall detection model (ONNX, already deployed)            │
│   - HAR model (ONNX, already deployed)                       │
└──────────┬──────────────────────────────────────────────────┘
           │ BLE — raw ECG window streamed to phone
           ▼
┌─────────────────────────────────────────────────────────────┐
│ Companion Phone (React Native + Expo)                        │
│                                                              │
│ RUNS ON PHONE (ONNX Runtime Mobile, ~2 ms / beat):           │
│   [1] ECG beat classifier   ← runs HERE in topology B        │
│                                                              │
│ Plus everything in Topology A's phone column.                │
└─────────────────────────────────────────────────────────────┘
```

**Guiding principle:**
- Small, latency-sensitive detectors → watch when on-watch runtime is ready.
- Anything that reasons across models and emits text → phone (or cloud).
- Raw sensor streams never leave the device pair; only classified events / summaries go to the cloud.

In topology B the ECG raw window briefly leaves the watch over the local
BLE pairing to the phone; this is acceptable for a paired-device security
model since both devices are owned by the same user. The classified `beat
class + confidence` event is what gets persisted and sent to the cloud
assistant, never the raw waveform.

---

## 2. Model registry — what to use, and where it is

### Model [1] — ECG beat classifier (this repository)

| property | value |
| --- | --- |
| **Source code** | `M:/GradProject/ECG_DEV/MIT-BIH/Trial_3/models/student_cnn.py` (`ECGStudentCNN`) |
| **Trained checkpoint (single seed, deployable)** | `output/checkpoints/v2_cincaug_ssl_seed42.pt` |
| **Trained ensemble (3 seeds, best accuracy)** | manifest: `output/checkpoints/ensemble/v2_ens_ssl_manifest.txt` |
| **Recommended for watch** | **single seed** (`v2_cincaug_ssl_seed42.pt`) |
| **Recommended for phone/cloud** | **ensemble** (3 seeds averaged) |
| **Parameters** | 15,820 |
| **FP32 size** | 62.8 KB |
| **INT8 size (estimated)** | 15.7 KB |
| **Peak activation** | 12 KB |
| **ARM Cortex-A latency** | ~1.9 ms / beat |
| **Input 1 (beat)** | `(1, 128, 1)` float — 1 s window at 128 Hz |
| **Input 2 (rr_features)** | `(1, 4)` float — `[pre_rr, post_rr, ratio, local_mean_rr_10]` in seconds |
| **Output** | `(1, 4)` logits over AAMI classes `[N, S, V, F]` (index order matches `config.AAMI_CLASSES`) |
| **Expected sampling rate** | 128 Hz (resample Watch 5's 500 Hz ECG to 128 via polyphase) |
| **Expected filter chain** | Butterworth bandpass order 4, 0.67–40 Hz, then 50/60 Hz notch, then per-beat z-score |
| **Documented performance** | DS2 macro-F1 0.59, S-recall 0.87, V-recall 0.96 (post-audit v2_ens re-run); CinC record N-dominance 0.999 on held-out 1,010 N-records (honest cross-records). See `RESULTS.md` → "Held-out CinC re-run". |

### Model [2] — Fall detection (external, not in this repo)

| property | value |
| --- | --- |
| **Source** | *To be provided by user* |
| **Expected input** | Accelerometer + gyroscope window (commonly 3 s × 50 Hz = 150 samples × 6 channels) |
| **Expected output** | Binary or 3-class (fall / slip / normal) |
| **Recommended runtime** | TFLite on watch (same XNNPACK pipeline as ECG) |
| **Trigger mode** | Event-driven: run only when accel magnitude > threshold (e.g., 2.5 g) to save battery |

### Model [3] — Human Activity Recognition (external, not in this repo)

| property | value |
| --- | --- |
| **Source** | *To be provided by user* |
| **Expected input** | IMU window (commonly 2.56 s × 50 Hz = 128 samples × 6 channels) |
| **Expected output** | 6–12 activities (walking, running, sitting, standing, stairs up/down, etc.) |
| **Recommended runtime** | TFLite on watch |
| **Invocation cadence** | Once per second (sliding window of last 2.56 s) |

### Model [4] — LLM (on phone)

| property | recommended primary | fallback |
| --- | --- | --- |
| **Provider** | Google **Gemini Nano** via Android AICore | **Claude / OpenAI** cloud API |
| **Requirements** | Android 14+, Pixel 8+/Galaxy S24+ | Internet |
| **Size on device** | ~1.5 GB | 0 on device |
| **Cost** | Free | $0.001–0.01/query |
| **Privacy** | On-device (no data leaves phone) | Cloud (requires aggregation, **never raw ECG**) |
| **Open-source option** | Llama 3.2 1B/3B via MediaPipe LLM Inference | — |

Use a `LlmProvider` interface on the phone app so you can swap providers at runtime.

---

## 3. Where each file in this repo maps to the integration

### Files the watch app needs to mirror

| This repo (Python) | Watch app (Kotlin) |
| --- | --- |
| `config.py` — constants: `BEAT_WINDOW_SAMPLES=128`, `BEAT_WINDOW_LEFT=48`, `BEAT_WINDOW_RIGHT=80`, `TARGET_FS=128`, `BANDPASS_LOW=0.67`, `BANDPASS_HIGH=40.0`, `BANDPASS_ORDER=4`, `NOTCH_FREQ=50`, `NOTCH_Q=30`, `AAMI_CLASSES=['N','S','V','F']` | Copy as Kotlin `object EcgConstants { ... }` |
| `preprocessing/filtering.py` — `bandpass`, `notch`, `zscore_normalize` | Re-implement in Kotlin; biquad cascade from scipy coefficients |
| `preprocessing/rpeak_detection.py` — NeuroKit2 + scipy fallback | Port a lightweight Pan–Tompkins detector (do NOT ship NeuroKit2) |
| `data/loader.py::compute_rr_features` | Re-implement; same 4-feature output `[pre_rr, post_rr, ratio, local_mean_rr_10]` |
| `models/student_cnn.py` | Export to TFLite (see §4); ship `.tflite` as an app asset |

### Files used to export the TFLite artifact

| | |
| --- | --- |
| `deployment/quantize.py::export_tflite_stub` | ONNX export entry-point |
| `deployment/quantize.py::ptq_int8` | PyTorch native INT8 PTQ (reference; for TFLite use the flow in §4) |
| `cache/cinc_n_beats.npz` | Stratified calibration set (use ~500 beats for INT8 representative dataset) |

### Files that should NOT ship to the watch

- `training/` — every file here is training-only, not needed at inference.
- `cache/cinc_ssl_beats.npz` — 302K pretraining beats.
- `output/checkpoints/**/*.pt` — PyTorch checkpoints. The watch ships the converted `.tflite` only.

---

## 4. Step-by-step: deploying the ECG model to the watch

### 4.1 Export `v2_cincaug_ssl_seed42.pt` → ONNX → TFLite INT8

Run from the repo root:

```bash
# 1. PyTorch -> ONNX
python -c "
import torch, sys
sys.path.insert(0, '.')
from models.student_cnn import build_student_model
m = build_student_model(use_fv_head=False, kd_proj_dim=None, verbose=False)
ck = torch.load('output/checkpoints/v2_cincaug_ssl_seed42.pt',
                 map_location='cpu', weights_only=False)
m.load_state_dict(ck['model_state_dict'], strict=False)
m.eval()
x_beat = torch.randn(1, 128, 1)
x_rr   = torch.randn(1, 4)
torch.onnx.export(m, (x_beat, x_rr), 'integration/ecg_v2.onnx',
                   input_names=['beat','rr'], output_names=['logits'],
                   opset_version=13,
                   dynamic_axes={'beat':{0:'B'}, 'rr':{0:'B'}, 'logits':{0:'B'}})
print('Wrote integration/ecg_v2.onnx')
"

# 2. ONNX -> TensorFlow SavedModel (needs tensorflow + onnx2tf)
pip install onnx2tf tensorflow
onnx2tf -i integration/ecg_v2.onnx -o integration/ecg_v2_tf_saved

# 3. SavedModel -> TFLite with INT8 quantization using a real calibration set
python -c "
import tensorflow as tf, numpy as np
converter = tf.lite.TFLiteConverter.from_saved_model('integration/ecg_v2_tf_saved')
converter.optimizations = [tf.lite.Optimize.DEFAULT]
cache = np.load('cache/cinc_n_beats.npz')
def rep():
    for i in range(500):
        beat = cache['beats'][i].astype(np.float32)[None, :, None]
        rr   = cache['rr_features'][i].astype(np.float32)[None, :]
        yield [beat, rr]
converter.representative_dataset = rep
converter.target_spec.supported_ops = [tf.lite.OpsSet.TFLITE_BUILTINS_INT8]
converter.inference_input_type  = tf.int8
converter.inference_output_type = tf.int8
open('integration/ecg_v2_int8.tflite','wb').write(converter.convert())
print('Wrote integration/ecg_v2_int8.tflite')
"
```

**Deliverable:** `integration/ecg_v2_int8.tflite` — roughly **16 KB**. This is the
single file that ships to the watch app under `app/src/main/assets/`.

### 4.2 Parity test (must pass before shipping)

Same 100 beats, same RR features, run through both paths. INT8 predicted classes
should match FP32 on at least 98% of beats.

```bash
python integration/parity_test.py  # see §7 below for the test template
```

### 4.3 Drop the file into the Wear OS app

```
watch-app/
└── app/src/main/
    └── assets/
        └── ecg_v2_int8.tflite          <-- place here
```

---

## 5. Watch app module layout (Kotlin)

```
watch-app/
├── app/src/main/assets/
│   ├── ecg_v2_int8.tflite              [model 1, ~16 KB]
│   ├── fall_detector.tflite            [model 2, external]
│   └── har_classifier.tflite           [model 3, external]
│
├── app/src/main/java/com/yourorg/health/
│   ├── ml/
│   │   ├── ModelRegistry.kt            # shared TFLite interpreter pool
│   │   ├── EcgBeatClassifier.kt        # wraps ecg_v2_int8.tflite
│   │   ├── FallDetector.kt             # wraps fall_detector.tflite
│   │   └── HarClassifier.kt            # wraps har_classifier.tflite
│   │
│   ├── signal/
│   │   ├── EcgConstants.kt             # port of config.py (128 Hz, 128 samples, 48/80 L/R)
│   │   ├── EcgBandpass.kt              # order-4 Butterworth biquad cascade
│   │   ├── EcgNotch.kt                 # 50 Hz or 60 Hz notch biquad
│   │   ├── EcgZScore.kt                # per-beat normalization
│   │   ├── RPeakDetector.kt            # lightweight Pan-Tompkins port
│   │   ├── RingBuffer.kt               # 10-s rolling window at 128 Hz
│   │   └── RrFeatureExtractor.kt       # 4-dim RR features in seconds
│   │
│   ├── pipeline/
│   │   ├── EcgStreamPipeline.kt        # sensor -> filter -> peaks -> classifier
│   │   ├── FallStreamPipeline.kt       # triggered by accel magnitude
│   │   └── HarStreamPipeline.kt        # 1 Hz sliding window over IMU
│   │
│   ├── events/
│   │   ├── ClinicalEvent.kt            # sealed class: {AbnormalBeat(N/S/V/F), Fall, Activity, ...}
│   │   ├── EventBus.kt                 # local Kotlin Flow
│   │   └── EventStore.kt               # sqlite: rolling 24 h ring
│   │
│   ├── sync/
│   │   └── PhoneSync.kt                # wear OS Data Layer client
│   │
│   └── ui/
│       ├── MainWearActivity.kt
│       ├── screens/LiveEcgScreen.kt
│       └── complications/HeartHealth.kt
│
└── app/build.gradle.kts                # deps: tflite, Health Services, Wear Compose
```

### 5.1 Key Gradle dependencies (Kotlin DSL)

```kotlin
dependencies {
    // Wear OS + Compose
    implementation("androidx.wear.compose:compose-material:1.3.0")
    implementation("androidx.wear.compose:compose-foundation:1.3.0")

    // Health Services (ECG, HR)
    implementation("androidx.health:health-services-client:1.0.0-rc02")

    // Data Layer (phone sync)
    implementation("com.google.android.gms:play-services-wearable:18.2.0")

    // TFLite + XNNPACK delegate
    implementation("org.tensorflow:tensorflow-lite:2.14.0")
    implementation("org.tensorflow:tensorflow-lite-support:0.4.4")
    // Optional GPU delegate if Watch 5 gains GPU-backed TFLite in future:
    // implementation("org.tensorflow:tensorflow-lite-gpu:2.14.0")
}
```

### 5.2 `EcgBeatClassifier.kt` — reference implementation

```kotlin
class EcgBeatClassifier(context: Context) {

    private val interpreter: Interpreter

    init {
        val model = FileUtil.loadMappedFile(context, "ecg_v2_int8.tflite")
        val options = Interpreter.Options().apply {
            numThreads = 2                           // W920 has 2 cores
        }
        interpreter = Interpreter(model, options)
    }

    // beatWindow: 128 floats, already filtered + z-scored
    // rrFeatures: 4 floats [pre_rr, post_rr, ratio, local_mean_rr] in seconds
    fun predict(beatWindow: FloatArray, rrFeatures: FloatArray): Prediction {
        require(beatWindow.size == 128)
        require(rrFeatures.size == 4)

        // INT8 quantized: convert to Int8 via the model's input quant params
        val beatInput = quantizeInput(beatWindow, interpreter.getInputTensor(0))
        val rrInput   = quantizeInput(rrFeatures, interpreter.getInputTensor(1))

        val logitsQ = ByteArray(4)
        interpreter.runForMultipleInputsOutputs(
            arrayOf(beatInput, rrInput), mapOf(0 to logitsQ)
        )

        val logits = dequantizeOutput(logitsQ, interpreter.getOutputTensor(0))
        val probs  = softmax(logits)
        val idx    = probs.indices.maxBy { probs[it] }
        return Prediction(
            classIdx = idx,
            className = EcgConstants.AAMI_CLASSES[idx],   // "N" | "S" | "V" | "F"
            confidence = probs[idx]
        )
    }

    fun close() = interpreter.close()
}

data class Prediction(val classIdx: Int, val className: String, val confidence: Float)
```

### 5.3 `EcgStreamPipeline.kt` — the runtime loop

```kotlin
class EcgStreamPipeline(
    private val classifier: EcgBeatClassifier,
    private val bandpass: EcgBandpass,
    private val notch: EcgNotch,
    private val peakDetector: RPeakDetector,
    private val rrExtractor: RrFeatureExtractor,
    private val eventBus: EventBus
) {
    private val ring = RingBuffer(capacitySeconds = 10, sampleRateHz = 128)
    private val recentPredictions = SlidingWindow<Int>(size = 5)

    fun onEcgSample(sample: Float, timestampNs: Long) {
        ring.push(sample)
        // Process every ~1 second
        if (ring.newSamplesSinceLastProcess() >= 128) {
            processWindow()
        }
    }

    private fun processWindow() {
        val raw = ring.last(samples = 1280)                          // 10 s window
        val filt = notch.apply(bandpass.apply(raw))
        val peaks = peakDetector.detect(filt)                         // sample indices
        for (peakIdx in peaks.newSinceLast()) {
            val start = peakIdx - EcgConstants.BEAT_WINDOW_LEFT       // 48
            val end   = peakIdx + EcgConstants.BEAT_WINDOW_RIGHT      // 80
            if (start < 0 || end > filt.size) continue

            val beat = EcgZScore.normalize(filt.sliceArray(start until end))
            val rr   = rrExtractor.compute(peaks.all(), peakIdx)      // FloatArray(4)

            val pred = classifier.predict(beat, rr)

            // Temporal smoothing: majority vote over last 5 predictions
            val smoothedIdx = recentPredictions.push(pred.classIdx).majorityVote()
            if (smoothedIdx in listOf(1, 2)) {                        // S or V
                eventBus.emit(
                    ClinicalEvent.AbnormalBeat(
                        aamiClass = EcgConstants.AAMI_CLASSES[smoothedIdx],
                        confidence = pred.confidence,
                        timestampNs = timestampNs,
                        peakSampleIdx = peakIdx
                    )
                )
            }
        }
    }
}
```

### 5.4 How ECG is captured on Watch 5

Samsung's stock Health Services API provides only on-demand 30-second ECG strips.
Three options in increasing order of access:

| Option | What you get | Gates |
| --- | --- | --- |
| Health Services `MeasureClient` | 30-s ECG on explicit user tap | Free, any developer |
| Samsung Health Monitor SDK | Programmatic 30-s strips | Samsung partnership |
| **Samsung Privileged Health SDK** | Continuous raw ECG | Research-track enrollment via Samsung |

Your ECG model assumes a **continuous** stream. If you cannot get the Privileged
SDK, switch to sampled mode: record a 30 s strip every 5 min, classify all beats
in it, sleep the rest. Battery lasts ~20–30 h in this mode.

---

## 6. Phone companion app

```
phone-app/
├── app/src/main/assets/
│   └── (no TFLite models — phone's job is persistence + LLM)
│
├── app/src/main/java/com/yourorg/health/
│   ├── sync/
│   │   ├── WatchListenerService.kt     # extends WearableListenerService
│   │   └── DataLayerRepository.kt
│   │
│   ├── persistence/
│   │   ├── AppDatabase.kt              # Room
│   │   ├── dao/EcgEventDao.kt
│   │   ├── dao/FallEventDao.kt
│   │   ├── dao/HarSessionDao.kt
│   │   └── entity/ClinicalEvent.kt
│   │
│   ├── aggregation/
│   │   ├── ContextBuilder.kt           # rolls events into LLM context
│   │   ├── EventSummarizer.kt
│   │   └── AnomalyRules.kt             # simple rule engine (AF burden, fall-after-sitting, etc.)
│   │
│   ├── llm/
│   │   ├── LlmProvider.kt              # interface
│   │   ├── GeminiNanoProvider.kt       # AICore on Android 14+
│   │   ├── CloudLlmProvider.kt         # Claude / OpenAI fallback
│   │   ├── LocalLlamaProvider.kt       # MediaPipe LLM Inference fallback
│   │   └── PromptBuilder.kt
│   │
│   ├── notifications/
│   │   └── AlertNotifier.kt
│   │
│   └── ui/
│       ├── MainActivity.kt
│       └── screens/{Dashboard, Chat, EventDetail, Settings}.kt
│
└── app/build.gradle.kts
```

### 6.1 Phone Gradle dependencies

```kotlin
dependencies {
    // Wear OS pairing
    implementation("com.google.android.gms:play-services-wearable:18.2.0")

    // Room
    implementation("androidx.room:room-runtime:2.6.1")
    implementation("androidx.room:room-ktx:2.6.1")
    ksp("androidx.room:room-compiler:2.6.1")

    // AICore (Gemini Nano) — Android 14+, specific devices
    // implementation("com.google.ai.client.generativeai:generativeai:0.2.x")

    // MediaPipe LLM Inference (Llama 3.2 fallback)
    // implementation("com.google.mediapipe:tasks-genai:0.10.x")

    // (Optional) cloud LLM clients
    // implementation("com.anthropic:anthropic-java:<x>")
    // implementation("com.openai:openai-java:<x>")
}
```

### 6.2 LLM context sketch

```kotlin
class ContextBuilder(
    private val ecgDao: EcgEventDao,
    private val fallDao: FallEventDao,
    private val harDao: HarSessionDao
) {
    suspend fun build(lastHours: Int = 6): String {
        val ecg = ecgDao.summarizeLast(lastHours)
        val falls = fallDao.getLast(lastHours)
        val activities = harDao.summarizeLast(lastHours)

        return """
            Over the last $lastHours hours:
            - Primary activity: ${activities.mostCommon} (${activities.durationMin} min).
            - Heart rate: avg ${ecg.avgHrBpm} bpm (rest ${ecg.restBpm}, active ${ecg.activeBpm}).
            - Beats analyzed: ${ecg.total}, abnormal: ${ecg.abnormal}
              (V: ${ecg.v}, S: ${ecg.s}, F: ${ecg.f}).
              Suspected AF burden: ${ecg.afBurdenMin} min.
            - Fall events: ${falls.size}.
        """.trimIndent()
    }
}
```

### 6.3 Prompt discipline (important)

- **Never** send raw ECG samples to a cloud LLM. Only aggregated counts/summaries.
- **Never** let the LLM output a diagnosis — use a system prompt that explicitly
  forbids medical conclusions.
- **Always** include a "not a medical device" disclaimer in user-facing LLM output.

```kotlin
val system = """
    You are a wellness assistant. You NEVER give a medical diagnosis.
    You summarize patterns in the user's health data and suggest when to
    consult a clinician. If you are unsure, say so. Do not claim to detect
    disease. Your outputs are informational only.
""".trimIndent()
```

---

## 7. Parity test template

Place at `integration/parity_test.py` before the first TFLite deploy:

```python
import numpy as np
import torch
import tensorflow as tf
import sys
sys.path.insert(0, '.')
from models.student_cnn import build_student_model

# 1. Load PyTorch FP32 model
m = build_student_model(use_fv_head=False, kd_proj_dim=None, verbose=False)
ck = torch.load('output/checkpoints/v2_cincaug_ssl_seed42.pt',
                 map_location='cpu', weights_only=False)
m.load_state_dict(ck['model_state_dict'], strict=False); m.eval()

# 2. Load TFLite INT8 model
interp = tf.lite.Interpreter(model_path='integration/ecg_v2_int8.tflite')
interp.allocate_tensors()
inp0, inp1 = interp.get_input_details()
out0 = interp.get_output_details()[0]

# 3. Run 500 cached DS2 beats through both
cache = np.load('cache/cinc_n_beats.npz')
beats = cache['beats'][:500]
rrs   = cache['rr_features'][:500]

torch_preds, tflite_preds = [], []
for i in range(500):
    beat = beats[i].astype(np.float32)
    rr   = rrs[i].astype(np.float32)

    with torch.no_grad():
        l_pt = m(torch.from_numpy(beat[None, :, None]),
                 torch.from_numpy(rr[None, :]))
    torch_preds.append(int(l_pt.argmax(1).item()))

    # Quantize inputs according to the TFLite model's scale/zero_point
    beat_q = np.round(beat / inp0['quantization'][0]
                      + inp0['quantization'][1]).astype(np.int8)
    rr_q   = np.round(rr / inp1['quantization'][0]
                      + inp1['quantization'][1]).astype(np.int8)
    interp.set_tensor(inp0['index'], beat_q[None, :, None])
    interp.set_tensor(inp1['index'], rr_q[None, :])
    interp.invoke()
    l_tfl = interp.get_tensor(out0['index'])[0]
    tflite_preds.append(int(l_tfl.argmax()))

agree = np.mean(np.array(torch_preds) == np.array(tflite_preds))
print(f'Agreement: {agree:.3%} across 500 beats')
assert agree > 0.98, 'Parity failure — check preprocessing or quant params'
```

If agreement drops below 98%, re-check Kotlin preprocessing (bandpass
coefficients, RR feature units, z-score) before blaming the model.

---

## 8. Event schemas (watch → phone over Data Layer)

All events are JSON-encoded (or Protobuf if you prefer); sent via `MessageClient`
on `/health/events/<type>` paths.

### 8.1 `AbnormalBeat` event

```json
{
  "type": "AbnormalBeat",
  "timestamp_ns": 1729448323456789000,
  "aami_class": "V",
  "confidence": 0.87,
  "rr_ms": [920, 510],
  "watch_battery_pct": 62
}
```

### 8.2 `Fall` event

```json
{
  "type": "Fall",
  "timestamp_ns": 1729448423456789000,
  "confidence": 0.94,
  "accel_peak_g": 4.2,
  "gyro_peak_dps": 380,
  "activity_before": "walking"
}
```

### 8.3 `Activity` event (HAR rollup, every minute)

```json
{
  "type": "ActivityMinute",
  "timestamp_ns": 1729448480000000000,
  "duration_s": 60,
  "activity_histogram": {
    "sitting": 42, "walking": 15, "stairs_up": 3
  }
}
```

### 8.4 Batching / buffering rule

- Urgent events (Fall, AF-suspected) → send immediately via `MessageClient`.
- Beat-level detections → batch 1/min → `DataClient` PutDataItem.
- HAR → rollup once per minute.
- If phone unreachable: keep up to 24 h buffered on watch (sqlite).

---

## 9. Battery strategy

| Mode | Description | Est. battery life |
| --- | --- | --- |
| **Continuous** | ECG + HAR + fall always on | ~8–10 h |
| **Sampled** (default) | 30-s ECG every 5 min; HAR 1 Hz; fall event-triggered | ~20–30 h |
| **Triggered** | HR monitor always on; ECG only when HR anomaly | ~36–48 h |
| **Workout** | Continuous during user-initiated workout only | (context-dependent) |

Expose these as a user setting. Default to **Sampled**.

---

## 10. Privacy / regulatory notes

- Package a "not a medical device" disclaimer in the app; require user to agree
  on first launch.
- Never upload raw ECG samples to cloud LLMs. Aggregate first.
- If you add any clinical claim (diagnose AF, predict cardiac event), FDA (US) or
  CE (EU) regulatory review is triggered. This project ships with a research /
  wellness classification only.
- HIPAA-equivalent encryption for the phone Room DB: use SQLCipher / Android
  Keystore-derived key.

---

## 11. Recommended build order (2–3 months, one full-time engineer)

| Week | Deliverable |
| --- | --- |
| 1 | TFLite export (§4) + parity test (§7) passes |
| 2 | Wear OS project skeleton + Health Services ECG listener |
| 3 | Kotlin preprocessor (bandpass, notch, z-score) with unit tests |
| 4 | R-peak detector + RR feature extractor with parity tests |
| 5 | `EcgBeatClassifier.kt` wired end-to-end; live prediction demo |
| 6 | Integrate fall + HAR models; EventBus scaffolding |
| 7 | Phone companion skeleton + Data Layer sync of events |
| 8 | Room DB + aggregation queries + rules engine |
| 9 | LLM integration (Gemini Nano primary, cloud fallback) |
| 10 | UI: watch complication + phone dashboard |
| 11 | Battery profiling, integration tests, crash hardening |
| 12 | Beta release |

---

## 12. File quick-reference card (the two questions this doc has to answer)

**"Which ECG model do I use?"** →
`output/checkpoints/v2_cincaug_ssl_seed42.pt` (single seed) — convert to
`integration/ecg_v2_int8.tflite` and ship to the watch. Use
`output/checkpoints/ensemble/v2_ens_ssl_manifest.txt` only on phone or server.

**"Where does each component run?"** →

| Component | Location | Exact path / API |
| --- | --- | --- |
| ECG classifier | Watch | `app/src/main/assets/ecg_v2_int8.tflite` |
| ECG preprocessor | Watch | Kotlin port of `preprocessing/filtering.py` |
| R-peak detector | Watch | Kotlin Pan–Tompkins port |
| Fall detector | Watch | `app/src/main/assets/fall_detector.tflite` (external) |
| HAR | Watch | `app/src/main/assets/har_classifier.tflite` (external) |
| Event store | Watch (24 h buffer) + Phone (persistent) | SQLite / Room |
| LLM | Phone | Gemini Nano (AICore), Claude/OpenAI (cloud), or Llama 3.2 (MediaPipe) |
| Watch ↔ phone sync | — | Wear OS Data Layer API (`MessageClient` / `DataClient`) |

---

## 13. Known open questions (must resolve before prod)

1. **Continuous ECG access on Watch 5.** Without the Samsung Privileged Health
   SDK, you are limited to 30-s on-demand strips. Is the app scoped for
   "sampled" mode, or will you pursue SDK enrollment?
2. **Fall and HAR model specs.** This doc assumes standard sizes. When the
   actual TFLite files arrive, verify each fits within the 32 KB total RAM
   budget alongside the ECG model.
3. **Phone offline handling.** Confirm 24 h is the right buffer; may need longer
   for users who go days without unlocking phone.
4. **Model OTA updates.** Decide between: app-bundled (redeploy for each model
   update) vs. Firebase ML Kit hosted vs. a plain CDN URL with signature
   verification.
5. **Regulatory scope.** Research / wellness / clinical — each gate requires
   different IRB / FDA / CE paperwork.

---

*Author: integration plan grounded in the v2 ECG classifier shipped at
`M:/GradProject/ECG_DEV/MIT-BIH/Trial_3/`. See `REPORT.md` and `RESULTS.md`
for training-time design and measured metrics.*
