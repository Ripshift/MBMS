package app.babs.ui

import android.os.PowerManager
import androidx.compose.foundation.Image
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.foundation.border
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import app.babs.BabsApp
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.babs.R
import app.babs.core.FriendRequest
import app.babs.core.Hub
import app.babs.core.RunState
import app.babs.core.SetupStage
import app.babs.core.WorldChoice
import app.babs.core.Backup
import app.babs.core.ContentEntry
import app.babs.core.WorldPack

/** Running, or on the way up or down: Start has nothing to do, while Restart and Stop do. */
internal fun RunState.isActive() = this == RunState.Starting || this == RunState.Running || this == RunState.Stopping

/** The tabs along the bottom. */
internal enum class Tab(val label: String, val icon: Int) {
    Worlds("Worlds", R.drawable.ic_tab_worlds),
    Bridge("Bridge", R.drawable.ic_tab_bridge),
    Server("Server", R.drawable.ic_tab_server),
    Console("Console", R.drawable.ic_tab_console),
    Settings("Settings", R.drawable.ic_tab_settings),
}

/** What the screen asks MainActivity and the service to do. */
class Actions(
    val onInstall: () -> Unit,
    val onDownloadServer: () -> Unit,
    val onCheckUpdate: () -> Unit,
    val onStart: () -> Unit,
    val onRestart: () -> Unit,
    val onStop: () -> Unit,
    val onCommand: (String) -> Unit,
    val onShareLog: () -> Unit,
    val onBatterySettings: () -> Unit,
    // Bridge
    val onPublicAddress: (String) -> Unit,
    val onNewCode: () -> Unit,
    val onRestartBridge: () -> Unit,
    val onSignOut: () -> Unit,
    val onAutoAccept: (Boolean) -> Unit,
    val onAllowAcceptedFriends: (Boolean) -> Unit,
    val onApproveFriend: (FriendRequest) -> Unit,
    val onDenyFriend: (FriendRequest) -> Unit,
    val onRefreshFriends: () -> Unit,
    // Server
    val onRestartServer: () -> Unit,
    val onSetProperties: (Map<String, String>) -> Unit,
    val onSelectWorld: (String) -> Unit,
    val onCreateWorld: (name: String, seed: String) -> Unit,
    val onAllowList: (name: String, add: Boolean) -> Unit,
    // World import
    val onImportFile: () -> Unit,
    val onImportFolder: () -> Unit,
    val onChooseImport: (WorldChoice) -> Unit,
    val onCancelImport: () -> Unit,
    val onDismissImport: () -> Unit,
    // A world's packs
    val onAddPack: (folder: String) -> Unit,
    val onDismissPack: () -> Unit,
    val onRemovePack: (folder: String, pack: WorldPack) -> Unit,
    val onMovePack: (folder: String, pack: WorldPack, by: Int) -> Unit,
    // Worlds tab: clone, rename, back up, backups
    val onCloneWorld: (folder: String, name: String) -> Unit,
    val onRenameWorld: (folder: String, name: String) -> Unit,
    val onBackupWorld: (folder: String) -> Unit,
    val onLoadBackup: (backup: Backup, name: String) -> Unit,
    val onDeleteBackup: (backup: Backup) -> Unit,
    val onDismissWorldTask: () -> Unit,
    val onAutoSave: (Boolean) -> Unit,
    val onShareContentLog: () -> Unit,
    // Export / back up
    val onExportWorld: (folder: String, name: String) -> Unit,
    val onDismissExport: () -> Unit,
    val onRemoveWorld: (folder: String) -> Unit,
    // Phone performance
    val onAutoRestart: (Boolean) -> Unit,
    // The grass block in the top bar
    val onToggleTheme: () -> Unit,
)

/** Settings kept by BABS rather than the server, passed down from MainActivity. */
data class AppSettings(
    val publicAddress: String,
    val autoAcceptFriends: Boolean,
    val allowAcceptedFriends: Boolean,
    val unrestricted: Boolean,
    val eulaAccepted: Boolean,
    val autoRestart: Boolean = true,
    val autoSave: Boolean = true,
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MainScreen(
    arch: String,
    usesBox64: Boolean,
    appVersion: String,
    settings: AppSettings,
    actions: Actions,
) {
    val server by Hub.server.collectAsStateWithLifecycle()
    val bridge by Hub.bridge.collectAsStateWithLifecycle()
    val health by Hub.bridgeHealth.collectAsStateWithLifecycle()
    val friends by Hub.friends.collectAsStateWithLifecycle()
    val setup by Hub.setup.collectAsStateWithLifecycle()
    val thermal by Hub.thermalStatus.collectAsStateWithLifecycle()
    // Until Linux is installed everything starts on the Server tab, where the install is.
    var tab by rememberSaveable { mutableStateOf(if (setup.stage == SetupStage.Ready) Tab.Bridge else Tab.Server) }

    // A new sign-in code brings the Bridge tab forward once, so the code isn't missed on another tab.
    val signInCode = health?.signInCode
    LaunchedEffect(signInCode) {
        if (signInCode != null) tab = Tab.Bridge
    }
    val bridgeNeedsYou = signInCode != null || !friends?.requests.isNullOrEmpty()
    // The Console is badged while the Content Log has errors, as Bedrock Hub's sidebar is.
    val content by Hub.contentLog.collectAsStateWithLifecycle()
    val contentErrors = content.count { it.level == ContentEntry.Level.Error }

    val minecraft = HubColors.minecraft
    // The Minecraft theme's dirt sits behind everything; the Scaffold is see-through to show it.
    Box(Modifier.fillMaxSize().then(if (minecraft) Modifier.dirtBackground() else Modifier.background(HubColors.Bg))) {
    Scaffold(
        containerColor = Color.Transparent,
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(containerColor = HubColors.Side),
                // Bedrock Hub's brand: the name in capitals, and what it's for underneath.
                title = {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        // The app icon's grass block. Tapping it switches the theme; there's no label, on purpose.
                        Image(
                            painterResource(R.drawable.ic_logo),
                            contentDescription = null,
                            modifier = Modifier
                                .size(36.dp)
                                .clickable(
                                    interactionSource = remember { MutableInteractionSource() },
                                    indication = null,
                                    onClick = actions.onToggleTheme,
                                ),
                        )
                        Spacer(Modifier.width(10.dp))
                        Column {
                            Text("BABS", fontWeight = FontWeight.Bold, fontSize = 18.sp, letterSpacing = 0.5.sp)
                            Text(
                                "Bridged Android Bedrock Server",
                                color = HubColors.Muted,
                                fontSize = if (minecraft) 9.sp else 11.sp,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                },
                actions = {
                    HeatChip(thermal)
                    StatusDot("Bridge", bridge.state)
                    Spacer(Modifier.width(12.dp))
                    StatusDot("Server", server.state)
                    Spacer(Modifier.width(16.dp))
                },
            )
        },
        bottomBar = {
            NavigationBar {
                Tab.entries.forEach { t ->
                    NavigationBarItem(
                        selected = tab == t,
                        onClick = { tab = t },
                        icon = {
                            BadgedBox(badge = {
                                if (t == Tab.Bridge && bridgeNeedsYou) Badge()
                                if (t == Tab.Console && contentErrors > 0) Badge { Text("$contentErrors") }
                            }) {
                                Icon(painterResource(t.icon), contentDescription = null)
                            }
                        },
                        label = { Text(t.label) },
                    )
                }
            }
        },
    ) { padding ->
        Box(
            Modifier
                .padding(padding)
                .consumeWindowInsets(padding)
                .imePadding()
                .fillMaxSize(),
        ) {
            when (tab) {
                Tab.Worlds -> WorldsTab(server, actions)
                Tab.Bridge -> BridgeTab(bridge, server, health, friends, settings, actions, onOpenSettings = { tab = Tab.Settings })
                Tab.Server -> ServerTab(server, bridge, usesBox64, settings.eulaAccepted, settings.publicAddress, actions, onOpenSettings = { tab = Tab.Settings }, onOpenWorlds = { tab = Tab.Worlds })
                Tab.Console -> ConsoleTab(serverRunning = server.state == RunState.Running, actions = actions)
                Tab.Settings -> SettingsTab(arch, usesBox64, appVersion, settings, actions)
            }
        }
    }
    }
}

/** A pip and a name, as Bedrock Hub's sidebar pills, so the state of both shows on every tab. */
@Composable
private fun StatusDot(name: String, state: RunState) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Pip(state, size = 8.dp)
        Spacer(Modifier.width(6.dp))
        Text(name, style = MaterialTheme.typography.labelMedium)
    }
}

/** Shows on every tab once the phone is warm, in Bedrock Hub's warning colours. */
@Composable
private fun HeatChip(status: Int) {
    if (status < PowerManager.THERMAL_STATUS_LIGHT) return
    val color = heatColor(status)
    Text(
        BabsApp.thermalWord(status).replaceFirstChar { it.uppercase() },
        color = color,
        fontWeight = FontWeight.SemiBold,
        style = MaterialTheme.typography.labelMedium,
        modifier = Modifier
            .border(1.dp, color, MaterialTheme.shapes.small)
            .padding(horizontal = 8.dp, vertical = 3.dp),
    )
    Spacer(Modifier.width(12.dp))
}

/** Normal and warm are fine, hot is a warning, and anything past that is Bedrock Hub's error red. */
internal fun heatColor(status: Int) = when {
    status >= PowerManager.THERMAL_STATUS_SEVERE -> HubColors.Err
    status >= PowerManager.THERMAL_STATUS_MODERATE -> HubColors.Warn
    status >= PowerManager.THERMAL_STATUS_LIGHT -> HubColors.Text
    else -> HubColors.Ok
}

/** A scrolling page of cards, as the Bridge, Server and Settings tabs are. */
@Composable
internal fun TabPage(content: @Composable () -> Unit) {
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) { content() }
}

@Composable
internal fun SectionCard(title: String, content: @Composable () -> Unit) {
    HubCard(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium)
            content()
        }
    }
}

@Composable
internal fun Hint(text: String) {
    Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

/** One line of text to enter. [problem] says what's wrong with the text, or null when it can be saved. */
@Composable
internal fun TextInputDialog(
    title: String,
    initial: String,
    note: String? = null,
    placeholder: String = "",
    number: Boolean = false,
    problem: (String) -> String? = { null },
    onSave: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    var text by rememberSaveable { mutableStateOf(initial) }
    val error = problem(text.trim())
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                note?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
                OutlinedTextField(
                    value = text,
                    onValueChange = { text = it },
                    singleLine = true,
                    isError = error != null && text.isNotEmpty(),
                    supportingText = { if (text.isNotEmpty()) error?.let { Text(it) } },
                    placeholder = { Text(placeholder) },
                    keyboardOptions = KeyboardOptions(
                        keyboardType = if (number) KeyboardType.Number else KeyboardType.Text,
                        imeAction = ImeAction.Done,
                    ),
                )
            }
        },
        confirmButton = { TextButton(colors = linkColors(), onClick = { onSave(text.trim()) }, enabled = error == null) { Text("Save") } },
        dismissButton = { TextButton(colors = linkColors(), onClick = onDismiss) { Text("Cancel") } },
    )
}

/** Pick one of a few values. */
@Composable
internal fun ChoiceDialog(
    title: String,
    options: List<Pair<String, String>>,
    selected: String,
    onPick: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            Column {
                options.forEach { (value, label) ->
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .selectable(selected = value == selected, role = Role.RadioButton, onClick = { onPick(value) })
                            .padding(vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        RadioButton(selected = value == selected, onClick = null)
                        Spacer(Modifier.width(12.dp))
                        Text(label, style = MaterialTheme.typography.bodyLarge)
                    }
                }
            }
        },
        confirmButton = { TextButton(colors = linkColors(), onClick = onDismiss) { Text("Cancel") } },
    )
}

@Composable
internal fun ConfirmDialog(title: String, text: String, confirm: String, onConfirm: () -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = { Text(text, style = MaterialTheme.typography.bodyMedium) },
        confirmButton = { TextButton(colors = linkColors(), onClick = onConfirm) { Text(confirm) } },
        dismissButton = { TextButton(colors = linkColors(), onClick = onDismiss) { Text("Cancel") } },
    )
}
