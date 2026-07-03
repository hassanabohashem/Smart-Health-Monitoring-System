package com.example.ecgwatch.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import androidx.core.app.NotificationCompat
import com.example.ecgwatch.comm.DataLayerSender
import com.example.ecgwatch.ecg.EcgCapture
import com.example.ecgwatch.ecg.SharedEcgBuffer
import com.example.ecgwatch.sensors.SensorManagerController
import com.example.ecgwatch.spo2.SharedSpo2Buffer
import com.example.ecgwatch.spo2.Spo2Capture
import com.example.ecgwatch.utils.JsonBuilder
import com.samsung.android.service.health.tracking.HealthTracker
import com.samsung.android.service.health.tracking.HealthTrackerException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * Always-on foreground service that:
 *   - Reads every Android SensorManager sensor continuously.
 *   - Optionally drives a Samsung Health ECG_ON_DEMAND session.
 *   - Once per second, drains both sources into a single JSON packet and sends it
 *     to the paired phone on the /sensor_data Data Layer path.
 *
 * UI calls [startEcg]/[stopEcg] via intent actions to bracket an ECG session.
 */
class SensorForegroundService : Service() {

    private lateinit var sensorController: SensorManagerController
    private lateinit var dataLayerSender: DataLayerSender
    private lateinit var ecgCapture: EcgCapture
    private lateinit var spo2Capture: Spo2Capture

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var aggregationJob: Job? = null
    private var ecgAutoStopJob: Job? = null
    private var spo2AutoStopJob: Job? = null
    private var wakeLock: PowerManager.WakeLock? = null

    @Volatile private var ecgSessionActive = false
    @Volatile private var spo2SessionActive = false
    @Volatile private var lastEcgError: String? = null
    @Volatile private var lastSpo2Error: String? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        startInForeground()

        sensorController = SensorManagerController(this)
        dataLayerSender = DataLayerSender(this)
        ecgCapture = EcgCapture(this)
        spo2Capture = Spo2Capture(this)

        sensorController.start()
        acquireWakeLock()
        startAggregationLoop()

        Log.i(TAG, "Service started; availability=${sensorController.availability()}")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START_ECG  -> startEcgInternal()
            ACTION_STOP_ECG   -> stopEcgInternal(reason = "user")
            ACTION_START_SPO2 -> startSpo2Internal()
            ACTION_STOP_SPO2  -> stopSpo2Internal(reason = "user")
        }
        return START_STICKY
    }

    override fun onDestroy() {
        Log.i(TAG, "Service stopping")
        try {
            aggregationJob?.cancel()
            ecgAutoStopJob?.cancel()
            spo2AutoStopJob?.cancel()
            sensorController.stop()
            stopEcgInternal(reason = "service destroy")
            stopSpo2Internal(reason = "service destroy")
            ecgCapture.disconnect()
            spo2Capture.disconnect()
            releaseWakeLock()
            scope.cancel()
        } catch (t: Throwable) {
            Log.e(TAG, "Error during onDestroy", t)
        }
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    // ---------- main aggregation loop ----------

    private fun startAggregationLoop() {
        aggregationJob = scope.launch {
            while (isActive) {
                try {
                    val packet = sensorController.snapshot()
                    val bytes = JsonBuilder.toBytes(packet)
                    dataLayerSender.send(bytes)
                } catch (t: Throwable) {
                    Log.e(TAG, "Aggregation tick failed", t)
                }
                delay(AGGREGATION_INTERVAL_MS)
            }
        }
    }

    // ---------- ECG lifecycle ----------

    private fun startEcgInternal() {
        if (ecgSessionActive) {
            Log.w(TAG, "startEcg called while session is already active; ignoring")
            return
        }
        lastEcgError = null
        Log.i(TAG, "Starting ECG session")
        SharedEcgBuffer.startRecording()
        ecgSessionActive = true
        ecgCapture.connect(captureListener)

        // Auto-stop after the configured session length (30 s by default).
        ecgAutoStopJob?.cancel()
        ecgAutoStopJob = scope.launch {
            val deadline = SystemClock.elapsedRealtime() + ECG_SESSION_DURATION_MS
            while (isActive && SystemClock.elapsedRealtime() < deadline && ecgSessionActive) {
                delay(250L)
            }
            if (ecgSessionActive) {
                Log.i(TAG, "ECG session auto-stop (30 s elapsed)")
                stopEcgInternal(reason = "auto-stop")
            }
        }
    }

    private fun stopEcgInternal(reason: String) {
        if (!ecgSessionActive) return
        Log.i(TAG, "Stopping ECG session (reason=$reason)")
        ecgSessionActive = false
        SharedEcgBuffer.stopRecording()
        try { ecgCapture.stopEcg() } catch (t: Throwable) { Log.w(TAG, "stopEcg threw", t) }
        try { ecgCapture.disconnect() } catch (t: Throwable) { Log.w(TAG, "disconnect threw", t) }
        ecgAutoStopJob?.cancel()
    }

    private val captureListener = object : EcgCapture.Listener {
        override fun onConnected() {
            if (!ecgSessionActive) return
            Log.i(TAG, "Health Platform connected; attaching ECG tracker")
            ecgCapture.startEcg()
        }

        override fun onConnectionFailed(reason: String, exception: HealthTrackerException?) {
            Log.e(TAG, "ECG connection failed: $reason", exception)
            lastEcgError = reason
            stopEcgInternal(reason = "connect failed")
        }

        override fun onConnectionEnded() {
            if (ecgSessionActive) {
                Log.w(TAG, "ECG connection ended mid-session")
                stopEcgInternal(reason = "connection ended")
            }
        }

        override fun onSamples(samples: List<EcgCapture.EcgSample>) {
            // EcgCapture has already pushed these into SharedEcgBuffer; nothing else to do here.
        }

        override fun onTrackerError(error: HealthTracker.TrackerError) {
            Log.e(TAG, "ECG tracker error: $error")
            lastEcgError = "tracker error: $error"
            stopEcgInternal(reason = "tracker error $error")
        }
    }

    // ---------- SpO2 lifecycle ----------

    private fun startSpo2Internal() {
        if (spo2SessionActive) {
            Log.w(TAG, "startSpo2 called while session is already active; ignoring")
            return
        }
        lastSpo2Error = null
        Log.i(TAG, "Starting SpO2 session")
        SharedSpo2Buffer.startMeasuring()
        spo2SessionActive = true
        spo2Capture.connect(spo2CaptureListener)

        // Auto-stop after the session length (Samsung SDK takes ~30s to settle).
        spo2AutoStopJob?.cancel()
        spo2AutoStopJob = scope.launch {
            val deadline = SystemClock.elapsedRealtime() + SPO2_SESSION_DURATION_MS
            while (isActive && SystemClock.elapsedRealtime() < deadline && spo2SessionActive) {
                delay(250L)
            }
            if (spo2SessionActive) {
                Log.i(TAG, "SpO2 session auto-stop")
                stopSpo2Internal(reason = "auto-stop")
            }
        }
    }

    private fun stopSpo2Internal(reason: String) {
        if (!spo2SessionActive) return
        Log.i(TAG, "Stopping SpO2 session (reason=$reason)")
        spo2SessionActive = false
        SharedSpo2Buffer.stopMeasuring()
        try { spo2Capture.stopSpo2() } catch (t: Throwable) { Log.w(TAG, "stopSpo2 threw", t) }
        try { spo2Capture.disconnect() } catch (t: Throwable) { Log.w(TAG, "spo2 disconnect threw", t) }
        spo2AutoStopJob?.cancel()
    }

    private val spo2CaptureListener = object : Spo2Capture.Listener {
        override fun onConnected() {
            if (!spo2SessionActive) return
            Log.i(TAG, "Health Platform connected; attaching SpO2 tracker")
            spo2Capture.startSpo2()
        }

        override fun onConnectionFailed(reason: String, exception: HealthTrackerException?) {
            Log.e(TAG, "SpO2 connection failed: $reason", exception)
            lastSpo2Error = reason
            stopSpo2Internal(reason = "connect failed")
        }

        override fun onConnectionEnded() {
            if (spo2SessionActive) {
                Log.w(TAG, "SpO2 connection ended mid-session")
                stopSpo2Internal(reason = "connection ended")
            }
        }

        override fun onSample(spo2Percent: Int?, status: Int, timestampNs: Long) {
            // Samsung emits intermediate status DataPoints. We only push a
            // result into the shared buffer once the value is populated
            // (status=0 means OK, value is final). Other statuses go
            // unrecorded — UI can poll SharedSpo2Buffer.isMeasuring for
            // the in-progress indication.
            if (spo2Percent != null && status == 0) {
                SharedSpo2Buffer.setResult(
                    SharedSpo2Buffer.Result(
                        spo2Percent       = spo2Percent,
                        measuredAtEpochMs = System.currentTimeMillis(),
                        status            = status
                    )
                )
                // Got a final value — end the session early to save battery.
                stopSpo2Internal(reason = "value received")
            }
        }

        override fun onTrackerError(error: HealthTracker.TrackerError) {
            Log.e(TAG, "SpO2 tracker error: $error")
            lastSpo2Error = "tracker error: $error"
            stopSpo2Internal(reason = "tracker error $error")
        }
    }

    // ---------- foreground notification, wakelock, channel (unchanged) ----------

    private fun startInForeground() {
        val notification = buildNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_HEALTH
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun buildNotification(): Notification {
        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
        val pendingIntent = PendingIntent.getActivity(
            this,
            0,
            launchIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Collecting sensor data")
            .setContentText("Streaming to paired phone")
            .setSmallIcon(android.R.drawable.ic_menu_compass)
            .setOngoing(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setContentIntent(pendingIntent)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Sensor Collection",
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "Ongoing sensor data collection"
            setShowBadge(false)
            enableVibration(false)
        }
        val mgr = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        mgr.createNotificationChannel(channel)
    }

    private fun acquireWakeLock() {
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(
            PowerManager.PARTIAL_WAKE_LOCK,
            "wear_app:SensorService"
        ).apply {
            setReferenceCounted(false)
            acquire()
        }
    }

    private fun releaseWakeLock() {
        wakeLock?.let { lock ->
            try { if (lock.isHeld) lock.release() } catch (_: Throwable) {}
        }
        wakeLock = null
    }

    companion object {
        private const val TAG = "SensorFgService"
        private const val CHANNEL_ID = "sensor_collection_channel"
        private const val NOTIFICATION_ID = 4711
        private const val AGGREGATION_INTERVAL_MS = 1_000L
        private const val ECG_SESSION_DURATION_MS = 30_000L
        private const val SPO2_SESSION_DURATION_MS = 35_000L

        const val ACTION_START_ECG  = "com.example.ecgwatch.action.START_ECG"
        const val ACTION_STOP_ECG   = "com.example.ecgwatch.action.STOP_ECG"
        const val ACTION_START_SPO2 = "com.example.ecgwatch.action.START_SPO2"
        const val ACTION_STOP_SPO2  = "com.example.ecgwatch.action.STOP_SPO2"

        fun start(context: Context) {
            val intent = Intent(context, SensorForegroundService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, SensorForegroundService::class.java))
        }

        /** Ask the service to begin a 30-second ECG session. Idempotent. */
        fun startEcg(context: Context) {
            val intent = Intent(context, SensorForegroundService::class.java).apply {
                action = ACTION_START_ECG
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        /** Ask the service to end the current ECG session, if any. Idempotent. */
        fun stopEcg(context: Context) {
            val intent = Intent(context, SensorForegroundService::class.java).apply {
                action = ACTION_STOP_ECG
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        /** Ask the service to begin an SpO2 on-demand session. Idempotent. */
        fun startSpo2(context: Context) {
            val intent = Intent(context, SensorForegroundService::class.java).apply {
                action = ACTION_START_SPO2
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        /** Ask the service to abort the current SpO2 session, if any. Idempotent. */
        fun stopSpo2(context: Context) {
            val intent = Intent(context, SensorForegroundService::class.java).apply {
                action = ACTION_STOP_SPO2
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }
    }
}
