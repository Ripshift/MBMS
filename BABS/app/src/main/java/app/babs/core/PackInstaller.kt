package app.babs.core

import android.content.Context
import android.net.Uri
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.util.zip.ZipInputStream

/** A pack in a world, as world_behavior_packs.json or world_resource_packs.json lists it. */
data class WorldPack(val name: String, val uuid: String, val version: String, val behavior: Boolean)

/** A pack kept in the mod library, ready to add to any world. */
data class LibraryPack(val name: String, val uuid: String, val version: String, val behavior: Boolean, val folder: String)

/** An Add Pack to World in progress, or what the last one did. */
data class PackImport(val busy: String? = null, val error: String? = null, val done: String? = null, val warnings: List<String> = emptyList())

/**
 * Add Pack to World: puts the packs from a .mcaddon, .mcpack or .zip into the world the server runs, the way
 * Bedrock Hub and the Mod Loader do (engine/addon_engine.py):
 *
 * - each pack goes in the world's behavior_packs or resource_packs as "<name>_<first 8 of its uuid>",
 *   replacing an older copy of the same pack wherever it is
 * - world_behavior_packs.json and world_resource_packs.json get its pack_id and version, and the first time a
 *   file is changed, the original is kept as <file>.bak_addonloader
 * - the kind comes from the manifest's modules: resources is a resource pack, data and script are behavior
 *   packs; skin packs and world templates aren't for a world, so they're left out
 *
 * The server reads packs when it starts, so it needs a restart to load them.
 */
object PackInstaller {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var job: Job? = null

    private val ARCHIVES = setOf("mcaddon", "mcpack", "zip")
    private val LANG_KEY = Regex("^[A-Za-z0-9_]+(?:\\.[A-Za-z0-9_:]+)+$")

    private class Pack(
        val dir: File,
        val uuid: String,
        val version: List<Int>,
        val name: String,
        val behavior: Boolean,
        val betaApis: Boolean,
        val deps: Set<String>,
    )

    /** What's in the world now, with names from the packs' own manifests. */
    fun list(worldDir: File): List<WorldPack> {
        val names = installed(worldDir).associate { it.uuid to it.name }
        return listOf(true, false).flatMap { behavior ->
            val file = File(worldDir, if (behavior) "world_behavior_packs.json" else "world_resource_packs.json")
            val json = runCatching { JSONArray(file.readText()) }.getOrNull() ?: return@flatMap emptyList()
            (0 until json.length()).mapNotNull { i ->
                val entry = json.optJSONObject(i) ?: return@mapNotNull null
                val uuid = entry.optString("pack_id").lowercase().ifEmpty { return@mapNotNull null }
                WorldPack(names[uuid] ?: uuid.take(8), uuid, versionText(entry.opt("version")), behavior)
            }
        }
    }

    /** Opens a .mcaddon, .mcpack or .zip into [work] and reads its packs. Throws when there's nothing usable. */
    private fun unpack(context: Context, uri: Uri, work: File, skipped: MutableList<String>): List<Pack> {
        val unpacked = File(work, "x").apply { mkdirs() }
        (context.contentResolver.openInputStream(uri) ?: throw IOException("Couldn't open the file")).use { unzip(it, unpacked) }
        // A .mcaddon often holds .mcpack files, sometimes another level down.
        repeat(3) {
            unpacked.walkTopDown().filter { it.isFile && it.extension.lowercase() in ARCHIVES }.toList().forEach { inner ->
                runCatching { inner.inputStream().use { unzip(it, File(inner.parentFile, inner.nameWithoutExtension + "_unpacked")) } }
                inner.delete()
            }
        }
        val packs = unpacked.walkTopDown().filter { it.isFile && it.name.equals("manifest.json", true) }.mapNotNull { manifest ->
            readPack(manifest.parentFile!!, skipped)
        }.distinctBy { it.uuid }.toList()
        if (packs.isEmpty()) {
            throw IOException(
                if (skipped.isNotEmpty()) "Nothing to add: ${skipped.joinToString()}"
                else "That isn't a Minecraft pack (no manifest.json). Pick a .mcaddon or .mcpack",
            )
        }
        return packs
    }

    fun add(context: Context, uri: Uri, worldDir: File, serverRunning: Boolean) {
        if (job?.isActive == true) return
        job = scope.launch {
            val work = File(context.cacheDir, "pack-import-${System.currentTimeMillis()}")
            try {
                Hub.updatePackImport { PackImport(busy = "Opening the pack") }
                if (!File(worldDir, "level.dat").exists()) {
                    throw IOException("The server's world hasn't been made yet. Start the server once, then add packs")
                }
                val skipped = mutableListOf<String>()
                val packs = unpack(context, uri, work, skipped)
                // Every pack added to a world is kept in the library too, so it can go in other worlds.
                val library = libraryDir(context)
                packs.forEach { pack -> runCatching { keep(pack, library) }.onFailure { Hub.log(Source.Babs, "Couldn't keep ${pack.name} in the mod library: ${it.message}") } }

                val existing = installed(worldDir).associateBy { it.uuid }
                packs.forEachIndexed { i, pack ->
                    Hub.updatePackImport { PackImport(busy = "Adding ${pack.name} (${i + 1} of ${packs.size})") }
                    copyIn(pack, worldDir, existing[pack.uuid]?.dir)
                }
                listOf(true, false).forEach { behavior -> register(worldDir, packs.filter { it.behavior == behavior }, behavior) }

                val names = packs.joinToString { it.name }
                Hub.log(Source.Babs, "Added to \"${worldDir.name}\": $names${if (serverRunning) ". Restart the server to load them" else ""}")
                if (serverRunning) Hub.updateServerSettings { it.copy(restartNeeded = true) }
                Hub.updatePackImport {
                    PackImport(
                        done = "Added $names." + if (serverRunning) " Restart the server to load ${if (packs.size == 1) "it" else "them"}." else "",
                        warnings = skipped.map { "Left out $it" } + packs.filter { it.betaApis }.map {
                            "${it.name} uses Beta APIs. Turn on that experiment for the world in Minecraft, or it won't run"
                        },
                    )
                }
            } catch (e: Throwable) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                val message = e.message ?: e.javaClass.simpleName
                Hub.log(Source.Babs, "Adding the pack failed: $message")
                Hub.updatePackImport { PackImport(error = message) }
            } finally {
                work.deleteRecursively()
            }
        }
    }

    fun dismiss() = Hub.updatePackImport { PackImport() }

    // ---------------------------------------------------------------- the mod library

    /**
     * The mod library, laid out as Bedrock Hub's (`engine/hub_library.py`), so its GitHub repo works on both: one
     * folder per pack in `files/library/`, named "<name>_<first 8 of its uuid>", beside Bedrock Hub's library.json,
     * which BABS leaves alone. Packs added to a world are kept here, and Import adds without a world. From here a
     * pack goes into any world, and GitHub Cloud puts a downloaded world's packs back from it.
     */
    fun libraryDir(context: Context) = File(context.filesDir, "library")

    fun library(dir: File): List<LibraryPack> = libraryPacks(dir)
        .map { LibraryPack(it.name, it.uuid, it.version.joinToString("."), it.behavior, it.dir.name) }
        .sortedBy { it.name.lowercase() }

    /** Copies a pack into the library, replacing an older copy of the same pack. */
    private fun keep(pack: Pack, library: File) {
        val parent = library.apply { mkdirs() }
        val old = allLibraryPacks(library).filter { it.uuid == pack.uuid }.map { it.dir }
        val tmp = File(parent, ".hubtmp-${pack.uuid.take(8)}")
        tmp.deleteRecursively()
        if (!pack.dir.copyRecursively(tmp, overwrite = true)) throw IOException("the copy didn't finish")
        old.forEach { it.deleteRecursively() }
        val final = File(parent, "${safeName(pack.name, 48).ifEmpty { "Mod" }}_${pack.uuid.take(8)}")
        final.deleteRecursively()
        if (!tmp.renameTo(final)) {
            tmp.deleteRecursively()
            throw IOException("couldn't put it in place")
        }
    }

    /** Import to library: keeps the packs from a .mcaddon or .mcpack without adding them to a world. */
    fun importToLibrary(context: Context, uri: Uri) {
        if (job?.isActive == true) return
        job = scope.launch {
            val work = File(context.cacheDir, "pack-import-${System.currentTimeMillis()}")
            try {
                Hub.updatePackImport { PackImport(busy = "Opening the pack") }
                val skipped = mutableListOf<String>()
                val packs = unpack(context, uri, work, skipped)
                packs.forEach { keep(it, libraryDir(context)) }
                val names = packs.joinToString { it.name }
                Hub.log(Source.Babs, "Added to the mod library: $names")
                Hub.bumpPacks()
                Hub.updatePackImport { PackImport(done = "Added $names to the library.", warnings = skipped.map { "Left out $it" }) }
            } catch (e: Throwable) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                val message = e.message ?: e.javaClass.simpleName
                Hub.log(Source.Babs, "Importing the pack failed: $message")
                Hub.updatePackImport { PackImport(error = message) }
            } finally {
                work.deleteRecursively()
            }
        }
    }

    /** Adds library packs to a world, the same as adding them from a file. */
    fun addFromLibrary(context: Context, uuids: Set<String>, worldDir: File, serverRunning: Boolean) {
        if (job?.isActive == true || uuids.isEmpty()) return
        job = scope.launch {
            try {
                if (!File(worldDir, "level.dat").exists()) {
                    throw IOException("The server's world hasn't been made yet. Start the server once, then add packs")
                }
                val packs = libraryPacks(libraryDir(context)).filter { it.uuid in uuids }
                if (packs.isEmpty()) throw IOException("Those packs aren't in the library any more")
                val existing = installed(worldDir).associateBy { it.uuid }
                packs.forEachIndexed { i, pack ->
                    Hub.updatePackImport { PackImport(busy = "Adding ${pack.name} (${i + 1} of ${packs.size})") }
                    copyIn(pack, worldDir, existing[pack.uuid]?.dir)
                }
                listOf(true, false).forEach { behavior -> register(worldDir, packs.filter { it.behavior == behavior }, behavior) }
                val names = packs.joinToString { it.name }
                Hub.log(Source.Babs, "Added to \"${worldDir.name}\" from the library: $names${if (serverRunning) ". Restart the server to load them" else ""}")
                if (serverRunning) Hub.updateServerSettings { it.copy(restartNeeded = true) }
                Hub.updatePackImport {
                    PackImport(
                        done = "Added $names." + if (serverRunning) " Restart the server to load ${if (packs.size == 1) "it" else "them"}." else "",
                        warnings = packs.filter { it.betaApis }.map { "${it.name} uses Beta APIs. Turn on that experiment for the world in Minecraft, or it won't run" },
                    )
                }
            } catch (e: Throwable) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                val message = e.message ?: e.javaClass.simpleName
                Hub.log(Source.Babs, "Adding the pack failed: $message")
                Hub.updatePackImport { PackImport(error = message) }
            }
        }
    }

    /** Deletes a pack from the library. Worlds that use it keep their own copies. Blocking. */
    fun deleteFromLibrary(library: File, uuid: String) {
        val copies = allLibraryPacks(library).filter { it.uuid == uuid.lowercase() }
        val pack = copies.firstOrNull() ?: return
        copies.forEach { if (!it.dir.deleteRecursively()) throw IOException("Couldn't delete ${pack.name}") }
        Hub.log(Source.Babs, "Deleted ${pack.name} from the mod library. Worlds that use it keep their copies")
    }

    /**
     * Puts back the packs a world lists but doesn't have, from the library, as Bedrock Hub does after a GitHub Cloud
     * download (cloud saves leave packs out). Leaves the world's lists alone. Blocking. Returns the names put back.
     */
    fun restoreFromLibrary(library: File, worldDir: File, uuids: Collection<String>): List<String> {
        val have = installedIds(worldDir)
        val wanted = uuids.map { it.lowercase() }.filter { it !in have }.toSet()
        if (wanted.isEmpty()) return emptyList()
        return libraryPacks(library).filter { it.uuid in wanted }.mapNotNull { pack ->
            runCatching { copyIn(pack, worldDir, null) }.map { pack.name }.getOrNull()
        }
    }

    /** Copies every pack the worlds have into the library, for packs added before there was one. Blocking. Returns how many. */
    fun collectFromWorlds(library: File, worldsDir: File): Int {
        val have = libraryPacks(library).map { it.uuid }.toMutableSet()
        var added = 0
        worldsDir.listFiles { f -> f.isDirectory }.orEmpty().forEach { world ->
            installed(world).filter { it.uuid !in have }.forEach { pack ->
                runCatching { keep(pack, library) }.onSuccess {
                    have += pack.uuid
                    added++
                }
            }
        }
        Hub.log(Source.Babs, if (added == 0) "The mod library already has every pack your worlds use" else "Copied $added packs from your worlds into the mod library")
        return added
    }

    /** The library's packs, the newest copy of each where Bedrock Hub left more than one. */
    private fun libraryPacks(library: File): List<Pack> = allLibraryPacks(library)
        .groupBy { it.uuid }.values.map { copies -> copies.maxWith(compareBy({ it.version.getOrElse(0) { 0 } }, { it.version.getOrElse(1) { 0 } }, { it.version.getOrElse(2) { 0 } })) }

    private fun allLibraryPacks(library: File): List<Pack> =
        library.listFiles { f -> f.isDirectory && !f.name.startsWith(".") }.orEmpty()
            .flatMap { top ->
                // A pack folder, or a folder holding a .mcaddon's packs, as Bedrock Hub's library can have
                readPack(top, mutableListOf())?.let { listOf(it) }
                    ?: top.listFiles { f -> f.isDirectory }.orEmpty().mapNotNull { readPack(it, mutableListOf()) }
            }

    /**
     * Takes a pack out of a world, as Bedrock Hub's Remove from world does: its entry in the world's list, and the
     * world's own copy of it in behavior_packs or resource_packs. Blocking. Returns the pack's name.
     */
    fun remove(worldDir: File, uuid: String, behavior: Boolean): String {
        val id = uuid.lowercase()
        val copy = installed(worldDir).firstOrNull { it.uuid == id && it.behavior == behavior }
        val name = copy?.name ?: id.take(8)
        editList(worldDir, behavior) { entries -> entries.filterNot { it.optString("pack_id").lowercase() == id } }
        if (copy != null && !copy.dir.deleteRecursively()) throw IOException("Couldn't delete the world's copy of $name")
        Hub.log(Source.Babs, "Removed $name from \"${worldDir.name}\"")
        return name
    }

    /**
     * Moves a pack [by] places in the world's list, -1 for earlier (loses to more) and 1 for later (wins over
     * more). The next pack added keeps this order, except where a rule needs a pack after another. Blocking.
     */
    fun move(worldDir: File, uuid: String, behavior: Boolean, by: Int) {
        val id = uuid.lowercase()
        editList(worldDir, behavior) { entries ->
            val list = entries.toMutableList()
            val from = list.indexOfFirst { it.optString("pack_id").lowercase() == id }
            val to = from + by
            if (from < 0 || to !in list.indices) return@editList entries
            list.add(to, list.removeAt(from))
            list
        }
    }

    /** Rewrites a world's pack list, keeping the original once as <file>.bak_addonloader, as the Mod Loader does. */
    private fun editList(worldDir: File, behavior: Boolean, change: (List<JSONObject>) -> List<JSONObject>) {
        val name = if (behavior) "world_behavior_packs.json" else "world_resource_packs.json"
        val file = File(worldDir, name)
        if (!file.exists()) return
        val data = runCatching { JSONArray(file.readText().removePrefix("\uFEFF")) }.getOrElse {
            throw IOException("The world's $name can't be read, so it was left alone")
        }
        val entries = (0 until data.length()).mapNotNull { data.optJSONObject(it) }
        val changed = change(entries)
        if (changed == entries) return
        val backup = File(worldDir, "$name.bak_addonloader")
        if (!backup.exists()) file.copyTo(backup)
        val text = JSONArray(changed).toString(2)
        val part = File(worldDir, "$name.part")
        part.writeText(text)
        if (!part.renameTo(file)) {
            file.writeText(text)
            part.delete()
        }
    }

    /** The pack in [dir], or null with the reason in [skipped] when it isn't one a world can use. */
    private fun readPack(dir: File, skipped: MutableList<String>): Pack? {
        val json = runCatching { JSONObject(File(dir, "manifest.json").readText().removePrefix("﻿")) }.getOrNull() ?: run {
            skipped += "${dir.name} (its manifest.json can't be read)"
            return null
        }
        val header = json.optJSONObject("header") ?: return null
        val uuid = header.optString("uuid").lowercase().takeIf { it.isNotEmpty() } ?: return null
        val name = displayName(dir, header.optString("name")).ifEmpty { dir.name }
        val modules = json.optJSONArray("modules") ?: JSONArray()
        val types = (0 until modules.length()).mapNotNull { modules.optJSONObject(it)?.optString("type")?.lowercase() }.toSet()
        val behavior = when {
            "resources" in types -> false
            "skin_pack" in types -> { skipped += "$name (a skin pack)"; return null }
            "world_template" in types -> { skipped += "$name (a world template; import it as a world instead)"; return null }
            types.any { it in setOf("data", "script", "client_data", "interface", "javascript") } -> true
            else -> { skipped += "$name (unknown kind)"; return null }
        }
        val deps = json.optJSONArray("dependencies") ?: JSONArray()
        val beta = (0 until deps.length()).any { versionText(deps.optJSONObject(it)?.opt("version")).contains("beta") }
        val depIds = (0 until deps.length()).mapNotNull { deps.optJSONObject(it)?.optString("uuid")?.lowercase()?.ifEmpty { null } }.toSet()
        return Pack(dir, uuid, versionList(header.opt("version")), name, behavior, beta, depIds)
    }

    /** The manifest's name, looked up in texts/en_US.lang when it's a key like pack.name, without colour codes. */
    private fun displayName(dir: File, raw: String): String {
        var name = raw
        if (LANG_KEY.matches(raw)) {
            val lang = File(dir, "texts/en_US.lang")
            name = runCatching { lang.readLines().firstOrNull { it.startsWith("$raw=") }?.substringAfter('=') }.getOrNull() ?: raw
        }
        return name.replace(Regex("§."), "").substringBefore('\t').trim()
    }

    /** The uuids of the packs in the world's own folders. */
    fun installedIds(worldDir: File): Set<String> = installed(worldDir).map { it.uuid }.toSet()

    /** Packs already in the world's folders, by uuid. */
    private fun installed(worldDir: File): List<Pack> = listOf("behavior_packs", "resource_packs").flatMap { folder ->
        File(worldDir, folder).listFiles { f -> f.isDirectory }.orEmpty().mapNotNull { readPack(it, mutableListOf()) }
    }

    /** Copies into a temporary folder next to where it goes, then swaps it in, as the add-on engine does. */
    private fun copyIn(pack: Pack, worldDir: File, existing: File?) {
        val parent = File(worldDir, if (pack.behavior) "behavior_packs" else "resource_packs").apply { mkdirs() }
        val tmp = File(parent, ".addonloader_${pack.uuid.take(8)}_tmp")
        tmp.deleteRecursively()
        if (!pack.dir.copyRecursively(tmp, overwrite = true)) throw IOException("Couldn't copy ${pack.name}")
        val final = existing?.takeIf { it.parentFile == parent } ?: File(parent, "${safeName(pack.name)}_${pack.uuid.take(8)}")
        existing?.deleteRecursively()
        final.deleteRecursively()
        if (!tmp.renameTo(final)) {
            tmp.deleteRecursively()
            throw IOException("Couldn't put ${pack.name} in place")
        }
    }

    /** Adds each pack to the world's list, or updates its version, keeping the original file once. */
    private fun register(worldDir: File, packs: List<Pack>, behavior: Boolean) {
        if (packs.isEmpty()) return
        val name = if (behavior) "world_behavior_packs.json" else "world_resource_packs.json"
        val file = File(worldDir, name)
        val data = if (file.exists()) {
            runCatching { JSONArray(file.readText().removePrefix("﻿")) }.getOrElse {
                throw IOException("The world's $name can't be read, so it was left alone")
            }.also {
                val backup = File(worldDir, "$name.bak_addonloader")
                if (!backup.exists()) file.copyTo(backup)
            }
        } else JSONArray()
        // The order before this add, which the automatic order keeps, placing only the new packs.
        val before = (0 until data.length()).mapNotNull { data.optJSONObject(it)?.optString("pack_id")?.lowercase() }
        for (pack in packs) {
            val index = (0 until data.length()).firstOrNull { data.optJSONObject(it)?.optString("pack_id")?.lowercase() == pack.uuid }
            val entry = JSONObject().put("pack_id", pack.uuid).put("version", JSONArray(pack.version))
            if (index == null) data.put(entry) else data.put(index, entry)
        }
        val ordered = inLoadOrder(worldDir, data, behavior, before)
        val part = File(worldDir, "$name.part")
        part.writeText(ordered.toString(2))
        if (!part.renameTo(file)) {
            file.writeText(ordered.toString(2))
            part.delete()
        }
    }

    /**
     * The world's list in automatic load order (see [PackOrder]), as Bedrock Hub writes it: entries for packs
     * that aren't in the world's folders (built-in or Marketplace ones) stay first and as they were, then the
     * world's own packs in order, later ones winning.
     */
    private fun inLoadOrder(worldDir: File, data: JSONArray, behavior: Boolean, before: List<String>): JSONArray {
        val entries = (0 until data.length()).mapNotNull { data.optJSONObject(it) }
        val here = installed(worldDir).filter { it.behavior == behavior }.associateBy { it.uuid }
        val ours = entries.map { it.optString("pack_id").lowercase() }.filter { it in here }.distinct()
        val kept = before.filter { it in here }.distinct()
        val items = ours.map { uuid ->
            val pack = here.getValue(uuid)
            val files = pack.dir.walkTopDown().filter { it.isFile }.map { it.relativeTo(pack.dir).invariantSeparatorsPath.lowercase() }
            PackOrder.Item(uuid, pack.name, pack.deps, PackOrder.countedPaths(files))
        }
        val order = PackOrder.order(items, kept)
        if (order != ours) {
            Hub.log(Source.Babs, "Load order for ${if (behavior) "behavior" else "resource"} packs, later ones win: " +
                order.joinToString(" → ") { here.getValue(it).name })
        }
        val byUuid = entries.associateBy { it.optString("pack_id").lowercase() }
        val foreign = entries.filter { it.optString("pack_id").lowercase() !in here }
        return JSONArray(foreign + order.mapNotNull { byUuid[it] })
    }

    private fun unzip(input: InputStream, into: File) {
        into.mkdirs()
        val root = into.canonicalPath + File.separator
        ZipInputStream(input.buffered()).use { zip ->
            var any = false
            while (true) {
                val entry = zip.nextEntry ?: break
                any = true
                val target = File(into, entry.name)
                if (!target.canonicalPath.startsWith(root)) throw IOException("The pack contains a file with an unsafe name: ${entry.name}")
                if (entry.isDirectory) target.mkdirs() else {
                    target.parentFile?.mkdirs()
                    target.outputStream().use { zip.copyTo(it) }
                }
            }
            if (!any) throw IOException("That isn't a .mcaddon or .mcpack (it isn't a zip)")
        }
    }

    /** As the add-on engine's safe_name: no colour codes or characters folders can't have, up to 40. */
    private fun safeName(name: String, limit: Int = 40): String = name.replace(Regex("§."), "")
        .replace(Regex("[<>:\"/\\\\|?*\\x00-\\x1f]"), "")
        .trim(' ', '.')
        .replace(Regex("\\s+"), " ")
        .take(limit).trim(' ', '.').ifEmpty { "pack" }

    /** [1, 2, 3] or "1.2.3" (format 3 manifests) as a list of three numbers. */
    private fun versionList(raw: Any?): List<Int> = when (raw) {
        is JSONArray -> (0 until raw.length()).map { raw.optInt(it) }
        is String -> raw.substringBefore('-').split('.').map { it.toIntOrNull() ?: 0 }
        else -> emptyList()
    }.plus(listOf(0, 0, 0)).take(3)

    private fun versionText(raw: Any?): String = when (raw) {
        is JSONArray -> (0 until raw.length()).joinToString(".") { raw.opt(it).toString() }
        null -> ""
        else -> raw.toString()
    }
}
