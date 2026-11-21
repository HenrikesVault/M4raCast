package com.m4racast.agent.infrastructure.storage

import android.content.Context
import android.content.SharedPreferences
import com.m4racast.agent.domain.agent.AgentConfiguration
import com.m4racast.agent.domain.streaming.AspectRatio
import com.m4racast.agent.domain.streaming.Resolution
import com.m4racast.agent.domain.streaming.StreamConfiguration
import com.m4racast.agent.domain.streaming.VideoCodec

/**
 * Persists and retrieves agent configuration using SharedPreferences.
 */
class ConfigurationRepository(context: Context) {

    companion object {
        private const val PREFS_NAME = "m4racast_config"
        private const val KEY_DEVICE_NAME = "device_name"
        private const val KEY_BIND_ADDRESS = "bind_address"
        private const val KEY_PORT = "port"
        private const val KEY_PASSWORD = "password"
        private const val KEY_MAX_CLIENTS = "max_clients"
        private const val KEY_ASPECT_RATIO = "aspect_ratio"
        private const val KEY_RESOLUTION = "resolution"
        private const val KEY_CUSTOM_WIDTH = "custom_width"
        private const val KEY_CUSTOM_HEIGHT = "custom_height"
        private const val KEY_FPS = "fps"
        private const val KEY_BITRATE_MBPS = "bitrate_mbps"
        private const val KEY_KEYFRAME_INTERVAL = "keyframe_interval"
    }

    private val prefs: SharedPreferences = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    fun load(): AgentConfiguration {
        val streamConfig = StreamConfiguration(
            aspectRatio = AspectRatio.valueOf(prefs.getString(KEY_ASPECT_RATIO, AspectRatio.ORIGINAL.name) ?: AspectRatio.ORIGINAL.name),
            resolution = Resolution.valueOf(prefs.getString(KEY_RESOLUTION, Resolution.ORIGINAL.name) ?: Resolution.ORIGINAL.name),
            customWidth = prefs.getInt(KEY_CUSTOM_WIDTH, 0),
            customHeight = prefs.getInt(KEY_CUSTOM_HEIGHT, 0),
            fps = prefs.getInt(KEY_FPS, 60),
            bitrateMbps = prefs.getFloat(KEY_BITRATE_MBPS, 8f),
            codec = VideoCodec.H264,
            keyframeIntervalSeconds = prefs.getInt(KEY_KEYFRAME_INTERVAL, 2)
        )

        val defaultName = android.os.Build.MODEL ?: "M4raCast"
        return AgentConfiguration(
            deviceName = prefs.getString(KEY_DEVICE_NAME, defaultName) ?: defaultName,
            bindAddress = prefs.getString(KEY_BIND_ADDRESS, "0.0.0.0") ?: "0.0.0.0",
            port = prefs.getInt(KEY_PORT, 0),
            password = prefs.getString(KEY_PASSWORD, "") ?: "",
            maxClients = prefs.getInt(KEY_MAX_CLIENTS, 4),
            streamConfig = streamConfig
        )
    }

    fun save(config: AgentConfiguration) {
        prefs.edit().apply {
            putString(KEY_DEVICE_NAME, config.deviceName)
            putString(KEY_BIND_ADDRESS, config.bindAddress)
            putInt(KEY_PORT, config.port)
            putString(KEY_PASSWORD, config.password)
            putInt(KEY_MAX_CLIENTS, config.maxClients)
            putString(KEY_ASPECT_RATIO, config.streamConfig.aspectRatio.name)
            putString(KEY_RESOLUTION, config.streamConfig.resolution.name)
            putInt(KEY_CUSTOM_WIDTH, config.streamConfig.customWidth)
            putInt(KEY_CUSTOM_HEIGHT, config.streamConfig.customHeight)
            putInt(KEY_FPS, config.streamConfig.fps)
            putFloat(KEY_BITRATE_MBPS, config.streamConfig.bitrateMbps)
            putInt(KEY_KEYFRAME_INTERVAL, config.streamConfig.keyframeIntervalSeconds)
            apply()
        }
    }
}
