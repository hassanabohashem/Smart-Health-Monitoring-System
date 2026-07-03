package com.example.ecgwatch

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.widget.Button
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import com.example.ecgwatch.ecg.EcgRecordingActivity
import com.example.ecgwatch.service.SensorForegroundService
import com.example.ecgwatch.spo2.Spo2RecordingActivity

class MainActivity : ComponentActivity() {

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) {
        SensorForegroundService.start(this)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        findViewById<Button>(R.id.openEcgButton).setOnClickListener {
            startActivity(Intent(this, EcgRecordingActivity::class.java))
        }
        findViewById<Button>(R.id.openSpo2Button).setOnClickListener {
            startActivity(Intent(this, Spo2RecordingActivity::class.java))
        }
        requestRuntimePermissionsThenStart()
    }

    private fun requestRuntimePermissionsThenStart() {
        val needed = mutableListOf<String>()

        if (!isGranted(Manifest.permission.BODY_SENSORS)) {
            needed += Manifest.permission.BODY_SENSORS
        }
        if (!isGranted(Manifest.permission.ACTIVITY_RECOGNITION)) {
            needed += Manifest.permission.ACTIVITY_RECOGNITION
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            !isGranted(Manifest.permission.POST_NOTIFICATIONS)
        ) {
            needed += Manifest.permission.POST_NOTIFICATIONS
        }

        if (needed.isEmpty()) {
            SensorForegroundService.start(this)
        } else {
            permissionLauncher.launch(needed.toTypedArray())
        }
    }

    private fun isGranted(permission: String): Boolean =
        ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED
}