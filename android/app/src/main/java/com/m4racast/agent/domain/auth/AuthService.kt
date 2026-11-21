package com.m4racast.agent.domain.auth

import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap

/**
 * Domain service: manages nonces and validates authentication.
 * Password is never stored as plaintext beyond initial config.
 */
class AuthService {

    private val activeTokens = ConcurrentHashMap<String, AuthToken>()
    private val activeNonces = ConcurrentHashMap<String, Long>()

    fun generateNonce(): String {
        val nonce = java.util.UUID.randomUUID().toString().replace("-", "")
        activeNonces[nonce] = System.currentTimeMillis()
        pruneNonces()
        return nonce
    }

    /**
     * Validates a hashed password attempt against the stored password + nonce.
     * Expected hash: SHA-256(password + nonce), hex-encoded.
     */
    fun authenticate(passwordHash: String, nonce: String, actualPassword: String): AuthResult {
        if (actualPassword.isEmpty()) return AuthResult.NotRequired
        val nonceTs = activeNonces.remove(nonce) ?: return AuthResult.InvalidPassword
        if (System.currentTimeMillis() - nonceTs > 60_000) return AuthResult.InvalidPassword // nonce expired

        val expectedHash = sha256(actualPassword + nonce)
        return if (expectedHash.equals(passwordHash, ignoreCase = true)) {
            val token = AuthToken()
            activeTokens[token.value] = token
            AuthResult.Success(token)
        } else {
            AuthResult.InvalidPassword
        }
    }

    fun validateToken(tokenValue: String): Boolean {
        val token = activeTokens[tokenValue] ?: return false
        if (!token.isValid()) {
            activeTokens.remove(tokenValue)
            return false
        }
        return true
    }

    fun issueTokenWithoutAuth(): AuthToken {
        val token = AuthToken()
        activeTokens[token.value] = token
        return token
    }

    fun revokeAll() {
        activeTokens.clear()
        activeNonces.clear()
    }

    private fun pruneNonces() {
        val now = System.currentTimeMillis()
        activeNonces.entries.removeIf { (_, ts) -> now - ts > 120_000 }
    }

    private fun sha256(input: String): String {
        val digest = MessageDigest.getInstance("SHA-256")
        val bytes = digest.digest(input.toByteArray(Charsets.UTF_8))
        return bytes.joinToString("") { "%02x".format(it) }
    }
}
