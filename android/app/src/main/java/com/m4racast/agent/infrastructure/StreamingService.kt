package com.m4racast.agent.infrastructure

import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.hardware.display.DisplayManager
import android.media.projection.MediaProjection
import android.os.Binder
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import android.view.Display
import android.view.Surface
import android.view.WindowManager
import android.widget.Toast
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import com.m4racast.agent.R
import com.m4racast.agent.domain.agent.AgentConfiguration
import com.m4racast.agent.domain.auth.AuthService
import com.m4racast.agent.domain.discovery.DiscoveryPacket
import com.m4racast.agent.domain.streaming.StreamingSession
import com.m4racast.agent.infrastructure.capture.AudioCaptureAdapter
import com.m4racast.agent.infrastructure.capture.MediaProjectionAdapter
import com.m4racast.agent.infrastructure.encoding.MediaCodecAdapter
import com.m4racast.agent.infrastructure.http.M4raCastHttpServer
import com.m4racast.agent.infrastructure.http.WebClientAssets
import com.m4racast.agent.infrastructure.http.WebSocketClientRegistry
import com.m4racast.agent.infrastructure.http.WebSocketHandler
import com.m4racast.agent.infrastructure.network.NetworkDiscovery
import com.m4racast.agent.infrastructure.storage.ConfigurationRepository
import com.m4racast.agent.presentation.main.MainActivity

import java.util.concurrent.Executors

/**
 * Android Foreground Service that owns the streaming pipeline lifecycle.
 * Coordinates: HTTP server, WebSocket clients, MediaProjection, MediaCodec, Discovery.
 */
class StreamingService : Service() {

    companion object {
        private const val TAG = "StreamingService"
        private const val NOTIFICATION_ID = 1001
        private const val CHANNEL_ID = "m4racast_streaming"

        const val ACTION_START = "com.m4racast.agent.START_STREAMING"
        const val ACTION_STOP = "com.m4racast.agent.STOP_STREAMING"
        const val EXTRA_RESULT_CODE = "result_code"
        const val EXTRA_DATA = "data"
    }

    inner class LocalBinder : Binder() {
        fun getService(): StreamingService = this@StreamingService
    }

    private val binder = LocalBinder()

    // Infrastructure components
    private lateinit var configRepo: ConfigurationRepository
    private lateinit var authService: AuthService
    private lateinit var httpServer: M4raCastHttpServer
    private lateinit var wsRegistry: WebSocketClientRegistry
    private lateinit var discovery: NetworkDiscovery
    private lateinit var projectionAdapter: MediaProjectionAdapter
    private lateinit var encoderAdapter: MediaCodecAdapter
    private lateinit var audioAdapter: AudioCaptureAdapter

    // State
    private var configuration: AgentConfiguration? = null
    private var streamingSession: StreamingSession? = null
    private var actualPort: Int = 0
    private var displayListener: DisplayManager.DisplayListener? = null
    private var lastCaptureW = 0
    private var lastCaptureH = 0
    private var lastRotation = -1

    private val serviceExecutor = Executors.newSingleThreadExecutor { r ->
        Thread(r, "M4raCast-ServiceWorker").also { it.isDaemon = true }
    }

    val isStreaming: Boolean get() = streamingSession?.isActive ?: false
    val currentPort: Int get() = actualPort
    val clientCount: Int get() = wsRegistry.clientCount()

    // Callbacks to UI
    var onStatusChanged: ((isStreaming: Boolean, port: Int, clientCount: Int) -> Unit)? = null
    var onError: ((String) -> Unit)? = null

    override fun onCreate() {
        super.onCreate()
        AppLogger.i(TAG, "StreamingService onCreate()")
        ensureForeground()

        configRepo = ConfigurationRepository(this)
        authService = AuthService()
        wsRegistry = WebSocketClientRegistry(authService)
        httpServer = M4raCastHttpServer(authService, WebClientAssets(this))
        discovery = NetworkDiscovery()
        projectionAdapter = MediaProjectionAdapter(this)
        encoderAdapter = MediaCodecAdapter()
        audioAdapter = AudioCaptureAdapter(this)

        audioAdapter.onAudioData = { pcmBytes ->
            wsRegistry.broadcastAudioFrame(pcmBytes)
        }

        httpServer.wsClientRegistry = wsRegistry
        wsRegistry.onClientCountChanged = { count ->
            val port = actualPort
            val streaming = streamingSession?.isActive ?: false
            Handler(Looper.getMainLooper()).post {
                onStatusChanged?.invoke(streaming, port, count)
            }
        }

        // On each new WebSocket client: resend cached SPS/PPS config then force a keyframe
        // so the client's WebCodecs decoder can start immediately.
        wsRegistry.onNewClient = { handler ->
            val config = encoderAdapter.lastConfigData
            if (config != null) {
                AppLogger.i(TAG, "Resending config (${config.size} B) to new client ${handler.id}")
                handler.sendBinaryFrame(WebSocketHandler.TYPE_CONFIG, config)
            }
            encoderAdapter.requestKeyframe()
            AppLogger.i(TAG, "Keyframe requested for new client ${handler.id}")
        }
    }

    private fun ensureForeground() {
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
        } else {
            0
        }
        ServiceCompat.startForeground(this, NOTIFICATION_ID, buildNotification("M4raCast service running"), type)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        AppLogger.i(TAG, "onStartCommand: action=${intent?.action}")
        ensureForeground()

        when (intent?.action) {
            ACTION_START -> {
                val resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, Activity.RESULT_CANCELED)
                val data = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    intent.getParcelableExtra(EXTRA_DATA, Intent::class.java)
                } else {
                    @Suppress("DEPRECATION")
                    intent.getParcelableExtra(EXTRA_DATA)
                }

                AppLogger.i(TAG, "ACTION_START received: resultCode=$resultCode (RESULT_OK=${Activity.RESULT_OK}), data=${if (data != null) "PRESENT" else "NULL"}")

                if (resultCode == Activity.RESULT_OK && data != null) {
                    AppLogger.i(TAG, "Starting streaming worker thread...")
                    serviceExecutor.submit {
                        startStreaming(resultCode, data)
                    }
                } else {
                    AppLogger.e(TAG, "Cannot start streaming: resultCode was not RESULT_OK ($resultCode) or data was null ($data)")
                }
            }
            ACTION_STOP -> {
                AppLogger.i(TAG, "ACTION_STOP received")
                serviceExecutor.submit {
                    stopStreaming()
                }
            }
        }
        return START_NOT_STICKY
    }

    override fun onBind(intent: Intent): IBinder {
        AppLogger.i(TAG, "onBind called")
        return binder
    }

    private fun startStreaming(resultCode: Int, data: Intent) {
        try {
            AppLogger.i(TAG, "[1/6] Loading configuration...")
            configuration = configRepo.load()
            val config = configuration!!

            AppLogger.i(TAG, "[2/6] Starting HTTP server on ${config.bindAddress}:${config.port}...")
            actualPort = httpServer.start(config.bindAddress, config.port)
            httpServer.configuration = config
            AppLogger.i(TAG, "HTTP server listening on port $actualPort")

            encoderAdapter.onOutputData = { type, payload ->
                wsRegistry.broadcastVideoFrame(type, payload)
            }
            encoderAdapter.onFormatChanged = { configData ->
                wsRegistry.broadcastVideoFrame(WebSocketHandler.TYPE_CONFIG, configData)
            }
            encoderAdapter.onError = { e ->
                AppLogger.e(TAG, "Encoder error event", e)
                onError?.invoke("Encoder error: ${e.message}")
            }

            AppLogger.i(TAG, "[3/6] Initializing MediaProjection...")
            val projection = projectionAdapter.createProjection(resultCode, data)
            val mainHandler = Handler(Looper.getMainLooper())
            projection.registerCallback(object : MediaProjection.Callback() {
                override fun onStop() {
                    AppLogger.w(TAG, "MediaProjection stopped externally by system")
                    stopStreaming()
                }
            }, mainHandler)

            AppLogger.i(TAG, "[4/6] Computing display & capture dimensions...")
            val streamConfig = config.streamConfig
            val (screenW, screenH, screenDpi) = projectionAdapter.getScreenMetrics()
            val (captureW, captureH) = computeCaptureDimensions(screenW, screenH)
            lastCaptureW = captureW
            lastCaptureH = captureH
            lastRotation = getDisplayRotation()
            AppLogger.i(TAG, "Screen: ${screenW}x${screenH} @ ${screenDpi}dpi -> Capture: ${captureW}x${captureH} (native aspect ratio)")

            AppLogger.i(TAG, "[5/6] Starting MediaCodec H.264 encoder...")
            val encoderSurface = encoderAdapter.start(streamConfig, captureW, captureH)

            AppLogger.i(TAG, "[6/6] Creating VirtualDisplay...")
            projectionAdapter.createVirtualDisplay(captureW, captureH, screenDpi, encoderSurface)

            // Start audio capture (system audio with mic fallback)
            audioAdapter.start(projection)

            // Register display listener for orientation changes
            registerDisplayListener()

            val session = StreamingSession(streamConfig)
            session.markStarting()
            session.markActive(captureW, captureH)
            streamingSession = session
            httpServer.streamingSession = session

            val discoveryPacket = DiscoveryPacket(
                name = config.deviceName,
                port = actualPort,
                protected = config.isProtected
            )
            discovery.startBroadcasting(discoveryPacket)

            Handler(Looper.getMainLooper()).post {
                updateNotification("Streaming on port $actualPort")
                onStatusChanged?.invoke(true, actualPort, wsRegistry.clientCount())
            }
            AppLogger.i(TAG, "=== STREAMING ACTIVE === Port: $actualPort")

        } catch (e: Exception) {
            AppLogger.e(TAG, "CRITICAL ERROR in startStreaming", e)
            val errorMsg = "Streaming error: ${e.javaClass.simpleName}: ${e.message}"
            Handler(Looper.getMainLooper()).post {
                Toast.makeText(applicationContext, errorMsg, Toast.LENGTH_LONG).show()
                onError?.invoke(errorMsg)
            }
            stopStreaming()
        }
    }

    fun stopStreaming() {
        unregisterDisplayListener()
        audioAdapter.stop()
        streamingSession?.markStopping()
        discovery.stopBroadcasting()
        wsRegistry.broadcastControl("""{"type":"stream_stop","reason":"user_stopped"}""")
        wsRegistry.disconnectAll()
        encoderAdapter.stop()
        projectionAdapter.stopCapture()
        httpServer.stop()
        streamingSession?.markStopped()
        streamingSession = null
        httpServer.streamingSession = null
        authService.revokeAll()

        Handler(Looper.getMainLooper()).post {
            onStatusChanged?.invoke(false, 0, 0)
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
        }
        Log.i(TAG, "Streaming stopped")
    }

    private fun registerDisplayListener() {
        try {
            val displayManager = getSystemService(Context.DISPLAY_SERVICE) as DisplayManager
            val listener = object : DisplayManager.DisplayListener {
                override fun onDisplayAdded(displayId: Int) {}
                override fun onDisplayRemoved(displayId: Int) {}
                override fun onDisplayChanged(displayId: Int) {
                    if (displayId == Display.DEFAULT_DISPLAY) {
                        handleDisplayChanged()
                    }
                }
            }
            displayListener = listener
            displayManager.registerDisplayListener(listener, Handler(Looper.getMainLooper()))
            AppLogger.i(TAG, "Display orientation listener registered")
        } catch (e: Exception) {
            AppLogger.w(TAG, "Failed to register display listener: ${e.message}")
        }
    }

    private fun unregisterDisplayListener() {
        displayListener?.let {
            try {
                val dm = getSystemService(Context.DISPLAY_SERVICE) as DisplayManager
                dm.unregisterDisplayListener(it)
            } catch (_: Exception) {}
            displayListener = null
        }
    }

    private fun handleDisplayChanged() {
        if (!isStreaming) return
        val (screenW, screenH, screenDpi) = projectionAdapter.getScreenMetrics()
        val (newW, newH) = computeCaptureDimensions(screenW, screenH)
        val rotation = getDisplayRotation()

        if (newW == lastCaptureW && newH == lastCaptureH && rotation == lastRotation) {
            return
        }

        AppLogger.i(TAG, "Screen orientation flip detected: ${screenW}x${screenH} -> capture ${newW}x${newH}, rot=$rotation°")
        lastCaptureW = newW
        lastCaptureH = newH
        lastRotation = rotation

        val config = configuration ?: return
        serviceExecutor.submit {
            try {
                encoderAdapter.stop()
                val newSurface = encoderAdapter.start(config.streamConfig, newW, newH)
                projectionAdapter.resizeVirtualDisplay(newW, newH, screenDpi, newSurface)
                encoderAdapter.requestKeyframe()

                streamingSession?.let {
                    it.markActive(newW, newH)
                }

                val json = """{"type":"orientation_change","rotation":$rotation,"width":$newW,"height":$newH}"""
                wsRegistry.broadcastControl(json)
                AppLogger.i(TAG, "Stream successfully flipped to ${newW}x${newH}")
            } catch (e: Exception) {
                AppLogger.e(TAG, "Error flipping stream on display change", e)
            }
        }
    }

    private fun getDisplayRotation(): Int {
        return try {
            val windowManager = getSystemService(Context.WINDOW_SERVICE) as WindowManager
            when (@Suppress("DEPRECATION") windowManager.defaultDisplay.rotation) {
                Surface.ROTATION_0 -> 0
                Surface.ROTATION_90 -> 90
                Surface.ROTATION_180 -> 180
                Surface.ROTATION_270 -> 270
                else -> 0
            }
        } catch (_: Exception) {
            0
        }
    }

    /**
     * Compute capture dimensions strictly preserving native screen aspect ratio.
     * Dimensions are always even multiples of 2 to guarantee MediaCodec compliance
     * and avoid any IllegalArgumentException.
     */
    private fun computeCaptureDimensions(screenW: Int, screenH: Int): Pair<Int, Int> {
        val safeScreenW = if (screenW > 0) screenW else 1080
        val safeScreenH = if (screenH > 0) screenH else 1920

        fun makeEven(v: Int): Int = (v / 2) * 2

        // Preserve screen's exact native aspect ratio!
        // Cap max dimension to 1920 to stay well within hardware H.264 encoder profile limits
        val maxDim = maxOf(safeScreenW, safeScreenH)
        val scale = if (maxDim > 1920) 1920f / maxDim else 1.0f

        val w = makeEven((safeScreenW * scale).toInt().coerceAtLeast(16))
        val h = makeEven((safeScreenH * scale).toInt().coerceAtLeast(16))
        return Pair(w, h)
    }

    private fun buildNotification(text: String): Notification {
        createNotificationChannel()
        val intent = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("M4raCast")
            .setContentText(text)
            .setSmallIcon(R.drawable.ic_cast)
            .setContentIntent(intent)
            .setOngoing(true)
            .build()
    }

    private fun updateNotification(text: String) {
        val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(NOTIFICATION_ID, buildNotification(text))
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(CHANNEL_ID, "M4raCast Streaming", NotificationManager.IMPORTANCE_LOW)
            channel.description = "Active screen sharing"
            (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).createNotificationChannel(channel)
        }
    }

    override fun onDestroy() {
        stopStreaming()
        super.onDestroy()
    }
}
