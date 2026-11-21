package com.m4racast.agent.infrastructure.http

import java.io.InputStream

/**
 * Minimal HTTP/1.1 request parser (GET, POST).
 *
 * IMPORTANT: [parse] requires a [BufferedInputStream] so that any bytes buffered
 * beyond the HTTP headers remain available for the caller (e.g. WebSocket frames).
 * The caller must reuse the same [BufferedInputStream] for all subsequent I/O on
 * the socket.
 */
data class HttpRequest(
    val method: String,
    val path: String,
    val query: Map<String, String>,
    val headers: Map<String, String>,
    val body: String
) {
    fun isWebSocketUpgrade(): Boolean =
        headers["upgrade"]?.lowercase() == "websocket"

    fun getHeader(name: String): String? = headers[name.lowercase()]

    fun requiresAuth(): Boolean = path.startsWith("/m4racast/v1/") &&
            path != "/m4racast/v1/info" &&
            path != "/m4racast/v1/nonce" &&
            path != "/m4racast/v1/auth"

    companion object {
        /**
         * Parse an HTTP request from [input].
         *
         * The caller MUST supply a [BufferedInputStream] so that any bytes read
         * ahead (beyond the HTTP headers / body) stay available in the same
         * stream for subsequent consumers (e.g. the WebSocket frame reader).
         */
        fun parse(input: InputStream): HttpRequest? {
            val requestLine = readLine(input)?.trim() ?: return null
            val parts = requestLine.split(" ")
            if (parts.size < 2) return null

            val method = parts[0].uppercase()
            val rawPath = parts.getOrElse(1) { "/" }
            val (path, queryString) = if ("?" in rawPath) {
                val idx = rawPath.indexOf("?")
                rawPath.substring(0, idx) to rawPath.substring(idx + 1)
            } else rawPath to ""

            val query = parseQuery(queryString)
            val headers = mutableMapOf<String, String>()
            var line = readLine(input)
            while (line != null && line.isNotBlank()) {
                val colonIdx = line.indexOf(":")
                if (colonIdx > 0) {
                    val key = line.substring(0, colonIdx).trim().lowercase()
                    val value = line.substring(colonIdx + 1).trim()
                    headers[key] = value
                }
                line = readLine(input)
            }

            val contentLength = headers["content-length"]?.toIntOrNull() ?: 0
            val body = if (contentLength > 0) {
                val buf = ByteArray(contentLength)
                var off = 0
                while (off < contentLength) {
                    val r = input.read(buf, off, contentLength - off)
                    if (r < 0) break
                    off += r
                }
                String(buf, 0, off, Charsets.ISO_8859_1)
            } else ""

            return HttpRequest(method, path, query, headers, body)
        }

        /**
         * Read a single line (terminated by `\n` or `\r\n`) directly from the
         * stream without buffering ahead.  Returns null on EOF.
         */
        private fun readLine(input: InputStream): String? {
            val sb = StringBuilder()
            while (true) {
                val b = input.read()
                if (b < 0) return if (sb.isEmpty()) null else sb.toString()
                val c = b.toChar()
                if (c == '\n') return sb.toString()
                if (c != '\r') sb.append(c)
            }
        }

        private fun parseQuery(query: String): Map<String, String> {
            if (query.isBlank()) return emptyMap()
            return query.split("&").mapNotNull { pair ->
                val idx = pair.indexOf("=")
                if (idx < 0) null
                else pair.substring(0, idx) to pair.substring(idx + 1)
            }.toMap()
        }
    }
}
