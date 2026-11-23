package app.babs.core

import android.os.Build
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.zip.Deflater
import java.util.zip.ZipEntry
import java.util.zip.ZipFile
import java.util.zip.ZipOutputStream

/** A clone, rename, backup or backup load, while it runs and just after. */
data class WorldTask(val busy: String? = null, val error: String? = null, val done: String? = null)

/**
 * A copy of a world that can be loaded as a new one: a zip from Back up, a .mcworld or folder put in the backups
 * folder, or one of AutoSave's copies from before and after a world's last session.
 */
data class Backup(
    val path: String,
    val name: String,
    /** "AutoSave: before the last session" and the like, or empty for an ordinary backup. */
    val label: String,
    val date: Long,
    val sizeBytes: Long,
)

/** World names and the folders they go in, as Bedrock Hub's engine/hub_rpc.py makes them. */
object WorldNames {
    private val BACKUP_FOLDER = Regex("""\.backup-\d{8}-\d{6}$""")
    private val RESERVED = setOf("con", "prn", "aux", "nul") + (1..9).flatMap { listOf("com$it", "lpt$it") }

    /** Without colour codes or control characters. */
    fun clean(raw: String) = raw.replace(Regex("§."), "").replace(Regex("[\\x00-\\x1f]"), "").trim()

    /** What's wrong with [raw] as a world name, or null when it's fine. */
    fun problem(raw: String): String? {
        val name = clean(raw)
        return when {
            name.isEmpty() || name.length > 60 -> "Use a name of 1 to 60 characters"
            BACKUP_FOLDER.containsMatchIn(name) -> "That looks like one of the dated backup folders. Choose another"
            else -> null
        }
    }

    /**
     * The folder for a world called [name]. The server stops reading level-name at an =, then quietly makes a new
     * empty world, so =, # and ! are left out as well as what folders can't have. The same rule as Bedrock Hub, so
     * a world keeps its folder name when it moves between them.
     */
    fun folderFor(name: String): String {
        val safe = clean(name)
            .replace(Regex("[<>:\"/\\\\|?*\\x00-\\x1f]"), "")
            .replace(Regex("\\s+"), " ")
            .trim(' ', '.').take(60).trim(' ', '.')
        val folder = safe.replace(Regex("[=#!]"), "").trim(' ', '.')
        val usable = if (!Regex("\\w").containsMatchIn(folder)) "World" else folder
        return if (usable.lowercase() in RESERVED) "$usable world" else usable
    }

    /** [base], or "base (2)" and so on when that's taken. */
    fun uniqueFolder(parent: File, base: String): File {
        var candidate = File(parent, base)
        var n = 2
        while (candidate.exists()) candidate = File(parent, "$base (${n++})")
        return candidate
    }
}

/**
 * Changes the world's name inside level.dat, as Bedrock Hub's with_level_name does: only the LevelName string
 * changes and every other byte is kept. Bedrock's level.dat is little-endian NBT after an 8-byte header.
 */
object LevelDat {
    fun withLevelName(data: ByteArray, name: String): ByteArray {
        val hasHeader = data.size > 8 && le(data).getInt(4) == data.size - 8
        val start = if (hasHeader) 8 else 0
        require(data[start].toInt() == 10) { "not a compound" }
        require(skip(data, start + 3 + u16(data, start + 1), 10) == data.size) { "unexpected data after the compound" }
        var pos = start + 3 + u16(data, start + 1)
        val value = name.toByteArray(Charsets.UTF_8)
        require(value.size <= 0xFFFF) { "name too long" }
        val key = "LevelName".toByteArray(Charsets.US_ASCII)
        val tag = ByteBuffer.allocate(3 + key.size + 2 + value.size).order(ByteOrder.LITTLE_ENDIAN)
            .put(8.toByte()).putShort(key.size.toShort()).put(key).putShort(value.size.toShort()).put(value).array()
        var out: ByteArray? = null
        while (out == null) {
            val type = data[pos].toInt() and 0xFF
            if (type == 0) {
                out = data.copyOfRange(0, pos) + tag + data.copyOfRange(pos, data.size)
                continue
            }
            val keyLength = u16(data, pos + 1)
            val end = skip(data, pos + 3 + keyLength, type)
            if (type == 8 && data.copyOfRange(pos + 3, pos + 3 + keyLength).contentEquals(key)) {
                out = data.copyOfRange(0, pos) + tag + data.copyOfRange(end, data.size)
                continue
            }
            pos = end
        }
        val result: ByteArray = out
        if (hasHeader) le(result).putInt(4, result.size - 8)
        require(skip(result, start + 3 + u16(result, start + 1), 10) == result.size) { "the new level.dat doesn't read back" }
        return result
    }

    private fun le(data: ByteArray) = ByteBuffer.wrap(data).order(ByteOrder.LITTLE_ENDIAN)
    private fun u16(data: ByteArray, at: Int) = le(data).getShort(at).toInt() and 0xFFFF
    private fun i32(data: ByteArray, at: Int) = le(data).getInt(at)

    /** The position just after one NBT value of [type] starting at [at]. */
    private fun skip(data: ByteArray, at: Int, type: Int): Int {
        var pos = at
        return when (type) {
            1 -> pos + 1
            2 -> pos + 2
            3, 5 -> pos + 4
            4, 6 -> pos + 8
            7 -> pos + 4 + i32(data, pos)
            8 -> pos + 2 + u16(data, pos)
            9 -> {
                val inner = data[pos].toInt() and 0xFF
                val count = i32(data, pos + 1)
                pos += 5
                repeat(count) { pos = skip(data, pos, inner) }
                pos
            }
            10 -> {
                while (true) {
                    val inner = data[pos].toInt() and 0xFF
                    pos += 1
                    if (inner == 0) break
                    pos += 2 + u16(data, pos)
                    pos = skip(data, pos, inner)
                }
                pos
            }
            11 -> pos + 4 + 4 * i32(data, pos)
            12 -> pos + 4 + 8 * i32(data, pos)
            else -> throw IllegalArgumentException("bad tag $type")
        }
    }
}

/**
 * AutoSave, the same as Bedrock Hub's `src/autosave.js` and in the same place (`backups/AutoSave/<world>/`):
 *
 * - `pregameplay`: how the world was when the server last started it
 * - `postgameplay`: how it was when the server last stopped
 *
 * Each start replaces pregameplay, and each stop replaces postgameplay, so there is always one copy from before
 * the last session and one from after it. `world.json` beside them says when each was taken and on which device,
 * in Bedrock Hub's format.
 */
class AutoSave(serverDir: File) {
    val root = File(serverDir, "backups/AutoSave")
    private val worldsDir = File(serverDir, "worlds")

    fun folderOf(world: String): File {
        require(world.isNotBlank() && world != "." && world != ".." && !world.contains('/')) { "That isn't a world folder" }
        return File(root, world)
    }

    fun before(world: String) = take(world, "pregameplay")
    fun after(world: String) = take(world, "postgameplay")

    /** Copies the world as it is now. False when it hasn't been made yet. */
    private fun take(world: String, kind: String): Boolean {
        val source = File(worldsDir, world)
        if (!File(source, "level.dat").isFile) return false
        val dir = folderOf(world).apply { mkdirs() }
        val need = source.walkTopDown().filter { it.isFile }.sumOf { it.length() }
        if (need + need / 10 > dir.usableSpace) {
            throw IOException("not enough space on the phone for a copy (${need / 1_048_576} MB)")
        }
        val target = File(dir, kind)
        val tmp = File(dir, "$kind.saving")
        tmp.deleteRecursively()
        try {
            if (!source.copyRecursively(tmp, overwrite = true)) throw IOException("the copy didn't finish")
        } catch (e: Exception) {
            tmp.deleteRecursively()
            throw e
        }
        target.deleteRecursively()
        if (!tmp.renameTo(target)) {
            tmp.deleteRecursively()
            throw IOException("couldn't put the copy in place")
        }

        val meta = meta(world)
        val name = runCatching { File(source, "levelname.txt").readText().trim() }.getOrNull()?.ifEmpty { null }
        meta.put("folder", world)
        meta.put("name", name ?: meta.optString("name").ifEmpty { world })
        meta.put(if (kind == "pregameplay") "pre" else "post", JSONObject().put("at", System.currentTimeMillis()).put("device", device))
        if (kind == "postgameplay") meta.put("changed", true) // not in GitHub Cloud yet, as Bedrock Hub marks it
        saveMeta(world, meta)
        Hub.log(Source.Babs, "AutoSave: saved \"${meta.optString("name")}\" ${if (kind == "pregameplay") "before" else "after"} this session")
        return true
    }

    fun has(world: String, kind: String) = File(folderOf(world), "$kind/level.dat").isFile

    /** world.json, or a new one with nothing uploaded yet. */
    fun meta(world: String): JSONObject = runCatching { JSONObject(File(folderOf(world), "world.json").readText()) }
        .getOrElse { JSONObject().put("folder", world).put("name", world).put("rev", 0).put("syncedRev", 0) }

    fun saveMeta(world: String, meta: JSONObject) {
        val dir = folderOf(world).apply { mkdirs() }
        val part = File(dir, "world.json.tmp")
        part.writeText(meta.toString(2))
        if (!part.renameTo(File(dir, "world.json"))) {
            File(dir, "world.json").writeText(meta.toString(2))
            part.delete()
        }
    }

    /** Worlds with at least one copy. */
    fun worlds(): List<String> = root.listFiles { f -> f.isDirectory }.orEmpty()
        .filter { w -> KINDS.any { has(w.name, it) } }.map { it.name }

    /**
     * Puts the world back from its postgameplay copy, for a newer save from another device, as Bedrock Hub's
     * restoreWorld. What it replaces is kept as "replaced", and the world keeps its own pack folders, which cloud
     * saves leave out.
     */
    fun restoreWorld(world: String) {
        val save = File(folderOf(world), "postgameplay")
        if (!File(save, "level.dat").isFile) throw IOException("There is no save to load")
        val target = File(worldsDir, world)
        val replaced = File(folderOf(world), "replaced")
        worldsDir.mkdirs()
        if (target.exists()) {
            replaced.deleteRecursively()
            if (!target.renameTo(replaced)) throw IOException("Couldn't move the world aside")
        }
        try {
            if (!save.copyRecursively(target, overwrite = true)) throw IOException("The copy didn't finish")
        } catch (e: Exception) {
            target.deleteRecursively()
            if (replaced.exists()) replaced.renameTo(target)
            throw e
        }
        for (dir in PACK_DIRS) {
            val kept = File(replaced, dir)
            if (!File(target, dir).exists() && kept.exists()) kept.copyRecursively(File(target, dir), overwrite = true)
        }
        Hub.log(Source.Babs, "AutoSave: loaded \"${meta(world).optString("name", world)}\" from its latest save. The copy it replaced is kept as a backup")
    }

    companion object {
        val KINDS = listOf("pregameplay", "postgameplay")
        val PACK_DIRS = listOf("behavior_packs", "resource_packs")
        val device = "${Build.MANUFACTURER} ${Build.MODEL}".trim()
    }
}

/**
 * The Worlds tab's longer jobs: clone, rename, back up, and load or delete a backup. They run one at a time in
 * their own scope, so turning the phone doesn't stop them, and report through [Hub.worldTask].
 */
object WorldOps {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var job: Job? = null

    /** The world the server has open. Its files are locked while it runs, as on Windows in Bedrock Hub. */
    private fun hostedAndRunning(folder: String): Boolean {
        val state = Hub.server.value.state
        return folder == Hub.serverSettings.value.currentWorld &&
            (state == RunState.Starting || state == RunState.Running || state == RunState.Stopping)
    }

    fun clone(serverDir: File, folder: String, rawName: String) = launchTask("Cloning") {
        val worldsDir = File(serverDir, "worlds")
        val source = world(worldsDir, folder)
        if (hostedAndRunning(folder)) throw IOException("The server has this world open. Stop it first, or Export it, which works while it runs")
        val name = checkedName(rawName)
        val need = sizeOf(source)
        checkSpace(worldsDir, need)
        val dest = WorldNames.uniqueFolder(worldsDir, WorldNames.folderFor(name))
        val tmp = File(worldsDir, ".babs-clone-${System.currentTimeMillis()}")
        Hub.updateWorldTask { WorldTask(busy = "Cloning \"${displayName(source)}\" as \"$name\"") }
        try {
            if (!source.copyRecursively(tmp, overwrite = true)) throw IOException("The copy didn't finish")
            setNames(tmp, name)
            if (!tmp.renameTo(dest)) throw IOException("Couldn't put the copy in place")
        } catch (e: Exception) {
            tmp.deleteRecursively()
            throw e
        }
        Hub.log(Source.Babs, "Cloned \"${displayName(source)}\" as \"$name\" (folder ${dest.name}). It has its own copy of the world's packs")
        reload(serverDir)
        "Cloned as \"$name\"."
    }

    fun rename(serverDir: File, folder: String, rawName: String) = launchTask("Renaming") {
        val worldsDir = File(serverDir, "worlds")
        val source = world(worldsDir, folder)
        if (hostedAndRunning(folder)) throw IOException("The server has this world open. Stop it first, then rename it")
        val name = checkedName(rawName)
        val wanted = WorldNames.folderFor(name)
        // Same folder, or only its capitals change: keep it. Otherwise a free folder name.
        val dest = if (wanted.equals(source.name, ignoreCase = true)) File(worldsDir, wanted) else WorldNames.uniqueFolder(worldsDir, wanted)
        if (dest.name != source.name) {
            if (wanted.equals(source.name, ignoreCase = true)) {
                // A rename that only changes capitals goes through another name first.
                val step = File(worldsDir, ".babs-rename-${System.currentTimeMillis()}")
                if (!source.renameTo(step) || !step.renameTo(dest)) throw IOException("Couldn't rename the folder")
            } else if (!source.renameTo(dest)) {
                throw IOException("Couldn't rename the folder")
            }
        }
        setNames(dest, name)
        val config = ServerConfig(serverDir)
        if (config.properties()["level-name"] == source.name && dest.name != source.name) {
            config.setProperties(mapOf("level-name" to dest.name))
        }
        Hub.log(Source.Babs, "Renamed the world \"${source.name}\" to \"$name\" (folder ${dest.name})")
        reload(serverDir)
        "Renamed to \"$name\"."
    }

    /** A zip of the world in the backups folder, named as Bedrock Hub names them. */
    fun backup(serverDir: File, folder: String) = launchTask("Backing up") {
        val source = world(File(serverDir, "worlds"), folder)
        if (hostedAndRunning(folder)) throw IOException("The server has this world open. Stop it first, or Export it, which works while it runs")
        val dir = File(serverDir, "backups").apply { mkdirs() }
        val need = sizeOf(source)
        checkSpace(dir, need / 2)
        val name = displayName(source)
        val stamp = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date())
        val out = File(dir, "${WorldNames.folderFor(name)}_$stamp.zip")
        val part = File(dir, out.name + ".part")
        Hub.updateWorldTask { WorldTask(busy = "Backing up \"$name\"") }
        try {
            ZipOutputStream(part.outputStream().buffered()).use { zip ->
                zip.setLevel(Deflater.BEST_SPEED)
                source.walkTopDown().filter { it.isFile }.forEach { file ->
                    zip.putNextEntry(ZipEntry(source.name + "/" + file.relativeTo(source).invariantSeparatorsPath))
                    file.inputStream().use { it.copyTo(zip) }
                    zip.closeEntry()
                }
            }
            if (!part.renameTo(out)) throw IOException("Couldn't save the backup")
        } catch (e: Exception) {
            part.delete()
            throw e
        }
        Hub.log(Source.Babs, "Backed up \"$name\" to backups/${out.name}")
        "Backed up \"$name\". It's under Backups."
    }

    /** A backup always loads as a new world, so nothing is overwritten. */
    fun loadBackup(serverDir: File, backup: Backup, rawName: String) = launchTask("Loading") {
        val worldsDir = File(serverDir, "worlds")
        val src = File(backup.path)
        if (!src.exists()) throw IOException("That backup isn't there any more")
        val name = checkedName(rawName)
        val tmp = File(worldsDir, ".babs-load-${System.currentTimeMillis()}")
        Hub.updateWorldTask { WorldTask(busy = "Loading \"${backup.name}\" as \"$name\"") }
        try {
            if (src.isDirectory) {
                checkSpace(worldsDir, sizeOf(src))
                if (!src.copyRecursively(tmp, overwrite = true)) throw IOException("The copy didn't finish")
            } else {
                checkSpace(worldsDir, src.length() * 3)
                unzipWorld(src, tmp)
            }
            if (!File(tmp, "level.dat").isFile) throw IOException("That backup doesn't contain a world (no level.dat)")
            setNames(tmp, name)
            val dest = WorldNames.uniqueFolder(worldsDir, WorldNames.folderFor(name))
            if (!tmp.renameTo(dest)) throw IOException("Couldn't put the world in place")
            Hub.log(Source.Babs, "Loaded the backup ${src.name} as a new world, \"$name\" (folder ${dest.name}). The backup wasn't changed")
        } catch (e: Exception) {
            tmp.deleteRecursively()
            throw e
        }
        reload(serverDir)
        "Loaded as \"$name\"."
    }

    fun deleteBackup(serverDir: File, backup: Backup) = launchTask("Deleting") {
        val file = File(backup.path)
        val backupsDir = File(serverDir, "backups").canonicalPath + File.separator
        if (!file.canonicalPath.startsWith(backupsDir)) throw IOException("That isn't in the backups folder")
        if (!file.deleteRecursively()) throw IOException("Couldn't delete it")
        Hub.log(Source.Babs, "Deleted the backup ${if (backup.label.isNotEmpty()) "${backup.label} of " else ""}\"${backup.name}\"")
        "Deleted."
    }

    fun dismiss() = Hub.updateWorldTask { WorldTask() }

    /**
     * Every backup, newest first: zips, .mcworld files and world folders in the backups folder, and AutoSave's
     * copies. Blocking, as it sizes folders.
     */
    fun backups(serverDir: File): List<Backup> {
        val dir = File(serverDir, "backups")
        val rows = mutableListOf<Backup>()
        dir.listFiles().orEmpty().forEach { entry ->
            when {
                entry.name == "AutoSave" || entry.name.startsWith(".") -> Unit
                entry.isDirectory && File(entry, "level.dat").isFile ->
                    rows += Backup(entry.path, displayName(entry), "", entry.lastModified(), sizeOf(entry))
                entry.isFile && entry.extension.lowercase() in setOf("zip", "mcworld") -> zipName(entry)?.let {
                    rows += Backup(entry.path, it, "", entry.lastModified(), entry.length())
                }
            }
        }
        File(dir, "AutoSave").listFiles { f -> f.isDirectory }.orEmpty().forEach { world ->
            val meta = runCatching { JSONObject(File(world, "world.json").readText()) }.getOrNull()
            for ((kind, label, key) in AUTOSAVE_KINDS) {
                val copy = File(world, kind)
                if (!File(copy, "level.dat").isFile) continue
                val taken = meta?.optJSONObject(key)?.optLong("at")?.takeIf { it > 0 } ?: copy.lastModified()
                rows += Backup(copy.path, displayName(copy), label, taken, sizeOf(copy))
            }
        }
        return rows.sortedByDescending { it.date }
    }

    private val AUTOSAVE_KINDS = listOf(
        Triple("pregameplay", "AutoSave: before the last session", "pre"),
        Triple("postgameplay", "AutoSave: after the last session", "post"),
        Triple("replaced", "AutoSave: replaced by a cloud download", ""),
    )

    private fun launchTask(verb: String, work: () -> String) {
        if (job?.isActive == true) return
        Hub.updateWorldTask { WorldTask(busy = "$verb…") }
        job = scope.launch {
            try {
                val done = work()
                Hub.updateWorldTask { WorldTask(done = done) }
            } catch (e: Exception) {
                val message = e.message ?: e.javaClass.simpleName
                Hub.log(Source.Babs, "$verb failed: $message")
                Hub.updateWorldTask { WorldTask(error = message) }
            }
        }
    }

    private fun world(worldsDir: File, folder: String): File {
        if (folder.isBlank() || folder.startsWith(".") || "/" in folder) throw IOException("That isn't a world folder")
        val dir = File(worldsDir, folder)
        if (!File(dir, "level.dat").isFile) throw IOException("That world hasn't been made yet. Start the server on it first")
        return dir
    }

    private fun checkedName(raw: String): String {
        WorldNames.problem(raw)?.let { throw IOException(it) }
        return WorldNames.clean(raw)
    }

    /** The name shown in the game and in world lists: levelname.txt, and LevelName in level.dat when it can be. */
    private fun setNames(dir: File, name: String) {
        val dat = File(dir, "level.dat")
        runCatching {
            val updated = LevelDat.withLevelName(dat.readBytes(), name)
            val tmp = File(dir, "level.dat.babstmp")
            tmp.writeBytes(updated)
            if (!tmp.renameTo(dat)) {
                tmp.delete()
                throw IOException("couldn't replace it")
            }
        }.onFailure {
            Hub.log(Source.Babs, "level.dat in \"${dir.name}\" couldn't be updated (${it.message}), so only levelname.txt has the new name")
        }
        File(dir, "levelname.txt").writeText(name)
    }

    private fun displayName(dir: File) =
        runCatching { WorldNames.clean(File(dir, "levelname.txt").readText()) }.getOrNull()?.ifEmpty { null } ?: dir.name

    private fun sizeOf(dir: File) = dir.walkTopDown().filter { it.isFile }.sumOf { it.length() }

    private fun checkSpace(dir: File, need: Long) {
        dir.mkdirs()
        val free = dir.usableSpace
        if (need + need / 10 > free) {
            throw IOException("Not enough space: about ${need / 1_048_576} MB needed, ${free / 1_048_576} MB free")
        }
    }

    /** The world's name from a backup zip's levelname.txt, or the file's name. Null when it holds no world. */
    private fun zipName(file: File): String? = runCatching {
        ZipFile(file).use { zip ->
            val base = worldBase(zip) ?: return null
            zip.getEntry(base + "levelname.txt")?.let { entry ->
                WorldNames.clean(zip.getInputStream(entry).bufferedReader().readText()).ifEmpty { null }
            } ?: file.nameWithoutExtension
        }
    }.getOrNull()

    /** The folder inside the zip that holds level.dat, nearest the top: "" or "World/". */
    private fun worldBase(zip: ZipFile): String? = zip.entries().asSequence()
        .map { it.name.replace('\\', '/') }
        .filter { it.substringAfterLast('/') == "level.dat" }
        .minByOrNull { it.count { c -> c == '/' } }
        ?.removeSuffix("level.dat")

    private fun unzipWorld(file: File, into: File) {
        into.mkdirs()
        val root = into.canonicalPath + File.separator
        ZipFile(file).use { zip ->
            val base = worldBase(zip) ?: throw IOException("That backup doesn't contain a world (no level.dat)")
            zip.entries().asSequence().forEach { entry ->
                val name = entry.name.replace('\\', '/')
                if (!name.startsWith(base) || name.length == base.length) return@forEach
                val target = File(into, name.removePrefix(base))
                if (!target.canonicalPath.startsWith(root)) throw IOException("The backup contains a file with an unsafe name: $name")
                if (entry.isDirectory) target.mkdirs() else {
                    target.parentFile?.mkdirs()
                    zip.getInputStream(entry).use { input -> target.outputStream().use { input.copyTo(it) } }
                }
            }
        }
    }

    private fun reload(serverDir: File) = Hub.updateServerSettings { ServerConfig(serverDir).load(it.restartNeeded) }
}
