package app.babs.service

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import app.babs.BabsApp
import app.babs.MainActivity
import app.babs.R
import app.babs.core.Hub
import app.babs.core.Layout
import app.babs.core.Launch
import app.babs.core.ManagedProcess
import app.babs.core.Prefs
import app.babs.core.RunState
import app.babs.core.SetupStage
import app.babs.core.Source
import app.babs.core.compareVersions
import app.babs.core.exitReason
import app.babs.setup.Installer
import app.babs.setup.ServerInstaller
import app.babs.core.ServerConfig
import app.babs.core.WorldExporter
import app.babs.core.SessionNames
import java.io.File
import java.io.IOException
import java.net.InetSocketAddress
import java.net.ServerSocket
import app.babs.core.BridgeApi
import app.babs.core.BridgeHealth
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * Runs the server and the bridge in the foreground so Android doesn't stop them,
 * and holds a wakelock and Wi-Fi lock while either is running.
 */
class ServerService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val lock = Mutex()
    private lateinit var layout: Layout
    private lateinit var server: ManagedProcess
    private lateinit var bridge: ManagedProcess
    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null

    override fun onCreate() {
        super.onCreate()
        layout = Layout(this)
        server = ManagedProcess(Source.Server, scope)
        bridge = ManagedProcess(Source.Bridge, scope)
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        goForeground()
        val action = intent?.action
        // Set before taking the lock, so Stop can cut short a start that is waiting for the port.
        if (action == ACTION_STOP) stopRequested = true
        if (action == ACTION_EXPORT_WORLD && intent != null) {
            exportWorld(intent)
            return START_NOT_STICKY
        }
        scope.launch {
            lock.withLock {
                when (action) {
                    ACTION_START -> startAll()
                    ACTION_STOP -> stopAll()
                    ACTION_RESTART -> restartRunning()
                    ACTION_COMMAND -> intent.getStringExtra(EXTRA_COMMAND)?.let(::sendCommand)
                    ACTION_INSTALL -> install()
                    ACTION_SERVER_DOWNLOAD -> downloadServer()
                    ACTION_RESTART_BRIDGE -> restartBridge()
                    ACTION_APPLY_ADDRESS -> applyPublicAddress()
                    ACTION_RESTART_SERVER -> restartServer()
                    ACTION_SIGN_OUT -> signOut()
                }
                stopIfIdle()
            }
        }
        return START_NOT_STICKY
    }

    @Volatile private var stopRequested = false

    private val anythingAlive: Boolean get() = server.isAlive || bridge.isAlive || probe?.isAlive == true || exporting || restartPending

    /** An export runs outside the lock, so Stop still works while a big world is copied. */
    @Volatile private var exporting = false

    private fun exportWorld(intent: Intent) {
        val folder = intent.getStringExtra(EXTRA_FOLDER) ?: return
        val uri = intent.data ?: return
        if (exporting) return
        exporting = true
        scope.launch {
            try {
                val worldDir = File(layout.serverDir, "worlds/$folder")
                // Only the world the running server has open needs the server to hold its saves.
                val live = server.isAlive && Hub.server.value.state == RunState.Running &&
                    ServerConfig(layout.serverDir).properties()["level-name"] == folder
                WorldExporter.export(this@ServerService, worldDir, uri, if (live) server::send else null)
            } finally {
                exporting = false
                lock.withLock { stopIfIdle() }
            }
        }
    }
    private var probe: ManagedProcess? = null

    /** Runs here rather than in the activity so the download and apt survive the screen turning off. */
    private suspend fun install() {
        if (layout.isLinuxReady) {
            Hub.setSetup(SetupStage.Ready, "Installed")
            return
        }
        acquireLocks()
        try {
            Installer(layout, scope).install()
        } finally {
            updateLocks()
        }
    }

    /**
     * Installs the newest Bedrock server, or updates to it. A running server is stopped with `stop` first
     * (which saves the world) and started again afterwards.
     */
    private suspend fun downloadServer() {
        if (!Prefs(this).eulaAccepted) {
            Hub.log(Source.Babs, "Accept the Minecraft EULA first")
            return
        }
        if (!layout.isLinuxReady) {
            Hub.log(Source.Babs, "Install Linux first")
            return
        }
        acquireLocks()
        Hub.updateServerFiles { it.copy(busy = "Checking for the newest version", progress = null, error = null) }
        try {
            val latest = ServerInstaller.checkLatest()
                ?: throw IOException("Couldn't reach minecraft.net. Check the internet connection and try again")
            Hub.updateServerFiles { it.copy(latest = latest.version) }
            val installed = layout.installedServerVersion()
            if (installed != null && installed != "unknown" && compareVersions(installed, latest.version) >= 0) {
                Hub.log(Source.Babs, "Bedrock server $installed is the newest version")
                return
            }
            val wasRunning = server.isAlive
            if (wasRunning) {
                Hub.setServer(RunState.Stopping, "Stopping to update")
                Hub.log(Source.Babs, "Stopping the server to update it")
                server.stop(gracefulCommand = "stop", timeoutMs = 30_000)
            }
            ServerInstaller(layout).install(latest)
            Hub.updateServerFiles { it.copy(installed = latest.version) }
            Hub.log(Source.Babs, "Bedrock server ${latest.version} is installed")
            // A first install gets settings made for a phone. Updates keep whatever was chosen.
            if (installed == null) {
                runCatching {
                    val config = ServerConfig(layout.serverDir)
                    config.setProperties(ServerConfig.PHONE_FRIENDLY.mapValues { it.value.first })
                    Hub.updateServerSettings { config.load() }
                }.onSuccess { Hub.log(Source.Babs, "Set the server up for a phone: view distance 10, simulation distance 4, snappy compression") }
            }
            if (wasRunning) startServer(layout.serverLaunch())
            else if (Hub.server.value.state == RunState.NotInstalled) Hub.setServer(RunState.Stopped)
        } catch (e: Exception) {
            val message = e.message ?: e.javaClass.simpleName
            Hub.updateServerFiles { it.copy(error = message) }
            Hub.log(Source.Babs, "Server download failed: $message")
        } finally {
            Hub.updateServerFiles { it.copy(busy = null, progress = null) }
            updateLocks()
        }
    }

    private suspend fun startAll() {
        stopRequested = false
        layout.ensureDirs()
        Hub.log(Source.Babs, "Device: ${layout.arch.label}, server runs ${if (layout.needsBox64) "through box64" else "natively, no box64"}")
        if (layout.isLinuxReady) {
            runCatching { layout.writeResolvConf() }
                .onSuccess { Hub.log(Source.Babs, "DNS for Linux: ${it.joinToString()}") }
                .onFailure { Hub.log(Source.Babs, "Couldn't set DNS for Linux: ${it.message}") }
        }

        if (!server.isAlive) {
            val missing = layout.serverMissing()
            if (missing != null) {
                Hub.setServer(RunState.NotInstalled, missing)
                Hub.log(Source.Babs, "Server: $missing")
            } else {
                startServer(layout.serverLaunch())
            }
        }

        if (!bridge.isAlive) {
            runCatching { layout.installBundledJar() }
                .onFailure { Hub.log(Source.Babs, "Couldn't install HMBC.jar: ${it.message}") }
            val missing = layout.bridgeMissing()
            if (missing != null) {
                Hub.setBridge(RunState.NotInstalled, missing)
                Hub.log(Source.Babs, "Bridge: $missing")
            } else {
                startBridge()
            }
        }

        if (!server.isAlive && !bridge.isAlive) {
            runDiagnostics()
        }
        updateLocks()
    }

    /**
     * Waits until nothing holds the server's port. After the server stops, Linux keeps its closed TCP
     * connections on the port for up to a minute, and the Bedrock server then starts without the TCP
     * listener that friends joining through Xbox need, without saying so. Returns false if Stop was pressed.
     */
    private suspend fun waitForServerPort(): Boolean {
        val port = layout.serverPort()
        val deadline = System.currentTimeMillis() + PORT_WAIT_MS
        var told = false
        while (!portFree(port)) {
            if (stopRequested) return false
            if (System.currentTimeMillis() > deadline) {
                Hub.log(Source.Babs, "Port $port is still in use, so starting anyway. Friends may not be able to join until a restart")
                return true
            }
            if (!told) {
                Hub.setServer(RunState.Starting, "Waiting for port $port to be freed")
                Hub.log(Source.Babs, "Port $port is still held by the last server, so waiting up to a minute for Android to free it")
                told = true
            }
            delay(2_000)
        }
        return true
    }

    /** Binds the TCP port without SO_REUSEADDR, as the Bedrock server does, to see whether it would fail. */
    private suspend fun portFree(port: Int): Boolean = withContext(Dispatchers.IO) {
        runCatching {
            ServerSocket().use {
                it.reuseAddress = false
                it.bind(InetSocketAddress(port))
            }
        }.isSuccess
    }

    private suspend fun startServer(launch: Launch) {
        if (!waitForServerPort()) {
            Hub.setServer(RunState.Stopped)
            return
        }
        Hub.setServer(RunState.Starting, "Loading the world")
        Hub.setPlayers(emptyList())
        runCatching {
            server.start(
                launch, layout.serverDir,
                onLine = { line ->
                    if (line.contains("Server started.")) {
                        Hub.setServerStartedAt(System.currentTimeMillis())
                        Hub.setServer(RunState.Running, "Online")
                        setSessionHidden(false)
                        // The server has written its settings and made the world folder, and any restart is done.
                        Hub.updateServerSettings { ServerConfig(layout.serverDir).load(restartNeeded = false) }
                        // A new world or server name than the bridge shows friends: restart it so they see it.
                        val names = currentNames()
                        if (bridge.isAlive && bridgeNames != null && names != bridgeNames) {
                            scope.launch {
                                lock.withLock {
                                    Hub.log(Source.Babs, "Restarting the bridge so friends see \"${names.server ?: "your gamertag"}\" with the world \"${names.world}\"")
                                    restartBridge()
                                }
                            }
                        }
                    }
                    PLAYER_JOINED.find(line)?.let { m -> Hub.setPlayers((Hub.players.value + m.groupValues[1]).distinct()) }
                    PLAYER_LEFT.find(line)?.let { m -> Hub.setPlayers(Hub.players.value - m.groupValues[1]) }
                },
                onExit = { code, requested ->
                    Hub.setPlayers(emptyList())
                    Hub.setServerStartedAt(null)
                    val signal = server.lastSignal
                    if (requested) Hub.setServer(RunState.Stopped)
                    else Hub.setServer(RunState.Crashed, exitReason(code, signal))
                    Hub.log(Source.Babs, "Server exited ($code${signal?.let { ", signal $it" } ?: ""})")
                    setSessionHidden(true)
                    if (!requested) scheduleAutoRestart()
                    onChildExit()
                },
            )
        }.onFailure {
            Hub.setServer(RunState.Crashed, "Couldn't start: ${it.message}")
            Hub.log(Source.Babs, "Server couldn't start: ${it.message}")
        }
    }

    /** When the server stopped unexpectedly lately, so a world that crashes at once can't restart for ever. */
    private val crashTimes = ArrayDeque<Long>()
    @Volatile private var restartPending = false

    /**
     * Starts the server again after it stops without being asked, such as when Android kills it for memory or it
     * crashes, after a few seconds. Gives up after three times in ten minutes, since then something is wrong
     * that a restart won't fix.
     */
    private fun scheduleAutoRestart() {
        if (!Prefs(this).autoRestart || stopRequested) return
        val now = System.currentTimeMillis()
        while (crashTimes.isNotEmpty() && now - crashTimes.first() > AUTO_RESTART_WINDOW_MS) crashTimes.removeFirst()
        crashTimes.addLast(now)
        if (crashTimes.size > AUTO_RESTART_LIMIT) {
            Hub.log(Source.Babs, "The server stopped unexpectedly $AUTO_RESTART_LIMIT times in 10 minutes, so BABS isn't restarting it again. See the lines above for why")
            return
        }
        restartPending = true
        Hub.log(Source.Babs, "Restarting the server in a few seconds (${crashTimes.size} of $AUTO_RESTART_LIMIT). Turn this off in Settings")
        scope.launch {
            delay(5_000)
            lock.withLock {
                restartPending = false
                if (!server.isAlive && !stopRequested) {
                    layout.serverMissing()?.let { Hub.setServer(RunState.NotInstalled, it) } ?: startServer(layout.serverLaunch())
                }
                stopIfIdle()
            }
        }
    }

    /** The names the bridge was started with, which it shows friends. */
    @Volatile private var bridgeNames: SessionNames? = null

    /**
     * The server name from Settings (null while it's Bedrock's default "Dedicated Server") and the name the game
     * shows for the server's world (levelname.txt), without colour codes.
     */
    private fun currentNames(): SessionNames {
        val props = ServerConfig(layout.serverDir).properties()
        val folder = props["level-name"] ?: "Bedrock level"
        val shown = runCatching { File(layout.serverDir, "worlds/$folder/levelname.txt").readText().trim() }.getOrNull()
        val server = props["server-name"]?.replace(Regex("§."), "")?.trim()?.take(60)?.takeIf { it.isNotEmpty() && it != "Dedicated Server" }
        return SessionNames(server, (shown?.ifEmpty { null } ?: folder).replace(Regex("§."), "").take(60))
    }

    private fun startBridge() {
        val publicAddress = Prefs(this).publicAddress
        Hub.setBridge(RunState.Starting, "Starting Java")
        Hub.log(
            Source.Babs,
            if (publicAddress.isEmpty()) "Starting the bridge with no public address, so only players on this network can join"
            else "Starting the bridge, public address $publicAddress",
        )
        // The session starts visible. It's hidden again below if the server isn't up.
        sessionHidden = false
        runCatching {
            bridge.start(
                layout.bridgeLaunch(publicAddress, Prefs(this).autoAcceptFriends, currentNames().also { bridgeNames = it }), layout.bridgeDir,
                onExit = { code, requested ->
                    healthJob?.cancel()
                    val wasWaitingForSignIn = Hub.bridgeHealth.value?.signInCode != null
                    Hub.setBridgeHealth(null)
                    Hub.setFriends(null)
                    val signal = bridge.lastSignal
                    if (requested) Hub.setBridge(RunState.Stopped)
                    else Hub.setBridge(RunState.Crashed, exitReason(code, signal))
                    Hub.log(Source.Babs, "Bridge exited ($code${signal?.let { ", signal $it" } ?: ""})")
                    // Microsoft only hands over the sign-in to the bridge that asked for the code.
                    if (wasWaitingForSignIn) {
                        Hub.log(Source.Babs, "The bridge stopped before the sign-in finished, so that code won't work. Start it again for a new one")
                    }
                    onChildExit()
                },
            )
            watchBridge()
        }.onFailure {
            Hub.setBridge(RunState.Crashed, "Couldn't start: ${it.message}")
            Hub.log(Source.Babs, "Bridge couldn't start: ${it.message}")
        }
    }

    private var healthJob: Job? = null
    private var sessionHidden = false

    /**
     * Polls HMBC's health endpoint while it runs, for the bridge card and the sign-in code, as Bedrock Hub does.
     * Leaves the card alone while Stop or Restart is in progress.
     */
    private fun watchBridge() {
        healthJob?.cancel()
        healthJob = scope.launch(Dispatchers.IO) {
            var lastCode: String? = null
            var hiddenForServer = false
            var lastFriendsCheck = 0L
            while (isActive && bridge.isAlive) {
                val health = BridgeApi.health()
                // Friend requests, from what HMBC last saw. It asks Xbox Live itself every minute or so.
                if (health?.gamertag != null && System.currentTimeMillis() - lastFriendsCheck > FRIENDS_POLL_MS) {
                    lastFriendsCheck = System.currentTimeMillis()
                    BridgeApi.friends()?.let { friends ->
                        val before = Hub.friends.value?.requests.orEmpty().map { it.xuid }.toSet()
                        friends.requests.filter { it.xuid !in before }.forEach {
                            Hub.log(Source.Babs, "Friend request from ${it.gamertag}. Accept it on the Bridge tab")
                        }
                        Hub.setFriends(friends)
                    }
                }
                val current = Hub.bridge.value.state
                if (health != null && bridge.isAlive && (current == RunState.Starting || current == RunState.Running)) {
                    Hub.setBridgeHealth(health)
                    // Remembered, as Bedrock Hub does, to show while the bridge is off.
                    val tag = health.gamertag
                    if (tag != null) {
                        val pic = health.gamerpic ?: Hub.account.value?.takeIf { it.first == tag }?.second.orEmpty()
                        if (Hub.account.value != (tag to pic)) {
                            Hub.setAccount(tag, pic)
                            Prefs(this@ServerService).apply { lastGamertag = tag; lastGamerpic = pic }
                        }
                    }
                    val (state, detail) = describe(health)
                    Hub.setBridge(state, detail)
                    if (health.signInCode != null && health.signInCode != lastCode) {
                        Hub.log(Source.Babs, "Sign the bridge in: open ${health.signInUrl} and enter ${health.signInCode}")
                    }
                    lastCode = health.signInCode
                    // HMBC saves the sign-in before reporting it, so a restart now keeps it.
                    if (addressRestartPending && health.state == "RUNNING" && health.gamertag != null) {
                        addressRestartPending = false
                        scope.launch {
                            lock.withLock {
                                Hub.log(Source.Babs, "Signed in, so restarting the bridge for the new public address")
                                restartBridge()
                            }
                        }
                    }
                    // Started before the server was up: hide it until "Server started." shows it again.
                    if (!hiddenForServer && health.state == "RUNNING" && !server.isAlive) {
                        hiddenForServer = true
                        setSessionHidden(true)
                    }
                }
                delay(if (health?.signInCode != null) 1000L else 3000L)
            }
        }
    }

    private fun describe(health: BridgeHealth): Pair<RunState, String> {
        val account = health.gamertag?.let { "Signed in as $it" }
        return when {
            health.signInCode != null -> RunState.Starting to "Waiting for sign-in"
            health.state == "RUNNING" && health.healthy -> RunState.Running to listOfNotNull(
                account,
                when {
                    health.sessionHidden -> "Hidden from friends until the server is up"
                    health.serverReachable == false -> "Can't reach the server"
                    else -> "Visible to friends"
                },
            ).joinToString("\n")
            health.state == "RUNNING" -> RunState.Running to "Not updating. It restarts itself if this continues"
            // HMBC waits 5 minutes after a sign-in code runs out before showing a new one.
            health.state == "RETRYING" && health.gamertag == null ->
                RunState.Starting to "The sign-in code ran out. A new one comes within 5 minutes, or tap New code"
            health.state == "RETRYING" -> RunState.Starting to "Can't start, retrying. See the console"
            health.state == "RESTARTING" -> RunState.Starting to "Restarting"
            else -> RunState.Starting to (account ?: "Signing in")
        }
    }

    /** While the server is down the bridge stays signed in, but friends shouldn't see a game they can't join. */
    private fun setSessionHidden(hidden: Boolean) {
        if (!bridge.isAlive || hidden == sessionHidden) return
        sessionHidden = hidden
        scope.launch(Dispatchers.IO) {
            if (!BridgeApi.setSessionHidden(hidden)) {
                Hub.log(Source.Babs, "The bridge couldn't ${if (hidden) "hide" else "show"} the session. It tries again at its next update")
            }
        }
    }

    /** Applies a new public address by restarting the bridge, if it's running. */
    /** Set when a new public address arrives during sign-in. The bridge restarts once the sign-in is saved. */
    @Volatile private var addressRestartPending = false

    /**
     * Restarting the bridge throws away a sign-in code that hasn't been used yet, and Microsoft only hands the
     * sign-in to the bridge that asked for it. So while a code is showing, the restart waits until it's done.
     */
    private suspend fun applyPublicAddress() {
        if (!bridge.isAlive) return
        val health = Hub.bridgeHealth.value
        if (health == null || health.gamertag == null) {
            addressRestartPending = true
            Hub.log(Source.Babs, "Public address saved. The bridge picks it up once it's signed in, so the sign-in code keeps working")
            return
        }
        restartBridge()
    }

    private suspend fun restartServer() {
        if (!server.isAlive) return
        stopRequested = false
        Hub.setServer(RunState.Stopping, "Restarting")
        Hub.log(Source.Babs, "Restarting the server")
        hideBeforeStopping()
        server.stop(gracefulCommand = "stop", timeoutMs = 30_000)
        layout.serverMissing()?.let { Hub.setServer(RunState.NotInstalled, it) } ?: startServer(layout.serverLaunch())
        updateLocks()
    }

    /**
     * Hides the session and waits for the bridge to take it, before the server goes down, as Stop does. Friends
     * don't try to join a server that's stopping, and the bridge stops pinging it, which leaves fewer old
     * connections holding the port when it starts again.
     */
    private suspend fun hideBeforeStopping() {
        if (!bridge.isAlive || sessionHidden) return
        sessionHidden = true
        withContext(Dispatchers.IO) { BridgeApi.setSessionHidden(true) }
    }

    /** Deletes HMBC's saved sign-in (cache.json in its cache folder) with the bridge stopped, then starts it again if it was running. */
    private suspend fun signOut() {
        val wasRunning = bridge.isAlive
        if (wasRunning) {
            Hub.setBridge(RunState.Stopping, "Signing out")
            bridge.stop(gracefulCommand = "stop", timeoutMs = 10_000)
        }
        Prefs(this).apply { lastGamertag = ""; lastGamerpic = "" }
        Hub.setAccount("", "")
        val cache = File(layout.bridgeDir, "cache/cache.json")
        if (cache.exists() && !cache.delete()) {
            Hub.log(Source.Babs, "Couldn't delete the bridge's sign-in")
        } else {
            Hub.log(Source.Babs, "Signed the bridge out")
        }
        if (wasRunning) {
            layout.bridgeMissing()?.let { Hub.setBridge(RunState.NotInstalled, it) } ?: startBridge()
        } else {
            Hub.setBridge(RunState.Stopped)
        }
        updateLocks()
    }

    private suspend fun restartBridge() {
        addressRestartPending = false
        if (!bridge.isAlive) return
        Hub.setBridge(RunState.Stopping, "Restarting")
        bridge.stop(gracefulCommand = "stop", timeoutMs = 10_000)
        layout.bridgeMissing()?.let { Hub.setBridge(RunState.NotInstalled, it) } ?: startBridge()
        updateLocks()
    }

    /**
     * Until the rootfs exists, checks what can be checked: that proot runs, or failing that,
     * that the device can start processes at all.
     */
    private fun runDiagnostics() {
        val probe = ManagedProcess(Source.Babs, scope).also { this.probe = it }
        val (what, launch) = if (layout.isLinuxReady) {
            "Linux" to layout.shell(
                "echo \"\$(. /etc/os-release; echo \$PRETTY_NAME) on \$(uname -m)\"; java -version 2>&1 | head -1" +
                    if (layout.needsBox64) "; box64 --version" else "",
            )
        } else if (layout.proot.exists()) {
            "proot" to layout.prootSelfTest()
        } else {
            "Process" to Launch(
                command = listOf("/system/bin/sh", "-c", "echo \"kernel: \$(uname -m)\""),
                env = emptyMap(),
            )
        }
        Hub.log(Source.Babs, "Nothing to run yet. Running the $what check:")
        runCatching {
            probe.start(
                launch,
                layout.filesDir,
                onExit = { code, _ ->
                    Hub.log(Source.Babs, if (code == 0) "$what check passed" else "$what check failed ($code)")
                    onChildExit()
                },
            )
        }.onFailure { Hub.log(Source.Babs, "$what check couldn't start: ${it.message}") }
    }

    private suspend fun stopAll() {
        if (server.isAlive && bridge.isAlive) {
            sessionHidden = true
            withContext(Dispatchers.IO) { BridgeApi.setSessionHidden(true) }
        }
        if (server.isAlive) {
            Hub.setServer(RunState.Stopping, "Saving the world")
            Hub.log(Source.Babs, "Stopping the server")
            server.stop(gracefulCommand = "stop", timeoutMs = 30_000)
        }
        if (bridge.isAlive) {
            Hub.setBridge(RunState.Stopping)
            Hub.log(Source.Babs, "Stopping the bridge")
            bridge.stop(gracefulCommand = "stop", timeoutMs = 10_000)
        }
    }

    /** Restarts only what is running, as in Bedrock Hub. */
    private suspend fun restartRunning() {
        stopRequested = false
        val serverWasUp = server.isAlive
        val bridgeWasUp = bridge.isAlive
        if (!serverWasUp && !bridgeWasUp) return startAll()
        if (serverWasUp) {
            Hub.setServer(RunState.Stopping, "Restarting")
            hideBeforeStopping()
            server.stop(gracefulCommand = "stop", timeoutMs = 30_000)
            layout.serverMissing()?.let { Hub.setServer(RunState.NotInstalled, it) } ?: startServer(layout.serverLaunch())
        }
        if (bridgeWasUp) restartBridge()
        updateLocks()
    }

    private fun sendCommand(command: String) {
        if (!server.isAlive) {
            Hub.log(Source.Babs, "The server isn't running")
            return
        }
        if (command.trim().equals("stop", ignoreCase = true)) {
            Hub.log(Source.Babs, "Use the Stop button so the bridge stops too")
            return
        }
        Hub.log(Source.Server, "> $command")
        server.send(command)
    }

    /**
     * A process ended. While Start/Stop/Restart is in progress it decides what happens next,
     * so only stop the service here when nothing else is going on.
     */
    private fun onChildExit() {
        updateLocks()
        if (!lock.isLocked) stopIfIdle()
    }

    /** Leaves the foreground once nothing is running. */
    private fun stopIfIdle() {
        updateLocks()
        if (!anythingAlive) {
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
        }
    }

    private fun updateLocks() {
        val running = server.isAlive || bridge.isAlive
        if (running) {
            acquireLocks()
        } else {
            wakeLock?.takeIf { it.isHeld }?.release()
            wifiLock?.takeIf { it.isHeld }?.release()
            wakeLock = null
            wifiLock = null
        }
    }

    private fun acquireLocks() {
        if (wakeLock != null) return
        wakeLock = getSystemService(PowerManager::class.java)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "BABS:server")
            .apply { acquire() }
        @Suppress("DEPRECATION")
        wifiLock = getSystemService(WifiManager::class.java)
            .createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "BABS:server")
            .apply { acquire() }
    }

    private fun goForeground() {
        val notification = buildNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun buildNotification(): Notification {
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE,
        )
        val stop = PendingIntent.getService(
            this, 1, Intent(this, ServerService::class.java).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, BabsApp.CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_server)
            .setContentTitle("BABS is running")
            .setContentText("Bedrock server and bridge")
            .setContentIntent(open)
            .addAction(0, "Stop", stop)
            .setOngoing(true)
            .build()
    }

    override fun onDestroy() {
        wakeLock?.takeIf { it.isHeld }?.release()
        wifiLock?.takeIf { it.isHeld }?.release()
        scope.cancel()
        super.onDestroy()
    }

    companion object {
        private const val NOTIFICATION_ID = 1
        private const val ACTION_START = "app.babs.START"
        private const val ACTION_STOP = "app.babs.STOP"
        private const val ACTION_RESTART = "app.babs.RESTART"
        private const val ACTION_COMMAND = "app.babs.COMMAND"
        private const val ACTION_INSTALL = "app.babs.INSTALL"
        private const val ACTION_SERVER_DOWNLOAD = "app.babs.SERVER_DOWNLOAD"
        private const val ACTION_RESTART_BRIDGE = "app.babs.RESTART_BRIDGE"
        private const val ACTION_APPLY_ADDRESS = "app.babs.APPLY_ADDRESS"
        private const val ACTION_RESTART_SERVER = "app.babs.RESTART_SERVER"
        private const val ACTION_SIGN_OUT = "app.babs.SIGN_OUT"
        private const val ACTION_EXPORT_WORLD = "app.babs.EXPORT_WORLD"
        private const val AUTO_RESTART_LIMIT = 3
        private const val AUTO_RESTART_WINDOW_MS = 10 * 60_000L
        private const val EXTRA_FOLDER = "folder"

        /** Saves the world in worlds/[folder] as a .mcworld at [uri], holding the server's saves if it has it open. */
        fun exportWorld(context: Context, folder: String, uri: android.net.Uri) = send(context, ACTION_EXPORT_WORLD) {
            putExtra(EXTRA_FOLDER, folder)
            setData(uri)
            addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        private const val FRIENDS_POLL_MS = 15_000L
        /** "Player connected: Steve, xuid: 2535..." and "Player disconnected: Steve, xuid: ..." */
        private val PLAYER_JOINED = Regex("""Player connected: (.+?), xuid""")
        private val PLAYER_LEFT = Regex("""Player disconnected: (.+?), xuid""")

        /** Restarts only the server, to load another world or apply settings. Does nothing if it isn't running. */
        fun restartServer(context: Context) = send(context, ACTION_RESTART_SERVER)

        /** Forgets the bridge's Microsoft sign-in. A running bridge restarts and shows a new code. */
        fun signOut(context: Context) = send(context, ACTION_SIGN_OUT)
        /** Linux keeps closed TCP connections for 60 seconds, so this covers it with room to spare. */
        private const val PORT_WAIT_MS = 90_000L
        private const val EXTRA_COMMAND = "command"

        /** Restarts the bridge if it's running, which also gets a fresh sign-in code. */
        fun restartBridge(context: Context) = send(context, ACTION_RESTART_BRIDGE)

        /** Restarts the bridge so it picks up a new public address, but not while a sign-in is under way. */
        fun applyPublicAddress(context: Context) = send(context, ACTION_APPLY_ADDRESS)

        fun install(context: Context) = send(context, ACTION_INSTALL)
        /** Installs the server, or updates it to the newest version. */
        fun downloadServer(context: Context) = send(context, ACTION_SERVER_DOWNLOAD)
        fun start(context: Context) = send(context, ACTION_START)
        fun stop(context: Context) = send(context, ACTION_STOP)
        fun restart(context: Context) = send(context, ACTION_RESTART)
        fun command(context: Context, command: String) =
            send(context, ACTION_COMMAND) { putExtra(EXTRA_COMMAND, command) }

        private fun send(context: Context, action: String, extras: Intent.() -> Unit = {}) {
            val intent = Intent(context, ServerService::class.java).setAction(action).apply(extras)
            ContextCompat.startForegroundService(context, intent)
        }
    }
}
