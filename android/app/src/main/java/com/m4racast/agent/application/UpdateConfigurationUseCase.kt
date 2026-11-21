package com.m4racast.agent.application

import com.m4racast.agent.domain.agent.AgentConfiguration
import com.m4racast.agent.infrastructure.storage.ConfigurationRepository

/**
 * Saves updated agent configuration.
 */
class UpdateConfigurationUseCase(private val repository: ConfigurationRepository) {
    fun execute(config: AgentConfiguration) {
        repository.save(config)
    }
}
