package app.babs

import android.Manifest
import android.annotation.SuppressLint
import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.provider.DocumentsContract
import app.babs.core.WorldImporter
import app.babs.core.PackInstaller
import app.babs.core.WorldExporter
import app.babs.core.WorldOps
import app.babs.core.ContentLog
import app.babs.core.CloudSync
import android.os.Environment
import java.io.File
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.SystemBarStyle
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.lifecycle.lifecycleScope
import app.babs.core.BridgeApi
import app.babs.core.FriendRequest
import app.babs.core.Hub
import app.babs.core.Layout
import app.babs.core.LogFile
import app.babs.core.Prefs
import app.babs.core.RunState
import app.babs.core.ServerConfig
import app.babs.core.SetupStage
import app.babs.core.Source
import app.babs.service.ServerService
import app.babs.setup.ServerInstaller
import app.babs.ui.Actions
import app.babs.ui.AppSettings
import app.babs.ui.BabsTheme
import app.babs.ui.MainScreen
import app.babs.ui.HubColors
import app.babs.ui.HubPalette
import app.babs.ui.MinecraftPalette
import app.babs.ui.Splash
import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.tween
import androidx.compose.runtime.saveable.rememberSaveable
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class MainActivity : ComponentActivity() {
    private var afterPermission: (() -> Unit)? = null
    private val askNotifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) {
        // Runs either way. Without the permission the notification just isn't shown.
        afterPermission?.invoke()
        afterPermission = null
    }

    /** The file picker, opened where [WorldImporter.findMinecraft] says worlds are likely to be. */
    private class OpenDocumentAt : ActivityResultContracts.OpenDocument() {
        var startAt: Uri? = null
        override fun createIntent(context: Context, input: Array<String>): Intent =
            super.createIntent(context, input).apply { startAt?.let { putExtra(DocumentsContract.EXTRA_INITIAL_URI, it) } }
    }

    private val openWorldFile = OpenDocumentAt()
    private val pickWorldFile = registerForActivityResult(openWorldFile) { uri ->
        if (uri != null) WorldImporter.importFile(this, uri, worldsDir)
    }
    private val pickWorldFolder = registerForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
        if (uri != null) {
            // Kept until the import is done, which can outlast this screen when the folder holds several worlds.
            runCatching { contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) }
            WorldImporter.importFolder(this, uri, worldsDir)
        }
    }
    private val worldsDir get() = File(layout.serverDir, "worlds")

    /**
     * Export: Android's save dialog, which suggests the world's name and the date. Which world is kept in the saved
     * state, since Android may recreate this screen while the dialog is open.
     */
    private var exportFolder: String? = null

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putString(KEY_EXPORT_FOLDER, exportFolder)
        outState.putString(KEY_PACK_FOLDER, packFolder)
    }
    private val saveWorld = registerForActivityResult(ActivityResultContracts.CreateDocument("application/octet-stream")) { uri ->
        val folder = exportFolder
        when {
            uri == null -> Unit
            folder != null -> ServerService.exportWorld(this, folder, uri)
            else -> {
                Hub.log(Source.Babs, "Couldn't tell which world to export. Try again")
                runCatching { DocumentsContract.deleteDocument(contentResolver, uri) }
            }
        }
        exportFolder = null
    }

    /**
     * Add pack to a world: a .mcaddon or .mcpack, which usually comes from a browser's downloads. Which world is kept
     * in the saved state, as for Export, since Android may recreate this screen while the picker is open.
     */
    private val openPack = OpenDocumentAt()
    private var packFolder: String? = null
    private val pickPack = registerForActivityResult(openPack) { uri ->
        val folder = packFolder
        packFolder = null
        if (uri != null && folder != null) {
            val hosted = folder == Hub.serverSettings.value.currentWorld
            PackInstaller.add(this, uri, File(worldsDir, folder), serverRunning && hosted)
        }
    }

    private lateinit var layout: Layout
    private lateinit var prefs: Prefs
    private lateinit var config: ServerConfig

    /** BABS's own settings, as the screen shows them. Battery state is checked again whenever BABS comes back. */
    private var settings by mutableStateOf(AppSettings("", true, true, false, false))

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Light status bar icons on Bedrock Hub's dark theme, whatever the phone's own setting.
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
        )
        layout = Layout(this)
        prefs = Prefs(this)
        exportFolder = savedInstanceState?.getString(KEY_EXPORT_FOLDER)
        packFolder = savedInstanceState?.getString(KEY_PACK_FOLDER)
        if (Hub.account.value == null) Hub.setAccount(prefs.lastGamertag, prefs.lastGamerpic)
        config = ServerConfig(layout.serverDir)
        settings = AppSettings(
            publicAddress = prefs.publicAddress,
            autoAcceptFriends = prefs.autoAcceptFriends,
            allowAcceptedFriends = prefs.allowAcceptedFriends,
            unrestricted = false,
            eulaAccepted = prefs.eulaAccepted,
            autoRestart = prefs.autoRestart,
            autoSave = prefs.autoSave,
        )
        // Unless an install is running, the files on disk say whether Linux is installed.
        if (Hub.setup.value.stage != SetupStage.Working) {
            Hub.setSetup(if (layout.isLinuxReady) SetupStage.Ready else SetupStage.NotInstalled)
        }
        if (Hub.serverFiles.value.busy == null) {
            Hub.updateServerFiles { it.copy(installed = layout.installedServerVersion()) }
        }
        reloadServerSettings()
        // Shows "Update to ..." when Mojang has released a newer server.
        if (layout.serverBinary.exists() && Hub.serverFiles.value.latest == null) {
            lifecycleScope.launch { checkForUpdate(quiet = true) }
        }
        val version = runCatching { packageManager.getPackageInfo(packageName, 0).versionName }.getOrNull() ?: "?"
        val actions = Actions(
            onInstall = { withNotifications { ServerService.install(this) } },
            onDownloadServer = {
                prefs.eulaAccepted = true
                settings = settings.copy(eulaAccepted = true)
                withNotifications { ServerService.downloadServer(this) }
            },
            onCheckUpdate = { lifecycleScope.launch { checkForUpdate(quiet = false) } },
            onStart = { withNotifications { ServerService.start(this) } },
            onRestart = { ServerService.restart(this) },
            onStop = { ServerService.stop(this) },
            onCommand = { ServerService.command(this, it) },
            onShareLog = ::shareLog,
            onBatterySettings = ::askUnrestricted,
            onPublicAddress = {
                prefs.publicAddress = it
                settings = settings.copy(publicAddress = prefs.publicAddress)
                if (Hub.bridge.value.state == RunState.Running || Hub.bridge.value.state == RunState.Starting) {
                    ServerService.applyPublicAddress(this)
                }
            },
            onNewCode = { ServerService.restartBridge(this) },
            onRestartBridge = { ServerService.restartBridge(this) },
            onSignOut = { ServerService.signOut(this) },
            onAutoAccept = ::setAutoAccept,
            onAllowAcceptedFriends = {
                prefs.allowAcceptedFriends = it
                settings = settings.copy(allowAcceptedFriends = it)
            },
            onApproveFriend = ::approveFriend,
            onDenyFriend = ::denyFriend,
            onRefreshFriends = {
                lifecycleScope.launch {
                    val friends = withContext(Dispatchers.IO) { BridgeApi.friends(refresh = true) }
                    if (friends != null) Hub.setFriends(friends) else Hub.log(Source.Babs, "The bridge didn't answer. Is it running and signed in?")
                }
            },
            onRestartServer = { ServerService.restartServer(this) },
            onSetProperties = ::setProperties,
            onSelectWorld = ::selectWorld,
            onCreateWorld = ::createWorld,
            onAllowList = { name, add -> lifecycleScope.launch { changeAllowList(name, add) } },
            onImportFile = {
                openWorldFile.startAt = Hub.minecraft.value?.startAt
                // .mcworld has no registered type, so any file can be picked and the importer checks it.
                runCatching { pickWorldFile.launch(arrayOf("*/*")) }
                    .onFailure { Hub.log(Source.Babs, "Couldn't open the file picker: ${it.message}") }
            },
            onImportFolder = {
                runCatching { pickWorldFolder.launch(Hub.minecraft.value?.startAt) }
                    .onFailure { Hub.log(Source.Babs, "Couldn't open the folder picker: ${it.message}") }
            },
            onChooseImport = { choice ->
                Hub.worldImport.value.choiceTree?.let { WorldImporter.importChoice(this, choice, Uri.parse(it), worldsDir) }
            },
            onCancelImport = WorldImporter::cancel,
            onDismissImport = WorldImporter::dismiss,
            onAddPack = { folder ->
                packFolder = folder
                openPack.startAt = DocumentsContract.buildDocumentUri(
                    "com.android.externalstorage.documents", "primary:${Environment.DIRECTORY_DOWNLOADS}",
                )
                // .mcaddon and .mcpack have no registered type, so any file can be picked and the installer checks it.
                runCatching { pickPack.launch(arrayOf("*/*")) }
                    .onFailure { Hub.log(Source.Babs, "Couldn't open the file picker: ${it.message}") }
            },
            onDismissPack = PackInstaller::dismiss,
            onRemovePack = { folder, pack -> changePacks(folder) { PackInstaller.remove(it, pack.uuid, pack.behavior) } },
            onMovePack = { folder, pack, by -> changePacks(folder) { PackInstaller.move(it, pack.uuid, pack.behavior, by) } },
            onCloneWorld = { folder, name -> WorldOps.clone(layout.serverDir, folder, name) },
            onRenameWorld = { folder, name -> WorldOps.rename(layout.serverDir, folder, name) },
            onBackupWorld = { folder -> WorldOps.backup(layout.serverDir, folder) },
            onLoadBackup = { backup, name -> WorldOps.loadBackup(layout.serverDir, backup, name) },
            onDeleteBackup = { backup -> WorldOps.deleteBackup(layout.serverDir, backup) },
            onDismissWorldTask = WorldOps::dismiss,
            onAutoSave = {
                prefs.autoSave = it
                settings = settings.copy(autoSave = it)
            },
            onShareContentLog = ::shareContentLog,
            onCloudUpload = { ServerService.cloudUpload(this, it) },
            onCloudDownload = { ServerService.cloudDownload(this, it) },
            onCloudCheck = { checkCloud(force = true) },
            onCloudChoice = { choice ->
                CloudSync.dismissPrompt()
                if (choice != null) withNotifications { ServerService.start(this, choice) }
            },
            onExportWorld = { folder, name ->
                exportFolder = folder
                runCatching { saveWorld.launch(WorldExporter.fileName(name)) }
                    .onFailure { Hub.log(Source.Babs, "Couldn't open the save dialog: ${it.message}") }
            },
            onDismissExport = WorldExporter::dismiss,
            onRemoveWorld = ::removeWorld,
            onAutoRestart = {
                prefs.autoRestart = it
                settings = settings.copy(autoRestart = it)
            },
            onToggleTheme = {
                prefs.minecraftTheme = !prefs.minecraftTheme
                HubColors.palette = if (prefs.minecraftTheme) MinecraftPalette else HubPalette
            },
        )
        HubColors.palette = if (prefs.minecraftTheme) MinecraftPalette else HubPalette
        // Babs winks once per launch, not when the screen is recreated (turning the phone, coming back to it).
        val firstLaunch = savedInstanceState == null
        setContent {
            BabsTheme {
                var splash by rememberSaveable { mutableStateOf(firstLaunch) }
                Crossfade(targetState = splash, animationSpec = tween(200), label = "splash") { showing ->
                    if (showing) {
                        Splash(onDone = { splash = false })
                    } else {
                        MainScreen(
                            arch = layout.arch.label,
                            usesBox64 = layout.needsBox64,
                            appVersion = version,
                            settings = settings,
                            actions = actions,
                        )
                    }
                }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        // Minecraft may have been installed, or set to shared storage, since BABS was last in front.
        Hub.setMinecraft(WorldImporter.findMinecraft(this))
        settings = settings.copy(
            unrestricted = getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(packageName),
        )
        checkCloud(force = false)
    }

    /**
     * Looks for newer saves in GitHub Cloud and uploads what isn't there yet, as Bedrock Hub does at launch. Coming
     * back to BABS checks at most every 15 minutes.
     */
    private fun checkCloud(force: Boolean) {
        if (!CloudSync.linked) return
        val now = System.currentTimeMillis()
        if (!force && now - lastCloudCheck < CLOUD_CHECK_MS) return
        lastCloudCheck = now
        lifecycleScope.launch {
            for (world in CloudSync.check()) ServerService.cloudUpload(this@MainActivity, world)
        }
    }

    private val serverRunning: Boolean
        get() = Hub.server.value.state == RunState.Running || Hub.server.value.state == RunState.Starting

    private fun reloadServerSettings(restartNeeded: Boolean = Hub.serverSettings.value.restartNeeded) {
        lifecycleScope.launch {
            val loaded = withContext(Dispatchers.IO) { config.load(restartNeeded) }
            Hub.updateServerSettings { loaded }
        }
    }

    /**
     * Writes server.properties. The server only reads it at start, so while it runs this asks for a restart,
     * except for the allow list, which the server switches straight away with its allowlist command.
     */
    private fun setProperties(changes: Map<String, String>) {
        lifecycleScope.launch {
            val ok = withContext(Dispatchers.IO) { runCatching { config.setProperties(changes) } }
                .onFailure { Hub.log(Source.Babs, "Couldn't change the server's settings: ${it.message}") }
                .isSuccess
            if (!ok) return@launch
            Hub.log(Source.Babs, "Server settings changed: " + changes.entries.joinToString { "${it.key}=${it.value}" })
            var restart = false
            if (serverRunning) {
                changes["allow-list"]?.let { ServerService.command(this@MainActivity, "allowlist ${if (it == "true") "on" else "off"}") }
                restart = changes.keys.any { it != "allow-list" }
            }
            reloadServerSettings(Hub.serverSettings.value.restartNeeded || restart)
        }
    }

    private fun selectWorld(folder: String) {
        lifecycleScope.launch {
            val ok = withContext(Dispatchers.IO) { runCatching { config.setProperties(mapOf("level-name" to folder)) }.isSuccess }
            if (!ok) {
                Hub.log(Source.Babs, "Couldn't switch worlds")
                return@launch
            }
            Hub.log(Source.Babs, "The server will run the world \"$folder\"")
            reloadServerSettings()
            if (serverRunning) ServerService.restartServer(this@MainActivity)
        }
    }

    /**
     * Removes or moves a pack in a world's list. A change to the world the server runs takes effect when it
     * restarts, so that shows the Restart now banner.
     */
    private fun changePacks(folder: String, change: (File) -> Unit) {
        lifecycleScope.launch {
            val ok = withContext(Dispatchers.IO) { runCatching { change(File(worldsDir, folder)) } }
                .onFailure { Hub.log(Source.Babs, "Couldn't change the packs: ${it.message}") }
                .isSuccess
            Hub.bumpPacks()
            if (ok && serverRunning && folder == Hub.serverSettings.value.currentWorld) {
                Hub.updateServerSettings { it.copy(restartNeeded = true) }
            }
        }
    }

    /** Deletes a world's folder, never the one the server runs (the button isn't offered for it, and this checks). */
    private fun removeWorld(folder: String) {
        if (folder == Hub.serverSettings.value.currentWorld || folder.isBlank() || "/" in folder || folder.startsWith(".")) return
        lifecycleScope.launch {
            val dir = File(worldsDir, folder)
            val ok = withContext(Dispatchers.IO) { dir.isDirectory && dir.deleteRecursively() }
            Hub.log(Source.Babs, if (ok) "Removed the world \"$folder\"" else "Couldn't remove the world \"$folder\"")
            reloadServerSettings()
        }
    }

    /** A new world is a new level-name: the server makes the folder the next time it starts. */
    private fun createWorld(name: String, seed: String) {
        lifecycleScope.launch {
            val ok = withContext(Dispatchers.IO) {
                runCatching { config.setProperties(mapOf("level-name" to name, "level-seed" to seed)) }.isSuccess
            }
            if (!ok) {
                Hub.log(Source.Babs, "Couldn't set up the new world")
                return@launch
            }
            Hub.log(Source.Babs, "New world \"$name\"${if (seed.isNotEmpty()) " with seed $seed" else ""}. The server makes it when it starts")
            reloadServerSettings()
            if (serverRunning) ServerService.restartServer(this@MainActivity)
        }
    }

    /** Edits allowlist.json, then has a running server read it again, so no restart is needed. */
    private suspend fun changeAllowList(name: String, add: Boolean) {
        val changed = withContext(Dispatchers.IO) { runCatching { config.changeAllowList(name, add) } }
            .onFailure { Hub.log(Source.Babs, "Couldn't change the allow list: ${it.message}") }
            .getOrDefault(false)
        if (changed) {
            Hub.log(Source.Babs, if (add) "Added $name to the allow list" else "Removed $name from the allow list")
            if (serverRunning) ServerService.command(this, "allowlist reload")
        }
        reloadServerSettings()
    }

    private fun setAutoAccept(enabled: Boolean) {
        prefs.autoAcceptFriends = enabled
        settings = settings.copy(autoAcceptFriends = enabled)
        Hub.friends.value?.let { Hub.setFriends(it.copy(autoAccept = enabled)) }
        lifecycleScope.launch {
            // A running bridge changes straight away. Otherwise it gets the setting when it starts.
            if (Hub.bridge.value.state.let { it == RunState.Running || it == RunState.Starting }) {
                val ok = withContext(Dispatchers.IO) { BridgeApi.setAutoAccept(enabled) }
                if (!ok) Hub.log(Source.Babs, "The bridge didn't take the change yet. It will when it next starts")
            }
        }
    }

    private fun approveFriend(request: FriendRequest) {
        lifecycleScope.launch {
            val ok = withContext(Dispatchers.IO) { BridgeApi.approve(request.xuid) }
            if (!ok) {
                Hub.log(Source.Babs, "Couldn't accept ${request.gamertag}. The request may have been withdrawn")
                return@launch
            }
            Hub.log(Source.Babs, "Accepted the friend request from ${request.gamertag}")
            Hub.friends.value?.let { f -> Hub.setFriends(f.copy(requests = f.requests - request)) }
            if (prefs.allowAcceptedFriends && Hub.serverSettings.value.allowListOn && ServerConfig.isValidName(request.gamertag)) {
                changeAllowList(request.gamertag, add = true)
            }
        }
    }

    private fun denyFriend(request: FriendRequest) {
        lifecycleScope.launch {
            val ok = withContext(Dispatchers.IO) { BridgeApi.deny(request.xuid) }
            if (ok) {
                Hub.log(Source.Babs, "Declined the friend request from ${request.gamertag}")
                Hub.friends.value?.let { f -> Hub.setFriends(f.copy(requests = f.requests - request)) }
            } else {
                Hub.log(Source.Babs, "Couldn't decline ${request.gamertag}")
            }
        }
    }

    private suspend fun checkForUpdate(quiet: Boolean) {
        val latest = ServerInstaller.checkLatest()
        if (latest == null) {
            if (!quiet) Hub.log(Source.Babs, "Couldn't reach minecraft.net to check for updates")
            return
        }
        Hub.updateServerFiles { it.copy(latest = latest.version) }
        if (!quiet) Hub.log(Source.Babs, "The newest Bedrock server is ${latest.version}")
    }

    /** Hands the saved log, with a short device header, to whichever app the person picks. */
    private fun shareLog() {
        lifecycleScope.launch {
            val file = runCatching { withContext(Dispatchers.IO) { LogFile.export(this@MainActivity) } }
                .getOrElse {
                    Hub.log(Source.Babs, "Couldn't prepare the log: ${it.message}")
                    return@launch
                }
            val uri = FileProvider.getUriForFile(this@MainActivity, "app.babs.files", file)
            val send = Intent(Intent.ACTION_SEND)
                .setType("text/plain")
                .putExtra(Intent.EXTRA_STREAM, uri)
                .putExtra(Intent.EXTRA_SUBJECT, "BABS log")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            // Also grants the share sheet itself, which reads the file for its preview.
            send.clipData = ClipData.newRawUri("BABS log", uri)
            startActivity(Intent.createChooser(send, "Share the BABS log"))
        }
    }

    /** Shares the Content Log as text, the same as Bedrock Hub's Copy all. */
    private fun shareContentLog() {
        lifecycleScope.launch {
            val file = runCatching {
                withContext(Dispatchers.IO) {
                    File(File(cacheDir, "share").apply { mkdirs() }, "content-log.txt").apply {
                        writeText(ContentLog.toText(Hub.contentLog.value) + "\n")
                    }
                }
            }.getOrElse {
                Hub.log(Source.Babs, "Couldn't prepare the Content Log: ${it.message}")
                return@launch
            }
            val uri = FileProvider.getUriForFile(this@MainActivity, "app.babs.files", file)
            val send = Intent(Intent.ACTION_SEND)
                .setType("text/plain")
                .putExtra(Intent.EXTRA_STREAM, uri)
                .putExtra(Intent.EXTRA_SUBJECT, "Bedrock server Content Log")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            send.clipData = ClipData.newRawUri("Content Log", uri)
            startActivity(Intent.createChooser(send, "Share the Content Log"))
        }
    }

    /** Asks Android to leave BABS out of battery optimisation, or opens the list if that dialog isn't available. */
    @SuppressLint("BatteryLife")
    private fun askUnrestricted() {
        val ask = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName"))
        runCatching { startActivity(ask) }
            .onFailure { runCatching { startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)) } }
    }

    private companion object {
        /** Shared by every MainActivity, so turning the phone doesn't check again. */
        var lastCloudCheck = 0L
        const val CLOUD_CHECK_MS = 15 * 60_000L
        const val KEY_EXPORT_FOLDER = "export_folder"
        const val KEY_PACK_FOLDER = "pack_folder"
    }

    private fun withNotifications(action: () -> Unit) {
        val needsAsking = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        if (needsAsking) {
            afterPermission = action
            askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
        } else {
            action()
        }
    }
}
