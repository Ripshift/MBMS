package app.babs.core

import android.content.ContentResolver
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document
import android.provider.OpenableColumns
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.util.zip.ZipInputStream
import kotlin.coroutines.coroutineContext

/** A world found inside a picked folder, waiting for the person to choose it. */
data class WorldChoice(val name: String, val documentId: String)

/**
 * A world import in progress or just finished. [choices] is set when a picked folder holds several worlds,
 * and [imported] names the folder of the world that was just added.
 */
data class WorldImport(
    val busy: String? = null,
    val progress: Float? = null,
    val error: String? = null,
    val imported: String? = null,
    val choices: List<WorldChoice> = emptyList(),
    val choiceTree: String? = null,
)

/** Whether Minecraft is on this phone, and where the file picker should open. */
data class MinecraftInfo(
    val installed: Boolean,
    val version: String?,
    /** Minecraft's worlds folder when other apps can reach it, else null. */
    val worldsFolder: Uri?,
    /** Where the pickers open: the worlds folder if reachable, else Downloads. */
    val startAt: Uri,
)

/**
 * Brings worlds from Minecraft into the server's worlds/ folder, from a .mcworld file (a zip of one world) or a
 * folder picked through Android's file picker. Copies into a hidden folder first and renames it at the end, so a
 * failed import never leaves half a world in the list. Runs in its own scope so turning the phone doesn't stop it.
 */
object WorldImporter {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var job: Job? = null

    private const val MINECRAFT = "com.mojang.minecraftpe"
    private const val STORAGE = "com.android.externalstorage.documents"

    val isBusy: Boolean get() = job?.isActive == true

    /**
     * Looks for Minecraft. Its worlds are in its own private storage on current versions, out of reach of other
     * apps, unless it's set to keep them in shared storage (games/com.mojang/minecraftWorlds), where they can be
     * picked. Android 10 still lets the picker into Android/data, where older versions kept them too.
     */
    fun findMinecraft(context: Context): MinecraftInfo {
        val info = runCatching { context.packageManager.getPackageInfo(MINECRAFT, 0) }.getOrNull()
        val shared = Environment.getExternalStorageDirectory()
        val candidates = buildList {
            add("games/com.mojang/minecraftWorlds")
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) add("Android/data/$MINECRAFT/files/games/com.mojang/minecraftWorlds")
        }
        val found = candidates.firstOrNull { File(shared, it).isDirectory }
        val folder = found?.let { DocumentsContract.buildDocumentUri(STORAGE, "primary:$it") }
        return MinecraftInfo(
            installed = info != null,
            version = info?.versionName,
            worldsFolder = folder,
            startAt = folder ?: DocumentsContract.buildDocumentUri(STORAGE, "primary:${Environment.DIRECTORY_DOWNLOADS}"),
        )
    }

    /** Imports a .mcworld (or a .zip of a world folder). */
    fun importFile(context: Context, uri: Uri, worldsDir: File) = start {
        val resolver = context.contentResolver
        val fileName = displayName(resolver, uri) ?: "world.mcworld"
        Hub.updateWorldImport { WorldImport(busy = "Reading $fileName") }

        // First pass: where the world starts inside the zip, how big it is unpacked, and its name.
        var total = 0L
        var name: String? = null
        val entries = mutableListOf<String>()
        open(resolver, uri).use { input ->
            ZipInputStream(input.buffered()).use { zip ->
                while (true) {
                    val entry = zip.nextEntry ?: break
                    coroutineContext.ensureActive()
                    entries += entry.name
                    if (!entry.isDirectory) total += maxOf(entry.size, 0)
                    if (entry.name.endsWith("levelname.txt") && entry.name.count { it == '/' } <= 1) {
                        name = zip.readBytes().decodeToString().trim().take(80).ifEmpty { null }
                    }
                }
            }
        }
        if (entries.isEmpty()) throw IOException("$fileName isn't a .mcworld file (it isn't a zip)")
        // Usually at the top, but some tools zip the world's folder, which puts it one level down.
        val levelDat = entries.filter { it == "level.dat" || it.endsWith("/level.dat") }
            .minByOrNull { it.count { c -> c == '/' } }
            ?: throw IOException("$fileName doesn't contain a Minecraft world (no level.dat)")
        val prefix = levelDat.removeSuffix("level.dat")
        checkSpace(worldsDir, total)

        val folder = uniqueFolder(worldsDir, name ?: fileName.substringBeforeLast('.'))
        val staging = File(worldsDir, ".import-${System.currentTimeMillis()}")
        try {
            var done = 0L
            open(resolver, uri).use { input ->
                ZipInputStream(input.buffered()).use { zip ->
                    while (true) {
                        val entry = zip.nextEntry ?: break
                        coroutineContext.ensureActive()
                        if (!entry.name.startsWith(prefix)) continue
                        val relative = entry.name.removePrefix(prefix)
                        if (relative.isEmpty()) continue
                        val target = safeChild(staging, relative)
                        if (entry.isDirectory) {
                            target.mkdirs()
                        } else {
                            target.parentFile?.mkdirs()
                            target.outputStream().use { out -> done += copy(zip, out) { n -> progress(folder, done + n, total) } }
                        }
                    }
                }
            }
            finish(staging, worldsDir, folder)
        } catch (e: Throwable) {
            staging.deleteRecursively()
            throw e
        }
    }

    /**
     * Imports from a picked folder. A world folder (with level.dat) is imported straight away. A folder of
     * worlds, such as Minecraft's minecraftWorlds, lists them for the person to pick one.
     */
    fun importFolder(context: Context, tree: Uri, worldsDir: File) = start {
        val resolver = context.contentResolver
        val rootId = DocumentsContract.getTreeDocumentId(tree)
        Hub.updateWorldImport { WorldImport(busy = "Looking for worlds") }
        val children = list(resolver, tree, rootId)
        if (children.any { !it.isDir && it.name == "level.dat" }) {
            copyWorld(resolver, tree, rootId, worldsDir)
            return@start
        }
        val worlds = children.filter { it.isDir }.mapNotNull { dir ->
            coroutineContext.ensureActive()
            val inside = list(resolver, tree, dir.id)
            if (inside.none { !it.isDir && it.name == "level.dat" }) return@mapNotNull null
            val shown = inside.firstOrNull { it.name == "levelname.txt" }?.let { readText(resolver, tree, it.id) }
            WorldChoice(shown ?: dir.name, dir.id)
        }
        when (worlds.size) {
            0 -> throw IOException("There's no Minecraft world in that folder. Pick a world's folder, or the folder that holds them")
            1 -> copyWorld(resolver, tree, worlds[0].documentId, worldsDir)
            else -> Hub.updateWorldImport { WorldImport(choices = worlds.sortedBy { it.name.lowercase() }, choiceTree = tree.toString()) }
        }
    }

    /** Imports the world the person picked from a folder of several. */
    fun importChoice(context: Context, choice: WorldChoice, tree: Uri, worldsDir: File) = start {
        copyWorld(context.contentResolver, tree, choice.documentId, worldsDir)
    }

    fun cancel() {
        job?.cancel()
        Hub.updateWorldImport { WorldImport() }
    }

    fun dismiss() = Hub.updateWorldImport { WorldImport() }

    private fun start(work: suspend () -> Unit) {
        if (isBusy) return
        job = scope.launch {
            try {
                work()
            } catch (e: kotlinx.coroutines.CancellationException) {
                Hub.log(Source.Babs, "World import cancelled")
                throw e
            } catch (e: Throwable) {
                val message = e.message ?: e.javaClass.simpleName
                Hub.log(Source.Babs, "World import failed: $message")
                Hub.updateWorldImport { WorldImport(error = message) }
            }
        }
    }

    private suspend fun copyWorld(resolver: ContentResolver, tree: Uri, docId: String, worldsDir: File) {
        val inside = list(resolver, tree, docId)
        val name = inside.firstOrNull { it.name == "levelname.txt" }?.let { readText(resolver, tree, it.id) }
            ?: displayName(resolver, DocumentsContract.buildDocumentUriUsingTree(tree, docId))
            ?: "Imported world"
        Hub.updateWorldImport { WorldImport(busy = "Measuring $name") }
        val total = size(resolver, tree, docId)
        checkSpace(worldsDir, total)
        val folder = uniqueFolder(worldsDir, name)
        val staging = File(worldsDir, ".import-${System.currentTimeMillis()}")
        try {
            var done = 0L
            suspend fun copyDir(id: String, into: File) {
                into.mkdirs()
                for (child in list(resolver, tree, id)) {
                    coroutineContext.ensureActive()
                    val target = safeChild(into, child.name)
                    if (child.isDir) {
                        copyDir(child.id, target)
                    } else {
                        open(resolver, DocumentsContract.buildDocumentUriUsingTree(tree, child.id)).use { input ->
                            target.outputStream().use { out -> done += copy(input, out) { n -> progress(folder, done + n, total) } }
                        }
                    }
                }
            }
            copyDir(docId, staging)
            if (!File(staging, "level.dat").exists()) throw IOException("The copied world has no level.dat")
            finish(staging, worldsDir, folder)
        } catch (e: Throwable) {
            staging.deleteRecursively()
            throw e
        }
    }

    private fun finish(staging: File, worldsDir: File, folder: String) {
        if (!File(staging, "level.dat").exists()) throw IOException("That doesn't contain a Minecraft world (no level.dat)")
        val target = File(worldsDir, folder)
        if (!staging.renameTo(target)) throw IOException("Couldn't move the world into place")
        Hub.log(Source.Babs, "Imported the world \"$folder\"")
        Hub.updateServerSettings { ServerConfig(worldsDir.parentFile!!).load(it.restartNeeded) }
        Hub.updateWorldImport { WorldImport(imported = folder) }
    }

    private fun progress(folder: String, done: Long, total: Long) {
        Hub.updateWorldImport {
            WorldImport(busy = "Copying \"$folder\"", progress = if (total > 0) (done.toFloat() / total).coerceIn(0f, 1f) else null)
        }
    }

    /** The server's level-name is the folder name, so it keeps to characters that are safe in both. */
    private fun uniqueFolder(worldsDir: File, name: String): String {
        val base = name.replace(Regex("§."), "") // Minecraft colour codes
            .replace(Regex("[^A-Za-z0-9 _'-]"), "")
            .trim().take(40).ifEmpty { "Imported world" }
        var candidate = base
        var n = 2
        while (File(worldsDir, candidate).exists()) candidate = "$base ($n)".also { n++ }
        return candidate
    }

    /** Refuses names that would land outside the world's folder, such as ../ in a zip. */
    private fun safeChild(parent: File, relative: String): File {
        val target = File(parent, relative)
        if (!target.canonicalPath.startsWith(parent.canonicalPath + File.separator)) {
            throw IOException("The world contains a file with an unsafe name: $relative")
        }
        return target
    }

    private fun checkSpace(worldsDir: File, total: Long) {
        worldsDir.mkdirs()
        val free = worldsDir.usableSpace
        if (total > 0 && free < total + 50L * 1024 * 1024) {
            throw IOException("Not enough space: the world needs ${total / 1_048_576} MB and ${free / 1_048_576} MB is free")
        }
    }

    private inline fun copy(input: InputStream, out: java.io.OutputStream, onProgress: (Long) -> Unit): Long {
        val buffer = ByteArray(64 * 1024)
        var copied = 0L
        var lastReport = 0L
        while (true) {
            val n = input.read(buffer)
            if (n < 0) break
            out.write(buffer, 0, n)
            copied += n
            if (copied - lastReport > 512 * 1024) {
                lastReport = copied
                onProgress(copied)
            }
        }
        return copied
    }

    private fun open(resolver: ContentResolver, uri: Uri): InputStream =
        resolver.openInputStream(uri) ?: throw IOException("Couldn't open the file")

    private class Doc(val id: String, val name: String, val isDir: Boolean, val size: Long)

    private fun list(resolver: ContentResolver, tree: Uri, parentId: String): List<Doc> {
        val uri = DocumentsContract.buildChildDocumentsUriUsingTree(tree, parentId)
        val columns = arrayOf(Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME, Document.COLUMN_MIME_TYPE, Document.COLUMN_SIZE)
        return resolver.query(uri, columns, null, null, null)?.use { c ->
            buildList {
                while (c.moveToNext()) {
                    add(Doc(c.getString(0), c.getString(1) ?: "", c.getString(2) == Document.MIME_TYPE_DIR, if (c.isNull(3)) 0 else c.getLong(3)))
                }
            }
        } ?: throw IOException("Couldn't read that folder")
    }

    private fun size(resolver: ContentResolver, tree: Uri, id: String): Long =
        list(resolver, tree, id).sumOf { if (it.isDir) size(resolver, tree, it.id) else it.size }

    private fun readText(resolver: ContentResolver, tree: Uri, id: String): String? = runCatching {
        open(resolver, DocumentsContract.buildDocumentUriUsingTree(tree, id)).use { it.readBytes().decodeToString().trim().take(80) }
    }.getOrNull()?.ifEmpty { null }

    private fun displayName(resolver: ContentResolver, uri: Uri): String? = runCatching {
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
            if (c.moveToFirst()) c.getString(0) else null
        }
    }.getOrNull()
}
