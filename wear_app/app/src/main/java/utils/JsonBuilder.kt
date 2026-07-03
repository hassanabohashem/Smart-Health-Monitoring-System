package com.example.ecgwatch.utils

import com.example.ecgwatch.data.EcgWindow
import com.example.ecgwatch.data.ImuHighRateWindow
import com.example.ecgwatch.data.SensorDataPacket
import com.example.ecgwatch.data.Spo2Reading
import com.example.ecgwatch.data.Vector3
import org.json.JSONArray
import org.json.JSONObject

object JsonBuilder {

    fun toJson(packet: SensorDataPacket): JSONObject = JSONObject().apply {
        put("timestamp",          packet.timestamp)
        put("heartRate",          packet.heartRate ?: JSONObject.NULL)
        put("accelerometer",      packet.accelerometer.asJson())
        put("gyroscope",          packet.gyroscope.asJson())
        put("stepCount",          packet.stepCount ?: JSONObject.NULL)
        put("linearAcceleration", packet.linearAcceleration.asJson())
        put("gravity",            packet.gravity.asJson())
        put("pressure",           packet.pressure ?: JSONObject.NULL)
        put("magneticField",      packet.magneticField.asJson())
        put("ecg",                packet.ecg.asJson())
        put("imuHighRate",        packet.imuHighRate.asJson())
        put("spo2",               packet.spo2.asJson())
    }

    fun toBytes(packet: SensorDataPacket): ByteArray {
        val jsonString = toJson(packet).toString()
        android.util.Log.d("JsonBuilder", jsonString)
        return jsonString.toByteArray(Charsets.UTF_8)
    }

    private fun Vector3?.asJson(): Any {
        if (this == null) return JSONObject.NULL
        return JSONObject().apply {
            put("x", x.toDouble())
            put("y", y.toDouble())
            put("z", z.toDouble())
        }
    }

    private fun EcgWindow?.asJson(): Any {
        if (this == null) return JSONObject.NULL
        val samplesJson = JSONArray()
        for (v in samplesMv) samplesJson.put(v.toDouble())
        val leadOffJson = JSONArray()
        for (v in leadOff) leadOffJson.put(v)
        return JSONObject().apply {
            put("isRecording",  isRecording)
            put("sampleRateHz", sampleRateHz)
            put("sampleCount",  samplesMv.size)
            put("samplesMv",    samplesJson)
            put("leadOff",      leadOffJson)
        }
    }

    /**
     * Serialise the high-rate IMU window. Each axis is emitted as a parallel
     * array of length sampleCount for compact JSON: `accel.x[i]` lines up
     * with `accel.y[i]` and `accel.z[i]`. The phone treats samples as
     * uniformly spaced at sampleRateHz (no per-sample timestamps emitted —
     * phone-side interpolation is not used by the consumer).
     */
    private fun ImuHighRateWindow?.asJson(): Any {
        if (this == null) return JSONObject.NULL
        val accelX = JSONArray(); val accelY = JSONArray(); val accelZ = JSONArray()
        for (s in accelSamples) {
            accelX.put(s.v.x.toDouble())
            accelY.put(s.v.y.toDouble())
            accelZ.put(s.v.z.toDouble())
        }
        val gyroX = JSONArray(); val gyroY = JSONArray(); val gyroZ = JSONArray()
        for (s in gyroSamples) {
            gyroX.put(s.v.x.toDouble())
            gyroY.put(s.v.y.toDouble())
            gyroZ.put(s.v.z.toDouble())
        }
        val pressureValues = JSONArray()
        for (s in pressureSamples) {
            pressureValues.put(s.value.toDouble())
        }
        return JSONObject().apply {
            put("sampleRateHz",        sampleRateHz)
            put("accelSampleCount",    accelSamples.size)
            put("gyroSampleCount",     gyroSamples.size)
            put("pressureSampleCount", pressureSamples.size)
            put("accel", JSONObject().apply {
                put("x", accelX); put("y", accelY); put("z", accelZ)
            })
            put("gyro", JSONObject().apply {
                put("x", gyroX); put("y", gyroY); put("z", gyroZ)
            })
            put("pressure", JSONObject().apply {
                put("values", pressureValues)
            })
        }
    }

    /**
     * Serialise the SpO2 reading. Single value per measurement session
     * (or null between sessions). Phone-side reads `spo2.value` and
     * stamps the home screen vitals card.
     */
    private fun Spo2Reading?.asJson(): Any {
        if (this == null) return JSONObject.NULL
        return JSONObject().apply {
            put("value",            spo2Percent ?: JSONObject.NULL)
            put("status",           status)
            put("measuredAtEpochMs", measuredAtEpochMs)
        }
    }
}
