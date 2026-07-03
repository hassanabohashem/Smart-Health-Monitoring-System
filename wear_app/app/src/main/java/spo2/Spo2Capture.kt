package com.example.ecgwatch.spo2

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
 * Thin wrapper around Samsung Health Sensor SDK SPO2_ON_DEMAND tracker.
 *
 * Mirrors [EcgCapture] structure but for SpO2, which returns a single
 * value after a ~30-second measurement window (rather than a continuous
 * sample stream like ECG).
 *
 * Lifecycle:
 *   1. connect(listener) — binds to Samsung Health Platform
 *   2. startSpo2()       — attaches tracker; Samsung begins measuring
 *   3. samples flow into Listener.onSample(...) as DataPoints arrive
 *      (typically: a status code per packet, then a final reading)
 *   4. stopSpo2()        — detaches tracker
 *   5. disconnect()      — unbinds
 *
 * Samsung's SPO2_ON_DEMAND data includes:
 *   - ValueKey.SpO2Set.SPO2     — percentage (0..100), populated when status=0
 *   - ValueKey.SpO2Set.STATUS   — 0 = OK, non-zero = measuring/error
 *                                  (e.g. DEVICE_MOVING, LOW_SIGNAL, INITIAL_STATUS)
 */
class Spo2Capture(private val context: Context) {

    interface Listener {
        fun onConnected()
        fun onConnectionFailed(reason: String, exception: HealthTrackerException?)
        fun onConnectionEnded()
        /** Fires for every DataPoint Samsung emits (including intermediate states). */
        fun onSample(spo2Percent: Int?, status: Int, timestampNs: Long)
        fun onTrackerError(error: HealthTracker.TrackerError)
    }

    private var trackingService: HealthTrackingService? = null
    private var spo2Tracker: HealthTracker? = null
    private var listener: Listener? = null

    fun connect(listener: Listener) {
        this.listener = listener
        if (trackingService != null) {
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

    fun startSpo2() {
        val service = trackingService
        if (service == null) {
            Log.e(TAG, "startSpo2() before connect() succeeded")
            return
        }
        if (spo2Tracker != null) {
            Log.w(TAG, "startSpo2() called while a tracker is already attached")
            return
        }
        try {
            val tracker = service.getHealthTracker(HealthTrackerType.SPO2_ON_DEMAND)
            tracker.setEventListener(trackerListener)
            spo2Tracker = tracker
            Log.i(TAG, "SpO2 tracker attached")
        } catch (t: Throwable) {
            Log.e(TAG, "Failed to attach SpO2 tracker", t)
        }
    }

    fun stopSpo2() {
        val tracker = spo2Tracker ?: return
        try {
            tracker.unsetEventListener()
        } catch (t: Throwable) {
            Log.w(TAG, "unsetEventListener threw", t)
        }
        spo2Tracker = null
        Log.i(TAG, "SpO2 tracker detached")
    }

    fun disconnect() {
        stopSpo2()
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
            Log.i(TAG, "Health Platform connected (SpO2)")
            listener?.onConnected()
        }

        override fun onConnectionEnded() {
            Log.i(TAG, "Health Platform connection ended (SpO2)")
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
            for (dp in dataPoints) {
                try {
                    val status: Int = dp.getValue(ValueKey.SpO2Set.STATUS) ?: continue
                    val spo2: Int? = dp.getValue(ValueKey.SpO2Set.SPO2)
                    listener?.onSample(spo2, status, dp.timestamp)
                } catch (t: Throwable) {
                    Log.w(TAG, "Bad SpO2 DataPoint", t)
                }
            }
        }

        override fun onFlushCompleted() {
            Log.d(TAG, "SpO2 flush completed")
        }

        override fun onError(error: HealthTracker.TrackerError) {
            Log.e(TAG, "SpO2 tracker error: $error")
            listener?.onTrackerError(error)
        }
    }

    companion object {
        private const val TAG = "Spo2Capture"
    }
}
