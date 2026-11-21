package com.m4racast.agent.infrastructure.http

import android.util.Log
import com.m4racast.agent.domain.agent.AgentConfiguration
import com.m4racast.agent.domain.auth.AuthResult
import com.m4racast.agent.domain.auth.AuthService
import com.m4racast.agent.domain.streaming.StreamingSession
import com.m4racast.agent.infrastructure.AppLogger
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStream
import java.io.InputStreamReader
import java.io.OutputStream
import java.net.ServerSocket
import java.net.Socket
import java.net.InetAddress
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Lightweight embedded HTTP/1.1 + WebSocket server.
 * Handles all M4raCast HTTP API endpoints and WebSocket upgrades.
 * Uses a cached thread pool for concurrent client handling.
 */
class M4raCastHttpServer(
    private val authService: AuthService,
    private val webClientAssets: WebClientAssets
) {

    companion object {
        private const val TAG = "M4raCastHttpServer"
        const val DEFAULT_PORT = 0
    }

    private var serverSocket: ServerSocket? = null
    private val executor = Executors.newCachedThreadPool()
    private val running = AtomicBoolean(false)

    var actualPort: Int = 0
        private set

    var configuration: AgentConfiguration? = null
    var streamingSession: StreamingSession? = null

    // WebSocket client registry — set by streaming infrastructure
    var wsClientRegistry: WebSocketClientRegistry? = null

    /**
     * Start listening. Binds to the configured address and port.
     * @return The actual bound port.
     */
    fun start(bindAddress: String = "0.0.0.0", port: Int = DEFAULT_PORT): Int {
        if (running.get()) return actualPort
        AppLogger.i(TAG, "Binding server socket on $bindAddress:$port...")
        val addr = if (bindAddress == "0.0.0.0") null else InetAddress.getByName(bindAddress)
        serverSocket = ServerSocket(port, 50, addr)
        actualPort = serverSocket!!.localPort
        running.set(true)
        AppLogger.i(TAG, "HTTP Server listening on port $actualPort")
        executor.submit { acceptLoop() }
        return actualPort
    }

    fun stop() {
        running.set(false)
        serverSocket?.close()
        serverSocket = null
        Log.i(TAG, "HTTP server stopped")
    }

    private fun acceptLoop() {
        while (running.get()) {
            try {
                val socket = serverSocket?.accept() ?: break
                executor.submit { handleConnection(socket) }
            } catch (e: Exception) {
                if (running.get()) Log.e(TAG, "Accept error: ${e.message}")
            }
        }
    }

    private fun handleConnection(socket: Socket) {
        var isWebSocket = false
        try {
            socket.soTimeout = 30_000
            val input = socket.getInputStream().buffered()
            val output = socket.getOutputStream()
            val request = HttpRequest.parse(input) ?: run {
                socket.close()
                return
            }

            Log.d(TAG, "${request.method} ${request.path}")

            // WebSocket upgrade — hand off ownership to the handler; never close here
            if (request.isWebSocketUpgrade()) {
                isWebSocket = true
                // Remove the HTTP read timeout — WebSocket connections are long-lived
                socket.soTimeout = 0
                // Disable Nagle's algorithm for instant low-latency frame transmission
                socket.tcpNoDelay = true
                socket.sendBufferSize = 512 * 1024
                socket.receiveBufferSize = 256 * 1024

                val wsKey = request.headers["sec-websocket-key"] ?: ""
                val wsHandler = WebSocketHandler(socket, input, output, wsKey, authService, wsClientRegistry)
                wsHandler.handshake()
                wsClientRegistry?.onNewConnection(wsHandler, request, configuration)
                return
            }

            val response = Router.route(request, configuration, authService, streamingSession, webClientAssets)
            response.writeTo(output)
        } catch (e: Exception) {
            Log.e(TAG, "Connection error: ${e.message}")
        } finally {
            // WebSocket sockets are owned by their WebSocketHandler; never close them here.
            if (!isWebSocket && !socket.isClosed) {
                try { socket.close() } catch (_: Exception) {}
            }
        }
    }
}
