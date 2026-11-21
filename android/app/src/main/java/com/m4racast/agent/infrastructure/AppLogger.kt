package com.m4racast.agent.infrastructure

import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.lifecycle.LiveData
import androidx.lifecycle.MutableLiveData
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Real-time diagnostic logger for M4raCast.
 * Outputs to both Android Logcat and an observable LiveData for on-screen inspection.
 */
object AppLogger {

    private const val MAX_LOGS = 50
    private val timeFormat = SimpleDateFormat("HH:mm:ss.SSS", Locale.US)
    private val mainHandler = Handler(Looper.getMainLooper())

    private val logList = mutableListOf<String>()
    private val _logs = MutableLiveData<List<String>>(emptyList())
    val logs: LiveData<List<String>> = _logs

    fun d(tag: String, msg: String) {
        Log.d("M4raCast-$tag", msg)
        append("[DEBUG] $tag: $msg")
    }

    fun i(tag: String, msg: String) {
        Log.i("M4raCast-$tag", msg)
        append("[INFO] $tag: $msg")
    }

    fun w(tag: String, msg: String) {
        Log.w("M4raCast-$tag", msg)
        append("[WARN] $tag: $msg")
    }

    fun e(tag: String, msg: String, tr: Throwable? = null) {
        val errText = if (tr != null) "$msg: ${tr.javaClass.simpleName} - ${tr.message}" else msg
        Log.e("M4raCast-$tag", errText, tr)
        append("[ERROR] $tag: $errText")
    }

    private fun append(entry: String) {
        val timestamp = timeFormat.format(Date())
        val formatted = "$timestamp $entry"
        mainHandler.post {
            if (logList.size >= MAX_LOGS) {
                logList.removeAt(0)
            }
            logList.add(formatted)
            _logs.value = ArrayList(logList)
        }
    }

    fun clear() {
        mainHandler.post {
            logList.clear()
            _logs.value = emptyList()
        }
    }
}

