package com.example.smarthealth.har   // <-- CHANGE to your phone app's package

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.tensorflow.lite.Interpreter
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.channels.FileChannel

/**
 * On-device Human Activity Recognition for the phone app.
 *
 * Consumes the Galaxy Watch 5 high-rate IMU stream (the `imuHighRate` block of
 * each [SensorPacket] — see README_watch_mobile_integration.md), downsamples it
 * from ~50 Hz to the model's native 20 Hz, maintains a sliding 10-second window,
 * and runs the TFLite model once per second.
 *
 * DUAL-HEAD model. Two outputs:
 *   probs   : softmax over CLASS_NAMES (walking, jogging, stairs, stationary)
 *   is_real : P(this is a real tracked activity, not junk / fake movement)
 * A window is rejected as fake movement when is_real < tau (junkThreshold);
 * otherwise the activity is argmax(probs). See har_model/RESULTS.md.
 *
 * Contract (must match har_model_meta.json produced by training):
 *   input   : float32 [1, 200, 6]  channels = ax,ay,az,gx,gy,gz
 *             accel in m/s^2 (incl. gravity), gyro in rad/s  -- RAW units;
 *             normalization is baked into the model.
 *   outputs : "probs" float32 [1, 4] + "is_real" float32 [1, 1]
 *
 * Usage:
 *   val har = HarClassifier(context)                 // loads har_model_float.tflite from assets
 *   // in SensorDataReceiverService.onMessageReceived, after parsing:
 *   har.onPacket(packet)
 *   // observe results anywhere:
 *   har.result.collect { r -> if (r.isConfident) showActivity(r.activity) }
 *   har.close()                                      // when done
 */
class HarClassifier(
    context: Context,
    modelAssetName: String = "har_model_float.tflite",
    /** is_real threshold tau from har_model_meta.json (inference.is_real_threshold_tau). */
    private val junkThreshold: Float = 0.80f,
    /** Majority-vote smoothing over the last N window predictions (1 = off). */
    private val smoothingWindow: Int = 3,
) {

    companion object {
        // Hard contract — keep in lockstep with config.py.
        const val TARGET_HZ = 20
        const val WINDOW = 200            // 10 s * 20 Hz
        const val N_CHANNELS = 6
        val CLASS_NAMES = listOf("walking", "jogging", "stairs", "stationary")
    }

    data class HarResult(
        val activity: String,        // argmax class name
        val confidence: Float,       // max softmax probability
        val isReal: Float,           // is_real head output (1 = real activity, 0 = junk)
        val isConfident: Boolean,    // true => real activity accepted (is_real >= tau)
        val probabilities: FloatArray,
    )

    private val interpreter: Interpreter
    private val inputBuf: ByteBuffer =
        ByteBuffer.allocateDirect(WINDOW * N_CHANNELS * 4).order(ByteOrder.nativeOrder())

    // Two output tensors; map their interpreter indices by shape at init.
    private var probsIdx = 0
    private var realIdx = 1

    // Ring buffer of 20 Hz samples; each entry is one [ax,ay,az,gx,gy,gz] frame.
    private val ring = ArrayDeque<FloatArray>(WINDOW * 2)
    private val recent = ArrayDeque<Int>()   // recent argmax indices for smoothing

    private val _result = MutableStateFlow(
        HarResult(CLASS_NAMES[0], 0f, 0f, false, FloatArray(CLASS_NAMES.size))
    )
    val result: StateFlow<HarResult> = _result.asStateFlow()

    init {
        val fd = context.assets.openFd(modelAssetName)
        val model = fd.createInputStream().channel.map(
            FileChannel.MapMode.READ_ONLY, fd.startOffset, fd.declaredLength
        )
        interpreter = Interpreter(model)
        // Identify which output tensor is the 4-class softmax vs the scalar is_real.
        for (i in 0 until interpreter.outputTensorCount) {
            val shape = interpreter.getOutputTensor(i).shape()
            val last = shape.last()
            if (last == CLASS_NAMES.size) probsIdx = i else if (last == 1) realIdx = i
        }
    }

    /**
     * Feed one watch packet. Downsamples this packet's ~50 Hz block to 20 Hz,
     * appends to the sliding window, and runs inference once a full window exists.
     * No-op when [SensorPacket.imuHighRate] is null (startup warm-up).
     */
    fun onPacket(packet: SensorPacket) {
        val imu = packet.imuHighRate ?: return

        // Resample each axis from the packet's native count to TARGET_HZ samples
        // for this 1-second slice. accel and gyro counts can differ (±10%), so
        // resample each independently onto the same 20-point grid.
        val ax = resample(imu.accelX, TARGET_HZ)
        val ay = resample(imu.accelY, TARGET_HZ)
        val az = resample(imu.accelZ, TARGET_HZ)
        val gx = resample(imu.gyroX, TARGET_HZ)
        val gy = resample(imu.gyroY, TARGET_HZ)
        val gz = resample(imu.gyroZ, TARGET_HZ)
        if (ax.isEmpty()) return

        for (i in 0 until TARGET_HZ) {
            ring.addLast(floatArrayOf(ax[i], ay[i], az[i], gx[i], gy[i], gz[i]))
        }
        while (ring.size > WINDOW) ring.removeFirst()

        if (ring.size == WINDOW) runInference()
    }

    private fun runInference() {
        inputBuf.rewind()
        for (frame in ring) {
            for (c in 0 until N_CHANNELS) inputBuf.putFloat(frame[c])
        }
        inputBuf.rewind()

        val probsOut = Array(1) { FloatArray(CLASS_NAMES.size) }
        val realOut = Array(1) { FloatArray(1) }
        val outputs = HashMap<Int, Any>().apply {
            put(probsIdx, probsOut)
            put(realIdx, realOut)
        }
        interpreter.runForMultipleInputsOutputs(arrayOf<Any>(inputBuf), outputs)

        val probs = probsOut[0]
        val isReal = realOut[0][0]
        var argmax = 0
        for (i in probs.indices) if (probs[i] > probs[argmax]) argmax = i

        // Smoothing: majority vote over the last `smoothingWindow` predictions.
        recent.addLast(argmax)
        while (recent.size > smoothingWindow) recent.removeFirst()
        val voted = recent.groupingBy { it }.eachCount().maxByOrNull { it.value }!!.key

        val conf = probs[voted]
        val name = CLASS_NAMES[voted]
        val isConfident = isReal >= junkThreshold      // reject fake movement via is_real head
        _result.value = HarResult(name, conf, isReal, isConfident, probs.copyOf())
    }

    /** Linear resample [src] (assumed uniformly spaced) to exactly [n] points. */
    private fun resample(src: FloatArray, n: Int): FloatArray {
        if (src.isEmpty()) return FloatArray(0)
        if (src.size == n) return src
        if (src.size == 1) return FloatArray(n) { src[0] }
        val out = FloatArray(n)
        val ratio = (src.size - 1).toFloat() / (n - 1).toFloat()
        for (i in 0 until n) {
            val pos = i * ratio
            val lo = pos.toInt()
            val hi = minOf(lo + 1, src.size - 1)
            val frac = pos - lo
            out[i] = src[lo] * (1f - frac) + src[hi] * frac
        }
        return out
    }

    fun close() = interpreter.close()
}
