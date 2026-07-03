# README — Watch ↔ Mobile App Integration

**From:** Mostafa Genidy (`mostafagenydy@gmail.com`)
**Project:** AI-Powered Smart Health Monitoring System (graduation thesis, Future University in Egypt)
**Watch app:** `com.gradproject2026.ecgwatch` — Galaxy Watch 5 (SM-R910)
**Date:** 2026-05-13

---

## 0. What you're integrating

The watch app is **finished and running on a real Galaxy Watch 5.** It captures sensors and (when Samsung's whitelist is fixed — see §7) ECG, and sends everything over the Wear OS Data Layer to a paired Android phone as a **single unified JSON packet per second**.

Your job: make the mobile app **receive that JSON, parse it, and use it** (display, store, feed to the ML model, whatever). No watch-side changes are required.

This README contains:
- §1 — The exact wire format (JSON schema)
- §2 — What you need to add to the phone app (deps, manifest, Kotlin code)
- §3 — Drop-in source files (ready to paste)
- §4 — How to test the connection end-to-end
- §5 — Pairing & prerequisites
- §6 — Troubleshooting
- §7 — ECG status (currently blocked at Samsung; will work later without code changes)

---

## 1. Wire format

**Transport:** Wear OS Data Layer, `MessageClient.sendMessage`
**Path:** `/sensor_data` (single channel — no other paths used)
**Frequency:** 1 packet per second
**Encoding:** UTF-8 JSON

### Packet schema (idle — no ECG recording)

```json
{
  "timestamp": 1778683174,
  "heartRate": 67,
  "accelerometer":      {"x": -0.59, "y":  3.25, "z": 8.90},
  "gyroscope":          {"x": -0.04, "y":  0.02, "z": 0.03},
  "stepCount": 0,
  "linearAcceleration": {"x": -0.09, "y": -0.08, "z": -0.31},
  "gravity":            {"x": -0.70, "y":  3.01, "z": 9.31},
  "pressure": 976.41,
  "magneticField":      {"x":  5.76, "y": -28.08, "z": -1.74},
  "ecg": null,
  "imuHighRate": {
    "sampleRateHz": 50,
    "accelSampleCount": 50,
    "gyroSampleCount": 50,
    "pressureSampleCount": 5,
    "accel": {
      "x": [0.031, 0.027, ...],   // 50 floats
      "y": [0.019, 0.022, ...],   // 50 floats
      "z": [9.74,  9.73,  ...]    // 50 floats
    },
    "gyro": {
      "x": [...],  "y": [...],  "z": [...]
    },
    "pressure": {
      "values": [...]              // ~5 floats per second (sensor's own rate)
    }
  }
}
```

The `imuHighRate` field carries **50 Hz** accelerometer and gyroscope samples (vs the 1 Hz mean values in the top-level `accelerometer` / `gyroscope` fields). Samples within each array are evenly spaced; the consumer assumes uniform `sampleRateHz` and does NOT need per-sample timestamps. The top-level `accelerometer` / `gyroscope` / `pressure` fields remain in place for 1 Hz consumers, unchanged.

`imuHighRate` may be `null` for the first 1-2 packets after app start (before buffers fill).

### Packet schema (during an ECG recording — ECG samples present)

When a user is actively recording an ECG (currently disabled pending Samsung — see §7), the `ecg` field carries the samples captured during that second:

```json
{
  "timestamp": 1778683174,
  "heartRate": 67,
  "accelerometer":      { ... },
  "gyroscope":          { ... },
  "stepCount": 0,
  "linearAcceleration": { ... },
  "gravity":            { ... },
  "pressure": 976.41,
  "magneticField":      { ... },
  "ecg": {
    "isRecording": true,
    "sampleRateHz": 500,
    "sampleCount": 500,
    "samplesMv": [0.012, 0.015, 0.011, ...],
    "leadOff":   [0, 0, 0, ...]
  }
}
```

### Field semantics

| Field | Type | Unit | Notes |
|-------|------|------|-------|
| `timestamp` | int64 | Unix seconds | Watch's wall clock |
| `heartRate` | int / null | BPM | null when watch isn't on wrist or sensor still warming up |
| `accelerometer.{x,y,z}` | float | m/s² | Total acceleration including gravity |
| `gyroscope.{x,y,z}` | float | rad/s | Angular velocity |
| `stepCount` | int / null | steps | Cumulative since boot |
| `linearAcceleration.{x,y,z}` | float | m/s² | Acceleration with gravity removed |
| `gravity.{x,y,z}` | float | m/s² | Gravity component (magnitude ~9.81) |
| `pressure` | float / null | hPa | Atmospheric pressure (barometer) |
| `magneticField.{x,y,z}` | float | µT | Compass field |
| `ecg` | object / null | — | `null` when no recording active; object during recording |
| `ecg.sampleRateHz` | int | Hz | Always 500 |
| `ecg.sampleCount` | int | — | Number of valid samples in this 1-second slice (typically 0–500) |
| `ecg.samplesMv[]` | float[] | mV | ECG amplitude per sample, length = sampleCount |
| `ecg.leadOff[]` | int[] | — | 0 = good electrode contact, non-zero = bad. Same length as samplesMv |
| `imuHighRate` | object / null | — | High-rate IMU window for the last 1 second. May be null briefly at startup. |
| `imuHighRate.sampleRateHz` | int | Hz | Nominal rate (usually 50). Samples assumed evenly spaced. |
| `imuHighRate.accelSampleCount` | int | — | Length of `accel.x` / `accel.y` / `accel.z` arrays. Typically ~50, varies ±10% per second. |
| `imuHighRate.gyroSampleCount` | int | — | Length of `gyro.x/y/z` arrays. Typically ~50. |
| `imuHighRate.pressureSampleCount` | int | — | Length of `pressure.values`. Typically ~5 (barometer's native rate). |
| `imuHighRate.accel.{x,y,z}[]` | float[] | m/s² | Per-axis accelerometer (total, includes gravity). Parallel arrays. |
| `imuHighRate.gyro.{x,y,z}[]` | float[] | rad/s | Per-axis gyroscope. Parallel arrays. |
| `imuHighRate.pressure.values[]` | float[] | hPa | Barometer samples within this 1-second window. |

### Key rules for the phone-side parser

1. **`ecg` may be `null`.** Always do `obj.optJSONObject("ecg")` and short-circuit if null.
2. **`heartRate`, `stepCount`, `pressure` may be `null`** (transient states). Use `optInt(...)` / `optDouble(...)` with defaults.
3. **`samplesMv` and `leadOff` are the same length** — they're parallel arrays. Index `i` of one corresponds to sample `i` of the other.
4. **An ECG session spans ~30 seconds** = roughly 30 packets, each carrying ~500 samples. Concatenate `samplesMv` from successive packets while `isRecording == true` to reconstruct the full waveform.
5. **The session ends** when a packet arrives with `"ecg": null` (or `isRecording: false`) again. That signals "session complete; total recording is whatever you've accumulated so far."
6. **`imuHighRate` may be `null`** for the first 1-2 packets after app start (buffers still filling). After that it's always present.
7. **`imuHighRate` arrays are uniformly spaced.** The phone is expected to treat them as 50 Hz (or whatever `sampleRateHz` says) without needing per-sample timestamps. If you need exact sample times, derive them as `packet.timestamp - 1 + i / sampleRateHz` seconds.
8. **Sample counts vary ±10% per packet.** `accelSampleCount`, `gyroSampleCount`, `pressureSampleCount` are NOT guaranteed exactly 50 / 50 / 5 each second — Android's `SENSOR_DELAY_GAME` is a hint, not a guarantee. Code defensively (read the count fields, don't assume).

---

## 2. What you need to add to the phone app

Three things:

1. Gradle dependencies
2. AndroidManifest declarations
3. Kotlin source files (3 files: receiver service, data classes, repository)

You're free to integrate this into whatever architecture your app already uses (MVVM, repository pattern, etc.). The receiver and parser are standalone; only the **UI binding** needs to be adapted to your existing screen.

---

## 3. Drop-in code

### 3.1 — `app/build.gradle` additions

Add to your `dependencies { ... }` block:

```groovy
// Wear OS Data Layer (MessageClient, NodeClient, WearableListenerService)
implementation 'com.google.android.gms:play-services-wearable:18.2.0'

// Kotlin coroutines (if not already present)
implementation 'org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1'
implementation 'org.jetbrains.kotlinx:kotlinx-coroutines-play-services:1.8.1'
```

No other dependencies needed.

Minimum SDK in `defaultConfig` should be **API 23+** (most apps already are). API 28+ recommended.

---

### 3.2 — `AndroidManifest.xml` additions

Inside the `<application>` element, register the receiver service. Use **your phone app's package** for the `android:name`:

```xml
<service
    android:name=".wear.SensorDataReceiverService"
    android:exported="true">
    <intent-filter>
        <action android:name="com.google.android.gms.wearable.MESSAGE_RECEIVED" />
        <data
            android:scheme="wear"
            android:host="*"
            android:pathPrefix="/sensor_data" />
    </intent-filter>
</service>
```

**`android:exported="true"` is required** — the Wear OS framework dispatches messages to this service from outside your process.

You can drop the `android:name=".wear.SensorDataReceiverService"` — that's relative to your phone's package. If you place the Kotlin file in a different package, adjust accordingly. The fully-qualified class name is what matters.

---

### 3.3 — Kotlin source files (3 files)

Create a new package `wear` under your existing source root, e.g. if your phone app's package is `com.example.smarthealth`, create:

```
app/src/main/java/com/example/smarthealth/wear/
├── SensorPacket.kt
├── SensorDataReceiverService.kt
└── LiveSensorRepository.kt
```

Adjust the `package` declarations to match your phone app's package.

---

#### File 1 — `SensorPacket.kt`

Data classes matching the watch's JSON. Designed to be the only thing the rest of your app needs to know about — UI, ViewModel, Repository, etc. work with `SensorPacket` directly, never with raw JSON.

```kotlin
package com.example.smarthealth.wear   // <-- CHANGE to your phone app's package

import org.json.JSONArray
import org.json.JSONObject

/** Live snapshot of all watch sensors plus optional ECG window plus high-rate IMU. */
data class SensorPacket(
    val timestamp: Long,                 // Unix seconds (watch wall clock)
    val heartRate: Int?,                 // BPM, null while warming up
    val accelerometer: Vec3,             // m/s² (total)             — 1 Hz mean
    val gyroscope: Vec3,                 // rad/s                    — 1 Hz mean
    val stepCount: Int?,                 // null at boot
    val linearAcceleration: Vec3,        // m/s² (gravity removed)
    val gravity: Vec3,                   // m/s²
    val pressure: Float?,                // hPa                      — 1 Hz mean
    val magneticField: Vec3,             // µT
    val ecg: EcgWindow?,                 // null when no recording active
    val imuHighRate: ImuHighRateWindow?  // ~50 Hz accel+gyro window; null briefly at startup
)

data class Vec3(val x: Float, val y: Float, val z: Float)

/** ECG samples carried inside a 1-second sensor packet during a recording session. */
data class EcgWindow(
    val isRecording: Boolean,
    val sampleRateHz: Int,               // always 500 for ECG_ON_DEMAND
    val samplesMv: FloatArray,           // length = sampleCount
    val leadOff: IntArray                // 0 = good contact, parallel to samplesMv
) {
    val sampleCount: Int get() = samplesMv.size

    /** True when every sample in this window had bad electrode contact. */
    val allBadContact: Boolean get() = leadOff.isNotEmpty() && leadOff.all { it != 0 }
}

/**
 * High-rate IMU samples for the 1-second window ending at this packet's timestamp.
 * Used for ML models (fall detection, HAR) that need >1 Hz input. Samples are
 * assumed uniformly spaced at sampleRateHz; no per-sample timestamps emitted.
 */
data class ImuHighRateWindow(
    val sampleRateHz: Int,
    val accelX: FloatArray, val accelY: FloatArray, val accelZ: FloatArray,
    val gyroX:  FloatArray, val gyroY:  FloatArray, val gyroZ:  FloatArray,
    val pressureValues: FloatArray
) {
    val accelSampleCount: Int get() = accelX.size
    val gyroSampleCount:  Int get() = gyroX.size
    val pressureSampleCount: Int get() = pressureValues.size
}

/** Pure-JSON parser. Throws on malformed input; callers should wrap in try/catch. */
object SensorPacketParser {

    fun parse(json: String): SensorPacket {
        val o = JSONObject(json)
        return SensorPacket(
            timestamp          = o.getLong("timestamp"),
            heartRate          = o.optIntOrNull("heartRate"),
            accelerometer      = o.getJSONObject("accelerometer").toVec3(),
            gyroscope          = o.getJSONObject("gyroscope").toVec3(),
            stepCount          = o.optIntOrNull("stepCount"),
            linearAcceleration = o.getJSONObject("linearAcceleration").toVec3(),
            gravity            = o.getJSONObject("gravity").toVec3(),
            pressure           = o.optDoubleOrNull("pressure")?.toFloat(),
            magneticField      = o.getJSONObject("magneticField").toVec3(),
            ecg                = o.optJSONObject("ecg")?.toEcgWindow(),
            imuHighRate        = o.optJSONObject("imuHighRate")?.toImuHighRateWindow()
        )
    }

    private fun JSONObject.toVec3(): Vec3 = Vec3(
        x = getDouble("x").toFloat(),
        y = getDouble("y").toFloat(),
        z = getDouble("z").toFloat()
    )

    private fun JSONObject.toEcgWindow(): EcgWindow {
        val mvJson = optJSONArray("samplesMv") ?: JSONArray()
        val loJson = optJSONArray("leadOff") ?: JSONArray()
        val n = mvJson.length()
        val samples = FloatArray(n) { mvJson.getDouble(it).toFloat() }
        val lead = IntArray(loJson.length()) { loJson.getInt(it) }
        return EcgWindow(
            isRecording  = optBoolean("isRecording", false),
            sampleRateHz = optInt("sampleRateHz", 500),
            samplesMv    = samples,
            leadOff      = lead
        )
    }

    private fun JSONObject.toImuHighRateWindow(): ImuHighRateWindow {
        val accel = getJSONObject("accel")
        val gyro  = getJSONObject("gyro")
        val pres  = getJSONObject("pressure")
        return ImuHighRateWindow(
            sampleRateHz   = optInt("sampleRateHz", 50),
            accelX         = accel.getJSONArray("x").toFloatArray(),
            accelY         = accel.getJSONArray("y").toFloatArray(),
            accelZ         = accel.getJSONArray("z").toFloatArray(),
            gyroX          = gyro.getJSONArray("x").toFloatArray(),
            gyroY          = gyro.getJSONArray("y").toFloatArray(),
            gyroZ          = gyro.getJSONArray("z").toFloatArray(),
            pressureValues = pres.getJSONArray("values").toFloatArray()
        )
    }

    private fun JSONArray.toFloatArray(): FloatArray =
        FloatArray(length()) { getDouble(it).toFloat() }

    private fun JSONObject.optIntOrNull(key: String): Int? =
        if (isNull(key) || !has(key)) null else optInt(key)

    private fun JSONObject.optDoubleOrNull(key: String): Double? =
        if (isNull(key) || !has(key)) null else optDouble(key)
}
```

---

#### File 2 — `SensorDataReceiverService.kt`

Receives messages on `/sensor_data`, parses each JSON packet, hands it to the in-memory repository for the UI to observe.

```kotlin
package com.example.smarthealth.wear   // <-- CHANGE to your phone app's package

import android.util.Log
import com.google.android.gms.wearable.MessageEvent
import com.google.android.gms.wearable.WearableListenerService

class SensorDataReceiverService : WearableListenerService() {

    override fun onMessageReceived(event: MessageEvent) {
        if (event.path != PATH_SENSOR_DATA) return

        val json = try {
            String(event.data, Charsets.UTF_8)
        } catch (t: Throwable) {
            Log.e(TAG, "Failed to decode payload as UTF-8", t)
            return
        }

        val packet = try {
            SensorPacketParser.parse(json)
        } catch (t: Throwable) {
            Log.e(TAG, "Failed to parse sensor JSON: $json", t)
            return
        }

        // Publish to the in-memory repository for the UI to observe.
        LiveSensorRepository.emit(packet)
    }

    companion object {
        private const val TAG = "SensorReceiverSvc"
        const val PATH_SENSOR_DATA = "/sensor_data"
    }
}
```

---

#### File 3 — `LiveSensorRepository.kt`

In-memory pub-sub. Receivers emit; UI collects. No persistence (add Room/SQLite separately if you want history).

```kotlin
package com.example.smarthealth.wear   // <-- CHANGE to your phone app's package

import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Process-wide singleton that holds the most recent SensorPacket and emits a
 * SharedFlow of every packet that arrives. Survives Activity rotation.
 *
 * To observe in an Activity / ViewModel / Fragment / Compose:
 *   LiveSensorRepository.latest.collect { packet -> ... }       // current value + future
 *   LiveSensorRepository.packets.collect { packet -> ... }      // event stream
 */
object LiveSensorRepository {

    private val _latest = MutableStateFlow<SensorPacket?>(null)
    val latest: StateFlow<SensorPacket?> = _latest.asStateFlow()

    private val _packets = MutableSharedFlow<SensorPacket>(
        replay = 0,
        extraBufferCapacity = 64
    )
    val packets: SharedFlow<SensorPacket> = _packets.asSharedFlow()

    /** Called by the receiver service. Not thread-locked; emit is safe across threads. */
    fun emit(packet: SensorPacket) {
        _latest.value = packet
        _packets.tryEmit(packet)
    }
}
```

---

### 3.4 — How to use these from your UI

Wherever your existing main screen displays anything, hook it to the repository.

**If your phone app uses ViewModel + LiveData / Flow (recommended):**

```kotlin
class DashboardViewModel : ViewModel() {
    val sensors: StateFlow<SensorPacket?> = LiveSensorRepository.latest
}
```

In your Activity / Fragment / Composable:

```kotlin
// Activity (with lifecycleScope)
lifecycleScope.launch {
    repeatOnLifecycle(Lifecycle.State.STARTED) {
        viewModel.sensors.collect { packet ->
            packet ?: return@collect
            heartRateTextView.text = packet.heartRate?.toString() ?: "—"
            accelText.text = "%.2f, %.2f, %.2f".format(
                packet.accelerometer.x,
                packet.accelerometer.y,
                packet.accelerometer.z
            )
            // ... etc
        }
    }
}
```

```kotlin
// Compose
val packet by viewModel.sensors.collectAsStateWithLifecycle()
Text("HR: ${packet?.heartRate ?: "—"} bpm")
```

**If you want a quick proof-of-life test without changing your UI:**

In any onCreate or onStart, drop:
```kotlin
lifecycleScope.launch {
    LiveSensorRepository.packets.collect { packet ->
        android.util.Log.d("WearTest", "Got packet: HR=${packet.heartRate} ts=${packet.timestamp}")
    }
}
```

Run the phone app + watch, watch Android Studio's Logcat for `WearTest`, you should see one line per second.

---

## 4. Testing the connection end-to-end

### Prerequisites
1. Galaxy Watch 5 is paired with this phone via **Galaxy Wearable** app. (One-time setup.)
2. The watch has the `com.gradproject2026.ecgwatch` app installed (Mostafa already did this).
3. Watch is on the wrist (so heart rate isn't null).

### Steps
1. Build and install the phone app with the changes from §3.
2. Launch the phone app.
3. On the watch: the standard sensor stream is **always-on** (foreground service). No action needed.
4. Wait ~3 seconds.
5. In Android Studio's Logcat tab on the **phone** side, filter by tag `SensorReceiverSvc` or `WearTest`.

### Expected
You should see one log line per second containing a parsed packet. The `heartRate` should be a real BPM (~60–100), the accelerometer Z-axis should be ~9.8 when the watch is on a table.

### If nothing arrives
See §6 (Troubleshooting).

---

## 5. Pairing & prerequisites

The Wear OS Data Layer only works when:
1. Watch and phone are paired via **Galaxy Wearable** (Samsung's pairing app) with **the same Samsung account**.
2. Watch is in Bluetooth or Wi-Fi range of the phone.
3. Both devices have internet (for the initial handshake) — once paired, the channel is direct.

**You don't need:**
- A Wear OS companion app on Play Store (unrelated)
- The phone app to have a special signing key
- The phone app's package name to match the watch's (they can be totally different)

**You do need:**
- The phone app to declare a `WearableListenerService` with the right intent filter (covered in §3.2)
- The path on both ends to match exactly (`/sensor_data` — already configured on watch side)

---

## 6. Troubleshooting

### No log lines appear at all on phone

| Cause | Check |
|---|---|
| Watch and phone not paired | Open Galaxy Wearable on phone — does it show "Connected"? |
| Manifest service not declared, or `exported=false` | Verify §3.2 is in your AndroidManifest |
| Wrong path in intent filter | Must be `/sensor_data` (case-sensitive; leading slash; no trailing slash) |
| Phone app force-stopped after install | Open the app at least once; some OEMs (Samsung especially) restrict background services until user interaction |
| Phone's battery optimizer killed the service | Settings → Apps → [your app] → Battery → Unrestricted |

### Packets arrive but every field is null / zero

| Cause | Check |
|---|---|
| Watch not on wrist | heartRate / stepCount need wrist contact and walking respectively |
| Watch just booted | First ~10 seconds, several sensors haven't warmed up |
| Wrong key names in your parser | Wire format is **case-sensitive**; field names listed in §1 are exact |

### Some packets parse, others fail with "Failed to parse sensor JSON"

| Cause | Check |
|---|---|
| You hit an ECG-active packet but your parser doesn't handle the `ecg` object | Make sure you used `SensorPacketParser` from §3.3 verbatim — it handles ecg=null and ecg=object both |
| Encoding mismatch | The watch sends UTF-8; the service decodes UTF-8 |

### `LiveSensorRepository` shows packets in logs but UI doesn't update

| Cause | Check |
|---|---|
| You're observing on the wrong dispatcher | Use `repeatOnLifecycle(Lifecycle.State.STARTED)` so collection stops/restarts with the UI; ensure UI updates happen on Main thread |
| ViewModel re-created on rotation, lost subscription | Use ViewModel-scoped Flow + collect in Activity with lifecycle awareness as in §3.4 |

### "Bound service intent must be explicit" or similar

You're trying to bind the `WearableListenerService` manually. **Don't.** Wear OS dispatches messages to it automatically. Just declare it in the manifest and the framework handles invocation.

---

## 7. ECG status (currently disabled — server-side issue at Samsung)

The watch app supports ECG capture using the Samsung Health Sensor SDK partner-program path. As of 2026-05-13:

- Samsung **approved** my partnership application (`mostafagenydy@gmail.com`, package `com.gradproject2026.ecgwatch`, SDK 1.4.1, tracker `ECG_ON_DEMAND`).
- However, the registered SHA-256 fingerprint in Samsung's whitelist contains a **trailing dash character** (a copy-paste artifact in my original submission). Samsung's runtime check compares the registered string literally against my app's actual signature; the extra `-` causes every call to fail with `SDK_POLICY_ERROR`.
- I have replied to `support@samsungdevelopers.com` asking them to remove the trailing dash. Expected resolution: 1-5 business days.

**Impact on the phone integration:**

- Until Samsung fixes the whitelist, every packet you receive will have `"ecg": null`. All other fields work normally.
- **The parser in §3.3 already handles this gracefully** (`o.optJSONObject("ecg")?.toEcgWindow()` returns `null`).
- When Samsung's fix lands, the watch will start emitting ECG samples inside the same JSON packet — no changes needed on the phone receiver/parser side. Your CNN/preprocessing code is what you'd hook up at that point.

**What you can build now (independently of Samsung):**
1. Phone-side reception of all 8 standard sensors → works today.
2. UI to display live sensor values → works today.
3. Local storage of sensor history (Room / SQLite) → works today.
4. **ECG-specific UI:** a screen that shows the recording state, accumulates `samplesMv` arrays across packets while `isRecording == true`, draws the waveform, and runs the CNN. This compiles and runs today; it just sits idle (showing "no ECG data yet") until Samsung's fix lands.

If you want the ECG accumulator logic, here's a sketch you can drop in alongside `LiveSensorRepository`:

```kotlin
package com.example.smarthealth.wear  // <-- CHANGE to your phone app's package

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * Tracks an ongoing ECG session by concatenating samplesMv from successive
 * packets while isRecording == true. Emits the completed session when a
 * packet arrives with ecg=null OR isRecording=false.
 */
object EcgSessionAccumulator {

    data class Session(
        val startUnixSec: Long,
        val sampleRateHz: Int,
        val samplesMv: FloatArray,
        val leadOff: IntArray
    )

    private val _currentSession = MutableStateFlow<Session?>(null)
    val currentSession: StateFlow<Session?> = _currentSession

    private val _completedSession = MutableStateFlow<Session?>(null)
    val completedSession: StateFlow<Session?> = _completedSession

    private var inProgress: MutableList<Float> = mutableListOf()
    private var leadOffBuf: MutableList<Int>   = mutableListOf()
    private var sessionStart: Long = 0L
    private var sessionRate: Int = 500
    private var wasRecording: Boolean = false

    fun feed(packet: SensorPacket) {
        val ecg = packet.ecg
        if (ecg != null && ecg.isRecording) {
            // Recording is active. Append.
            if (!wasRecording) {
                sessionStart = packet.timestamp
                sessionRate = ecg.sampleRateHz
                inProgress.clear()
                leadOffBuf.clear()
                wasRecording = true
            }
            ecg.samplesMv.forEach { inProgress.add(it) }
            ecg.leadOff.forEach { leadOffBuf.add(it) }
            _currentSession.value = Session(
                sessionStart, sessionRate,
                inProgress.toFloatArray(), leadOffBuf.toIntArray()
            )
        } else if (wasRecording) {
            // Recording just ended. Publish the completed session.
            val finished = Session(
                sessionStart, sessionRate,
                inProgress.toFloatArray(), leadOffBuf.toIntArray()
            )
            _completedSession.value = finished
            _currentSession.value = null
            inProgress.clear()
            leadOffBuf.clear()
            wasRecording = false
        }
    }
}
```

Then in `SensorDataReceiverService.onMessageReceived`:
```kotlin
LiveSensorRepository.emit(packet)
EcgSessionAccumulator.feed(packet)   // <- add this line
```

Hook your CNN inference to `EcgSessionAccumulator.completedSession.collect { ... }`. Each emission is one complete recording.

---

## 8. Summary — minimum to get standard sensors working

If you skip the ECG accumulator for now, the minimum integration is:

1. Add 2 dependencies to `app/build.gradle` (§3.1)
2. Add the `<service>` block to `AndroidManifest.xml` (§3.2)
3. Drop 3 Kotlin files into `app/src/main/java/.../wear/` (§3.3) — change the `package` declaration in each to match your phone app
4. Hook `LiveSensorRepository.latest` into your existing UI (§3.4)
5. Pair watch + phone via Galaxy Wearable (one-time, §5)
6. Run the phone app, look at logcat for `SensorReceiverSvc`, expect 1 packet/second (§4)

That's the complete integration. The watch is already running on Mostafa's wrist and streaming.

---

## 9. Contact

If anything in this README is unclear or you hit a wall I didn't cover:

- **Mostafa Genidy** — `mostafagenydy@gmail.com`
- Full project context lives in `wear_app/README.md` (the watch-app dev log) — useful for understanding why the architecture is the way it is.

Good luck — once you wire this in, the full pipeline (watch → phone → display) works end-to-end, and the moment Samsung's whitelist fix lands you'll have ECG too.
