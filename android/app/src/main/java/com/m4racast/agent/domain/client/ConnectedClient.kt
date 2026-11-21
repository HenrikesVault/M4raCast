package com.m4racast.agent.domain.client

import java.util.UUID

/**
 * Represents a viewer client currently connected to this agent.
 */
data class ConnectedClient(
    val id: String = UUID.randomUUID().toString(),
    val remoteAddress: String,
    val connectedAt: Long = System.currentTimeMillis(),
    val isAuthenticated: Boolean = false
)
