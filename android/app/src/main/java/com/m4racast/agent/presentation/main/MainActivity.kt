package com.m4racast.agent.presentation.main

import android.Manifest
import android.app.Activity
import android.content.ComponentName
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.ViewModelProvider
import com.m4racast.agent.R
import com.m4racast.agent.databinding.ActivityMainBinding
import com.m4racast.agent.infrastructure.AppLogger
import com.m4racast.agent.infrastructure.StreamingService
import com.m4racast.agent.presentation.settings.SettingsActivity

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private lateinit var viewModel: MainViewModel
    private lateinit var projectionManager: MediaProjectionManager

    private val screenCaptureRequest = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        AppLogger.i("MainActivity", "Screen capture permission result: ${result.resultCode}")
        if (result.resultCode == Activity.RESULT_OK && result.data != null) {
            AppLogger.i("MainActivity", "Permission GRANTED, launching StreamingService...")
            launchStreamingService(result.resultCode, result.data!!)
        } else {
            AppLogger.w("MainActivity", "Permission was not granted (code: ${result.resultCode})")
            Toast.makeText(this, "Screen capture permission denied", Toast.LENGTH_SHORT).show()
        }
    }

    private val notificationPermissionRequest = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        AppLogger.i("MainActivity", "Notification permission granted: $granted")
        if (!granted) {
            Toast.makeText(this, "Notification permission recommended for streaming", Toast.LENGTH_SHORT).show()
        }
        checkAudioPermissionAndProceed()
    }

    private val audioPermissionRequest = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        AppLogger.i("MainActivity", "Audio permission granted: $granted")
        requestScreenCapture()
    }

    private var isPasswordRevealed = false
    private var currentPassword = ""
    private var isProtectedConfig = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)
        setSupportActionBar(binding.toolbar)

        AppLogger.i("MainActivity", "App started on Android SDK ${Build.VERSION.SDK_INT} (${Build.MODEL})")

        projectionManager = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        viewModel = ViewModelProvider(this)[MainViewModel::class.java]

        setupObservers()
        setupClickListeners()
    }

    private fun setupObservers() {
        AppLogger.logs.observe(this) { logs ->
            binding.tvLogs.text = logs.takeLast(25).joinToString("\n")
            binding.scrollLogs.post {
                binding.scrollLogs.fullScroll(View.FOCUS_DOWN)
            }
        }

        viewModel.isStreaming.observe(this) { streaming ->
            updateStreamingUI(streaming)
        }

        viewModel.serverPort.observe(this) { port ->
            binding.tvPort.text = if (port > 0) "Port: $port" else "Port: —"
            updateAddressDisplay()
        }

        viewModel.clientCount.observe(this) { count ->
            binding.tvClientCount.text = if (count == 1) "1 client" else "$count clients"
        }

        viewModel.lanAddresses.observe(this) { _ ->
            updateAddressDisplay()
        }

        viewModel.configuration.observe(this) { config ->
            binding.tvDeviceName.text = config.deviceName
            isProtectedConfig = config.isProtected
            currentPassword = config.password
            updatePasswordDisplay()
            updateAddressDisplay()
        }

        viewModel.errorMessage.observe(this) { error ->
            error?.let { Toast.makeText(this, it, Toast.LENGTH_LONG).show() }
        }
    }

    private fun updateAddressDisplay() {
        val addresses = viewModel.lanAddresses.value ?: emptyList()
        val port = if ((viewModel.serverPort.value ?: 0) > 0) {
            viewModel.serverPort.value!!
        } else {
            viewModel.configuration.value?.port ?: 46283
        }

        binding.tvLanAddresses.text = if (addresses.isEmpty()) {
            "http://detecting..."
        } else {
            "http://${addresses.first()}:$port"
        }
    }

    private fun updatePasswordDisplay() {
        if (isProtectedConfig) {
            binding.tvProtected.text = "🔒 Security Password"
            binding.layoutPasswordCard.visibility = View.VISIBLE
            if (isPasswordRevealed) {
                binding.tvPasswordValue.text = currentPassword.ifEmpty { "(no password set)" }
                binding.tvPasswordHint.text = "Tap to hide"
            } else {
                binding.tvPasswordValue.text = "••••••••"
                binding.tvPasswordHint.text = "Tap to reveal"
            }
        } else {
            binding.tvProtected.text = "🔓 Open Access"
            binding.tvPasswordValue.text = "No password required"
            binding.tvPasswordHint.text = ""
        }
    }

    private fun setupClickListeners() {
        binding.btnToggleStream.setOnClickListener {
            if (viewModel.isStreaming.value == true) {
                stopStreaming()
            } else {
                checkPermissionsAndStart()
            }
        }

        binding.btnRefreshAddresses.setOnClickListener {
            viewModel.refreshLanAddresses()
        }

        binding.tvLanAddresses.setOnClickListener {
            val addressText = binding.tvLanAddresses.text.toString()
            if (addressText.startsWith("http://") && !addressText.contains("detecting")) {
                val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                val clip = ClipData.newPlainText("M4raCast URL", addressText)
                clipboard.setPrimaryClip(clip)
                Toast.makeText(this, "Copied address to clipboard", Toast.LENGTH_SHORT).show()
            }
        }

        binding.layoutPasswordCard.setOnClickListener {
            if (isProtectedConfig) {
                isPasswordRevealed = !isPasswordRevealed
                updatePasswordDisplay()
            }
        }
    }

    private fun checkPermissionsAndStart() {
        AppLogger.i("MainActivity", "User clicked Start Sharing")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
                AppLogger.i("MainActivity", "Requesting POST_NOTIFICATIONS permission")
                notificationPermissionRequest.launch(Manifest.permission.POST_NOTIFICATIONS)
                return
            }
        }
        checkAudioPermissionAndProceed()
    }

    private fun checkAudioPermissionAndProceed() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED) {
            AppLogger.i("MainActivity", "Requesting RECORD_AUDIO permission")
            audioPermissionRequest.launch(Manifest.permission.RECORD_AUDIO)
        } else {
            requestScreenCapture()
        }
    }

    private fun requestScreenCapture() {
        AppLogger.i("MainActivity", "Requesting screen capture intent from system...")
        screenCaptureRequest.launch(projectionManager.createScreenCaptureIntent())
    }

    private fun launchStreamingService(resultCode: Int, data: Intent) {
        AppLogger.i("MainActivity", "Building service intent with resultCode=$resultCode")
        val serviceIntent = Intent(this, StreamingService::class.java).apply {
            action = StreamingService.ACTION_START
            putExtra(StreamingService.EXTRA_RESULT_CODE, resultCode)
            putExtra(StreamingService.EXTRA_DATA, data)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            AppLogger.i("MainActivity", "Calling startForegroundService()...")
            startForegroundService(serviceIntent)
        } else {
            AppLogger.i("MainActivity", "Calling startService()...")
            startService(serviceIntent)
        }
        AppLogger.i("MainActivity", "Binding to service...")
        viewModel.bindToService()
    }

    private fun stopStreaming() {
        viewModel.stopStreamingFromService()
    }

    private fun updateStreamingUI(streaming: Boolean) {
        if (streaming) {
            binding.btnToggleStream.text = "Stop Sharing"
            binding.btnToggleStream.backgroundTintList = ContextCompat.getColorStateList(this, R.color.stop_color)
            binding.tvStatus.text = "● LIVE"
            binding.tvStatus.setTextColor(ContextCompat.getColor(this, R.color.streaming_color))
        } else {
            binding.btnToggleStream.text = "Start Sharing"
            binding.btnToggleStream.backgroundTintList = ContextCompat.getColorStateList(this, R.color.start_color)
            binding.tvStatus.text = "● Idle"
            binding.tvStatus.setTextColor(ContextCompat.getColor(this, R.color.idle_color))
        }
    }

    override fun onCreateOptionsMenu(menu: Menu): Boolean {
        menuInflater.inflate(R.menu.main_menu, menu)
        return true
    }

    override fun onOptionsItemSelected(item: MenuItem): Boolean {
        return when (item.itemId) {
            R.id.action_settings -> {
                startActivity(Intent(this, SettingsActivity::class.java))
                true
            }
            else -> super.onOptionsItemSelected(item)
        }
    }

    override fun onResume() {
        super.onResume()
        viewModel.loadConfiguration()
        viewModel.refreshLanAddresses()
        viewModel.bindToService()
    }

    override fun onDestroy() {
        viewModel.unbindFromService()
        super.onDestroy()
    }
}
