package app.babs.core

import android.app.ActivityManager
import android.content.Context
import android.os.Build
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import java.io.File
import java.io.FileWriter
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Everything the console shows, also written to files/logs/babs.log with the time, so it survives BABS being
 * closed and can be shared from the Console tab. When the log reaches 2 MB it becomes babs.1.log.
 */
object LogFile {
    private const val MAX_BYTES = 2L * 1024 * 1024
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val queue = Channel<String>(Channel.UNLIMITED)
    private val time = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US)
    @Volatile private var dir: File? = null

    private val current get() = dir?.let { File(it, "babs.log") }
    private val previous get() = dir?.let { File(it, "babs.1.log") }

    fun init(context: Context) {
        if (dir != null) return
        dir = File(context.filesDir, "logs").apply { mkdirs() }
        scope.launch {
            for (first in queue) {
                val file = current ?: continue
                if (file.length() > MAX_BYTES) {
                    previous?.delete()
                    file.renameTo(previous!!)
                }
                runCatching {
                    FileWriter(file, true).buffered().use { out ->
                        out.write(first)
                        // Writes whatever else has queued up in the same go.
                        while (true) out.write(queue.tryReceive().getOrNull() ?: break)
                    }
                }
            }
        }
    }

    fun write(source: Source, text: String) {
        if (dir == null) return
        queue.trySend("${time.format(Date())} [${source.tag}] $text\n")
    }

    /**
     * Joins the older and current log, after a header describing the device, into one file in the cache
     * for sharing. The header has nothing personal: the phone model, Android version and memory.
     */
    fun export(context: Context): File {
        val out = File(context.cacheDir, "share").apply { mkdirs() }.let { File(it, "babs-log.txt") }
        val memory = ActivityManager.MemoryInfo().also {
            context.getSystemService(ActivityManager::class.java).getMemoryInfo(it)
        }
        val version = runCatching {
            context.packageManager.getPackageInfo(context.packageName, 0).versionName
        }.getOrNull()
        out.bufferedWriter().use { w ->
            w.write("BABS $version on ${Build.MANUFACTURER} ${Build.MODEL}, Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})\n")
            w.write("ABIs ${Build.SUPPORTED_ABIS.joinToString()}, RAM ${memory.totalMem / 1_048_576} MB, ${memory.availMem / 1_048_576} MB free now\n")
            w.write("Exported ${time.format(Date())}\n\n")
            listOfNotNull(previous, current).filter { it.exists() }.forEach { f ->
                f.bufferedReader().use { it.copyTo(w) }
            }
        }
        return out
    }
}
