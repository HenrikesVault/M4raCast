package com.m4racast.agent.domain.streaming

/**
 * Represents an active streaming session. Tracks state transitions.
 */
class StreamingSession(val config: StreamConfiguration) {

    enum class State { IDLE, STARTING, ACTIVE, STOPPING, STOPPED }

    var state: State = State.IDLE
        private set

    var actualWidth: Int = 0
    var actualHeight: Int = 0
    var actualFps: Int = config.fps

    fun markStarting() { state = State.STARTING }
    fun markActive(width: Int, height: Int) {
        state = State.ACTIVE
        actualWidth = width
        actualHeight = height
    }
    fun markStopping() { state = State.STOPPING }
    fun markStopped() { state = State.STOPPED }

    val isActive: Boolean get() = state == State.ACTIVE
}
