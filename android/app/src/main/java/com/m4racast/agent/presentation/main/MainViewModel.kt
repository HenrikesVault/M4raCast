package com.m4racast.agent.presentation.main

import android.app.Application
import android.app.ActivityManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.IBinder
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.LiveData
import androidx.lifecycle.MutableLiveData
import androidx.lifecycle.viewModelScope
import com.m4racast.agent.domain.agent.AgentConfiguration
import com.m4racast.agent.infrastructure.StreamingService
import com.m4racast.agent.infrastructure.network.LanAddressProvider
import com.m4racast.agent.infrastructure.storage.ConfigurationRepository
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

class MainViewModel(application: Application) : AndroidViewModel(application) {

    private val configRepo = ConfigurationRepository(application)

    private val _isStreaming = MutableLiveData(false)
    val isStreaming: LiveData<Boolean> = _isStreaming

    private val _serverPort = MutableLiveData(0)
    val serverPort: LiveData<Int> = _serverPort

    private val _clientCount = MutableLiveData(0)
    val clientCount: LiveData<Int> = _clientCount

    private val _lanAddresses = MutableLiveData<List<String>>(emptyList())
    val lanAddresses: LiveData<List<String>> = _lanAddresses

    private val _errorMessage = MutableLiveData<String?>(null)
    val errorMessage: LiveData<String?> = _errorMessage

    private val _configuration = MutableLiveData<AgentConfiguration>()
    val configuration: LiveData<AgentConfiguration> = _configuration

    private var boundService: StreamingService? = null

    private val serviceConnection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, service: IBinder?) {
            val binder = service as? StreamingService.LocalBinder ?: return
            val svc = binder.getService()
            boundService = svc

            // Immediately synchronize current live state upon binding
            _isStreaming.postValue(svc.isStreaming)
            _serverPort.postValue(svc.currentPort)
            _clientCount.postValue(svc.clientCount)

            svc.onStatusChanged = { streaming, port, clients ->
                _isStreaming.postValue(streaming)
                _serverPort.postValue(port)
                _clientCount.postValue(clients)
            }
            svc.onError = { msg -> _errorMessage.postValue(msg) }
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            boundService = null
        }
    }

    init {
        loadConfiguration()
        refreshLanAddresses()
        tryBindService()
    }

    fun loadConfiguration() {
        _configuration.value = configRepo.load()
    }

    fun refreshLanAddresses() {
        viewModelScope.launch(Dispatchers.IO) {
            val addresses = LanAddressProvider.getLanAddresses()
            _lanAddresses.postValue(addresses)
        }
    }

    private fun tryBindService() {
        val app = getApplication<Application>()
        if (isServiceRunning(app)) {
            val intent = Intent(app, StreamingService::class.java)
            app.bindService(intent, serviceConnection, Context.BIND_AUTO_CREATE)
        }
    }

    fun bindToService() {
        val app = getApplication<Application>()
        val intent = Intent(app, StreamingService::class.java)
        app.bindService(intent, serviceConnection, Context.BIND_AUTO_CREATE)
    }

    fun unbindFromService() {
        try {
            getApplication<Application>().unbindService(serviceConnection)
        } catch (_: Exception) {}
        boundService = null
    }

    fun stopStreamingFromService() {
        boundService?.stopStreaming()
    }

    private fun isServiceRunning(context: Context): Boolean {
        val manager = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        @Suppress("DEPRECATION")
        return manager.getRunningServices(100).any {
            it.service.className == StreamingService::class.java.name
        }
    }

    override fun onCleared() {
        unbindFromService()
        super.onCleared()
    }
}
