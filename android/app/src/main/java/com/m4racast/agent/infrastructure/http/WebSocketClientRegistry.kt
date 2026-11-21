package com.m4racast.agent.infrastructure.http

import android.util.Log
import com.m4racast.agent.domain.agent.AgentConfiguration
import com.m4racast.agent.domain.auth.AuthService
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap

/**
 * Manages all active WebSocket client connections.
 * Distributes video frames to all connected, authenticated clients.
 */
class WebSocketClientRegistry(
    private val authService: AuthService
) {
    companion object {
        private const val TAG = "WsClientRegistry"
    }

    private val clients = ConcurrentHashMap<String, WebSocketHandler>()
    var onClientCountChanged: ((Int) -> Unit)? = null
    /** Invoked immediately after a new, authenticated client is registered. */
    var onNewClient: ((WebSocketHandler) -> Unit)? = null

    fun onNewConnection(handler: WebSocketHandler, request: HttpRequest, config: AgentConfiguration?) {
        // Validate token for protected agents
        if (config?.isProtected == true) {
            val token = request.query["token"]
            if (token == null || !authService.validateToken(token)) {
                handler.sendTextFrame("""{"type":"error","code":"AUTH_REQUIRED","message":"Authentication required"}""")
                handler.close()
                return
            }
        }

        // Check max clients
        val maxClients = config?.maxClients ?: 4
        if (clients.size >= maxClients) {
            handler.sendTextFrame("""{"type":"error","code":"MAX_CLIENTS","message":"Maximum clients reached"}""")
            handler.close()
            return
        }

        clients[handler.id] = handler
        Log.i(TAG, "Client connected: ${handler.id}. Total: ${clients.size}")
        onClientCountChanged?.invoke(clients.size)

        // Notify service so it can resend config + request keyframe for this client
        onNewClient?.invoke(handler)

        handler.onClose = {
            clients.remove(handler.id)
            Log.i(TAG, "Client disconnected: ${handler.id}. Total: ${clients.size}")
            onClientCountChanged?.invoke(clients.size)
        }

        handler.onControlMessage = { message ->
            handleControlMessage(handler, message)
        }

        // Start reading from this client
        handler.startReadLoop()
    }

    fun broadcastVideoFrame(type: Byte, payload: ByteArray) {
        clients.values.forEach { client ->
            if (client.isOpen()) {
                client.sendBinaryFrame(type, payload)
            }
        }
    }

    fun broadcastAudioFrame(payload: ByteArray) {
        clients.values.forEach { client ->
            if (client.isOpen()) {
                client.sendBinaryFrame(WebSocketHandler.TYPE_AUDIO_FRAME, payload)
            }
        }
    }

    fun broadcastControl(json: String) {
        val payload = json.toByteArray(Charsets.UTF_8)
        clients.values.forEach { client ->
            if (client.isOpen()) {
                client.sendBinaryFrame(WebSocketHandler.TYPE_CONTROL, payload)
            }
        }
    }

    fun disconnectAll() {
        clients.values.forEach { it.close() }
        clients.clear()
    }

    fun clientCount(): Int = clients.size

    private fun handleControlMessage(handler: WebSocketHandler, message: String) {
        try {
            val json = JSONObject(message)
            Log.d(TAG, "Control from ${handler.id}: $message")
            // Commands like request_keyframe, set_quality, ping etc.
        } catch (e: Exception) {
            Log.w(TAG, "Invalid control message: $message")
        }
    }
}

