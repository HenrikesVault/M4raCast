package com.m4racast.agent.infrastructure.network

import android.util.Log
import com.m4racast.agent.domain.discovery.DiscoveryPacket
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/**
 * Broadcasts UDP discovery packets on the local network.
 * Agents announce themselves every 2 seconds on port 42400.
 */
class NetworkDiscovery {

    companion object {
        private const val TAG = "NetworkDiscovery"
        const val DISCOVERY_PORT = 42400
        const val BROADCAST_INTERVAL_SECONDS = 2L
    }

    private val scheduler = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "M4raCast-Discovery").also { it.isDaemon = true }
    }
    private var broadcastFuture: ScheduledFuture<*>? = null
    private var udpSocket: DatagramSocket? = null

    fun startBroadcasting(packet: DiscoveryPacket) {
        stopBroadcasting()
        val jsonBytes = packet.toJson().toByteArray(Charsets.UTF_8)
        val broadcastAddr = InetAddress.getByName("255.255.255.255")

        broadcastFuture = scheduler.scheduleAtFixedRate({
            try {
                val socket = udpSocket ?: DatagramSocket().also {
                    it.broadcast = true
                    udpSocket = it
                }
                val datagram = DatagramPacket(jsonBytes, jsonBytes.size, broadcastAddr, DISCOVERY_PORT)
                socket.send(datagram)
                Log.v(TAG, "Broadcast sent: ${packet.name}:${packet.port}")
            } catch (e: Exception) {
                Log.e(TAG, "Broadcast error: ${e.message}")
            }
        }, 0, BROADCAST_INTERVAL_SECONDS, TimeUnit.SECONDS)

        Log.i(TAG, "UDP discovery broadcasting started")
    }

    fun stopBroadcasting() {
        broadcastFuture?.cancel(false)
        broadcastFuture = null
        udpSocket?.close()
        udpSocket = null
        Log.i(TAG, "UDP discovery broadcasting stopped")
    }
}
