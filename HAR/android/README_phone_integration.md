# Activity Recognition (HAR) — Phone-App Integration Guide

**For:** the mobile (phone) app developer
**What this adds:** on-device **Human Activity Recognition**. Every second the app
can tell whether the wearer is **walking, jogging, on stairs, or stationary** —
and it ignores fake movements / random hand motion instead of mislabeling them.

It runs entirely on the phone (TensorFlow Lite), fed by the Galaxy Watch 5 sensor
stream the app **already receives**. No watch-side changes, no new transport, no
internet.

---

## 0. TL;DR — what you do

1. Add one Gradle dependency.
2. Drop `har_model_float.tflite` into `app/src/main/assets/`.
3. Drop in `HarClassifier.kt` (change the `package` line).
4. Call `classifier.onPacket(packet)` for each sensor packet you already parse.
5. Observe `classifier.result` and show `r.activity` when `r.isConfident`.

That's it. ~20 lines of glue.

---

## 1. Prerequisite (must already be in place)

This builds directly on the watch↔phone integration in
`README_watch_mobile_integration.md`. The classifier consumes the **`SensorPacket`**
object that doc's parser produces — specifically its `imuHighRate` block
(`accelX/Y/Z`, `gyroX/Y/Z` arrays at ~50 Hz).

If the app already receives and parses watch packets (the `SensorPacket`,
`ImuHighRateWindow`, `LiveSensorRepository` classes from that README exist), you
are ready. **If not, do that integration first** — this feature has nothing to
classify without it.

---

## 2. Files in this handoff

| File | What to do with it |
|------|--------------------|
| `har_model_float.tflite` | The model (~0.65 MB). Put in `app/src/main/assets/`. **Use this one.** |
| `har_model_int8.tflite` | Optional smaller build (~0.18 MB), same contract. Use only if you need the space. |
| `HarClassifier.kt` | Drop into your source tree; change the `package` line. |
| `har_model_meta.json` | Reference: the exact I/O contract, the tuned threshold, and the measured accuracy. The defaults in `HarClassifier.kt` already match it. |
| `README_phone_integration.md` | This file. |

---

## 3. Step-by-step

### 3.1 Gradle

```groovy
// app/build.gradle  ->  dependencies { ... }
implementation 'org.tensorflow:tensorflow-lite:2.14.0'
```

If you use R8/ProGuard, keep TFLite from being stripped:
```
-keep class org.tensorflow.** { *; }
```

### 3.2 Model asset

Copy `har_model_float.tflite` into `app/src/main/assets/` (create the folder if it
doesn't exist). `.tflite` is not compressed by aapt, so it memory-maps fine.

### 3.3 Add `HarClassifier.kt`

Put it anywhere in your source tree (e.g. next to your `wear` package). Change the
**first line** `package ...` to your app's package. It reuses the `SensorPacket` /
`ImuHighRateWindow` types from the watch-integration README — no new model classes.

### 3.4 Create the classifier once, feed every packet

Create one instance (the TFLite interpreter should be built once):

```kotlin
object HarHolder {
    lateinit var classifier: HarClassifier
    fun init(ctx: Context) {
        if (!::classifier.isInitialized)
            classifier = HarClassifier(ctx.applicationContext)
    }
}
```

Call `HarHolder.init(this)` in `Application.onCreate()` (or the receiver service's
`onCreate`). Then, wherever you already handle a parsed packet
(`SensorDataReceiverService.onMessageReceived`):

```kotlin
LiveSensorRepository.emit(packet)        // you already have this
HarHolder.classifier.onPacket(packet)    // <-- add this line
```

### 3.5 Observe results

```kotlin
lifecycleScope.launch {
    repeatOnLifecycle(Lifecycle.State.STARTED) {
        HarHolder.classifier.result.collect { r ->
            if (r.isConfident) {
                activityText.text = r.activity          // "walking" / "jogging" / "stairs" / "stationary"
            } else {
                activityText.text = "—"                 // not sure / fake movement → show nothing
            }
        }
    }
}
```

`result` is a `StateFlow<HarResult>`:

```kotlin
data class HarResult(
    val activity: String,        // "walking" | "jogging" | "stairs" | "stationary"
    val confidence: Float,       // 0..1, the activity head's top probability
    val isReal: Float,           // 0..1, junk detector (1 = real activity, 0 = fake movement)
    val isConfident: Boolean,    // true => show it; false => uncertain / fake movement
    val probabilities: FloatArray // per-class probabilities, order = CLASS_NAMES
)
```

**Rule of thumb for the UI:** only display an activity when `isConfident == true`.

---

## 4. The model contract (FYI — already handled by `HarClassifier.kt`)

| | |
|---|---|
| **Input** | float32 `[1, 200, 6]` — a 10-second window at 20 Hz, channels `[ax, ay, az, gx, gy, gz]` |
| **Units** | accel = m/s² (incl. gravity), gyro = rad/s — **raw** values; normalization is baked into the model |
| **Output 1 `probs`** | float32 `[1, 4]` softmax over `["walking","jogging","stairs","stationary"]` |
| **Output 2 `is_real`** | float32 `[1, 1]` — P(real tracked activity); reject as fake movement if `< tau` |
| **tau (threshold)** | `0.8` (from `har_model_meta.json`) |

You don't compute any of this yourself — `HarClassifier.kt` does the buffering,
the 50→20 Hz downsampling, the windowing, and applies the threshold.

---

## 5. How it works (so you can tune it)

- The watch sends ~50 Hz IMU in `imuHighRate` once per second. The model is 20 Hz,
  so the classifier resamples each 1-second block 50→20 Hz.
- It keeps a **10-second sliding window** and predicts **once per second**.
- It has **two heads**: an activity classifier (`probs`) and a dedicated
  fake-movement detector (`is_real`). A window is reported as a confident activity
  only when `is_real ≥ tau`; otherwise it's treated as junk/uncertain. (A plain
  confidence threshold can't do this — neural nets stay overconfident on motion
  they were never trained on; the dedicated detector is what makes rejection work.)
- A short **majority-vote smoother** (last 3 predictions) removes single-second
  flicker.

### Tuning knobs (constructor args)

```kotlin
HarClassifier(
    context,
    junkThreshold = 0.80f,   // raise → reject more (fewer false activities); lower → more sensitive
    smoothingWindow = 3      // 1 = off; larger = steadier but slower to switch
)
```

---

## 6. What to expect (measured, subject-independent)

Tested on people the model never trained on:

| Metric | Value |
|--------|-------|
| Accuracy per 1-second window | **94%** |
| Accuracy in real use (voted over an activity bout) | **~96%** |
| Fake-movement rejection | **~89%** |
| First prediction after launch | ~10 s (one window must fill) |
| Inference cost | ~1 ms/window, 0.65 MB model |

Per-activity quality: `stationary` and `jogging` are strongest; `stairs` is the
weakest (a wrist sensor can't fully separate stairs from walking) but still ~0.91 f1.

---

## 7. Coexisting with your other models

The app can host several models on the same stream. They all share the one
`LiveSensorRepository.packets` flow. `HarClassifier` keeps its own internal buffer,
so adding it does **not** interfere with the ECG model or any other consumer —
each just subscribes to the same packets independently.

---

## 8. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `result` never updates | You're not calling `onPacket(packet)`. Add it where you emit to `LiveSensorRepository`. |
| Always `isConfident == false` | Watch on the wrist? `imuHighRate` null for the first 1–2 packets is normal. If it persists, the watch stream may be stalled — verify packets are arriving (logcat `SensorReceiverSvc`). |
| Activity never changes / very laggy | Lower `smoothingWindow` (e.g. 1). |
| Too many false activities during hand motion | Raise `junkThreshold` (e.g. 0.85–0.9). |
| Misses real activities (too strict) | Lower `junkThreshold` (e.g. 0.6–0.7). |
| `FileNotFoundException` on the asset | `har_model_float.tflite` must be in `app/src/main/assets/` (exact name). |
| Crash: TFLite class not found in release build | Add the ProGuard keep rule in §3.1. |

---

## 9. Checklist

- [ ] Watch→phone packet parsing already works (`SensorPacket` exists).
- [ ] `tensorflow-lite` dependency added.
- [ ] `har_model_float.tflite` in `app/src/main/assets/`.
- [ ] `HarClassifier.kt` added, `package` line changed.
- [ ] `HarHolder.init(...)` called once at startup.
- [ ] `onPacket(packet)` called for each parsed packet.
- [ ] UI observes `result` and shows `activity` only when `isConfident`.

Questions on the model itself (retraining, thresholds, adding classes) → see
`../README.md` and `../RESULTS.md` in the `har_model/` folder.
