# Changes for Mostafa — 2026-05-23 (SpO2 addition)

## TL;DR — what's new since the May 13 build

We added **SpO2 on-demand measurement**, following the exact same pattern
as ECG. The user taps "Measure SpO2" on the main watch screen → 30-sec
Samsung Health session → result lands in the phone app's home screen
vitals card.

**Action you need to take:** rebuild the watch APK once more with your
Samsung-whitelisted keystore (same one as ECG) and reinstall on the
watch. ECG keeps working exactly as before — this is additive.

**Files added:**
- `app/src/main/java/spo2/Spo2Capture.kt` — Samsung SDK SPO2_ON_DEMAND wrapper (mirrors `EcgCapture.kt`)
- `app/src/main/java/spo2/SharedSpo2Buffer.kt` — single-slot buffer (mirrors `SharedEcgBuffer.kt`)
- `app/src/main/java/spo2/Spo2RecordingActivity.kt` — UI screen (mirrors `EcgRecordingActivity.kt`)
- `app/src/main/res/layout/activity_spo2_recording.xml` — layout

**Files modified:**
- `app/src/main/java/data/SensorDataModel.kt` — added `Spo2Reading` data class + `spo2: Spo2Reading?` on `SensorDataPacket`
- `app/src/main/java/sensors/SensorManagerController.kt` — `snapshot()` now drains `SharedSpo2Buffer.drainResult()` and includes it in the packet
- `app/src/main/java/service/SensorForegroundService.kt` — added `Spo2Capture` member + `ACTION_START_SPO2`/`ACTION_STOP_SPO2` intents + listener
- `app/src/main/java/com/example/ecgwatch/MainActivity.kt` — wired the new SpO2 button
- `app/src/main/AndroidManifest.xml` — registered `Spo2RecordingActivity`
- `app/src/main/res/layout/activity_main.xml` — added SpO2 button next to ECG button
- `app/src/main/res/values/strings.xml` — SpO2 UI strings
- `app/src/main/java/utils/JsonBuilder.kt` — `spo2` field in outgoing /sensor_data JSON

**Samsung partnership note:** SPO2_ON_DEMAND is part of the same Samsung
Health Sensor SDK 1.4.1 that ECG uses, so the same signing-certificate
whitelist covers both — no new partnership enrollment step.

---

# Original changes — 2026-05-13

**Author of changes:** Phone-side integrator (Smart Health phone app team)
**Files changed:** 3 source files + this changelog
**Watch side functional impact:** none for users; ~17 KB/s of additional
sensor data added to each `/sensor_data` packet
**Action you need to take:** rebuild the APK on your machine (you keep
your Samsung-whitelisted debug keystore) and reinstall on the watch

---

## What changed and why

Your phone-side integrator (the Smart Health React Native app) needs
on-device fall detection (FusionNet) and human-activity-recognition
(CNN-Transformer) to run on **watch-sourced IMU data**. Both models were
trained on wrist-mounted IMU at 50-100 Hz; the existing 1-Hz `accelerometer`/
`gyroscope` fields in your unified JSON packet only provide a single
sample per second, which is two orders of magnitude too slow for those
inference windows (fall = 2-s window @ ~100 Hz = 200 samples; HAR =
2.56-s window @ 50 Hz = 128 samples).

The fix is small and non-breaking — your packet schema is **extended**,
not replaced. Existing consumers reading `accelerometer`, `gyroscope`,
`pressure` etc. at 1 Hz keep working unchanged.

---

## Files modified

### 1. `app/src/main/java/data/SensorDataModel.kt`

Added three data classes and one field:

```kotlin
data class TimestampedVec3(val tsNs: Long, val v: Vector3)
data class TimestampedFloat(val tsNs: Long, val value: Float)
data class ImuHighRateWindow(
    val sampleRateHz: Int,
    val accelSamples: List<TimestampedVec3>,
    val gyroSamples:  List<TimestampedVec3>,
    val pressureSamples: List<TimestampedFloat>
)

data class SensorDataPacket(
    // ...all existing fields unchanged...,
    val imuHighRate: ImuHighRateWindow? = null   // <-- NEW
)
```

`SensorDataPacket.imuHighRate` defaults to null, so any existing call
site that constructs a packet without this argument keeps compiling.

### 2. `app/src/main/java/sensors/SensorManagerController.kt`

Three changes:

**A. Bump accelerometer + gyroscope registration rate** (lines ~50-58):

```kotlin
register(accelerometerSensor, SensorManager.SENSOR_DELAY_GAME, "Accelerometer")
register(gyroscopeSensor,     SensorManager.SENSOR_DELAY_GAME, "Gyroscope")
```

Was `SENSOR_DELAY_NORMAL` (~5 Hz). Now `SENSOR_DELAY_GAME` (~50 Hz
nominal). Other sensors stay at `NORMAL` — barometer, step counter,
linear accel, gravity, magnetometer don't need high rate.

**B. Add three new buffers** (next to the existing `AtomicReference`
fields, ~line 37):

```kotlin
private val accelBuffer = ArrayList<TimestampedVec3>(64)
private val gyroBuffer  = ArrayList<TimestampedVec3>(64)
private val pressureBuffer = ArrayList<TimestampedFloat>(8)
private val imuLock = Any()
private val imuSampleRateHz = 50
```

**C. In `onSensorChanged()`, append every sample to the appropriate
buffer** (around lines 115-123, in addition to the existing
`latestX.set(...)` calls):

```kotlin
Sensor.TYPE_ACCELEROMETER -> {
    val v = event.toVector3()
    latestAccelerometer.set(v)               // existing
    synchronized(imuLock) {                  // new
        accelBuffer.add(TimestampedVec3(event.timestamp, v))
    }
}
// Similar for TYPE_GYROSCOPE and TYPE_PRESSURE.
```

**D. In `snapshot()`, drain the buffers under lock and build an
`ImuHighRateWindow`** (line ~69 onwards). The drain is done under
`synchronized(imuLock)` so `onSensorChanged()` can keep appending the
moment we release.

### 3. `app/src/main/java/utils/JsonBuilder.kt`

Added serialisation for the new field. Output format adds one new
top-level JSON key, `imuHighRate`:

```json
{
  "timestamp": 1778683174,
  "heartRate": 67,
  "accelerometer":      {"x": ..., "y": ..., "z": ...},  // unchanged
  "gyroscope":          {"x": ..., "y": ..., "z": ...},  // unchanged
  // ...all existing fields...
  "ecg": null,
  "imuHighRate": {
    "sampleRateHz": 50,
    "accelSampleCount": 50,
    "gyroSampleCount": 50,
    "pressureSampleCount": 5,
    "accel": {
      "x":    [...50 floats...],
      "y":    [...50 floats...],
      "z":    [...50 floats...],
      "tsNs": [...50 longs...]
    },
    "gyro": {
      "x":    [...50 floats...],
      "y":    [...50 floats...],
      "z":    [...50 floats...],
      "tsNs": [...50 longs...]
    },
    "pressure": {
      "values": [...~5 floats...],
      "tsNs":   [...~5 longs...]
    }
  }
}
```

Per-axis parallel arrays were chosen over per-sample objects to keep
the JSON compact. A 50-sample accel window in parallel-array form is
~1.5 KB vs ~3 KB if each sample were its own `{x,y,z,tsNs}` object.

---

## Packet size impact

| State | Before | After |
|---|---|---|
| Idle (no ECG) | ~500 B | **~15 KB** |
| Recording ECG | ~7 KB | **~22 KB** |

Still well under the MessageClient 100 KB-per-message limit. Bandwidth
over Bluetooth is ~17 KB/s sustained (vs. ~500 B/s before); negligible
on modern phones.

---

## What you need to do

1. **Pull these changes** (or copy the three files from your
   `D:/GP-IMP/wear_app/` directory if we share a folder; otherwise I'll
   send you the patch).
2. **Rebuild the APK** in Android Studio: Build → Generate APKs →
   `app-debug.apk`. **Use your existing debug keystore** — Samsung's
   ECG whitelist is keyed to your debug-key SHA-256
   (`3E:6A:4C:B6:BB:...:DB`). If we build it here, our keystore is
   different and Samsung's ECG check fails.
3. **Uninstall the old app on the watch**, then install the new APK
   (same instructions as your README §6).
4. **Verify the new field is appearing** by tailing logcat with
   `adb -s 192.168.1.X:CONNECT_PORT logcat -s JsonBuilder` and looking
   for `imuHighRate` with non-empty `accel` / `gyro` arrays.
5. **Optional:** sanity-check sample rates against what GAME actually
   delivers on the Galaxy Watch 5. Nominal is 50 Hz but actual rate
   varies — log `accelSampleCount` over 30 seconds and check it's
   roughly `30 × 50 = 1500` total samples (give or take 10%).

---

## What if I want to push to a higher rate later (100 Hz)?

In `SensorManagerController.kt`, change:

```kotlin
SensorManager.SENSOR_DELAY_GAME       → SensorManager.SENSOR_DELAY_FASTEST
private val imuSampleRateHz = 50      → private val imuSampleRateHz = 100
```

`FASTEST` is a hint — actual rate depends on the sensor's native rate
(typically 100-200 Hz on the Galaxy Watch 5 IMU). Battery impact is
worse but the fall-detection model was originally trained at 100 Hz.

---

## Nothing changed about the ECG path

ECG capture, `SharedEcgBuffer`, `EcgRecordingActivity` are all
untouched. ECG continues to land in the `ecg` field exactly as before.
Once Samsung's whitelist fix lands, ECG starts flowing into the same
packets that now also carry the high-rate IMU window.

---

## Questions for you (the watch owner)

1. Is the ~15 KB/s extra bandwidth and the slightly higher battery
   drain at GAME rate acceptable for the thesis-demo battery budget?
   (Should still last 6-10 hours on the watch.)
2. Do you want the per-sample `tsNs` timestamps included in the JSON?
   I included them because we may want to interpolate to exact 100 Hz
   on the phone side later. If you'd rather save bandwidth, drop them
   — I can compress by ~30 % at the cost of losing per-sample timing
   precision.

---

If anything in these changes blocks something else you're doing on the
watch side, ping me and we'll work through it.
