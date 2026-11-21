package com.m4racast.agent.domain.auth

sealed class AuthResult {
    data class Success(val token: AuthToken) : AuthResult()
    object InvalidPassword : AuthResult()
    object NotRequired : AuthResult()
}
