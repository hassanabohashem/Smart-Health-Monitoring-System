package com.example.ecgwatch.spo2

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
 * Thin UI for an on-demand SpO2 measurement. Mirrors [EcgRecordingActivity]
 * but for SpO2:
 *   - tapping Start asks the service to begin an SPO2_ON_DEMAND session
 *   - polls [SharedSpo2Buffer.isMeasuring] to drive the UI
 *   - shows the measured % once the session completes (Samsung typically
 *     returns the value before the auto-stop deadline)
 */
class Spo2RecordingActivity : ComponentActivity() {

    private lateinit var statusText: TextView
    private lateinit var progressText: TextView
    private lateinit var recordButton: Button

    private var uiJob: Job? = null
    private var sessionStartElapsedMs: Long = 0L

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_spo2_recording)

        statusText = findViewById(R.id.spo2StatusText)
        progressText = findViewById(R.id.spo2ProgressText)
        recordButton = findViewById(R.id.spo2RecordButton)

        recordButton.setOnClickListener {
            if (SharedSpo2Buffer.isMeasuring) stopSession() else startSession()
        }

        renderIdleIfNotMeasuring()
        if (SharedSpo2Buffer.isMeasuring) beginUiLoop()
    }

    override fun onResume() {
        super.onResume()
        if (SharedSpo2Buffer.isMeasuring) beginUiLoop() else renderIdleIfNotMeasuring()
    }

    override fun onPause() {
        uiJob?.cancel()
        super.onPause()
    }

    private fun startSession() {
        sessionStartElapsedMs = SystemClock.elapsedRealtime()
        statusText.setText(R.string.spo2_status_connecting)
        progressText.text = ""
        recordButton.setText(R.string.spo2_button_stop)
        SensorForegroundService.startSpo2(this)
        beginUiLoop()
    }

    private fun stopSession() {
        SensorForegroundService.stopSpo2(this)
        renderDone()
    }

    private fun beginUiLoop() {
        uiJob?.cancel()
        uiJob = lifecycleScope.launch {
            while (isActive) {
                if (!SharedSpo2Buffer.isMeasuring) {
                    renderDone()
                    break
                }
                val elapsed = SystemClock.elapsedRealtime() - sessionStartElapsedMs
                val secondsLeft = ((SESSION_DURATION_MS - elapsed) / 1000L).coerceAtLeast(0L) + 1
                statusText.setText(R.string.spo2_status_measuring)
                progressText.text = "${secondsLeft.coerceAtMost(SESSION_DURATION_MS / 1000L)}s left"
                recordButton.setText(R.string.spo2_button_stop)
                delay(250L)
            }
        }
    }

    private fun renderIdleIfNotMeasuring() {
        if (SharedSpo2Buffer.isMeasuring) return
        statusText.setText(R.string.spo2_status_idle)
        progressText.text = ""
        recordButton.setText(R.string.spo2_button_start)
    }

    private fun renderDone() {
        statusText.setText(R.string.spo2_status_done)
        progressText.text = "Result streamed to phone"
        recordButton.setText(R.string.spo2_button_start)
    }

    companion object {
        private const val SESSION_DURATION_MS = 35_000L
    }
}
