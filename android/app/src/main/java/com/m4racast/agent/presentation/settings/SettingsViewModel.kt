package com.m4racast.agent.presentation.settings

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.LiveData
import androidx.lifecycle.MutableLiveData
import com.m4racast.agent.application.UpdateConfigurationUseCase
import com.m4racast.agent.domain.agent.AgentConfiguration
import com.m4racast.agent.domain.streaming.AspectRatio
import com.m4racast.agent.domain.streaming.Resolution
import com.m4racast.agent.domain.streaming.StreamConfiguration
import com.m4racast.agent.infrastructure.storage.ConfigurationRepository

class SettingsViewModel(application: Application) : AndroidViewModel(application) {

    private val repository = ConfigurationRepository(application)
    private val updateUseCase = UpdateConfigurationUseCase(repository)

    private val _configuration = MutableLiveData<AgentConfiguration>()
    val configuration: LiveData<AgentConfiguration> = _configuration

    private val _saved = MutableLiveData(false)
    val saved: LiveData<Boolean> = _saved

    init {
        load()
    }

    fun load() {
        _configuration.value = repository.load()
    }

    fun save(
        deviceName: String,
        bindAddress: String,
        port: String,
        password: String,
        maxClients: String,
        fps: String,
        bitrateMbps: String,
        keyframeInterval: String
    ) {
        val current = _configuration.value ?: repository.load()
        val newConfig = current.copy(
            deviceName = deviceName.trim().ifEmpty { android.os.Build.MODEL ?: "M4raCast" },
            bindAddress = bindAddress.trim().ifEmpty { "0.0.0.0" },
            port = port.trim().toIntOrNull() ?: 0,
            password = password,
            maxClients = maxClients.trim().toIntOrNull() ?: 4,
            streamConfig = current.streamConfig.copy(
                aspectRatio = AspectRatio.ORIGINAL,
                resolution = Resolution.ORIGINAL,
                customWidth = 0,
                customHeight = 0,
                fps = fps.trim().toIntOrNull()?.coerceIn(15, 120) ?: 60,
                bitrateMbps = bitrateMbps.trim().toFloatOrNull()?.coerceIn(1f, 50f) ?: 8f,
                keyframeIntervalSeconds = keyframeInterval.trim().toIntOrNull()?.coerceIn(1, 10) ?: 2
            )
        )
        updateUseCase.execute(newConfig)
        _configuration.value = newConfig
        _saved.value = true
    }
}
