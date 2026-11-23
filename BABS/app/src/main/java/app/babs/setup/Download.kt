package app.babs.setup

import app.babs.core.Hub
import app.babs.core.Source
import kotlinx.coroutines.delay
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.nio.file.Files

/** Downloads that survive a dropped or damaged connection, which the emulator's network produces under load. */
object Download {
    private const val ATTEMPTS = 5

    /**
     * Downloads [url] to [dest] through dest.part, resuming where it stopped, up to 5 tries.
     * [check] decides whether the finished file is intact. A file that fails it is started again from scratch.
     * [what] names the download in messages, e.g. "Ubuntu".
     */
    suspend fun resumable(
        url: String,
        dest: File,
        what: String,
        check: (File) -> Boolean = { true },
        onProgress: (read: Long, total: Long) -> Unit,
    ) {
        val part = File(dest.path + ".part")
        var lastError: Exception? = null
        for (attempt in 1..ATTEMPTS) {
            try {
                fetch(url, part, onProgress)
                if (check(part)) {
                    Files.deleteIfExists(dest.toPath())
                    if (!part.renameTo(dest)) throw IOException("Couldn't save the download")
                    return
                }
                Hub.log(Source.Babs, "The $what download was damaged, starting it again")
                part.delete()
            } catch (e: IOException) {
                lastError = e
                Hub.log(Source.Babs, "Download interrupted (${firstLine(e)}), attempt $attempt of $ATTEMPTS")
            }
            if (attempt < ATTEMPTS) delay(3_000L * attempt)
        }
        throw IOException(
            "Couldn't download $what. Check the internet connection and try again" +
                (lastError?.let { " (${firstLine(it)})" } ?: ""),
        )
    }

    /** Appends to [part] from where it left off, if the server allows ranges. */
    private fun fetch(url: String, part: File, onProgress: (Long, Long) -> Unit) {
        val have = if (part.exists()) part.length() else 0L
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 20_000
            readTimeout = 60_000
            instanceFollowRedirects = true
            setRequestProperty("User-Agent", "BABS")
            if (have > 0) setRequestProperty("Range", "bytes=$have-")
        }
        try {
            val resumed = when (conn.responseCode) {
                206 -> true
                200 -> false
                416 -> return // already complete
                else -> throw IOException("HTTP ${conn.responseCode} for $url")
            }
            var read = if (resumed) have else 0L
            val total = if (conn.contentLengthLong > 0) read + conn.contentLengthLong else -1L
            var lastShown = -1L
            conn.inputStream.use { input ->
                FileOutputStream(part, resumed).use { out ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        out.write(buf, 0, n)
                        read += n
                        val step = if (total > 0) read * 100 / total else read / 1_000_000
                        if (step != lastShown) {
                            lastShown = step
                            onProgress(read, total)
                        }
                    }
                }
            }
            if (total > 0 && read < total) throw IOException("The connection closed early")
        } finally {
            conn.disconnect()
        }
    }

    /** "12 MB of 98 MB", or "12 MB" when the size isn't known. */
    fun sizeText(read: Long, total: Long) =
        "${read / 1_000_000} MB" + if (total > 0) " of ${total / 1_000_000} MB" else ""

    private fun firstLine(e: Exception) = e.message?.lineSequence()?.firstOrNull() ?: e.toString()
}
