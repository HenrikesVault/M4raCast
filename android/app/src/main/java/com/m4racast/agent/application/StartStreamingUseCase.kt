package com.m4racast.agent.application

import android.content.Intent
import com.m4racast.agent.domain.agent.AgentConfiguration
import com.m4racast.agent.infrastructure.StreamingService

/**
 * Encapsulates the "start streaming" operation.
 * Builds and dispatches the service intent.
 */
class StartStreamingUseCase {
    fun buildIntent(
        baseIntent: Intent,
        resultCode: Int,
        projectionData: Intent
    ): Intent {
        return Intent(baseIntent).apply {
            action = StreamingService.ACTION_START
            putExtra(StreamingService.EXTRA_RESULT_CODE, resultCode)
            putExtra(StreamingService.EXTRA_DATA, projectionData)
        }
    }
}
