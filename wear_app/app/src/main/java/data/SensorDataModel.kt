package com.example.ecgwatch.data

data class Vector3(
    val x: Float,
    val y: Float,
    val z: Float
)

/**
 * One second of ECG samples (or however many were collected since the last tick).
 *
 * @param sampleRateHz nominal sample rate of the source (500 Hz for ECG_ON_DEMAND)
 * @param samplesMv    ECG amplitudes in millivolts, time-ordered
 * @param leadOff      lead-off flag per sample (0 = good contact, non-zero = bad)
 * @param isRecording  whether a recording session is active right now (true even
 *                     if no new samples landed in this 1-second window)
 */
data class EcgWindow(
    val sampleRateHz: Int,
    val samplesMv: FloatArray,
    val leadOff: IntArray,
    val isRecording: Boolean
) {
    init {
        require(samplesMv.size == leadOff.size) {
            "samplesMv and leadOff must have the same length"
        }
    }
}

/**
 * One IMU sample with the sensor-event timestamp (nanoseconds since boot).
 * Used inside [ImuHighRateWindow] to preserve precise timing inside a 1-second packet.
 */
data class TimestampedVec3(
    val tsNs: Long,
    val v: Vector3
)

data class TimestampedFloat(
    val tsNs: Long,
    val value: Float
)

/**
 * High-rate IMU samples collected during one packet period (1 second).
 *
 * Required by the phone-side AI pipeline (fall detection + HAR) — those
 * models need ~50-100 Hz IMU windows, which the existing 1-Hz fields
 * (`accelerometer`, `gyroscope`, `pressure`) cannot supply.
 *
 * - `accelSamples`, `gyroSamples` are registered at SENSOR_DELAY_GAME
 *   (~50 Hz nominal; actual rate varies by hardware).
 * - `pressureSamples` registered at SENSOR_DELAY_NORMAL (baro changes slowly).
 *
 * Empty lists are valid (e.g., during the first second after start before
 * any callback fires); the phone-side parser tolerates short windows.
 */
data class ImuHighRateWindow(
    val sampleRateHz: Int,
    val accelSamples: List<TimestampedVec3>,
    val gyroSamples:  List<TimestampedVec3>,
    val pressureSamples: List<TimestampedFloat>
)

/**
 * Single SpO2 reading from Samsung Health SPO2_ON_DEMAND tracker.
 *
 * @param spo2Percent Final measurement (0..100). May be null while a session
 *                    is in progress or if the session failed.
 * @param status      Samsung status code: 0 = OK, non-zero = measuring/error
 *                    (e.g. DEVICE_MOVING, LOW_SIGNAL).
 * @param measuredAtEpochMs Watch wall-clock ms when the measurement landed.
 */
data class Spo2Reading(
    val spo2Percent: Int?,
    val status: Int,
    val measuredAtEpochMs: Long
)

data class SensorDataPacket(
    val timestamp: Long,
    val heartRate: Float? = null,
    val accelerometer: Vector3? = null,
    val gyroscope: Vector3? = null,
    val stepCount: Long? = null,
    val linearAcceleration: Vector3? = null,
    val gravity: Vector3? = null,
    val pressure: Float? = null,
    val magneticField: Vector3? = null,
    val ecg: EcgWindow? = null,
    val imuHighRate: ImuHighRateWindow? = null,
    val spo2: Spo2Reading? = null
)
