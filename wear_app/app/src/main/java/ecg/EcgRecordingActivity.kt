package com.example.ecgwatch.ecg

import android.os.Bundle
import android.os.SystemClock
import android.widget.Button
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.lifecycle.lifecycleScope
import com.example.ecgwatch.R
import com.example.ecgwatch.service.SensorForegroundService
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * Thin UI for a 30-second ECG session.
 *
 * All actual capture lives in [SensorForegroundService]; the activity only:
 *   - asks the service to start/stop the session via intent actions
 *   - polls [SharedEcgBuffer.isRecording] for state
 *   - shows a countdown and the running sample count for user feedback
 *
 * Captured samples flow into the same /sensor_data JSON stream as everything else,
 * one second at a time. There is no separate /ecg_session channel.
 */
class EcgRecordingActivity : ComponentActivity() {

    private lateinit var statusText: TextView
    private lateinit var progressText: TextView
    private lateinit var recordButton: Button

    private var uiJob: Job? = null
    private var sessionStartElapsedMs: Long = 0L

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_ecg_recording)

        statusText = findViewById(R.id.ecgStatusText)
        progressText = findViewById(R.id.ecgProgressText)
        recordButton = findViewById(R.id.ecgRecordButton)

        recordButton.setOnClickListener {
            if (SharedEcgBuffer.isRecording) stopSession() else startSession()
        }

        renderIdleIfNotRecording()
        if (SharedEcgBuffer.isRecording) beginUiLoop()
    }

    override fun onResume() {
        super.onResume()
        // Sync UI with whatever state the service is in.
        if (SharedEcgBuffer.isRecording) beginUiLoop() else renderIdleIfNotRecording()
    }

    override fun onPause() {
        uiJob?.cancel()
        super.onPause()
    }

    private fun startSession() {
        sessionStartElapsedMs = SystemClock.elapsedRealtime()
        statusText.setText(R.string.ecg_status_connecting)
        progressText.text = ""
        recordButton.setText(R.string.ecg_button_stop)
        SensorForegroundService.startEcg(this)
        beginUiLoop()
    }

    private fun stopSession() {
        SensorForegroundService.stopEcg(this)
        renderDone()
    }

    private fun beginUiLoop() {
        uiJob?.cancel()
        uiJob = lifecycleScope.launch {
            while (isActive) {
                if (!SharedEcgBuffer.isRecording) {
                    renderDone()
                    break
                }
                val elapsed = SystemClock.elapsedRealtime() - sessionStartElapsedMs
                val secondsLeft = ((SESSION_DURATION_MS - elapsed) / 1000L).coerceAtLeast(0L) + 1
                statusText.setText(R.string.ecg_status_recording)
                progressText.text = "${secondsLeft.coerceAtMost(SESSION_DURATION_MS / 1000L)}s left  •  " +
                        "${SharedEcgBuffer.pendingCount()} pending"
                recordButton.setText(R.string.ecg_button_stop)
                delay(250L)
            }
        }
    }

    private fun renderIdleIfNotRecording() {
        if (SharedEcgBuffer.isRecording) return
        statusText.setText(R.string.ecg_status_idle)
        progressText.text = ""
        recordButton.setText(R.string.ecg_button_start)
    }

    private fun renderDone() {
        statusText.setText(R.string.ecg_status_done)
        progressText.text = "Session ended — samples streamed to phone"
        recordButton.setText(R.string.ecg_button_start)
    }

    companion object {
        private const val SESSION_DURATION_MS = 30_000L
    }
}
