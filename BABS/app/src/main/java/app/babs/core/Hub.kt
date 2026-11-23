package app.babs.core

import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

enum class RunState { Stopped, Starting, Running, Stopping, NotInstalled, Crashed }

data class ComponentStatus(val state: RunState = RunState.Stopped, val detail: String = "")

/** Where a console line came from. Shown as a tag in front of the line, like Bedrock Hub's console. */
enum class Source(val tag: String) { Server("server"), Bridge("bridge"), Setup("setup"), Babs("babs") }

enum class SetupStage { NotInstalled, Working, Ready, Failed }

/** The Linux system's install state. [progress] is 0..1, or null when there is no way to measure it. */
data class SetupStatus(
    val stage: SetupStage = SetupStage.NotInstalled,
    val step: String = "",
    val progress: Float? = null,
)

/**
 * The Bedrock server's files. [installed] and [latest] are versions like "1.26.63.1" ([latest] is null until
 * checked). [busy] says what a download or update is doing, or is null when nothing is.
 */
data class ServerFiles(
    val installed: String? = null,
    val latest: String? = null,
    val busy: String? = null,
    val progress: Float? = null,
    val error: String? = null,
) {
    val updateAvailable: Boolean
        get() = installed != null && latest != null && compareVersions(latest, installed) > 0
}

/** Negative when [a] is older than [b], as in Bedrock Hub. */
fun compareVersions(a: String, b: String): Int {
    val left = a.split('.').map { it.toIntOrNull() ?: 0 }
    val right = b.split('.').map { it.toIntOrNull() ?: 0 }
    for (i in 0 until maxOf(left.size, right.size)) {
        val diff = left.getOrElse(i) { 0 } - right.getOrElse(i) { 0 }
        if (diff != 0) return diff
    }
    return 0
}

data class ConsoleLine(val id: Long, val source: Source, val text: String)

/**
 * App-wide state shared by the service (which writes it) and the UI (which reads it).
 * Kept as a process singleton so the UI shows the right state when it is reopened while the service runs.
 */
object Hub {
    private const val MAX_LINES = 2000

    private val _server = MutableStateFlow(ComponentStatus())
    val server: StateFlow<ComponentStatus> = _server.asStateFlow()

    private val _bridge = MutableStateFlow(ComponentStatus())
    val bridge: StateFlow<ComponentStatus> = _bridge.asStateFlow()

    private val _setup = MutableStateFlow(SetupStatus())
    val setup: StateFlow<SetupStatus> = _setup.asStateFlow()

    fun setSetup(stage: SetupStage, step: String = "", progress: Float? = null) {
        _setup.value = SetupStatus(stage, step, progress)
    }

    private val _serverFiles = MutableStateFlow(ServerFiles())
    val serverFiles: StateFlow<ServerFiles> = _serverFiles.asStateFlow()

    fun updateServerFiles(change: (ServerFiles) -> ServerFiles) = _serverFiles.update(change)

    /** The bridge's last status from its health endpoint, or null while it isn't running or answering. */
    private val _bridgeHealth = MutableStateFlow<BridgeHealth?>(null)
    val bridgeHealth: StateFlow<BridgeHealth?> = _bridgeHealth.asStateFlow()

    fun setBridgeHealth(health: BridgeHealth?) { _bridgeHealth.value = health }

    /** Players in the game now, from the server's "Player connected" and "Player disconnected" lines. */
    private val _players = MutableStateFlow<List<String>>(emptyList())
    val players: StateFlow<List<String>> = _players.asStateFlow()

    fun setPlayers(players: List<String>) { _players.value = players }

    /** The bridge account last seen signed in (gamertag, picture address), remembered between runs. */
    private val _account = MutableStateFlow<Pair<String, String>?>(null)
    val account: StateFlow<Pair<String, String>?> = _account.asStateFlow()

    fun setAccount(gamertag: String, gamerpic: String) {
        _account.value = if (gamertag.isEmpty()) null else gamertag to gamerpic
    }

    /** Add Pack to World, while it runs and just after. */
    private val _packImport = MutableStateFlow(PackImport())
    val packImport: StateFlow<PackImport> = _packImport.asStateFlow()

    fun updatePackImport(change: (PackImport) -> PackImport) = _packImport.update(change)

    /** Android's thermal status (PowerManager.THERMAL_STATUS_*), 0 when the phone is cool or can't say. */
    private val _thermalStatus = MutableStateFlow(0)
    val thermalStatus: StateFlow<Int> = _thermalStatus.asStateFlow()

    fun setThermalStatus(status: Int) { _thermalStatus.value = status }

    /** When the server last printed "Server started.", for its uptime. Null while it isn't up. */
    private val _serverStartedAt = MutableStateFlow<Long?>(null)
    val serverStartedAt: StateFlow<Long?> = _serverStartedAt.asStateFlow()

    fun setServerStartedAt(time: Long?) { _serverStartedAt.value = time }

    /** HMBC's friend requests, or null while the bridge isn't signed in. */
    private val _friends = MutableStateFlow<Friends?>(null)
    val friends: StateFlow<Friends?> = _friends.asStateFlow()

    fun setFriends(friends: Friends?) { _friends.value = friends }

    /** A world import from a .mcworld file or a folder, while it runs and just after. */
    private val _worldImport = MutableStateFlow(WorldImport())
    val worldImport: StateFlow<WorldImport> = _worldImport.asStateFlow()

    fun updateWorldImport(change: (WorldImport) -> WorldImport) = _worldImport.update(change)

    /** Whether Minecraft is installed and where the world pickers open. Checked whenever BABS comes to the front. */
    private val _minecraft = MutableStateFlow<MinecraftInfo?>(null)
    val minecraft: StateFlow<MinecraftInfo?> = _minecraft.asStateFlow()

    fun setMinecraft(info: MinecraftInfo) { _minecraft.value = info }

    /** server.properties, the worlds and the allow list, as last read. */
    private val _serverSettings = MutableStateFlow(ServerSettings())
    val serverSettings: StateFlow<ServerSettings> = _serverSettings.asStateFlow()

    fun updateServerSettings(change: (ServerSettings) -> ServerSettings) = _serverSettings.update(change)

    private val _console =MutableStateFlow<List<ConsoleLine>>(emptyList())
    val console: StateFlow<List<ConsoleLine>> = _console.asStateFlow()

    private var nextId = 0L

    fun setServer(state: RunState, detail: String = "") { _server.value = ComponentStatus(state, detail) }
    fun setBridge(state: RunState, detail: String = "") { _bridge.value = ComponentStatus(state, detail) }

    /** The server's output as it arrives, for things that wait on an answer, such as save query during an export. */
    private val _serverLines = MutableSharedFlow<String>(extraBufferCapacity = 512)
    val serverLines: SharedFlow<String> = _serverLines.asSharedFlow()

    /** A world export, while it runs and just after. */
    private val _worldExport = MutableStateFlow(WorldExport())
    val worldExport: StateFlow<WorldExport> = _worldExport.asStateFlow()

    fun updateWorldExport(change: (WorldExport) -> WorldExport) = _worldExport.update(change)

    /** What the server reported about packs since it last started, for the Console's Content Log. */
    private val contentParser = ContentLog()
    private val _contentLog = MutableStateFlow<List<ContentEntry>>(emptyList())
    val contentLog: StateFlow<List<ContentEntry>> = _contentLog.asStateFlow()

    fun clearContentLog() = synchronized(contentParser) {
        contentParser.clear()
        _contentLog.value = emptyList()
    }

    /** A clone, rename, backup or backup load on the Worlds tab, while it runs and just after. */
    private val _worldTask = MutableStateFlow(WorldTask())
    val worldTask: StateFlow<WorldTask> = _worldTask.asStateFlow()

    fun updateWorldTask(change: (WorldTask) -> WorldTask) = _worldTask.update(change)

    /** Counts pack removals and moves, so a world's page reads its packs again. */
    private val _packsChanged = MutableStateFlow(0)
    val packsChanged: StateFlow<Int> = _packsChanged.asStateFlow()

    fun bumpPacks() = _packsChanged.update { it + 1 }

    /** GitHub Cloud: sign-in, the linked repo and how each world compares with it. */
    private val _cloud = MutableStateFlow(CloudView())
    val cloud: StateFlow<CloudView> = _cloud.asStateFlow()

    fun setCloud(view: CloudView) { _cloud.value = view }

    fun log(source: Source, text: String) {
        if (source == Source.Server) {
            _serverLines.tryEmit(text)
            synchronized(contentParser) { if (contentParser.add(text)) _contentLog.value = contentParser.all }
        }
        LogFile.write(source, text)
        _console.update { lines ->
            val line = synchronized(this) { ConsoleLine(nextId++, source, text) }
            if (lines.size >= MAX_LINES) lines.drop(lines.size - MAX_LINES + 1) + line else lines + line
        }
    }

    fun clearConsole() { _console.value = emptyList() }
}
