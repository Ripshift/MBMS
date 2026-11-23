package app.babs.setup

import android.system.Os
import app.babs.core.Arch
import app.babs.core.Hub
import app.babs.core.Layout
import app.babs.core.ManagedProcess
import app.babs.core.SetupStage
import app.babs.core.Source
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FilterInputStream
import java.io.IOException
import java.io.InputStream
import java.nio.file.FileVisitResult
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.nio.file.SimpleFileVisitor
import java.nio.file.attribute.BasicFileAttributes
import java.security.MessageDigest
import java.util.zip.GZIPInputStream

/**
 * Installs the Linux system the server and bridge run in:
 *
 * 1. Downloads Ubuntu Base 26.04 LTS for this CPU and checks its SHA256.
 * 2. Unpacks it into rootfs.partial, sets up DNS and apt for proot, then renames it to rootfs.
 * 3. Inside it, installs OpenJDK 21 (for the bridge) and, on ARM, box64 (for the server) with apt.
 *
 * Each stage leaves a marker in the rootfs, so a failed install picks up where it stopped.
 */
class Installer(private val layout: Layout, private val scope: CoroutineScope) {

    private data class Image(val name: String, val url: String, val sha256: String)

    private val image = when (layout.arch) {
        Arch.Arm64 -> Image(
            "Ubuntu 26.04.1 (arm64)",
            "$UBUNTU_BASE/ubuntu-base-26.04.1-base-arm64.tar.gz",
            "5a1906794ced63a71a8119c3f211ef5f0bbe0a243001b4bbd41fdf80c5b219fd",
        )
        Arch.X86_64 -> Image(
            "Ubuntu 26.04.1 (x86_64)",
            "$UBUNTU_BASE/ubuntu-base-26.04.1-base-amd64.tar.gz",
            "a496a960472ce474a59590b8987d3a1135d3cbef1991f3b1abe8cacfea8bf85a",
        )
        Arch.Unsupported -> null
    }

    suspend fun install() = withContext(Dispatchers.IO) {
        try {
            val image = image ?: throw IOException("This device's processor isn't supported")
            layout.ensureDirs()
            if (!layout.baseMarker.exists()) installBase(image)
            installPackages()
            Hub.setSetup(SetupStage.Ready, "Installed")
            Hub.log(Source.Babs, "Linux is installed")
        } catch (e: Exception) {
            Hub.setSetup(SetupStage.Failed, e.message ?: e.javaClass.simpleName)
            Hub.log(Source.Babs, "Install failed: ${e.message ?: e}")
        }
    }

    private suspend fun installBase(image: Image) {
        val free = layout.filesDir.usableSpace
        if (free < MIN_FREE_BYTES) {
            throw IOException("Needs about ${MIN_FREE_BYTES / 1_000_000} MB free, this device has ${free / 1_000_000} MB")
        }

        val archive = File(layout.cacheDir, "ubuntu-base.tar.gz")
        if (!archive.exists() || sha256(archive) != image.sha256) {
            Hub.log(Source.Babs, "Downloading ${image.name}")
            Download.resumable(image.url, archive, "Ubuntu", check = { sha256(it) == image.sha256 }) { read, total ->
                Hub.setSetup(
                    SetupStage.Working,
                    "Downloading Ubuntu (${Download.sizeText(read, total)})",
                    if (total > 0) read.toFloat() / total else null,
                )
            }
        }

        Hub.setSetup(SetupStage.Working, "Unpacking Ubuntu", 0f)
        Hub.log(Source.Babs, "Unpacking")
        deleteTree(layout.rootfsPartial)
        layout.rootfsPartial.mkdirs()
        val total = archive.length().toFloat()
        Progress(archive.inputStream()) { read ->
            Hub.setSetup(SetupStage.Working, "Unpacking Ubuntu", read / total)
        }.use { counted ->
            GZIPInputStream(counted, 64 * 1024).use { Tar.extract(it, layout.rootfsPartial) }
        }

        configure(layout.rootfsPartial)
        File(layout.rootfsPartial, layout.baseMarker.name).writeText(image.url + "\n")
        deleteTree(layout.rootfs)
        if (!layout.rootfsPartial.renameTo(layout.rootfs)) throw IOException("Couldn't move the rootfs into place")
        archive.delete()
    }

    /** Makes a stock Ubuntu Base usable under proot on Android. */
    private fun configure(root: File) {
        // Ubuntu's resolv.conf points at systemd-resolved, which doesn't run here. Use the phone's DNS instead.
        val dns = layout.writeResolvConf(root)
        Hub.log(Source.Babs, "DNS for Linux: ${dns.joinToString()}")
        File(root, "etc/hosts").writeText("127.0.0.1 localhost\n::1 localhost\n")
        // Docs and man pages are useless here, and Java's are large.
        File(root, "etc/dpkg/dpkg.cfg.d").mkdirs()
        File(root, "etc/dpkg/dpkg.cfg.d/99babs-nodoc").writeText(
            """
            path-exclude=/usr/share/doc/*
            path-exclude=/usr/share/man/*
            path-exclude=/usr/share/info/*
            path-exclude=/usr/share/locale/*
            path-include=/usr/share/doc/*/copyright
            """.trimIndent() + "\n",
        )
    }

    private suspend fun installPackages() {
        // Written on every attempt, so a rootfs unpacked by an older BABS gets the current settings.
        File(layout.rootfs, "etc/apt/apt.conf.d/99babs").writeText(
            """
            // apt drops to the _apt user to download. Under proot everyone is really the app's user, so stay root.
            APT::Sandbox::User "root";
            APT::Install-Recommends "false";
            Acquire::Retries "3";
            // Pipelined HTTP gave "Hash Sum mismatch" on the emulator's network. One request at a time is reliable.
            Acquire::http::Pipeline-Depth "0";
            """.trimIndent() + "\n",
        )
        val box64 = layout.needsBox64
        val packages = buildList {
            add("ca-certificates")
            add("openjdk-21-jre-headless")
            if (box64) add("box64")
        }
        Hub.setSetup(SetupStage.Working, "Installing Java 21${if (box64) " and box64" else ""}", null)
        Hub.log(Source.Babs, "Installing ${packages.joinToString()} with apt. This takes a few minutes.")
        val script = buildString {
            appendLine("set -e")
            // box64 and OpenJDK 21 are in universe.
            appendLine("sed -i 's/^Components:.*/Components: main restricted universe multiverse/' /etc/apt/sources.list.d/ubuntu.sources")
            // Damaged downloads show up as "Hash Sum mismatch". apt-get update still exits 0 then, so check its
            // errors. Each retry only fetches the files that failed, since the good ones are kept.
            appendLine("for try in 1 2 3 4 5; do")
            appendLine("  if apt-get update 2>&1 | tee /tmp/apt-update.log; ! grep -q '^E:' /tmp/apt-update.log; then break; fi")
            appendLine("  [ \$try = 5 ] && exit 1")
            appendLine("  echo \"apt-get update had errors, retrying in 5 s (\$try of 5)\"; sleep 5")
            appendLine("done")
            appendLine("for try in 1 2 3 4 5; do")
            appendLine("  apt-get install -y ${packages.joinToString(" ")} && break")
            appendLine("  [ \$try = 5 ] && exit 1")
            appendLine("  echo \"apt-get install failed, retrying in 5 s (\$try of 5)\"; sleep 5")
            appendLine("done")
            // The package lists are ~130 MB. Anything that installs more runs apt-get update first.
            appendLine("apt-get clean")
            appendLine("rm -rf /var/lib/apt/lists/*")
            appendLine("java -version")
            if (box64) appendLine("box64 --version")
        }
        val code = runInRootfs(script)
        if (code != 0) throw IOException("Installing Java${if (box64) " and box64" else ""} failed (exit $code). See the console")
        layout.readyMarker.writeText(packages.joinToString("\n") + "\n")
    }

    private suspend fun runInRootfs(script: String): Int {
        val done = CompletableDeferred<Int>()
        ManagedProcess(Source.Setup, scope).start(
            layout.shell(script),
            layout.filesDir,
            onExit = { code, _ -> done.complete(code) },
        )
        return done.await()
    }

    /** Reports how many bytes have been read, about every 256 KB. */
    class Progress(input: InputStream, private val onRead: (Long) -> Unit) : FilterInputStream(input) {
        private var count = 0L
        private var lastReported = 0L

        override fun read(): Int = super.read().also { if (it >= 0) advance(1) }
        override fun read(b: ByteArray, off: Int, len: Int): Int = super.read(b, off, len).also { if (it > 0) advance(it.toLong()) }

        private fun advance(n: Long) {
            count += n
            if (count - lastReported > 256 * 1024) {
                lastReported = count
                onRead(count)
            }
        }
    }

    companion object {
        private const val UBUNTU_BASE = "https://cdimage.ubuntu.com/ubuntu-base/releases/26.04/release"
        /** Ubuntu, Java and box64 unpacked, plus room for apt's downloads. */
        private const val MIN_FREE_BYTES = 800L * 1_000_000

        fun sha256(file: File): String {
            val digest = MessageDigest.getInstance("SHA-256")
            file.inputStream().use { input ->
                val buf = ByteArray(64 * 1024)
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    digest.update(buf, 0, n)
                }
            }
            return digest.digest().joinToString("") { "%02x".format(it) }
        }

        /** Deletes a folder tree without following symlinks, which in a rootfs often point at absolute paths. */
        fun deleteTree(root: File) {
            val start = root.toPath()
            if (!Files.exists(start, LinkOption.NOFOLLOW_LINKS)) return
            Files.walkFileTree(start, object : SimpleFileVisitor<Path>() {
                override fun preVisitDirectory(dir: Path, attrs: BasicFileAttributes): FileVisitResult {
                    runCatching { Os.chmod(dir.toString(), 0x1C0) } // so its contents can be deleted
                    return FileVisitResult.CONTINUE
                }

                override fun visitFile(file: Path, attrs: BasicFileAttributes): FileVisitResult {
                    Files.delete(file)
                    return FileVisitResult.CONTINUE
                }

                override fun visitFileFailed(file: Path, exc: IOException): FileVisitResult {
                    Files.deleteIfExists(file)
                    return FileVisitResult.CONTINUE
                }

                override fun postVisitDirectory(dir: Path, exc: IOException?): FileVisitResult {
                    Files.delete(dir)
                    return FileVisitResult.CONTINUE
                }
            })
        }
    }
}
