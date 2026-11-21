package com.m4racast.agent.infrastructure.http

import com.m4racast.agent.domain.agent.AgentConfiguration
import com.m4racast.agent.domain.auth.AuthResult
import com.m4racast.agent.domain.auth.AuthService
import com.m4racast.agent.domain.streaming.StreamingSession
import org.json.JSONObject

/**
 * Routes HTTP requests to the appropriate handler.
 * Implements the M4raCast HTTP API v1.
 */
object Router {

    fun route(
        req: HttpRequest,
        config: AgentConfiguration?,
        authService: AuthService,
        session: StreamingSession?,
        webClientAssets: WebClientAssets
    ): HttpResponse {
        // Auth check for protected endpoints
        if (req.requiresAuth() && config?.isProtected == true) {
            val token = req.getHeader("x-m4racast-token") ?: req.query["token"]
            if (token == null || !authService.validateToken(token)) {
                return HttpResponse.unauthorized()
            }
        }

        return when {
            // OPTIONS preflight
            req.method == "OPTIONS" -> HttpResponse.ok("{}")

            // Web client static files
            req.path == "/" || req.path == "/index.html" || req.path.startsWith("/stream") || req.path.startsWith("/connect") ->
                webClientAssets.serveIndex()
            req.path.startsWith("/assets/") ||
            req.path.startsWith("/css/") ||
            req.path.startsWith("/js/") ||
            req.path.endsWith(".ico") ||
            req.path.endsWith(".png") ||
            req.path.endsWith(".svg") ->
                webClientAssets.serveAsset(req.path)

            // M4raCast API & Stream endpoints
            (req.path == "/m4racast/v1/info" || req.path == "/info") && req.method == "GET" ->
                handleInfo(config, session)
            (req.path == "/m4racast/v1/nonce" || req.path == "/nonce") && req.method == "GET" ->
                handleNonce(authService)
            (req.path == "/m4racast/v1/auth" || req.path == "/auth") && req.method == "POST" ->
                handleAuth(req, config, authService)
            (req.path == "/m4racast/v1/stream/info" || req.path == "/stream/info") && req.method == "GET" ->
                handleStreamInfo(session)
            req.path == "/m4racast/v1/stream/connect" || req.path.startsWith("/stream") ->
                // WebSocket upgrade handled before Router; if we reach here via standard HTTP GET, return info or upgrade error
                if (req.method == "GET") handleStreamInfo(session) else HttpResponse.badRequest("WebSocket upgrade required")

            else -> HttpResponse.notFound()
        }
    }

    private fun handleInfo(config: AgentConfiguration?, session: StreamingSession?): HttpResponse {
        val json = JSONObject().apply {
            put("name", config?.deviceName ?: "M4raCast Agent")
            put("version", "1.0")
            put("protected", config?.isProtected ?: false)
            put("streaming", session?.isActive ?: false)
            put("resolution", if (session?.isActive == true) "${session.actualWidth}x${session.actualHeight}" else "unknown")
            put("fps", config?.streamConfig?.fps ?: 30)
        }
        return HttpResponse.ok(json.toString())
    }

    private fun handleNonce(authService: AuthService): HttpResponse {
        val nonce = authService.generateNonce()
        return HttpResponse.ok("""{"nonce":"$nonce"}""")
    }

    private fun handleAuth(req: HttpRequest, config: AgentConfiguration?, authService: AuthService): HttpResponse {
        val body = if (req.body.isNotBlank()) {
            try { JSONObject(req.body) } catch (_: Exception) { JSONObject() }
        } else JSONObject()

        if (config?.isProtected != true) {
            val token = authService.issueTokenWithoutAuth()
            return HttpResponse.ok("""{"token":"${token.value}","expires_in":3600}""")
        }

        val passwordHash = body.optString("password_hash", "")
        val nonce = body.optString("nonce", "")
        return when (val result = authService.authenticate(passwordHash, nonce, config.password)) {
            is AuthResult.Success -> HttpResponse.ok("""{"token":"${result.token.value}","expires_in":3600}""")
            is AuthResult.NotRequired -> {
                val token = authService.issueTokenWithoutAuth()
                HttpResponse.ok("""{"token":"${token.value}","expires_in":3600}""")
            }
            is AuthResult.InvalidPassword -> HttpResponse.unauthorized()
        }
    }

    private fun handleStreamInfo(session: StreamingSession?): HttpResponse {
        if (session == null) return HttpResponse.json(200, """{"streaming":false}""")
        val json = JSONObject().apply {
            put("codec", session.config.codec.mimeType)
            put("width", session.actualWidth)
            put("height", session.actualHeight)
            put("fps", session.actualFps)
            put("bitrate", session.config.bitrateBytes)
            put("streaming", session.isActive)
        }
        return HttpResponse.ok(json.toString())
    }
}
