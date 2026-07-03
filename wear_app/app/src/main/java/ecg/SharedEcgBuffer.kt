package com.example.ecgwatch.ecg

/**
 * Process-wide buffer that bridges Samsung's ECG_ON_DEMAND callback (background thread,
 * 500 Hz) with the sensor aggregation loop (1 Hz).
 *
 * Usage:
 *   - EcgCapture pushes incoming samples into [add].
 *   - SensorForegroundService calls [drainAll] once per second when building the
 *     outgoing JSON packet — the drained samples become the "ecg" field for that
 *     second of data.
 *   - [isRecording] is exposed so the JSON encoder can include a status flag even
 *     during sub-second windows where no samples happened to arrive.
 *
 * Thread-safety: all methods are synchronized on a private lock. Cheap because
 * the critical sections are tiny (just list append / list copy).
 */
object SharedEcgBuffer {

    private val lock = Any()
    private val samples = ArrayList<EcgCapture.EcgSample>(1024)

    @Volatile
    var isRecording: Boolean = false
        private set

    /** Mark the start of a recording session. Clears any leftover samples. */
    fun startRecording() {
        synchronized(lock) {
            samples.clear()
            isRecording = true
        }
    }

    /** Mark the end of a recording session. Keeps any pending samples so the next
     *  drainAll() will still flush them to the phone. */
    fun stopRecording() {
        synchronized(lock) {
            isRecording = false
        }
    }

    /** Append samples produced by EcgCapture. Only stored if a session is active. */
    fun add(newSamples: List<EcgCapture.EcgSample>) {
        if (newSamples.isEmpty()) return
        synchronized(lock) {
            if (isRecording) samples.addAll(newSamples)
        }
    }

    /** Return all buffered samples since the last drain, and clear the buffer. */
    fun drainAll(): List<EcgCapture.EcgSample> {
        synchronized(lock) {
            if (samples.isEmpty()) return emptyList()
            val out = ArrayList<EcgCapture.EcgSample>(samples.size)
            out.addAll(samples)
            samples.clear()
            return out
        }
    }

    /** Snapshot of buffer size, for UI display. */
    fun pendingCount(): Int = synchronized(lock) { samples.size }
}
