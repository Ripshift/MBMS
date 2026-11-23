package app.babs.core

import android.content.Context
import android.net.Uri
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import java.io.File
import java.io.IOException
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

/** An export in progress, or how the last one went. */
data class WorldExport(val busy: String? = null, val progress: Float? = null, val error: String? = null, val done: String? = null)

/**
 * Saves a world as a .mcworld: a zip with level.dat at the top, which Minecraft opens and BABS imports.
 *
 * A running server keeps writing its world, so copying it then can catch a half-written file. Bedrock's server
 * has a way round that, which this follows:
 *
 * 1. `save hold` pauses saving (the game carries on).
 * 2. `save query` is repeated until the server says "Data saved. Files are now ready to be copied." and lists
 *    every file with how many bytes of it count. Files can be longer than that, since the server may already be
 *    writing past the end, so only that many bytes are copied. Database files not listed are left out.
 * 3. `save resume` lets it save again, whatever happened.
 */
object WorldExporter {
    private const val READY = "Files are now ready to be copied"
    private val FILE_LENGTH = Regex(":\\d+(,|$)")

    /** A name for the file: the world's name and today's date, as Bedrock Hub names its backups. */
    fun fileName(worldName: String): String {
        val safe = worldName.replace(Regex("§."), "").replace(Regex("[<>:\"/\\\\|?*\\x00-\\x1f]"), "").trim().ifEmpty { "World" }
        return "$safe ${SimpleDateFormat("yyyy-MM-dd HHmm", Locale.US).format(Date())}.mcworld"
    }

    /**
     * Exports [worldDir] to [uri]. With [send] (the running server's console), the server is asked to hold its
     * saves first. Blocking and long, so call from a background coroutine.
     */
    suspend fun export(context: Context, worldDir: File, uri: Uri, send: ((String) -> Boolean)?) {
        val name = runCatching { File(worldDir, "levelname.txt").readText().trim() }.getOrNull()?.ifEmpty { null } ?: worldDir.name
        try {
            if (!File(worldDir, "level.dat").exists()) throw IOException("That world hasn't been made yet. Start the server on it first")
            var lengths: Map<String, Long>? = null
            if (send != null) {
                Hub.updateWorldExport { WorldExport(busy = "Asking the server to pause saving") }
                lengths = holdAndQuery(send, worldDir.name)
            }
            try {
                writeZip(context, worldDir, uri, lengths, name)
            } finally {
                if (send != null) send("save resume")
            }
            Hub.log(Source.Babs, "Exported \"$name\"")
            Hub.updateWorldExport { WorldExport(done = "Saved \"$name\" as a .mcworld. Open it with Minecraft, or import it into BABS.") }
        } catch (e: Throwable) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            val message = e.message ?: e.javaClass.simpleName
            Hub.log(Source.Babs, "Export failed: $message")
            Hub.updateWorldExport { WorldExport(error = message) }
            // A half-written file isn't a backup.
            runCatching { android.provider.DocumentsContract.deleteDocument(context.contentResolver, uri) }
        }
    }

    /** `save hold`, then `save query` until the file list comes. Returns each file's path in the world and length. */
    private suspend fun holdAndQuery(send: (String) -> Boolean, folder: String): Map<String, Long> = coroutineScope {
        val list = CompletableDeferred<String>()
        var readySeen = false
        val listener = launch {
            Hub.serverLines.collect { line ->
                when {
                    READY in line -> readySeen = true
                    // The next line lists the files, as "<world>/db/000005.ldb:1234, <world>/level.dat:3056, ..."
                    readySeen && !line.startsWith("[") && "$folder/" in line && FILE_LENGTH.containsMatchIn(line) -> list.complete(line)
                }
            }
        }
        if (!send("save hold")) throw IOException("The server isn't taking commands")
        val answer = withTimeoutOrNull(60_000) {
            while (!list.isCompleted) {
                delay(1_500)
                send("save query")
                delay(500)
            }
            list.await()
        }
        listener.cancel()
        answer ?: run {
            send("save resume")
            throw IOException("The server didn't get the world ready to copy within a minute")
        }
        answer.split(", ").mapNotNull { item ->
            val colon = item.lastIndexOf(':')
            if (colon < 0) return@mapNotNull null
            val path = item.substring(0, colon).trim().removePrefix("$folder/")
            val length = item.substring(colon + 1).trim().toLongOrNull() ?: return@mapNotNull null
            path to length
        }.toMap()
    }

    private fun writeZip(context: Context, worldDir: File, uri: Uri, lengths: Map<String, Long>?, name: String) {
        val files = worldDir.walkTopDown().filter { it.isFile }.map { it to it.relativeTo(worldDir).invariantSeparatorsPath }
            .filter { (_, path) ->
                // During a hold, database files the server didn't list are stale or still being written.
                lengths == null || path in lengths || !path.startsWith("db/")
            }.toList()
        val total = files.sumOf { (file, path) -> lengths?.get(path) ?: file.length() }.coerceAtLeast(1)
        var done = 0L
        val out = context.contentResolver.openOutputStream(uri) ?: throw IOException("Couldn't write the file")
        ZipOutputStream(out.buffered()).use { zip ->
            val buffer = ByteArray(64 * 1024)
            for ((file, path) in files) {
                zip.putNextEntry(ZipEntry(path))
                var left = lengths?.get(path) ?: Long.MAX_VALUE
                file.inputStream().use { input ->
                    while (left > 0) {
                        val n = input.read(buffer, 0, minOf(buffer.size.toLong(), left).toInt())
                        if (n < 0) break
                        zip.write(buffer, 0, n)
                        left -= n
                        done += n
                    }
                }
                zip.closeEntry()
                Hub.updateWorldExport { WorldExport(busy = "Saving \"$name\"", progress = (done.toFloat() / total).coerceIn(0f, 1f)) }
            }
        }
    }

    fun dismiss() = Hub.updateWorldExport { WorldExport() }
}
