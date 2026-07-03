package com.example.ecgwatch.comm

import android.content.Context
import android.util.Log
import com.google.android.gms.wearable.Node
import com.google.android.gms.wearable.Wearable
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withContext

class DataLayerSender(context: Context) {

    private val appContext = context.applicationContext
    private val messageClient = Wearable.getMessageClient(appContext)
    private val nodeClient = Wearable.getNodeClient(appContext)

    suspend fun send(payload: ByteArray) {
        send(payload, SENSOR_DATA_PATH)
    }

    suspend fun send(payload: ByteArray, path: String): Boolean {
        val nodes: List<Node> = try {
            withContext(Dispatchers.IO) { nodeClient.connectedNodes.await() }
        } catch (t: Throwable) {
            Log.e(TAG, "Failed to enumerate connected nodes", t)
            return false
        }

        if (nodes.isEmpty()) {
            Log.d(TAG, "No connected Wear OS nodes; dropping packet path=$path")
            return false
        }

        var anySuccess = false
        for (node in nodes) {
            if (sendToNode(node, payload, path)) anySuccess = true
        }
        return anySuccess
    }

    private suspend fun sendToNode(node: Node, payload: ByteArray, path: String): Boolean {
        return try {
            withContext(Dispatchers.IO) {
                messageClient.sendMessage(node.id, path, payload).await()
            }
            true
        } catch (t: Throwable) {
            Log.e(TAG, "Send failed to node=${node.displayName} path=$path", t)
            false
        }
    }

    companion object {
        private const val TAG = "DataLayerSender"

        /**
         * Single unified path. Both standard sensors and ECG samples ride the same
         * 1 Hz JSON stream. The ECG field of each packet is null when no recording
         * is active.
         */
        const val SENSOR_DATA_PATH = "/sensor_data"
    }
}