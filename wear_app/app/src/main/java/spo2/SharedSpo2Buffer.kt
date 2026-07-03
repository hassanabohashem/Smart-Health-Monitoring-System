package com.example.ecgwatch.spo2

/**
 * Process-wide single-slot buffer that bridges Samsung's SPO2_ON_DEMAND
 * callback with the sensor aggregation loop. Mirrors [SharedEcgBuffer]
 * but for a single-value reading instead of a continuous sample stream.
 *
 * Usage:
 *   - Spo2Capture pushes the final SpO2 percentage into [setResult] when
 *     the on-demand session completes.
 *   - SensorForegroundService calls [drainResult] once per second when
 *     building the outgoing JSON packet — if a fresh reading is pending,
 *     it's emitted in the next /sensor_data packet as the "spo2" field.
 *   - [isMeasuring] is exposed so the encoder can include status while
 *     a session is in progress (gives the phone UI a "measuring…" hint).
 *
 * Thread-safety: all methods synchronized on a private lock.
 */
object SharedSpo2Buffer {

    /** Snapshot of one completed SpO2 measurement. */
    data class Result(
        /** SpO2 percentage as reported by the Samsung tracker (0..100). */
        val spo2Percent: Int,
        /** Watch wall-clock epoch ms when the result became available. */
        val measuredAtEpochMs: Long,
        /** Samsung status code reported alongside the value (0 = OK). */
        val status: Int,
    )

    private val lock = Any()
    private var pending: Result? = null

    @Volatile
    var isMeasuring: Boolean = false
        private set

    /** Mark the start of a measurement session. */
    fun startMeasuring() {
        synchronized(lock) {
            isMeasuring = true
        }
    }

    /** Mark the end of a measurement session (regardless of success). */
    fun stopMeasuring() {
        synchronized(lock) {
            isMeasuring = false
        }
    }

    /** Push a completed reading. Overwrites any previous pending result. */
    fun setResult(result: Result) {
        synchronized(lock) {
            pending = result
        }
    }

    /**
     * Return the pending result and clear it. Used by the aggregation
     * loop to include the value in exactly one outgoing packet.
     */
    fun drainResult(): Result? {
        synchronized(lock) {
            val out = pending
            pending = null
            return out
        }
    }
}
