package com.m4racast.agent.domain.streaming

/**
 * Video encoding and capture configuration.
 */
data class StreamConfiguration(
    val aspectRatio: AspectRatio = AspectRatio.ORIGINAL,
    val resolution: Resolution = Resolution.ORIGINAL,
    val customWidth: Int = 0,
    val customHeight: Int = 0,
    val fps: Int = 60,
    val bitrateMbps: Float = 8f,
    val codec: VideoCodec = VideoCodec.H264,
    val keyframeIntervalSeconds: Int = 2
) {
    val bitrateBytes: Int get() = (bitrateMbps * 1_000_000).toInt()
}

enum class AspectRatio(val label: String, val widthRatio: Int, val heightRatio: Int) {
    ORIGINAL("Original", 0, 0),
    RATIO_16_9("16:9", 16, 9),
    RATIO_16_10("16:10", 16, 10),
    RATIO_4_3("4:3", 4, 3),
    CUSTOM("Custom", 0, 0)
}

enum class Resolution(val label: String, val height: Int) {
    ORIGINAL("Original", 0),
    P480("480p", 480),
    P720("720p", 720),
    P1080("1080p", 1080),
    CUSTOM("Custom", 0)
}

enum class VideoCodec(val mimeType: String) {
    H264("video/avc")
}
