package app.babs.core

import android.content.Context
import android.net.ConnectivityManager
import android.os.Build
import java.io.File

enum class Arch(val label: String) {
    Arm64("arm64"),
    X86_64("x86_64 (emulator)"),
    Unsupported("unsupported"),
}

/**
 * Every folder and binary BABS uses, and how the server and bridge are launched on this device.
 *
 * Inside the rootfs the server folder is bound to /srv/bedrock and the bridge folder to /srv/bridge,
 * so the Linux side never sees Android paths.
 */
class Layout(context: Context) {
    val arch: Arch = when (Build.SUPPORTED_ABIS.firstOrNull()) {
        "arm64-v8a" -> Arch.Arm64
        "x86_64" -> Arch.X86_64
        else -> Arch.Unsupported
    }

    /** Bedrock Dedicated Server is x86_64 only, so ARM devices run it through box64. */
    val needsBox64: Boolean get() = arch == Arch.Arm64

    val filesDir: File = context.filesDir
    val cacheDir: File = context.cacheDir
    val rootfs = File(filesDir, "rootfs")
    /** The rootfs is unpacked here first, then renamed, so a half-unpacked one is never used. */
    val rootfsPartial = File(filesDir, "rootfs.partial")
    val serverDir = File(filesDir, "server")
    val bridgeDir = File(filesDir, "bridge")
    val tmpDir = File(context.cacheDir, "proot-tmp")

    /** Android only lets apps run files from the native library folder, so proot ships as lib*.so. */
    private val nativeDir = File(context.applicationInfo.nativeLibraryDir)
    val proot = File(nativeDir, "libproot.so")
    val prootLoader = File(nativeDir, "libproot-loader.so")

    val serverBinary = File(serverDir, "bedrock_server")
    /** The installed server's version, written after each download. */
    val serverVersionFile = File(serverDir, ".babs-version")
    /** A server download is unpacked here first, then moved into serverDir. */
    val serverStaging = File(filesDir, "server.new")
    val bridgeJar = File(bridgeDir, "HMBC.jar")
    /** The SHA256 of the bundled HMBC.jar last copied in, so an app update brings a new one. */
    private val bridgeJarMarker = File(bridgeDir, ".babs-jar")
    private val assets = context.assets
    private val appContext: Context = context.applicationContext

    /** The installed server's version, "unknown" if it was put there by hand, or null if there's no server. */
    fun installedServerVersion(): String? = when {
        !serverBinary.exists() -> null
        serverVersionFile.exists() -> serverVersionFile.readText().trim().ifEmpty { "unknown" }
        else -> "unknown"
    }

    /** Written once Ubuntu is unpacked and configured. */
    val baseMarker = File(rootfs, ".babs-base")
    /** Written once Java (and box64 on ARM) are installed and have run. */
    val readyMarker = File(rootfs, ".babs-ready")
    val isLinuxReady: Boolean get() = readyMarker.exists()

    /** What is missing before the server can start, or null when it is ready. */
    fun serverMissing(): String? = when {
        arch == Arch.Unsupported -> "This device's processor (${Build.SUPPORTED_ABIS.joinToString()}) isn't supported"
        !proot.exists() -> "proot is missing from the app"
        !isLinuxReady -> "Linux isn't installed yet. Tap Install"
        !serverBinary.exists() -> "The Bedrock server isn't downloaded yet. Tap Download server"
        else -> null
    }

    /** What is missing before the bridge can start, or null when it is ready. */
    fun bridgeMissing(): String? = when {
        arch == Arch.Unsupported -> "This device's processor isn't supported"
        !proot.exists() -> "proot is missing from the app"
        !isLinuxReady -> "Linux isn't installed yet. Tap Install"
        !bridgeJar.exists() -> "This build of BABS doesn't include HMBC.jar (see scripts\\fetch-bridge.ps1)"
        else -> null
    }

    /** Runs [script] with the rootfs's /bin/sh, as fake root, from /root. */
    fun shell(script: String): Launch = prootLaunch(
        binds = emptyList(),
        workDir = "/root",
        guestEnv = listOf("DEBIAN_FRONTEND=noninteractive"),
        program = listOf("/bin/sh", "-c", script),
    )

    fun serverLaunch(): Launch {
        val program = if (needsBox64) listOf("/usr/bin/box64", "./bedrock_server") else listOf("./bedrock_server")
        return prootLaunch(
            binds = listOf(serverDir to "/srv/bedrock"),
            workDir = "/srv/bedrock",
            guestEnv = listOf("LD_LIBRARY_PATH=."),
            program = program,
        )
    }

    /**
     * HMBC reads any config.yml option from MCXB_ variables (see the HMBS README), the same ones Bedrock Hub sets.
     * [publicAddress] is offered to players alongside the server's own address. Empty means none (LAN only).
     */
    fun bridgeLaunch(publicAddress: String, autoAcceptFriends: Boolean, names: SessionNames): Launch = prootLaunch(
        binds = listOf(bridgeDir to "/srv/bridge"),
        workDir = "/srv/bridge",
        guestEnv = listOf(
            "MCXB_SESSION__REMOTE_ADDRESS=127.0.0.1",
            "MCXB_SESSION__REMOTE_PORT=${serverPort()}",
            "MCXB_SESSION__PUBLIC_ADDRESS=$publicAddress",
            "MCXB_RESILIENCE__HEALTH_PORT=$BRIDGE_HEALTH_PORT",
            "MCXB_NOTIFICATIONS__ENABLED=false",
            "MCXB_FRIEND_SYNC__AUTO_FRIEND=$autoAcceptFriends",
            // Friends see the server name from Settings and the loaded world's name, rather than HMBC's defaults
            // or the server's own ping (options added to HMBC for BABS; off in Bedrock Hub). With the server name
            // left at Bedrock's default, the account's gamertag stands in for it.
            "MCXB_SESSION__QUERY_NAMES=false",
            "MCXB_SESSION__HOST_NAME_FROM_ACCOUNT=${names.server == null}",
            "MCXB_SESSION__SESSION_INFO__HOST_NAME=${names.server ?: "BABS"}",
            "MCXB_SESSION__SESSION_INFO__WORLD_NAME=${names.world}",
        ),
        // Java tuned for a phone, where the bridge shares the CPU and memory with the server:
        // - SerialGC: one garbage collector thread instead of one per core, and a smaller heap overhead
        // - TieredStopAtLevel=1: the quick JIT only, which compiles far less, for code that's mostly waiting on the network
        // - a smaller code cache and thread stacks, and the heap given back to Android when it's not in use
        program = listOf(
            "/usr/bin/java",
            "-Xmx320m",
            "-XX:+UseSerialGC",
            "-XX:TieredStopAtLevel=1",
            "-XX:ReservedCodeCacheSize=48m",
            "-Xss512k",
            "-XX:MinHeapFreeRatio=10",
            "-XX:MaxHeapFreeRatio=30",
            "-jar", "HMBC.jar",
        ),
    )

    /** server-port from server.properties, or Bedrock's default. */
    fun serverPort(): Int = runCatching {
        File(serverDir, "server.properties").useLines { lines ->
            lines.map { it.trim() }.firstOrNull { it.startsWith("server-port=") }
                ?.substringAfter('=')?.trim()?.toIntOrNull()
        }
    }.getOrNull() ?: 19132

    /** The bundled HMBC.jar's SHA256, or null if this build of BABS doesn't include it. */
    private fun bundledJarSha(): String? =
        runCatching { assets.open("bridge/HMBC.sha256").bufferedReader().use { it.readText().trim() } }.getOrNull()

    /**
     * Copies the bundled HMBC.jar into the bridge folder if it's missing or a different build.
     * Returns false if this build of BABS doesn't include one.
     */
    fun installBundledJar(): Boolean {
        val sha = bundledJarSha() ?: return bridgeJar.exists()
        if (bridgeJar.exists() && bridgeJarMarker.exists() && bridgeJarMarker.readText().trim() == sha) return true
        bridgeDir.mkdirs()
        val part = File(bridgeDir, "HMBC.jar.part")
        assets.open("bridge/HMBC.jar").use { input -> part.outputStream().use { input.copyTo(it, 64 * 1024) } }
        if (!part.renameTo(bridgeJar)) throw java.io.IOException("Couldn't install HMBC.jar")
        bridgeJarMarker.writeText(sha + "\n")
        return true
    }

    /**
     * Runs an Android shell under proot with no rootfs (so "/" is Android's own), as fake root.
     * Proves that proot, its loader and its libraries load and that ptrace works on this device.
     */
    fun prootSelfTest(): Launch = Launch(
        command = listOf(
            proot.absolutePath, "--kill-on-exit", "-0",
            "/system/bin/sh", "-c",
            "echo \"proot works: uid \$(id -u) inside, kernel \$(uname -r)\"",
        ),
        env = prootEnv(),
    )

    /**
     * proot and its libraries are Android (bionic) programs, found through LD_LIBRARY_PATH. The guest is glibc,
     * so it starts from `env -i` and never sees that path or any other Android variable.
     */
    private fun prootLaunch(
        binds: List<Pair<File, String>>,
        workDir: String,
        guestEnv: List<String>,
        program: List<String>,
    ): Launch {
        val args = mutableListOf(
            proot.absolutePath,
            "--kill-on-exit",
            "--link2symlink",
            "-0",
            "-r", rootfs.absolutePath,
            "-b", "/dev", "-b", "/proc", "-b", "/sys",
        )
        binds.forEach { (host, guest) -> args += listOf("-b", "${host.absolutePath}:$guest") }
        args += listOf("-w", workDir)
        args += listOf(
            "/usr/bin/env", "-i",
            "HOME=/root",
            "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            "LANG=C.UTF-8",
            "TERM=dumb",
        )
        args += guestEnv
        args += program
        return Launch(command = args, env = prootEnv())
    }

    private fun prootEnv(): Map<String, String> = mapOf(
        "LD_LIBRARY_PATH" to nativeDir.absolutePath,
        "PROOT_LOADER" to prootLoader.absolutePath,
        "PROOT_TMP_DIR" to tmpDir.absolutePath,
    )

    fun ensureDirs() {
        listOf(serverDir, bridgeDir, tmpDir).forEach { it.mkdirs() }
    }

    /**
     * Points Ubuntu's DNS at the servers the phone is using right now, with public ones after them.
     * Public DNS on its own is blocked or unreliable on some networks, and then everything the bridge does
     * fails, including saving a sign-in. Rewritten at every start, since the phone moves between networks.
     * Returns the servers written.
     */
    fun writeResolvConf(root: File = rootfs): List<String> {
        val device = runCatching {
            val cm = appContext.getSystemService(ConnectivityManager::class.java)
            cm.getLinkProperties(cm.activeNetwork)?.dnsServers.orEmpty()
                // A link-local address needs its interface named, which glibc's resolver can't be given here.
                .filterNot { it.isLinkLocalAddress || it.isLoopbackAddress }
                .mapNotNull { it.hostAddress }
        }.getOrDefault(emptyList())
        // glibc reads at most three.
        val servers = (device + listOf("1.1.1.1", "8.8.8.8")).distinct().take(3)
        val file = File(root, "etc/resolv.conf")
        java.nio.file.Files.deleteIfExists(file.toPath())
        file.writeText(
            "# Written by BABS at each start from the phone's network\n" +
                servers.joinToString("") { "nameserver $it\n" } +
                "options timeout:3 attempts:3\n",
        )
        return servers
    }
}

data class Launch(val command: List<String>, val env: Map<String, String>)

/**
 * What friends see in their friends list: [server] is the server name from Settings (null while it's Bedrock's
 * default, when the account's gamertag is shown instead), [world] the loaded world's name.
 */
data class SessionNames(val server: String?, val world: String)

/** HMBC's status endpoint, on localhost only. Bedrock Hub uses 8080. This is less likely to clash on a phone. */
const val BRIDGE_HEALTH_PORT = 19180
