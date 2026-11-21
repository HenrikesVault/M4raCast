package com.m4racast.agent.infrastructure.http

import android.content.Context

/**
 * Serves the bundled web client files from Android assets.
 * Files are located in app/src/main/assets/webclient/
 */
class WebClientAssets(private val context: Context) {

    // The client is bundled inside the APK and changes with every app build.
    // Tell browsers not to reuse a cached copy, otherwise an older player.js can
    // keep running after the app has been updated.
    private val noCacheHeaders = mapOf(
        "Cache-Control" to "no-store, no-cache, must-revalidate",
        "Pragma" to "no-cache",
        "Expires" to "0"
    )

    private val mimeTypes = mapOf(
        "html" to "text/html; charset=utf-8",
        "css" to "text/css; charset=utf-8",
        "js" to "application/javascript; charset=utf-8",
        "json" to "application/json",
        "png" to "image/png",
        "ico" to "image/x-icon",
        "svg" to "image/svg+xml",
        "woff2" to "font/woff2"
    )

    fun serveIndex(): HttpResponse {
        return try {
            val bytes = context.assets.open("webclient/index.html").readBytes()
            HttpResponse.bytes(200, "text/html; charset=utf-8", bytes, noCacheHeaders)
        } catch (e: Exception) {
            HttpResponse.html(200, fallbackIndexHtml())
        }
    }

    fun serveAsset(path: String): HttpResponse {
        val sanitizedPath = path.trimStart('/')
            .removePrefix("assets/")
        val assetPath = "webclient/$sanitizedPath"
        val ext = sanitizedPath.substringAfterLast(".", "")
        val mime = mimeTypes[ext] ?: "application/octet-stream"
        return try {
            val bytes = context.assets.open(assetPath).readBytes()
            HttpResponse.bytes(200, mime, bytes, noCacheHeaders)
        } catch (e: Exception) {
            HttpResponse.notFound()
        }
    }

    private fun fallbackIndexHtml(): String = """
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <title>M4raCast</title>
            <style>
                body { background: #0F1117; color: #FFF; font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
                .box { background: #1A1D27; padding: 32px; border-radius: 12px; text-align: center; max-width: 400px; }
                h1 { color: #4FC3F7; margin-top: 0; }
                p { color: #8899AA; font-size: 14px; line-height: 1.5; }
            </style>
        </head>
        <body>
            <div class="box">
                <h1>M4raCast Agent</h1>
                <p>Agent is running. Web client assets are being bundled or accessible via standalone client.</p>
            </div>
        </body>
        </html>
    """.trimIndent()
}
