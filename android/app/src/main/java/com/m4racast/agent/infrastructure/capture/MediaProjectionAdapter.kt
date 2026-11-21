package com.m4racast.agent.infrastructure.capture

import android.content.Context
import android.content.Intent
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.util.DisplayMetrics
import android.util.Log
import android.view.Surface
import android.view.WindowManager
import com.m4racast.agent.infrastructure.AppLogger

/**
 * Wraps Android MediaProjection API.
 * Manages VirtualDisplay lifecycle tied to an encoding Surface.
 */
class MediaProjectionAdapter(private val context: Context) {

    companion object {
        private const val TAG = "MediaProjectionAdapter"
        private const val VIRTUAL_DISPLAY_NAME = "M4raCast"
    }

    private var mediaProjection: MediaProjection? = null
    private var virtualDisplay: VirtualDisplay? = null

    val currentProjection: MediaProjection? get() = mediaProjection

    /**
     * Creates a MediaProjection from the granted permission intent.
     * Must be called with the result of MediaProjectionManager.createScreenCaptureIntent().
     */
    fun createProjection(resultCode: Int, data: Intent): MediaProjection {
        AppLogger.i(TAG, "Requesting MediaProjection from manager (resultCode=$resultCode)...")
        val manager = context.getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        return manager.getMediaProjection(resultCode, data).also {
            mediaProjection = it
            AppLogger.i(TAG, "MediaProjection successfully acquired: $it")
        }
    }

    /**
     * Creates a VirtualDisplay that feeds into the given encoderSurface.
     * @param width target capture width in pixels
     * @param height target capture height in pixels
     * @param dpi screen DPI (use real screen DPI for best quality)
     * @param encoderSurface the Surface from MediaCodec input
     */
    fun createVirtualDisplay(width: Int, height: Int, dpi: Int, encoderSurface: Surface): VirtualDisplay {
        val projection = mediaProjection ?: throw IllegalStateException("MediaProjection not created")
        AppLogger.i(TAG, "Calling projection.createVirtualDisplay(${width}x${height}, ${dpi}dpi)...")
        virtualDisplay = projection.createVirtualDisplay(
            VIRTUAL_DISPLAY_NAME,
            width, height, dpi,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            encoderSurface,
            null, null
        )
        AppLogger.i(TAG, "VirtualDisplay active: $virtualDisplay")
        return virtualDisplay!!
    }

    /**
     * Updates an existing VirtualDisplay with new dimensions and surface (e.g. on orientation flip).
     */
    fun resizeVirtualDisplay(width: Int, height: Int, dpi: Int, newSurface: Surface) {
        val vd = virtualDisplay
        if (vd != null) {
            AppLogger.i(TAG, "Updating VirtualDisplay to ${width}x${height} (${dpi}dpi)...")
            vd.setSurface(newSurface)
            vd.resize(width, height, dpi)
        } else {
            createVirtualDisplay(width, height, dpi, newSurface)
        }
    }

    /**
     * Returns the real screen dimensions and DPI.
     */
    fun getScreenMetrics(): Triple<Int, Int, Int> {
        return try {
            val windowManager = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
            val metrics = DisplayMetrics()
            @Suppress("DEPRECATION")
            windowManager.defaultDisplay.getRealMetrics(metrics)
            val w = if (metrics.widthPixels > 0) metrics.widthPixels else context.resources.displayMetrics.widthPixels
            val h = if (metrics.heightPixels > 0) metrics.heightPixels else context.resources.displayMetrics.heightPixels
            val dpi = if (metrics.densityDpi > 0) metrics.densityDpi else context.resources.displayMetrics.densityDpi
            Triple(w, h, dpi)
        } catch (e: Exception) {
            val dm = context.resources.displayMetrics
            Triple(dm.widthPixels, dm.heightPixels, dm.densityDpi)
        }
    }

    fun stopCapture() {
        virtualDisplay?.release()
        virtualDisplay = null
        mediaProjection?.stop()
        mediaProjection = null
        Log.i(TAG, "MediaProjection stopped")
    }

    fun registerCallback(callback: MediaProjection.Callback) {
        mediaProjection?.registerCallback(callback, null)
    }
}
