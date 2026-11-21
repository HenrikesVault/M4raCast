package com.m4racast.agent.presentation.settings

import android.os.Bundle
import android.view.MenuItem
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.ViewModelProvider
import com.m4racast.agent.databinding.ActivitySettingsBinding

class SettingsActivity : AppCompatActivity() {

    private lateinit var binding: ActivitySettingsBinding
    private lateinit var viewModel: SettingsViewModel

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivitySettingsBinding.inflate(layoutInflater)
        setContentView(binding.root)
        setSupportActionBar(binding.toolbar)
        supportActionBar?.setDisplayHomeAsUpEnabled(true)
        supportActionBar?.title = "Settings"

        viewModel = ViewModelProvider(this)[SettingsViewModel::class.java]

        setupObservers()
        setupSaveButton()
    }

    private fun setupObservers() {
        viewModel.configuration.observe(this) { config ->
            binding.etDeviceName.setText(config.deviceName)
            binding.etBindAddress.setText(config.bindAddress)
            binding.etPort.setText(if (config.port == 0) "" else config.port.toString())
            binding.etPassword.setText(config.password)
            binding.etMaxClients.setText(config.maxClients.toString())
            binding.etFps.setText(config.streamConfig.fps.toString())
            binding.etBitrate.setText(config.streamConfig.bitrateMbps.toString())
            binding.etKeyframeInterval.setText(config.streamConfig.keyframeIntervalSeconds.toString())
        }

        viewModel.saved.observe(this) { saved ->
            if (saved) {
                Toast.makeText(this, "Settings saved", Toast.LENGTH_SHORT).show()
                finish()
            }
        }
    }

    private fun setupSaveButton() {
        binding.btnSave.setOnClickListener {
            viewModel.save(
                deviceName = binding.etDeviceName.text.toString(),
                bindAddress = binding.etBindAddress.text.toString(),
                port = binding.etPort.text.toString(),
                password = binding.etPassword.text.toString(),
                maxClients = binding.etMaxClients.text.toString(),
                fps = binding.etFps.text.toString(),
                bitrateMbps = binding.etBitrate.text.toString(),
                keyframeInterval = binding.etKeyframeInterval.text.toString()
            )
        }
    }

    override fun onOptionsItemSelected(item: MenuItem): Boolean {
        if (item.itemId == android.R.id.home) {
            finish()
            return true
        }
        return super.onOptionsItemSelected(item)
    }
}
