package com.m4racast.agent.infrastructure.http

import android.util.Base64
import android.util.Log
import com.m4racast.agent.domain.auth.AuthService
import java.io.InputStream
import java.io.OutputStream
import java.net.Socket
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicBoolean

/**
 * WebSocket handler: performs handshake and provides send/receive APIs.
 * Implements RFC 6455 framing (server side — unmask on receive, server to client unmasked).
 */
class WebSocketHandler(
    private val socket: Socket,
    private val input: InputStream,
    private val output: OutputStream,
    private val wsKey: String,
    private val authService: AuthService,
    private val registry: WebSocketClientRegistry?
) {
    companion object {
        private const val TAG = "WebSocketHandler"
        private const val WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

        // M4raCast frame type bytes
        const val TYPE_VIDEO_FRAME: Byte = 0x01
        const val TYPE_CONFIG: Byte = 0x02
        const val TYPE_CONTROL: Byte = 0x03
        const val TYPE_STATS: Byte = 0x04
        const val TYPE_PING: Byte = 0x05
        const val TYPE_PONG: Byte = 0x06
        const val TYPE_AUDIO_FRAME: Byte = 0x07
    }

    val id: String = java.util.UUID.randomUUID().toString()
    private val open = AtomicBoolean(false)
    var onClose: (() -> Unit)? = null
    var onControlMessage: ((String) -> Unit)? = null

    fun handshake() {
        val acceptKey = computeAcceptKey(wsKey)
        val response = "HTTP/1.1 101 Switching Protocols\r\n" +
                "Upgrade: websocket\r\n" +
                "Connection: Upgrade\r\n" +
                "Sec-WebSocket-Accept: $acceptKey\r\n\r\n"
        output.write(response.toByteArray(Charsets.ISO_8859_1))
        output.flush()
        open.set(true)
        Log.i(TAG, "WebSocket handshake complete for $id")
    }

    /**
     * Send a binary M4raCast frame: [typebyte][payload]
     * Optimized to perform a single memory allocation and a single socket write.
     */
    @Synchronized
    fun sendBinaryFrame(type: Byte, payload: ByteArray) {
        if (!open.get()) return
        try {
            val payloadLen = payload.size + 1
            val headerSize = when {
                payloadLen <= 125 -> 2
                payloadLen <= 65535 -> 4
                else -> 10
            }
            val packet = ByteArray(headerSize + payloadLen)
            packet[0] = (0x80 or 0x02).toByte() // FIN + binary opcode (0x02)

            when (headerSize) {
                2 -> {
                    packet[1] = payloadLen.toByte()
                }
                4 -> {
                    packet[1] = 126.toByte()
                    packet[2] = ((payloadLen shr 8) and 0xFF).toByte()
                    packet[3] = (payloadLen and 0xFF).toByte()
                }
                10 -> {
                    packet[1] = 127.toByte()
                    val l = payloadLen.toLong()
                    for (i in 0 until 8) {
                        packet[2 + i] = ((l shr ((7 - i) * 8)) and 0xFF).toByte()
                    }
                }
            }

            packet[headerSize] = type
            if (payload.isNotEmpty()) {
                System.arraycopy(payload, 0, packet, headerSize + 1, payload.size)
            }

            output.write(packet)
            output.flush()
        } catch (e: Exception) {
            Log.e(TAG, "Send error: ${e.message}")
            close()
        }
    }

    @Synchronized
    fun sendTextFrame(text: String) {
        if (!open.get()) return
        try {
            writeWsFrame(text.toByteArray(Charsets.UTF_8), binary = false)
        } catch (e: Exception) {
            Log.e(TAG, "Send text error: ${e.message}")
            close()
        }
    }

    fun startReadLoop() {
        Thread {
            try {
                while (open.get()) {
                    val frame = readWsFrame() ?: break
                    handleFrame(frame)
                }
            } catch (e: Exception) {
                if (open.get()) Log.e(TAG, "Read error: ${e.message}")
            } finally {
                close()
            }
        }.also {
            it.name = "M4raCast-WS-$id"
            it.isDaemon = true
            it.start()
        }
    }

    private fun handleFrame(frame: WsFrame) {
        when (frame.opcode) {
            0x1 -> { // text
                val text = String(frame.payload, Charsets.UTF_8)
                onControlMessage?.invoke(text)
            }
            0x2 -> { // binary — M4raCast client frame
                if (frame.payload.isNotEmpty()) {
                    val type = frame.payload[0]
                    if (type == TYPE_PING) {
                        sendBinaryFrame(TYPE_PONG, byteArrayOf())
                    } else if (type == TYPE_CONTROL && frame.payload.size > 1) {
                        val text = String(frame.payload, 1, frame.payload.size - 1, Charsets.UTF_8)
                        onControlMessage?.invoke(text)
                    }
                }
            }
            0x8 -> close() // close
            0x9 -> { // ping — reply pong
                writeWsFrame(frame.payload, opcode = 0xA)
            }
        }
    }

    fun isOpen() = open.get()

    fun close() {
        if (open.compareAndSet(true, false)) {
            try {
                // Send WebSocket close frame
                writeWsFrame(byteArrayOf(), opcode = 0x8)
            } catch (_: Exception) {}
            try { socket.close() } catch (_: Exception) {}
            onClose?.invoke()
            Log.i(TAG, "WebSocket $id closed")
        }
    }

    private data class WsFrame(val opcode: Int, val payload: ByteArray)

    private fun readWsFrame(): WsFrame? {
        val b1 = input.read()
        if (b1 < 0) return null
        val b2 = input.read()
        if (b2 < 0) return null

        val opcode = b1 and 0x0F
        val masked = (b2 and 0x80) != 0
        var payloadLen = (b2 and 0x7F).toLong()

        payloadLen = when (payloadLen.toInt()) {
            126 -> {
                val byte1 = input.read()
                val byte2 = input.read()
                if (byte1 < 0 || byte2 < 0) return null
                ((byte1 shl 8) or byte2).toLong()
            }
            127 -> {
                var len = 0L
                for (i in 0 until 8) {
                    val b = input.read()
                    if (b < 0) return null
                    len = (len shl 8) or (b.toLong() and 0xFF)
                }
                len
            }
            else -> payloadLen
        }

        if (payloadLen < 0 || payloadLen > 16 * 1024 * 1024) {
            // Guard against unreasonably large frames
            return null
        }

        val mask = if (masked) {
            val maskBytes = ByteArray(4)
            var readMask = 0
            while (readMask < 4) {
                val r = input.read(maskBytes, readMask, 4 - readMask)
                if (r < 0) return null
                readMask += r
            }
            maskBytes
        } else null

        val payload = ByteArray(payloadLen.toInt())
        var offset = 0
        while (offset < payload.size) {
            val read = input.read(payload, offset, payload.size - offset)
            if (read < 0) return null
            offset += read
        }
        if (mask != null) {
            for (i in payload.indices) {
                payload[i] = (payload[i].toInt() xor mask[i % 4].toInt()).toByte()
            }
        }
        return WsFrame(opcode, payload)
    }

    private fun writeWsFrame(data: ByteArray, binary: Boolean = true, opcode: Int = -1) {
        val op = if (opcode >= 0) opcode else if (binary) 0x2 else 0x1
        val len = data.size
        val header = when {
            len <= 125 -> byteArrayOf((0x80 or op).toByte(), len.toByte())
            len <= 65535 -> byteArrayOf(
                (0x80 or op).toByte(),
                126.toByte(),
                ((len shr 8) and 0xFF).toByte(),
                (len and 0xFF).toByte()
            )
            else -> {
                val h = ByteArray(10)
                h[0] = (0x80 or op).toByte()
                h[1] = 127.toByte()
                val l = len.toLong()
                for (i in 0 until 8) {
                    h[2 + i] = ((l shr ((7 - i) * 8)) and 0xFF).toByte()
                }
                h
            }
        }
        output.write(header)
        if (data.isNotEmpty()) {
            output.write(data)
        }
        output.flush()
    }

    private fun computeAcceptKey(key: String): String {
        val combined = key.trim() + WS_GUID
        val sha1 = MessageDigest.getInstance("SHA-1").digest(combined.toByteArray(Charsets.ISO_8859_1))
        return Base64.encodeToString(sha1, Base64.NO_WRAP)
    }
}

