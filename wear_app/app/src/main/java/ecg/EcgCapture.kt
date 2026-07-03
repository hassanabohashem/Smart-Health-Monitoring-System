package com.example.ecgwatch.ecg

import android.content.Context
import android.util.Log
import com.samsung.android.service.health.tracking.ConnectionListener
import com.samsung.android.service.health.tracking.HealthTracker
import com.samsung.android.service.health.tracking.HealthTrackerException
import com.samsung.android.service.health.tracking.HealthTrackingService
import com.samsung.android.service.health.tracking.data.DataPoint
import com.samsung.android.service.health.tracking.data.HealthTrackerType
import com.samsung.android.service.health.tracking.data.ValueKey

/**
 * Thin wrapper around Samsung Health Sensor SDK ECG_ON_DEMAND tracker.
 *
 * Lifecycle:
 *   1. connect(listener)         -- binds to the Samsung Health Platform service
 *   2. startEcg()                -- attaches event listener; user must hold finger on Home button
 *   3. samples flow into Listener.onSamples(...) at ~500 Hz
 *   4. stopEcg()                 -- detaches listener
 *   5. disconnect()              -- unbinds
 *
 * Requires:
 *   - Samsung Galaxy Watch with ECG hardware (e.g. Galaxy Watch 5)
 *   - Samsung Health Platform installed and Health Platform Developer Mode enabled on the watch
 *   - Region where ECG is allowed by Samsung
 */
class EcgCapture(private val context: Context) {

    interface Listener {
        fun onConnected()
        fun onConnectionFailed(reason: String, exception: HealthTrackerException?)
        fun onConnectionEnded()
        fun onSamples(samples: List<EcgSample>)
        fun onTrackerError(error: HealthTracker.TrackerError)
    }

    /**
     * One ECG sample.
     * @param timestampNs Sensor timestamp in nanoseconds (from DataPoint.getTimestamp()).
     * @param ecgMv      ECG amplitude in millivolts.
     * @param leadOff    0 means good electrode contact; non-zero means contact is bad — discard.
     */
    data class EcgSample(
        val timestampNs: Long,
        val ecgMv: Float,
        val leadOff: Int
    )

    private var trackingService: HealthTrackingService? = null
    private var ecgTracker: HealthTracker? = null
    private var listener: Listener? = null

    fun connect(listener: Listener) {
        this.listener = listener
        if (trackingService != null) {
            // Already connected
            listener.onConnected()
            return
        }
        try {
            val service = HealthTrackingService(connectionListener, context.applicationContext)
            trackingService = service
            service.connectService()
        } catch (t: Throwable) {
            Log.e(TAG, "HealthTrackingService construction failed", t)
            listener.onConnectionFailed("init failed: ${t.message}", null)
        }
    }

    fun startEcg() {
        val service = trackingService
        if (service == null) {
            Log.e(TAG, "startEcg() before connect() succeeded")
            return
        }
        if (ecgTracker != null) {
            Log.w(TAG, "startEcg() called while a tracker is already attached")
            return
        }
        try {
            val tracker = service.getHealthTracker(HealthTrackerType.ECG_ON_DEMAND)
            tracker.setEventListener(trackerListener)
            ecgTracker = tracker
            Log.i(TAG, "ECG tracker attached")
        } catch (t: Throwable) {
            Log.e(TAG, "Failed to attach ECG tracker", t)
        }
    }

    fun stopEcg() {
        val tracker = ecgTracker ?: return
        try {
            tracker.unsetEventListener()
        } catch (t: Throwable) {
            Log.w(TAG, "unsetEventListener threw", t)
        }
        ecgTracker = null
        Log.i(TAG, "ECG tracker detached")
    }

    fun disconnect() {
        stopEcg()
        try {
            trackingService?.disconnectService()
        } catch (t: Throwable) {
            Log.w(TAG, "disconnectService threw", t)
        }
        trackingService = null
        listener = null
    }

    private val connectionListener = object : ConnectionListener {
        override fun onConnectionSuccess() {
            Log.i(TAG, "Health Platform connected")
            // Diagnostic: log every tracker this specific watch can offer.
            // Tells us at runtime what hardware/firmware exposes — separately
            // from the per-tracker partnership whitelist.
            try {
                val caps = trackingService?.trackingCapability
                val types = caps?.supportHealthTrackerTypes
                Log.i(TAG, "Tracking capability: ${types?.joinToString()}")
            } catch (t: Throwable) {
                Log.w(TAG, "Failed to enumerate tracking capability", t)
            }
            listener?.onConnected()
        }

        override fun onConnectionEnded() {
            Log.i(TAG, "Health Platform connection ended")
            listener?.onConnectionEnded()
        }

        override fun onConnectionFailed(e: HealthTrackerException) {
            val msg = "Health Platform connection failed code=${e.errorCode}"
            Log.e(TAG, msg, e)
            listener?.onConnectionFailed(msg, e)
        }
    }

    private val trackerListener = object : HealthTracker.TrackerEventListener {
        override fun onDataReceived(dataPoints: List<DataPoint>) {
            if (dataPoints.isEmpty()) return
            val samples = ArrayList<EcgSample>(dataPoints.size)
            for (dp in dataPoints) {
                try {
                    val mv = dp.getValue(ValueKey.EcgSet.ECG_MV) ?: continue
                    val leadOff = dp.getValue(ValueKey.EcgSet.LEAD_OFF) ?: 0
                    samples += EcgSample(
                        timestampNs = dp.timestamp,
                        ecgMv = mv,
                        leadOff = leadOff
                    )
                } catch (t: Throwable) {
                    Log.w(TAG, "Bad DataPoint", t)
                }
            }
            if (samples.isNotEmpty()) {
                // Feed the unified JSON stream first; an active session collects samples here.
                SharedEcgBuffer.add(samples)
                listener?.onSamples(samples)
            }
        }

        override fun onFlushCompleted() {
            Log.d(TAG, "ECG flush completed")
        }

        override fun onError(error: HealthTracker.TrackerError) {
            Log.e(TAG, "ECG tracker error: $error")
            listener?.onTrackerError(error)
        }
    }

    companion object {
        private const val TAG = "EcgCapture"

        /** Samsung's ECG_ON_DEMAND tracker streams at 500 Hz. */
        const val SAMPLE_RATE_HZ = 500
    }
}
