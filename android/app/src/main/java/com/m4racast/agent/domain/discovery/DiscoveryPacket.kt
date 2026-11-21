package com.m4racast.agent.domain.discovery

/**
 * Data broadcast over UDP for agent discovery.
 */
data class DiscoveryPacket(
    val protocol: String = "M4raCast",
    val version: String = "1.0",
    val name: String,
    val port: Int,
    val protected: Boolean
) {
    fun toJson(): String = """{"protocol":"$protocol","version":"$version","name":"${name.replace("\"","'")}","port":$port,"protected":$protected}"""
}
