package com.m4racast.agent.infrastructure.network

import android.content.Context
import android.net.wifi.WifiManager
import java.net.NetworkInterface

/**
 * Discovers available LAN IP addresses on the device.
 */
object LanAddressProvider {

    /**
     * Returns all LAN IPv4 addresses (non-loopback, non-link-local).
     */
    fun getLanAddresses(): List<String> {
        val addresses = mutableListOf<String>()
        try {
            NetworkInterface.getNetworkInterfaces()?.toList()?.forEach { iface ->
                if (!iface.isLoopback && iface.isUp) {
                    iface.inetAddresses.toList().forEach { addr ->
                        if (!addr.isLoopbackAddress && !addr.isLinkLocalAddress && addr.hostAddress?.contains(":") == false) {
                            addr.hostAddress?.let { addresses.add(it) }
                        }
                    }
                }
            }
        } catch (e: Exception) {
            // Ignore
        }
        return addresses
    }

    /**
     * Returns the primary WiFi IP address.
     */
    fun getWifiAddress(context: Context): String? {
        return try {
            @Suppress("DEPRECATION")
            val wifiManager = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            @Suppress("DEPRECATION")
            val ip = wifiManager.connectionInfo.ipAddress
            if (ip == 0) null
            else "${ip and 0xFF}.${(ip shr 8) and 0xFF}.${(ip shr 16) and 0xFF}.${(ip shr 24) and 0xFF}"
        } catch (e: Exception) {
            null
        }
    }
}
