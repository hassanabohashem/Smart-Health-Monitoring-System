/**
 * TypeScript schema mirroring the JSON packet emitted once per second by
 * the Galaxy Watch 5 (com.gradproject2026.ecgwatch) on path /sensor_data.
 *
 * The Kotlin source of truth is `wear_app/app/src/main/java/.../JsonBuilder.kt`.
 * If you change the watch-side encoding, update both this file and the
 * shape consumers (sensor-listener.ts, imu-window-buffer.ts, ecg-session.ts).
 */

export interface Vector3 {
  x: number;
  y: number;
  z: number;
}

/**
 * 500 Hz ECG window included when the watch is in a recording session;
 * `null` otherwise. `samplesMv` is variable-length (typically ~500 per
 * 1-sec packet) and is in millivolts.
 */
export interface EcgWindow {
  isRecording: boolean;
  sampleRateHz: number;
  sampleCount: number;
  samplesMv: number[];
  /**
   * Per-sample lead-off flag (1 = lead off, 0 = lead on). Same length as
   * samplesMv. Useful for masking out segments where the electrode lost
   * skin contact.
   */
  leadOff: number[];
}

/**
 * Parallel-array encoding for one IMU axis stream (accel or gyro). Each
 * index i corresponds to one sample: `(x[i], y[i], z[i])` at time
 * `tsNs[i]` nanoseconds (Android SystemClock.elapsedRealtimeNanos).
 */
export interface ImuHighRateAxisArrays {
  x: number[];
  y: number[];
  z: number[];
  tsNs: number[];
}

export interface ImuHighRatePressureArrays {
  values: number[];
  tsNs: number[];
}

/**
 * Per-second high-rate IMU window. Accel/gyro are requested at
 * SENSOR_DELAY_GAME (~50 Hz) on the watch; pressure ticks at whatever
 * rate the barometer hardware delivers (typically ≤5 Hz on Galaxy Watch
 * 5). Counts are not assumed equal across axes.
 */
export interface ImuHighRateWindow {
  sampleRateHz: number;
  accelSampleCount: number;
  gyroSampleCount: number;
  pressureSampleCount: number;
  accel: ImuHighRateAxisArrays;
  gyro: ImuHighRateAxisArrays;
  pressure: ImuHighRatePressureArrays;
}

/**
 * Single SpO2 measurement from Samsung Health Sensor SDK SPO2_ON_DEMAND.
 * Present only in the one packet that follows session completion, then
 * `null` again until the next user-initiated session.
 */
export interface Spo2Reading {
  /** Final SpO2 percentage (0-100). `null` if the session failed. */
  value: number | null;
  /** Samsung tracker status. 0 = OK; non-zero codes mean measuring/error. */
  status: number;
  /** Watch wall-clock epoch ms when the value landed. */
  measuredAtEpochMs: number;
}

/**
 * Top-level packet. Low-rate scalar fields are once-per-packet; the
 * `imuHighRate` and `ecg` blobs carry the per-second windows used to
 * feed fall / HAR / cardiac inference respectively. `spo2` lands once
 * per user-triggered SpO2 measurement session.
 */
export interface WearSensorPacket {
  /** Watch wall-clock epoch milliseconds when the packet was assembled. */
  timestamp: number;
  heartRate: number | null;
  accelerometer: Vector3 | null;
  gyroscope: Vector3 | null;
  stepCount: number | null;
  linearAcceleration: Vector3 | null;
  gravity: Vector3 | null;
  pressure: number | null;
  magneticField: Vector3 | null;
  ecg: EcgWindow | null;
  imuHighRate: ImuHighRateWindow | null;
  spo2: Spo2Reading | null;
}

/**
 * Event payload emitted by the native bridge. `json` is the raw watch
 * payload as a UTF-8 string — we deliberately don't parse on the native
 * side so the schema-evolution surface is one place (this file).
 */
export interface WearSensorEvent {
  json: string;
  /** Phone clock ms when the WearableListenerService received the message. */
  receivedAtMs: number;
}
