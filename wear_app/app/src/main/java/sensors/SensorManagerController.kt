package com.example.ecgwatch.sensors

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.util.Log
import com.example.ecgwatch.data.EcgWindow
import com.example.ecgwatch.data.ImuHighRateWindow
import com.example.ecgwatch.data.SensorDataPacket
import com.example.ecgwatch.data.Spo2Reading
import com.example.ecgwatch.data.TimestampedFloat
import com.example.ecgwatch.data.TimestampedVec3
import com.example.ecgwatch.data.Vector3
import com.example.ecgwatch.ecg.EcgCapture
import com.example.ecgwatch.ecg.SharedEcgBuffer
import com.example.ecgwatch.spo2.SharedSpo2Buffer
import java.util.concurrent.atomic.AtomicReference

class SensorManagerController(context: Context) : SensorEventListener {

    private val sensorManager =
        context.applicationContext.getSystemService(Context.SENSOR_SERVICE) as SensorManager

    private val heartRateSensor: Sensor? = sensorManager.getDefaultSensor(Sensor.TYPE_HEART_RATE)
    private val accelerometerSensor: Sensor? = sensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
    private val gyroscopeSensor: Sensor? = sensorManager.getDefaultSensor(Sensor.TYPE_GYROSCOPE)
    private val stepCounterSensor: Sensor? = sensorManager.getDefaultSensor(Sensor.TYPE_STEP_COUNTER)
    private val linearAccelerationSensor: Sensor? = sensorManager.getDefaultSensor(Sensor.TYPE_LINEAR_ACCELERATION)
    private val gravitySensor: Sensor? = sensorManager.getDefaultSensor(Sensor.TYPE_GRAVITY)
    private val pressureSensor: Sensor? = sensorManager.getDefaultSensor(Sensor.TYPE_PRESSURE)
    private val magneticFieldSensor: Sensor? = sensorManager.getDefaultSensor(Sensor.TYPE_MAGNETIC_FIELD)

    private val latestHeartRate = AtomicReference<Float?>(null)
    private val latestAccelerometer = AtomicReference<Vector3?>(null)
    private val latestGyroscope = AtomicReference<Vector3?>(null)
    private val latestStepCount = AtomicReference<Long?>(null)
    private val latestLinearAcceleration = AtomicReference<Vector3?>(null)
    private val latestGravity = AtomicReference<Vector3?>(null)
    private val latestPressure = AtomicReference<Float?>(null)
    private val latestMagneticField = AtomicReference<Vector3?>(null)

    /**
     * High-rate IMU buffers — every sample received from the sensors is
     * appended here, then drained once per second by [snapshot]. The phone-
     * side AI pipeline needs full windows of motion data (fall: 100Hz×2s,
     * HAR: 50Hz×2.56s) which the latest-value AtomicReferences above can't
     * supply. All access is synchronised because [onSensorChanged] runs on
     * the SensorManager thread while [snapshot] runs on the foreground
     * service's aggregation thread.
     */
    private val accelBuffer = ArrayList<TimestampedVec3>(64)
    private val gyroBuffer = ArrayList<TimestampedVec3>(64)
    private val pressureBuffer = ArrayList<TimestampedFloat>(8)
    private val imuLock = Any()
    private val imuSampleRateHz = 50  // SENSOR_DELAY_GAME nominal rate on Galaxy Watch 5

    fun availability(): Map<String, Boolean> = mapOf(
        "heartRate"           to (heartRateSensor != null),
        "accelerometer"       to (accelerometerSensor != null),
        "gyroscope"           to (gyroscopeSensor != null),
        "stepCount"           to (stepCounterSensor != null),
        "linearAcceleration"  to (linearAccelerationSensor != null),
        "gravity"             to (gravitySensor != null),
        "pressure"            to (pressureSensor != null),
        "magneticField"       to (magneticFieldSensor != null),
    )

    fun start() {
        register(heartRateSensor,          SensorManager.SENSOR_DELAY_NORMAL, "HeartRate")
        // Accelerometer + Gyroscope at GAME rate (~50 Hz) so the phone-side
        // fall-detection (FusionNet) and HAR (CNN-Transformer) pipelines
        // receive enough samples per 1-second packet to assemble windows
        // (fall = 2-s window @ 100 Hz, HAR = 2.56-s window @ 50 Hz).
        register(accelerometerSensor,      SensorManager.SENSOR_DELAY_GAME,   "Accelerometer")
        register(gyroscopeSensor,          SensorManager.SENSOR_DELAY_GAME,   "Gyroscope")
        register(stepCounterSensor,        SensorManager.SENSOR_DELAY_NORMAL, "StepCounter")
        register(linearAccelerationSensor, SensorManager.SENSOR_DELAY_NORMAL, "LinearAcceleration")
        register(gravitySensor,            SensorManager.SENSOR_DELAY_NORMAL, "Gravity")
        register(pressureSensor,           SensorManager.SENSOR_DELAY_NORMAL, "Pressure")
        register(magneticFieldSensor,      SensorManager.SENSOR_DELAY_NORMAL, "Magnetometer")
    }

    fun stop() {
        try {
            sensorManager.unregisterListener(this)
        } catch (t: Throwable) {
            Log.e(TAG, "Failed to unregister sensor listener", t)
        }
    }

    fun snapshot(): SensorDataPacket {
        // Drain the high-rate IMU buffers under lock so onSensorChanged
        // can keep appending the moment we release.
        val (accel, gyro, pressureSamples) = synchronized(imuLock) {
            val a = accelBuffer.toList()
            val g = gyroBuffer.toList()
            val p = pressureBuffer.toList()
            accelBuffer.clear()
            gyroBuffer.clear()
            pressureBuffer.clear()
            Triple(a, g, p)
        }
        val imuWindow = if (accel.isEmpty() && gyro.isEmpty() && pressureSamples.isEmpty()) {
            null  // first ~second after start, before any callback fires
        } else {
            ImuHighRateWindow(
                sampleRateHz = imuSampleRateHz,
                accelSamples = accel,
                gyroSamples = gyro,
                pressureSamples = pressureSamples
            )
        }
        return SensorDataPacket(
            timestamp          = System.currentTimeMillis() / 1000L,
            heartRate          = latestHeartRate.get(),
            accelerometer      = latestAccelerometer.get(),
            gyroscope          = latestGyroscope.get(),
            stepCount          = latestStepCount.get(),
            linearAcceleration = latestLinearAcceleration.get(),
            gravity            = latestGravity.get(),
            pressure           = latestPressure.get(),
            magneticField      = latestMagneticField.get(),
            ecg                = currentEcgWindow(),
            imuHighRate        = imuWindow,
            spo2               = currentSpo2Reading()
        )
    }

    /**
     * Returns a pending SpO2 reading if one was completed since the last
     * snapshot; clears it so the value lands in exactly one outgoing
     * packet. Mirrors [currentEcgWindow]'s drain-on-emit semantics.
     */
    private fun currentSpo2Reading(): Spo2Reading? {
        val result = SharedSpo2Buffer.drainResult() ?: return null
        return Spo2Reading(
            spo2Percent       = result.spo2Percent,
            status            = result.status,
            measuredAtEpochMs = result.measuredAtEpochMs
        )
    }

    /**
     * Drains any ECG samples accumulated since the last tick and packs them as an
     * [EcgWindow] for inclusion in the outgoing JSON.
     *
     * - During an active recording the window contains the samples observed in
     *   this second (typically ~500 at 500 Hz).
     * - Right after the session ends we still emit one final window holding any
     *   trailing samples, then [EcgWindow] is null again until the next session.
     * - If no session is active and no samples are pending, the field is null
     *   (omitted as JSON null) — keeping per-second payloads small.
     */
    private fun currentEcgWindow(): EcgWindow? {
        val drained: List<EcgCapture.EcgSample> = SharedEcgBuffer.drainAll()
        val recording = SharedEcgBuffer.isRecording
        if (drained.isEmpty() && !recording) return null
        val samplesMv = FloatArray(drained.size) { drained[it].ecgMv }
        val leadOff = IntArray(drained.size) { drained[it].leadOff }
        return EcgWindow(
            sampleRateHz = EcgCapture.SAMPLE_RATE_HZ,
            samplesMv = samplesMv,
            leadOff = leadOff,
            isRecording = recording
        )
    }

    override fun onSensorChanged(event: SensorEvent?) {
        if (event == null) return
        try {
            when (event.sensor.type) {
                Sensor.TYPE_HEART_RATE -> {
                    val bpm = event.values.getOrNull(0)
                    if (bpm != null && bpm > 0f) latestHeartRate.set(bpm)
                }
                Sensor.TYPE_ACCELEROMETER -> {
                    val v = event.toVector3()
                    latestAccelerometer.set(v)
                    synchronized(imuLock) {
                        accelBuffer.add(TimestampedVec3(event.timestamp, v))
                    }
                }
                Sensor.TYPE_GYROSCOPE -> {
                    val v = event.toVector3()
                    latestGyroscope.set(v)
                    synchronized(imuLock) {
                        gyroBuffer.add(TimestampedVec3(event.timestamp, v))
                    }
                }
                Sensor.TYPE_STEP_COUNTER         ->
                    event.values.getOrNull(0)?.toLong()?.let(latestStepCount::set)
                Sensor.TYPE_LINEAR_ACCELERATION  -> latestLinearAcceleration.set(event.toVector3())
                Sensor.TYPE_GRAVITY              -> latestGravity.set(event.toVector3())
                Sensor.TYPE_PRESSURE -> {
                    event.values.getOrNull(0)?.let { p ->
                        latestPressure.set(p)
                        synchronized(imuLock) {
                            pressureBuffer.add(TimestampedFloat(event.timestamp, p))
                        }
                    }
                }
                Sensor.TYPE_MAGNETIC_FIELD       -> latestMagneticField.set(event.toVector3())
            }
        } catch (t: Throwable) {
            Log.e(TAG, "Error processing sensor event", t)
        }
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}

    private fun register(sensor: Sensor?, samplingRate: Int, label: String) {
        if (sensor == null) {
            Log.w(TAG, "Sensor not available: $label")
            return
        }
        val ok = sensorManager.registerListener(this, sensor, samplingRate)
        if (ok) Log.i(TAG, "Listener registered: $label")
        else    Log.e(TAG, "Failed to register: $label")
    }

    private fun SensorEvent.toVector3(): Vector3 = Vector3(
        x = values.getOrNull(0) ?: 0f,
        y = values.getOrNull(1) ?: 0f,
        z = values.getOrNull(2) ?: 0f
    )

    companion object {
        private const val TAG = "SensorManagerCtrl"
    }
}