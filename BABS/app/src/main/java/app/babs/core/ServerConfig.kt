package app.babs.core

import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/** A world folder in the server's worlds/, by folder name, with the name the game shows if it differs. */
data class World(val folder: String, val displayName: String, val sizeBytes: Long, val lastPlayed: Long)

/**
 * What the Settings and Server tabs show of the server's files. [restartNeeded] is set when something changed
 * while the server was running, and cleared when it next starts.
 */
data class ServerSettings(
    val properties: Map<String, String> = emptyMap(),
    val worlds: List<World> = emptyList(),
    val allowList: List<String> = emptyList(),
    val restartNeeded: Boolean = false,
) {
    val currentWorld: String get() = properties["level-name"] ?: "Bedrock level"
    val allowListOn: Boolean get() = properties["allow-list"]?.trim() == "true"
}

/**
 * Reads and changes server.properties, allowlist.json and the worlds folder. server.properties is edited line by
 * line so Mojang's comments stay. Changes to it only take effect when the server restarts; the allow list can be
 * reloaded while it runs.
 */
class ServerConfig(private val serverDir: File) {
    private val propertiesFile = File(serverDir, "server.properties")
    private val allowListFile = File(serverDir, "allowlist.json")
    private val worldsDir = File(serverDir, "worlds")

    fun load(restartNeeded: Boolean = false) = ServerSettings(
        properties = properties(),
        worlds = worlds(),
        allowList = allowList(),
        restartNeeded = restartNeeded,
    )

    fun properties(): Map<String, String> = runCatching {
        propertiesFile.readLines()
            .map { it.trim() }
            .filter { it.isNotEmpty() && !it.startsWith("#") && it.contains('=') }
            .associate { it.substringBefore('=').trim() to it.substringAfter('=').trim() }
    }.getOrDefault(emptyMap())

    /** Sets each key, replacing its line or adding one at the end. Values can't contain line breaks. */
    fun setProperties(changes: Map<String, String>) {
        require(changes.values.none { '\n' in it || '\r' in it }) { "Line breaks aren't allowed" }
        val lines = if (propertiesFile.exists()) propertiesFile.readLines().toMutableList() else mutableListOf()
        val left = changes.toMutableMap()
        for (i in lines.indices) {
            val line = lines[i].trim()
            if (line.startsWith("#") || !line.contains('=')) continue
            val key = line.substringBefore('=').trim()
            left.remove(key)?.let { lines[i] = "$key=$it" }
        }
        left.forEach { (key, value) -> lines += "$key=$value" }
        writeAtomically(propertiesFile, lines.joinToString("\n", postfix = "\n"))
    }

    // Hidden folders are imports still being copied.
    fun worlds(): List<World> = worldsDir.listFiles { f -> f.isDirectory && !f.name.startsWith(".") }.orEmpty()
        .map { dir ->
            val shown = runCatching { File(dir, "levelname.txt").readText().trim() }.getOrNull()
            World(
                folder = dir.name,
                displayName = shown?.ifEmpty { null } ?: dir.name,
                sizeBytes = dir.walkTopDown().filter { it.isFile }.sumOf { it.length() },
                lastPlayed = File(dir, "level.dat").lastModified(),
            )
        }
        .sortedByDescending { it.lastPlayed }

    fun allowList(): List<String> = runCatching {
        val json = JSONArray(allowListFile.readText())
        (0 until json.length()).mapNotNull { json.optJSONObject(it)?.optString("name")?.ifEmpty { null } }
    }.getOrDefault(emptyList())

    /**
     * Adds or removes a name, keeping anything else in each entry (such as an xuid the server filled in).
     * Returns false when nothing changed.
     */
    fun changeAllowList(name: String, add: Boolean): Boolean {
        val existing = runCatching { JSONArray(allowListFile.readText()) }.getOrDefault(JSONArray())
        val entries = (0 until existing.length()).mapNotNull { existing.optJSONObject(it) }
        val has = entries.any { it.optString("name").equals(name, ignoreCase = true) }
        if (add == has) return false
        val kept = if (add) {
            entries + JSONObject().put("ignoresPlayerLimit", false).put("name", name)
        } else {
            entries.filterNot { it.optString("name").equals(name, ignoreCase = true) }
        }
        writeAtomically(allowListFile, JSONArray(kept).toString(2) + "\n")
        return true
    }

    private fun writeAtomically(file: File, text: String) {
        val part = File(file.parentFile, file.name + ".part")
        part.writeText(text)
        if (!part.renameTo(file)) {
            file.writeText(text)
            part.delete()
        }
    }

    companion object {
        /**
         * Settings that take load off a phone, with why. Bedrock's defaults are made for a PC: a view distance of
         * 32 chunks makes the server load and send about ten times the land of 10, and the CPU is what a phone runs
         * short of first. Applied when BABS first downloads the server, and from Settings.
         */
        val PHONE_FRIENDLY = linkedMapOf(
            "view-distance" to ("10" to "View distance 10 chunks: the biggest saving. Players' games still draw land further out"),
            "tick-distance" to ("4" to "Simulation distance 4 chunks: less of the world moving at once"),
            "client-side-chunk-generation-enabled" to ("true" to "Players' games draw distant land, not the server"),
            "compression-algorithm" to ("snappy" to "Snappy compression: less work per packet than zlib, for a little more data"),
        )

        /** Gamertags: letters, digits and spaces, up to 16 characters, plus an optional #1234 suffix. */
        fun isValidName(name: String) = name.matches(Regex("[A-Za-z0-9 ]{1,16}(#\\d{1,4})?"))

        /** Folder names for new worlds: what Bedrock allows and is safe as a folder. */
        fun isValidWorldName(name: String) = name.matches(Regex("[A-Za-z0-9 _'-]{1,40}")) && name.isNotBlank()
    }
}
