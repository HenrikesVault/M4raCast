package com.m4racast.agent.infrastructure.http

import java.io.OutputStream

/**
 * Lightweight HTTP response builder.
 */
data class HttpResponse(
    val statusCode: Int,
    val statusText: String,
    val contentType: String,
    val body: ByteArray,
    val extraHeaders: Map<String, String> = emptyMap()
) {
    fun writeTo(output: OutputStream) {
        val sb = StringBuilder()
        sb.append("HTTP/1.1 $statusCode $statusText\r\n")
        sb.append("Content-Type: $contentType\r\n")
        sb.append("Content-Length: ${body.size}\r\n")
        sb.append("Access-Control-Allow-Origin: *\r\n")
        sb.append("Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n")
        sb.append("Access-Control-Allow-Headers: X-M4raCast-Token, Content-Type\r\n")
        sb.append("Connection: close\r\n")
        extraHeaders.forEach { (k, v) -> sb.append("$k: $v\r\n") }
        sb.append("\r\n")
        output.write(sb.toString().toByteArray(Charsets.ISO_8859_1))
        output.write(body)
        output.flush()
    }

    companion object {
        fun json(statusCode: Int, json: String, statusText: String = statusText(statusCode)): HttpResponse =
            HttpResponse(statusCode, statusText, "application/json; charset=utf-8", json.toByteArray(Charsets.UTF_8))

        fun html(statusCode: Int, html: String): HttpResponse =
            HttpResponse(statusCode, statusText(statusCode), "text/html; charset=utf-8", html.toByteArray(Charsets.UTF_8))

        fun bytes(
            statusCode: Int,
            contentType: String,
            data: ByteArray,
            extraHeaders: Map<String, String> = emptyMap()
        ): HttpResponse =
            HttpResponse(statusCode, statusText(statusCode), contentType, data, extraHeaders)

        fun notFound(): HttpResponse = json(404, """{"error":"Not Found"}""")
        fun unauthorized(): HttpResponse = json(401, """{"error":"Unauthorized"}""")
        fun badRequest(msg: String = "Bad Request"): HttpResponse = json(400, """{"error":"$msg"}""")
        fun ok(json: String): HttpResponse = json(200, json)

        private fun statusText(code: Int) = when(code) {
            200 -> "OK"; 400 -> "Bad Request"; 401 -> "Unauthorized"
            403 -> "Forbidden"; 404 -> "Not Found"; 500 -> "Internal Server Error"
            101 -> "Switching Protocols"
            else -> "Unknown"
        }
    }
}
