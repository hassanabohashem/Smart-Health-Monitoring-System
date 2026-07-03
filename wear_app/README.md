# wear_app — Development Log

**Project:** AI-Powered Smart Health Monitoring System
**Author:** Mostafa Genidy — Future University in Egypt (FUE), Faculty of Computer Science & IT
**Defense:** June 2026
**Hardware:** Samsung Galaxy Watch 5 (SM-R910NZAAEGY, Egypt unit, firmware R910XXU2DZB6)
**Samsung partner status:** **APPROVED** (Health Sensor SDK 1.4.1, ECG_ON_DEMAND)
**Last updated:** 2026-05-13

---

## 1. Architecture (current — single unified JSON stream)

Two apps. Models run on the **phone**, not on the watch. The watch is purely an acquisition device. **Everything — standard sensors plus ECG — rides one channel as a single JSON packet per second.**

```
┌────────────────────────────────────────┐         /sensor_data         ┌─────────────────────┐
│        Galaxy Watch 5 — wear_app       │  ── 1 Hz unified JSON ──────►│   Android Phone     │
│                                        │     (sensors + optional      │   (companion app)   │
│   SensorForegroundService              │      ECG window inside)      │                     │
│     ├─ SensorManager  (always-on)      │                              │   - Decode JSON     │
│     └─ EcgCapture     (during session) │                              │   - Bandpass/notch  │
│             ↓                          │                              │   - Resample        │
│       SharedEcgBuffer  (drained per s) │                              │   - R-peak detect   │
│                                        │                              │   - CNN classify    │
│   EcgRecordingActivity                 │                              │   - Display results │
│     (UI: Start / Stop / countdown)     │                              └─────────────────────┘
└────────────────────────────────────────┘
```

**Single Data Layer path:** `/sensor_data`. The old `/ecg_session` binary path has been removed.

---

## 2. Unified JSON wire format

One packet, every second, on `/sensor_data`:

```json
{
  "timestamp": 1777645462,
  "heartRate": 96,
  "accelerometer":      {"x": 0.031, "y": 0.019, "z": 9.74},
  "gyroscope":          {"x": 0.733, "y": 0.616, "z": 0.022},
  "stepCount": 0,
  "linearAcceleration": {"x": 0.172, "y": -0.120, "z": 0.225},
  "gravity":            {"x": -0.219, "y": -0.232, "z": 9.801},
  "pressure": 1006.71,
  "magneticField":      {"x": -38.34, "y": -22.62, "z": -28.80},
  "ecg": null
}
```

When a recording is active, `ecg` carries the samples for that second:

```json
"ecg": {
  "isRecording": true,
  "sampleRateHz": 500,
  "sampleCount": 500,
  "samplesMv":  [0.012, 0.015, 0.011,  …  500 values],
  "leadOff":    [0, 0, 0,  …  500 ints (0 = good contact)]
}
```

**Packet sizes:**
- Idle (no ECG): ~500 B
- During recording (with 500 ECG samples): ~7 KB
- 30-second recording total: ~210 KB over 30 packets, well under the 100 KB-per-message MessageClient limit (each packet stays ~7 KB).

**Phone-side decoder** must check `obj.optJSONObject("ecg")` — null when idle, otherwise read `sampleRateHz`, `samplesMv`, `leadOff`.

---

## 3. File inventory

```
wear_app/
└── app/
    ├── build.gradle                            applicationId = com.gradproject2026.ecgwatch  (Samsung-approved)
    │                                            namespace     = com.example.ecgwatch          (compile-time only; intentionally NOT renamed to avoid source-file moves)
    ├── libs/samsung-health-sensor-api-1.4.1.aar
    └── src/main/
        ├── AndroidManifest.xml                 + <queries> for Samsung Health
        ├── res/{layout, values}/…
        └── java/
            ├── com/example/ecgwatch/MainActivity.kt
            ├── comm/DataLayerSender.kt         single path /sensor_data
            ├── data/SensorDataModel.kt         SensorDataPacket + EcgWindow
            ├── ecg/
            │   ├── EcgCapture.kt               Samsung SDK wrapper, pushes to SharedEcgBuffer
            │   ├── EcgRecordingActivity.kt     thin UI; tells service to start/stop
            │   └── SharedEcgBuffer.kt          thread-safe singleton (500 Hz → 1 Hz bridge)
            ├── sensors/SensorManagerController.kt  drains ECG buffer each snapshot
            ├── service/
            │   ├── BootReceiver.kt
            │   └── SensorForegroundService.kt  ECG lifecycle + per-second aggregation
            └── utils/JsonBuilder.kt            serializes EcgWindow into JSON
```

**What each ECG file does now:**
- **`EcgCapture.kt`** — connects to `HealthTrackingService`, attaches `ECG_ON_DEMAND` tracker, pushes incoming samples into `SharedEcgBuffer`.
- **`SharedEcgBuffer.kt`** — thread-safe singleton. EcgCapture writes from the SDK's background thread; the sensor aggregation loop drains once per second.
- **`EcgRecordingActivity.kt`** — pure UI. Sends `ACTION_START_ECG` / `ACTION_STOP_ECG` intents to the service. No direct SDK contact.

**Removed:** `EcgPayload.kt` (binary encoder no longer needed — everything is JSON now).

---

## 4. Data flow for one ECG session

```
1. User taps "Record ECG" in EcgRecordingActivity
       ↓
2. UI sends ACTION_START_ECG intent to SensorForegroundService
       ↓
3. Service:
     - SharedEcgBuffer.startRecording()    (sets isRecording = true)
     - ecgCapture.connect(captureListener)
     - schedules 30-s auto-stop
       ↓
4. Health Platform connects → service attaches ECG_ON_DEMAND tracker
       ↓
5. SDK delivers DataPoints @ 500 Hz on its background thread
       ↓
6. EcgCapture parses each → EcgSample(timestampNs, ecgMv, leadOff)
       ↓
7. EcgCapture pushes batch into SharedEcgBuffer.add(samples)
       ↓
8. Every 1 second, SensorForegroundService aggregation loop:
     - sensorController.snapshot()  ← drains SharedEcgBuffer here
     - builds EcgWindow if any samples or isRecording == true
     - JsonBuilder.toBytes(packet)
     - dataLayerSender.send(bytes)  ← /sensor_data
       ↓
9. After 30 s OR user taps Stop:
     - SharedEcgBuffer.stopRecording()
     - ecgCapture.stopEcg() + disconnect()
     - one final tick may still flush trailing samples
     - subsequent packets again have "ecg": null
```

---

## 5. Key constants

| Constant | Value |
|----------|-------|
| applicationId (runtime; Samsung-checked) | `com.gradproject2026.ecgwatch` |
| namespace (compile-time only) | `com.example.ecgwatch` |
| Debug keystore SHA-256 | `3E:6A:4C:B6:BB:2E:32:42:56:78:4F:2D:33:8D:72:D8:85:C8:E6:2D:7E:BF:0B:23:82:6E:9E:2A:92:7F:E1:DB` |
| Watch model | SM-R910NZAAEGY |
| Watch firmware | R910XXU2DZB6 |
| Watch device serial | RFAW41X9VTF |
| Samsung Health Sensor SDK version | 1.4.1 |
| ECG sample rate | 500 Hz |
| ECG session length | 30 s (auto-stop) |
| Aggregation interval | 1 s |
| Data Layer path | `/sensor_data` (single, unified) |
| Service intent actions | `com.example.ecgwatch.action.START_ECG`, `com.example.ecgwatch.action.STOP_ECG` |

---

## 6. Build & install

### Build
- Android Studio → **Build → Generate App Bundles or APKs → Generate APKs**.
- Output: `app/build/outputs/apk/debug/app-debug.apk`.

### Before installing the new APK on the watch (one-time)
The `applicationId` changed from `com.example.wear_app` to `com.example.ecgwatch`. Android treats them as **different apps**, so the old one stays installed forever unless removed.

```powershell
# Uninstall the old app first (if you previously installed v1)
& "C:\Users\ABDELRAHMAN\AppData\Local\Android\Sdk\platform-tools\adb.exe" -s 192.168.1.X:CONNECT_PORT uninstall com.example.wear_app

# Then install the new one
& "C:\Users\ABDELRAHMAN\AppData\Local\Android\Sdk\platform-tools\adb.exe" -s 192.168.1.X:CONNECT_PORT install -r "C:\Users\ABDELRAHMAN\AndroidStudioProjects\wear_app\app\build\outputs\apk\debug\app-debug.apk"
```

### Watch JSON live
```powershell
& "C:\Users\ABDELRAHMAN\AppData\Local\Android\Sdk\platform-tools\adb.exe" -s 192.168.1.X:CONNECT_PORT logcat -s JsonBuilder
```
Look at the `"ecg"` field — `null` when idle, populated when recording.

### Watch service / ECG flow live
```powershell
& "C:\Users\ABDELRAHMAN\AppData\Local\Android\Sdk\platform-tools\adb.exe" -s 192.168.1.X:CONNECT_PORT logcat -s SensorFgService EcgCapture EcgRecordingActivity
```

---

## 7. Phone-side decoder skeleton (Kotlin reference)

```kotlin
override fun onMessageReceived(event: MessageEvent) {
    if (event.path != "/sensor_data") return
    val json = JSONObject(String(event.data, Charsets.UTF_8))

    val timestamp = json.getLong("timestamp")
    val hr        = json.optDouble("heartRate", Double.NaN)
    // … parse the other sensors …

    val ecg = json.optJSONObject("ecg")
    if (ecg != null) {
        val isRecording  = ecg.getBoolean("isRecording")
        val sampleRateHz = ecg.getInt("sampleRateHz")
        val n            = ecg.getInt("sampleCount")
        val samplesMv    = ecg.getJSONArray("samplesMv")  // length == n
        val leadOff      = ecg.getJSONArray("leadOff")    // length == n
        // append to your ECG buffer; once you have ≥30 s, hand to preprocessing + CNN
    }
}
```

---

## 8. Pending items

### User
1. Rebuild APK in Android Studio.
2. **Uninstall old `com.example.wear_app`** from the watch first, then install the new APK.
3. Test: stream visible in `logcat -s JsonBuilder`, `"ecg"` field flips from `null` to a populated object once Record ECG is tapped and ECG samples start flowing (≥ ~250 samples per second once the SDK warms up).
4. Build the **phone-side `WearableListenerService`** (decoder skeleton above).

### Optional
- Fix the cosmetic UI-thread bug in `EcgRecordingActivity.onTrackerError` (samples are still correctly captured; just the in-activity error text path now lives in the service).
- Replace launcher icon (currently default Android robot).

---

## 9. History — what changed in this iteration

- Samsung Health Sensor SDK partner application **APPROVED** for `com.example.ecgwatch`.
- Package renamed `com.example.wear_app` → `com.example.ecgwatch` (refactor previously left `applicationId` inconsistent; now fixed).
- Architecture switched from **two channels** (`/sensor_data` JSON + `/ecg_session` binary) to **one unified channel** (`/sensor_data` JSON with embedded ECG window).
- ECG capture moved out of `EcgRecordingActivity` into `SensorForegroundService` so capture lives next to the always-on sensor loop.
- Added `SharedEcgBuffer` to bridge the SDK's 500 Hz background callback to the 1 Hz aggregation tick safely.
- `EcgPayload.kt` removed (binary format no longer needed).
- Phone-side decode is now plain `JSONObject` parsing — no binary, no `ByteBuffer`.

---

## 10. Where session memory lives

For future Claude sessions on this project:
```
~/.claude/projects/C--Users-ABDELRAHMAN-AndroidStudioProjects-wear-app/
├── MEMORY.md                                            (index)
├── memory/
│   ├── project_overview.md
│   ├── architecture_watch_collects_phone_processes.md
│   ├── wear_app_state.md
│   ├── ecg_integration_done.md
│   └── environment_paths.md
```

---

## 11. Additional Documentation (in `docs/`)

- [**CHANGES_FOR_MOSTAFA.md**](file:///d:/GP-IMP/wear_app/docs/CHANGES_FOR_MOSTAFA.md): Detailed development history, package renaming details, and instructions for building and testing the watch application.
- [**README_watch_mobile_integration.md**](file:///d:/GP-IMP/wear_app/docs/README_watch_mobile_integration.md): In-depth guide to Wear OS and Android companion app communication protocols, data layer paths, and JSON serialization.
- [**PartnerData_SHealth_m4bzko7w0vgffktg.csv**](file:///d:/GP-IMP/wear_app/docs/PartnerData_SHealth_m4bzko7w0vgffktg.csv): Samsung Health partner account verification data export.

