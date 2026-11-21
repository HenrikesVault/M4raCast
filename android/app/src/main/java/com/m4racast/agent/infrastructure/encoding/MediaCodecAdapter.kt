package com.m4racast.agent.infrastructure.encoding

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.os.Build
import android.util.Log
import android.view.Surface
import com.m4racast.agent.domain.streaming.StreamConfiguration
import com.m4racast.agent.domain.streaming.VideoCodec
import com.m4racast.agent.infrastructure.AppLogger
import com.m4racast.agent.infrastructure.http.WebSocketHandler
import java.nio.ByteBuffer

/**
 * Wraps Android MediaCodec for hardware-accelerated H.264 encoding.
 * Uses Surface input mode (encoder pulls frames from VirtualDisplay via Surface).
 *
 * Calls [onOutputData] for each encoded NAL unit batch.
 * Calls [onFormatChanged] when SPS/PPS are available (config data).
 */
class MediaCodecAdapter {

    companion object {
        private const val TAG = "MediaCodecAdapter"
        private const val TIMEOUT_US = 1_000L // 1ms polling timeout for ultra-low latency
    }

    private var encoder: MediaCodec? = null
    private var encoderThread: Thread? = null
    private var running = false

    var onOutputData: ((type: Byte, data: ByteArray) -> Unit)? = null
    var onFormatChanged: ((configData: ByteArray) -> Unit)? = null
    var onError: ((Exception) -> Unit)? = null

    /** Last known SPS+PPS config data — resent to each newly connecting client. */
    @Volatile
    var lastConfigData: ByteArray? = null
        private set

    /**
     * Prepares and starts the encoder for smooth 60fps low-latency streaming.
     * @return The input Surface to feed into VirtualDisplay.
     */
    fun start(config: StreamConfiguration, width: Int, height: Int): Surface {
        val format = MediaFormat.createVideoFormat(config.codec.mimeType, width, height).apply {
            setInteger(MediaFormat.KEY_BIT_RATE, config.bitrateBytes)
            setInteger(MediaFormat.KEY_FRAME_RATE, config.fps)
            setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, config.keyframeIntervalSeconds)
            setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
            setInteger(MediaFormat.KEY_BITRATE_MODE, MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_CBR)
            setInteger(MediaFormat.KEY_PROFILE, MediaCodecInfo.CodecProfileLevel.AVCProfileHigh)
            setInteger(MediaFormat.KEY_LEVEL, MediaCodecInfo.CodecProfileLevel.AVCLevel42)
            // Low-latency mode on Android 11+ (API 30+)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                setInteger(MediaFormat.KEY_LOW_LATENCY, 1)
            }
            // Realtime encoder priority
            setInteger(MediaFormat.KEY_PRIORITY, 0)
            // High operating rate to prevent encoder throttling
            setInteger(MediaFormat.KEY_OPERATING_RATE, config.fps)
            // Repeat frame after interval to avoid stuttering on static display
            setLong(MediaFormat.KEY_REPEAT_PREVIOUS_FRAME_AFTER, 1_000_000L / config.fps)
        }

        val codecName = config.codec.mimeType
        AppLogger.i(TAG, "Creating encoder: $codecName (${width}x${height} @ ${config.fps}fps, ${(config.bitrateBytes / 1_000_000)}Mbps)...")
        encoder = MediaCodec.createEncoderByType(codecName)
        try {
            encoder!!.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            AppLogger.i(TAG, "Encoder configured with High Profile Level 4.2 low-latency format")
        } catch (e: Exception) {
            AppLogger.w(TAG, "High profile configure failed (${e.message}), trying Baseline fallback...")
            val fallbackFormat = MediaFormat.createVideoFormat(config.codec.mimeType, width, height).apply {
                setInteger(MediaFormat.KEY_BIT_RATE, config.bitrateBytes)
                setInteger(MediaFormat.KEY_FRAME_RATE, config.fps)
                setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, config.keyframeIntervalSeconds)
                setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
                setInteger(MediaFormat.KEY_PROFILE, MediaCodecInfo.CodecProfileLevel.AVCProfileBaseline)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    setInteger(MediaFormat.KEY_LOW_LATENCY, 1)
                }
            }
            encoder!!.configure(fallbackFormat, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            AppLogger.i(TAG, "Encoder configured with fallback Baseline format")
        }

        val surface = encoder!!.createInputSurface()
        encoder!!.start()
        running = true
        AppLogger.i(TAG, "MediaCodec encoder started successfully")

        startDrainThread()
        return surface
    }

    private fun startDrainThread() {
        encoderThread = Thread {
            val bufferInfo = MediaCodec.BufferInfo()
            while (running) {
                try {
                    drainEncoder(bufferInfo)
                } catch (e: Exception) {
                    if (running) {
                        Log.e(TAG, "Encoder drain error: ${e.message}")
                        onError?.invoke(e)
                    }
                    break
                }
            }
            Log.i(TAG, "Encoder drain thread exiting")
        }.also {
            it.name = "M4raCast-Encoder"
            it.isDaemon = true
            it.start()
        }
    }

    private fun drainEncoder(bufferInfo: MediaCodec.BufferInfo) {
        val enc = encoder ?: return
        val outputIndex = enc.dequeueOutputBuffer(bufferInfo, TIMEOUT_US)
        when {
            outputIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                // SPS/PPS config — build Annex-B codec config buffer (00 00 00 01 prefix on each NAL)
                val format = enc.outputFormat
                val sps = format.getByteBuffer("csd-0")
                val pps = format.getByteBuffer("csd-1")
                if (sps != null && pps != null) {
                    val startCode = byteArrayOf(0x00, 0x00, 0x00, 0x01)
                    val spsBytes = ByteArray(sps.remaining()).also { sps.get(it) }
                    val ppsBytes = ByteArray(pps.remaining()).also { pps.get(it) }

                    // Check if csd-0 already has an Annex-B start code; add one if not.
                    val spsHasStartCode = spsBytes.size >= 4 &&
                        spsBytes[0] == 0x00.toByte() && spsBytes[1] == 0x00.toByte() &&
                        spsBytes[2] == 0x00.toByte() && spsBytes[3] == 0x01.toByte()
                    val ppsHasStartCode = ppsBytes.size >= 4 &&
                        ppsBytes[0] == 0x00.toByte() && ppsBytes[1] == 0x00.toByte() &&
                        ppsBytes[2] == 0x00.toByte() && ppsBytes[3] == 0x01.toByte()

                    val configData = ByteArray(
                        (if (spsHasStartCode) 0 else startCode.size) + spsBytes.size +
                        (if (ppsHasStartCode) 0 else startCode.size) + ppsBytes.size
                    )
                    var offset = 0
                    if (!spsHasStartCode) { startCode.copyInto(configData, offset); offset += startCode.size }
                    spsBytes.copyInto(configData, offset); offset += spsBytes.size
                    if (!ppsHasStartCode) { startCode.copyInto(configData, offset); offset += startCode.size }
                    ppsBytes.copyInto(configData, offset)

                    lastConfigData = configData
                    onFormatChanged?.invoke(configData)
                    Log.i(TAG, "Config data ready (Annex-B): ${configData.size} bytes, sps=${spsBytes.size}B, pps=${ppsBytes.size}B")
                }
            }
            outputIndex >= 0 -> {
                try {
                    val outputBuffer: ByteBuffer? = enc.getOutputBuffer(outputIndex)
                    if (outputBuffer != null && bufferInfo.size > 0) {
                        outputBuffer.position(bufferInfo.offset)
                        outputBuffer.limit(bufferInfo.offset + bufferInfo.size)
                        val isConfig = (bufferInfo.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0
                        val isKeyframe = (bufferInfo.flags and MediaCodec.BUFFER_FLAG_KEY_FRAME) != 0

                        val data = ByteArray(bufferInfo.size)
                        outputBuffer.get(data)

                        if (isConfig) {
                            // Some encoders also emit config as output buffer — ensure Annex-B start code is present
                            val startCode = byteArrayOf(0x00, 0x00, 0x00, 0x01)
                            val hasStartCode = data.size >= 4 &&
                                data[0] == 0x00.toByte() && data[1] == 0x00.toByte() &&
                                data[2] == 0x00.toByte() && data[3] == 0x01.toByte()
                            val configData = if (hasStartCode) data else (startCode + data)
                            lastConfigData = configData
                            onFormatChanged?.invoke(configData)
                        } else {
                            // Prepend timestamp (8 bytes, big-endian) + keyframe flag for jitter buffer
                            val frameData = ByteArray(9 + data.size)
                            val pts = bufferInfo.presentationTimeUs
                            for (i in 0..7) frameData[i] = ((pts shr ((7 - i) * 8)) and 0xFF).toByte()
                            frameData[8] = if (isKeyframe) 0x01 else 0x00
                            data.copyInto(frameData, 9)

                            onOutputData?.invoke(WebSocketHandler.TYPE_VIDEO_FRAME, frameData)
                        }
                    }
                } finally {
                    enc.releaseOutputBuffer(outputIndex, false)
                }
            }
        }
    }

    fun requestKeyframe() {
        try {
            val params = android.os.Bundle().apply {
                putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0)
            }
            encoder?.setParameters(params)
            Log.d(TAG, "Keyframe requested")
        } catch (e: Exception) {
            Log.w(TAG, "Keyframe request failed: ${e.message}")
        }
    }

    fun stop() {
        running = false
        try {
            encoder?.signalEndOfInputStream()
        } catch (_: Exception) {}
        encoderThread?.join(2000)
        try {
            encoder?.stop()
            encoder?.release()
        } catch (e: Exception) {
            Log.e(TAG, "Encoder stop error: ${e.message}")
        }
        encoder = null
        Log.i(TAG, "Encoder stopped")
    }
}

