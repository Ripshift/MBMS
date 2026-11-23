package app.babs.setup

import android.system.Os
import app.babs.core.Hub
import app.babs.core.Layout
import app.babs.core.Source
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.StandardCopyOption
import java.util.zip.CRC32
import java.util.zip.CheckedInputStream
import java.util.zip.ZipException
import java.util.zip.ZipFile

/** A Bedrock Dedicated Server release for Linux. */
data class Release(val version: String, val url: String)

/**
 * Downloads Mojang's Bedrock Dedicated Server for Linux and installs or updates it in the server folder, the same
 * way Bedrock Hub's updater does on Windows:
 *
 * - The newest version comes from the links API minecraft.net's download page uses. Only downloads from
 *   minecraft.net's own server folder are accepted.
 * - The zip is unpacked into server.new first, checking every file's CRC, since there's no published hash.
 * - Then it is moved over the server folder. `server.properties`, `allowlist.json` and `permissions.json` are
 *   kept if they're already there, and `worlds/` is never touched (the zip doesn't contain it).
 */
class ServerInstaller(private val layout: Layout) {

    suspend fun install(release: Release) = withContext(Dispatchers.IO) {
        if (!isAllowedDownload(release.url)) throw IOException("That download address isn't the official Minecraft one")
        val free = layout.filesDir.usableSpace
        if (free < MIN_FREE_BYTES) {
            throw IOException("Needs about ${MIN_FREE_BYTES / 1_000_000} MB free, this device has ${free / 1_000_000} MB")
        }

        val zip = File(layout.cacheDir, "bedrock-server-${release.version}.zip")
        // Leftovers from an older version's interrupted download.
        layout.cacheDir.listFiles { f -> f.name.startsWith("bedrock-server-") && !f.name.startsWith(zip.name) }
            ?.forEach { it.delete() }

        for (attempt in 1..UNPACK_ATTEMPTS) {
            if (!zip.exists()) {
                Hub.log(Source.Babs, "Downloading Bedrock server ${release.version} from minecraft.net")
                Download.resumable(release.url, zip, "the Bedrock server") { read, total ->
                    busy("Downloading Bedrock server ${release.version} (${Download.sizeText(read, total)})",
                        if (total > 0) read.toFloat() / total else null)
                }
            }
            try {
                unpack(zip, layout.serverStaging)
                break
            } catch (e: ZipException) {
                // A damaged download. Range requests can't fix a wrong byte in the middle, so start over.
                zip.delete()
                Hub.log(Source.Babs, "The download was damaged (${e.message}), downloading it again")
                if (attempt == UNPACK_ATTEMPTS) {
                    throw IOException("The server download kept arriving damaged. Check the connection and try again")
                }
            }
        }

        busy("Installing", null)
        layout.serverDir.mkdirs()
        moveInto(layout.serverStaging, layout.serverDir)
        Os.chmod(layout.serverBinary.path, 0x1ED) // 0755
        layout.serverVersionFile.writeText(release.version + "\n")
        Installer.deleteTree(layout.serverStaging)
        zip.delete()
    }

    private fun unpack(zip: File, staging: File) {
        Installer.deleteTree(staging)
        staging.mkdirs()
        val stagingPath = staging.toPath().normalize()
        ZipFile(zip).use { archive ->
            val entries = archive.entries().toList()
            val total = entries.sumOf { maxOf(it.size, 0L) }.coerceAtLeast(1L)
            var done = 0L
            var lastShown = -1
            for (entry in entries) {
                val name = entry.name.replace('\\', '/')
                val parts = name.split('/').filter { it.isNotEmpty() && it != "." }
                if (parts.isEmpty()) continue
                if (parts.any { it == ".." }) throw IOException("The server zip has an unsafe path: $name")
                val target = File(staging, parts.joinToString("/"))
                if (!target.toPath().normalize().startsWith(stagingPath)) throw IOException("The server zip has an unsafe path: $name")

                if (entry.isDirectory) {
                    target.mkdirs()
                    continue
                }
                target.parentFile?.mkdirs()
                val checked = CheckedInputStream(archive.getInputStream(entry), CRC32())
                checked.use { input -> target.outputStream().use { input.copyTo(it, 64 * 1024) } }
                if (entry.crc != -1L && checked.checksum.value != entry.crc) {
                    throw ZipException("${entry.name} doesn't match its checksum")
                }
                done += maxOf(entry.size, 0L)
                val pct = (done * 100 / total).toInt()
                if (pct != lastShown) {
                    lastShown = pct
                    busy("Unpacking the server", done.toFloat() / total)
                }
            }
        }
        if (!File(staging, "bedrock_server").exists()) throw IOException("The download doesn't contain the server program")
    }

    /** Moves the new files over the old ones, merging folders, as Bedrock Hub's updater copies them. */
    private fun moveInto(from: File, to: File) {
        for (child in from.listFiles().orEmpty()) {
            val dest = File(to, child.name)
            if (child.name == "worlds") continue
            if (child.name in KEEP && dest.exists()) {
                Hub.log(Source.Babs, "Kept your ${child.name}")
                continue
            }
            merge(child, dest)
        }
    }

    private fun merge(src: File, dest: File) {
        if (src.isDirectory) {
            if (Files.exists(dest.toPath(), LinkOption.NOFOLLOW_LINKS) && !dest.isDirectory) Files.delete(dest.toPath())
            dest.mkdirs()
            src.listFiles().orEmpty().forEach { merge(it, File(dest, it.name)) }
        } else {
            if (dest.isDirectory) Installer.deleteTree(dest)
            Files.move(src.toPath(), dest.toPath(), StandardCopyOption.REPLACE_EXISTING)
        }
    }

    private fun busy(step: String, progress: Float?) =
        Hub.updateServerFiles { it.copy(busy = step, progress = progress) }

    companion object {
        private const val LINKS_URL = "https://net-secondary.web.minecraft-services.net/api/v1.0/download/links"
        private const val LINUX_SERVER = "serverBedrockLinux"
        private const val DOWNLOAD_PREFIX = "https://www.minecraft.net/bedrockdedicatedserver/"
        private val VERSION = Regex("""bedrock-server-(\d+(?:\.\d+)+)\.zip$""")
        /** The server's own settings, kept across updates. */
        val KEEP = setOf("server.properties", "allowlist.json", "permissions.json")
        /** The ~100 MB zip plus ~320 MB unpacked, plus room for the old copy while it's replaced. */
        private const val MIN_FREE_BYTES = 800L * 1_000_000
        private const val UNPACK_ATTEMPTS = 3

        fun isAllowedDownload(url: String?) =
            url != null && url.startsWith(DOWNLOAD_PREFIX) && url.none { it.isWhitespace() || it == '\'' || it == '"' }

        /** The Linux server in the links API's response, or null. */
        fun parseLatest(body: String): Release? = runCatching {
            val links = JSONObject(body).getJSONObject("result").getJSONArray("links")
            val url = (0 until links.length())
                .map { links.getJSONObject(it) }
                .firstOrNull { it.optString("downloadType") == LINUX_SERVER }
                ?.optString("downloadUrl")
            if (!isAllowedDownload(url)) return null
            VERSION.find(url!!)?.let { Release(it.groupValues[1], url) }
        }.getOrNull()

        /** The newest Linux server, or null if minecraft.net can't be reached. */
        suspend fun checkLatest(): Release? = withContext(Dispatchers.IO) {
            runCatching {
                val conn = (URL(LINKS_URL).openConnection() as HttpURLConnection).apply {
                    connectTimeout = 10_000
                    readTimeout = 10_000
                    setRequestProperty("User-Agent", "BABS")
                }
                try {
                    if (conn.responseCode != 200) return@runCatching null
                    parseLatest(conn.inputStream.bufferedReader().use { it.readText() })
                } finally {
                    conn.disconnect()
                }
            }.getOrNull()
        }
    }
}
