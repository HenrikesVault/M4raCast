package com.m4racast.agent.application

import android.content.Context
import android.content.Intent
import com.m4racast.agent.infrastructure.StreamingService

/**
 * Encapsulates the "stop streaming" operation.
 */
class StopStreamingUseCase {
    fun buildIntent(context: Context): Intent =
        Intent(context, StreamingService::class.java).apply {
            action = StreamingService.ACTION_STOP
        }
}
