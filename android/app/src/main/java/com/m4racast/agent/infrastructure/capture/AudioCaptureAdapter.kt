package com.m4racast.agent.infrastructure.capture

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioPlaybackCaptureConfiguration
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.projection.MediaProjection
import android.os.Build
import com.m4racast.agent.infrastructure.AppLogger
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Captures internal system audio (Android 10+) or microphone audio (fallback)
 * and streams raw PCM 16-bit 48kHz stereo frames to connected clients.
 */
class AudioCaptureAdapter(private val context: Context) {

    companion object {
        private const val TAG = "AudioCaptureAdapter"
        const val SAMPLE_RATE = 48000
        const val CHANNEL_CONFIG = AudioFormat.CHANNEL_IN_STEREO
        const val AUDIO_FORMAT = AudioFormat.ENCODING_PCM_16BIT
    }

    private var audioRecord: AudioRecord? = null
    private var recordThread: Thread? = null
    private val isRecording = AtomicBoolean(false)

    var onAudioData: ((ByteArray) -> Unit)? = null

    @SuppressLint("MissingPermission")
    fun start(projection: MediaProjection?): Boolean {
        if (isRecording.get()) return true

        try {
            audioRecord = createAudioRecord(projection)
            if (audioRecord == null || audioRecord?.state != AudioRecord.STATE_INITIALIZED) {
                AppLogger.w(TAG, "AudioRecord could not be initialized")
                audioRecord?.release()
                audioRecord = null
                return false
            }

            audioRecord!!.startRecording()
            isRecording.set(true)
            AppLogger.i(TAG, "Audio recording started successfully (48kHz stereo PCM)")

            startReadThread()
            return true
        } catch (e: Exception) {
            AppLogger.w(TAG, "Failed to start audio recording: ${e.message}")
            stop()
            return false
        }
    }

    @SuppressLint("MissingPermission")
    private fun createAudioRecord(projection: MediaProjection?): AudioRecord? {
        val minBufferSize = AudioRecord.getMinBufferSize(SAMPLE_RATE, CHANNEL_CONFIG, AUDIO_FORMAT)
        val bufferSize = if (minBufferSize > 0) (minBufferSize * 2).coerceAtLeast(4096) else 8192

        // 1. Try System Audio Playback Capture (Android 10+, requires MediaProjection)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && projection != null) {
            try {
                val config = AudioPlaybackCaptureConfiguration.Builder(projection)
                    .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
                    .addMatchingUsage(AudioAttributes.USAGE_GAME)
                    .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
                    .build()

                val audioFormat = AudioFormat.Builder()
                    .setEncoding(AUDIO_FORMAT)
                    .setSampleRate(SAMPLE_RATE)
                    .setChannelMask(CHANNEL_CONFIG)
                    .build()

                val record = AudioRecord.Builder()
                    .setAudioPlaybackCaptureConfig(config)
                    .setAudioFormat(audioFormat)
                    .setBufferSizeInBytes(bufferSize)
                    .build()

                if (record.state == AudioRecord.STATE_INITIALIZED) {
                    AppLogger.i(TAG, "Internal system audio capture initialized successfully")
                    return record
                }
                record.release()
            } catch (e: Exception) {
                AppLogger.w(TAG, "System audio capture failed (${e.message}), trying MIC fallback")
            }
        }

        // 2. Fallback: Microphone capture
        try {
            val record = AudioRecord(
                MediaRecorder.AudioSource.MIC,
                SAMPLE_RATE,
                CHANNEL_CONFIG,
                AUDIO_FORMAT,
                bufferSize
            )
            if (record.state == AudioRecord.STATE_INITIALIZED) {
                AppLogger.i(TAG, "Microphone audio capture initialized")
                return record
            }
            record.release()
        } catch (e: Exception) {
            AppLogger.w(TAG, "Microphone capture failed: ${e.message}")
        }

        return null
    }

    private fun startReadThread() {
        recordThread = Thread {
            // Read 4096-byte chunks (1024 stereo samples = ~21.3ms of audio)
            val buffer = ByteArray(4096)
            var totalBytesRead = 0L
            var lastLogTime = System.currentTimeMillis()

            while (isRecording.get()) {
                val record = audioRecord ?: break
                val bytesRead = record.read(buffer, 0, buffer.size)
                if (bytesRead > 0) {
                    totalBytesRead += bytesRead
                    val now = System.currentTimeMillis()
                    if (now - lastLogTime >= 5000) {
                        AppLogger.i(TAG, "Audio streaming active: ${(totalBytesRead / 1024)} KB captured")
                        lastLogTime = now
                    }

                    val chunk = if (bytesRead == buffer.size) {
                        buffer.copyOf()
                    } else {
                        buffer.copyOf(bytesRead)
                    }
                    onAudioData?.invoke(chunk)
                } else if (bytesRead == 0) {
                    try { Thread.sleep(10) } catch (_: Exception) {}
                } else if (bytesRead == AudioRecord.ERROR_INVALID_OPERATION || bytesRead == AudioRecord.ERROR_BAD_VALUE) {
                    AppLogger.e(TAG, "AudioRecord error: $bytesRead")
                    break
                }
            }
        }.also {
            it.name = "M4raCast-AudioWorker"
            it.isDaemon = true
            it.start()
        }
    }

    fun stop() {
        isRecording.set(false)
        try {
            audioRecord?.stop()
        } catch (_: Exception) {}
        try {
            audioRecord?.release()
        } catch (_: Exception) {}
        audioRecord = null
        recordThread = null
        AppLogger.i(TAG, "Audio recording stopped")
    }
}

