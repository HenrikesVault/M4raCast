package com.m4racast.agent.domain.auth

import java.util.UUID

/**
 * A short-lived session token issued after successful authentication.
 */
data class AuthToken(
    val value: String = UUID.randomUUID().toString(),
    val createdAt: Long = System.currentTimeMillis(),
    val expiryMs: Long = 3_600_000L // 1 hour
) {
    fun isValid(): Boolean = (System.currentTimeMillis() - createdAt) < expiryMs
}
