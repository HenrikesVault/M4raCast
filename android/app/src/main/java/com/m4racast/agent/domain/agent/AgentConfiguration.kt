package com.m4racast.agent.domain.agent

import com.m4racast.agent.domain.streaming.StreamConfiguration

/**
 * Full runtime configuration of the agent.
 */
data class AgentConfiguration(
    val deviceName: String,
    val bindAddress: String = "0.0.0.0",
    val port: Int = 0,
    val password: String = "",
    val maxClients: Int = 4,
    val streamConfig: StreamConfiguration = StreamConfiguration()
) {
    val isProtected: Boolean get() = password.isNotEmpty()
}
