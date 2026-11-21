package com.m4racast.agent.domain.agent

/**
 * Represents the identity and state of this M4raCast agent.
 */
data class AgentInfo(
    val name: String,
    val version: String = "1.0",
    val isProtected: Boolean = false,
    val isStreaming: Boolean = false
)
