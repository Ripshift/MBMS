package app.babs.ui

import android.graphics.BitmapFactory
import android.os.PowerManager
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.FilledTonalButton
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import app.babs.BabsApp
import app.babs.core.PackInstaller
import app.babs.core.WorldPack
import app.babs.core.WorldExport
import android.text.format.DateUtils
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import app.babs.core.PhoneStats
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import java.io.File
import android.text.format.Formatter
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.selectable
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.foundation.layout.height
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.babs.core.ComponentStatus
import app.babs.core.Hub
import app.babs.core.RunState
import app.babs.core.ServerConfig
import app.babs.core.ServerSettings
import app.babs.core.SetupStage
import app.babs.core.Source
import app.babs.core.World

/** The Bedrock server: install, status, who's on, Start / Restart / Stop, and which world it runs. */
@Composable
internal fun ServerTab(
    server: ComponentStatus,
    bridge: ComponentStatus,
    usesBox64: Boolean,
    eulaAccepted: Boolean,
    publicAddress: String,
    actions: Actions,
    onOpenSettings: () -> Unit,
) {
    val setup by Hub.setup.collectAsStateWithLifecycle()
    val files by Hub.serverFiles.collectAsStateWithLifecycle()
    val settings by Hub.serverSettings.collectAsStateWithLifecycle()
    val players by Hub.players.collectAsStateWithLifecycle()
    val console by Hub.console.collectAsStateWithLifecycle()

    TabPage {
        if (setup.stage != SetupStage.Ready) {
            SetupCard(setup, usesBox64, actions.onInstall)
        } else if (files.installed == null || files.busy != null || files.error != null) {
            ServerDownloadCard(files, eulaAccepted, actions.onDownloadServer)
        }

        StatusCard("Server", server, Modifier.fillMaxWidth()) {
            ServerStats(server, settings, players, publicAddress)
            if (files.updateAvailable && files.busy == null) {
                TextButton(colors = linkColors(), onClick = actions.onDownloadServer, contentPadding = PaddingValues(0.dp)) {
                    Text("Update to ${files.latest}")
                }
            }
        }

        val serverUp = server.state.isActive()
        val bridgeUp = bridge.state.isActive()
        val ready = setup.stage == SetupStage.Ready
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
            // Bedrock Hub's controls: a green Start, and plain panel buttons for Restart and Stop.
            Button(
                onClick = actions.onStart, enabled = ready && !(serverUp && bridgeUp), modifier = Modifier.weight(1f),
                shape = MaterialTheme.shapes.small,
                colors = ButtonDefaults.buttonColors(containerColor = HubColors.Green, contentColor = Color.White),
            ) { Text("Start", fontWeight = FontWeight.SemiBold) }
            FilledTonalButton(onClick = actions.onRestart, enabled = serverUp || bridgeUp, modifier = Modifier.weight(1f), shape = MaterialTheme.shapes.small) {
                Text("Restart", fontWeight = FontWeight.SemiBold)
            }
            FilledTonalButton(onClick = actions.onStop, enabled = serverUp || bridgeUp, modifier = Modifier.weight(1f), shape = MaterialTheme.shapes.small) {
                Text("Stop", fontWeight = FontWeight.SemiBold)
            }
        }
        Hint("Start, Restart and Stop work on the server and the bridge together.")

        if (settings.restartNeeded && server.state == RunState.Running) {
            RestartBanner(actions.onRestartServer)
        }

        if (files.installed != null) {
            AllowListNotice(settings, onOpenSettings)
            WorldsCard(settings, server.state, actions)
            PacksCard(settings, actions)
        }

        // The server's last few lines, so what it's doing shows without leaving this tab.
        val recent = console.asReversed().asSequence().filter { it.source == Source.Server }.take(4).toList().asReversed()
        if (recent.isNotEmpty()) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .background(CONSOLE_BACKGROUND, MaterialTheme.shapes.medium)
                    .padding(10.dp),
            ) {
                Text("Latest from the server", color = CONSOLE_DIM, style = MaterialTheme.typography.labelLarge)
                recent.forEach { line ->
                    Text(
                        line.text,
                        color = line.source.color(),
                        fontFamily = FontFamily.Monospace,
                        fontSize = 11.sp,
                        lineHeight = 14.sp,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
    }
}

/**
 * The same stats as Bedrock Hub's server card (players, uptime, who's on, version, game mode, world, last saved,
 * address), plus what matters when the server is a phone: its memory and the battery.
 */
@Composable
private fun ServerStats(server: ComponentStatus, settings: ServerSettings, players: List<String>, publicAddress: String) {
    val context = LocalContext.current
    val files by Hub.serverFiles.collectAsStateWithLifecycle()
    val startedAt by Hub.serverStartedAt.collectAsStateWithLifecycle()
    val up = server.state == RunState.Running
    val props = settings.properties
    val worldDir = File(context.filesDir, "server/worlds/${settings.currentWorld}")

    // Phone stats every 5 seconds, and the world's picture whenever the world changes.
    var stats by remember { mutableStateOf(PhoneStats()) }
    LaunchedEffect(settings.currentWorld) {
        while (true) {
            stats = withContext(Dispatchers.IO) { PhoneStats.read(context, worldDir) }
            delay(5_000)
        }
    }
    val icon by produceState<ImageBitmap?>(null, settings.currentWorld, stats.lastSaved) {
        value = withContext(Dispatchers.IO) {
            runCatching { BitmapFactory.decodeFile(File(worldDir, "world_icon.jpeg").path)?.asImageBitmap() }.getOrNull()
        }
    }
    // Uptime ticks every second while the server is up.
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(startedAt) {
        while (startedAt != null) {
            now = System.currentTimeMillis()
            delay(1_000)
        }
    }

    val worldName = settings.worlds.firstOrNull { it.folder == settings.currentWorld }?.displayName ?: settings.currentWorld
    val port = props["server-port"] ?: "19132"
    val modes = mapOf("survival" to "Survival", "creative" to "Creative", "adventure" to "Adventure")
    val size = { bytes: Long -> Formatter.formatShortFileSize(context, bytes) }

    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(vertical = 4.dp)) {
        icon?.let {
            Image(
                it, contentDescription = null, contentScale = ContentScale.Crop,
                modifier = Modifier
                    .size(56.dp)
                    .clip(MaterialTheme.shapes.small),
            )
            Spacer(Modifier.width(12.dp))
        }
        Column {
            Text(worldName, style = MaterialTheme.typography.titleMedium)
            Hint(modes[props["gamemode"]] ?: props["gamemode"].orEmpty().ifEmpty { "Game mode not set" })
        }
    }
    val thermal by Hub.thermalStatus.collectAsStateWithLifecycle()
    // Bedrock Hub's eight, in its order, then the phone's own.
    val cells = listOf(
        StatCell("Players", if (up) "${players.size} / ${props["max-players"] ?: "?"}" else "-"),
        StatCell("Uptime", startedAt?.takeIf { up }?.let { span((now - it) / 1000) } ?: "-"),
        StatCell("Online now", if (!up) "-" else players.joinToString().ifEmpty { "Nobody" }),
        StatCell("Version", (files.installed ?: "-") + (if (files.updateAvailable) " (${files.latest} available)" else "")),
        StatCell("Game mode", modes[props["gamemode"]] ?: props["gamemode"] ?: "-"),
        StatCell("World", worldName),
        StatCell("Last saved", stats.lastSaved?.let { ago(it, now.coerceAtLeast(System.currentTimeMillis())) } ?: "-"),
        StatCell("Address", stats.lanAddress?.let { "$it:$port" } ?: "No network"),
        StatCell(
            "Temperature",
            listOfNotNull(stats.batteryTemp?.let { "%.1f °C".format(it) }, BabsApp.thermalWord(thermal).replaceFirstChar { it.uppercase() })
                .joinToString(", "),
            heatColor(thermal).takeIf { thermal >= PowerManager.THERMAL_STATUS_MODERATE },
        ),
        StatCell("Battery", stats.batteryPercent?.let { "$it%${if (stats.charging) ", charging" else ""}" } ?: "-"),
        StatCell("Server memory", if (stats.serverMemory == 0L) "-" else size(stats.serverMemory)),
        StatCell("Bridge memory", if (stats.bridgeMemory == 0L) "-" else size(stats.bridgeMemory)),
    )
    cells.chunked(2).forEach { pair ->
        Row(horizontalArrangement = Arrangement.spacedBy(16.dp), modifier = Modifier.fillMaxWidth()) {
            pair.forEach { StatBox(it, Modifier.weight(1f)) }
            if (pair.size == 1) Spacer(Modifier.weight(1f))
        }
    }
    if (publicAddress.isNotEmpty()) Hint("From outside this network: $publicAddress:$port")
}

private data class StatCell(val label: String, val value: String, val color: Color? = null)

/** Bedrock Hub's stat: a line above, a small capitalised label, and the value in semibold. */
@Composable
private fun StatBox(cell: StatCell, modifier: Modifier) {
    Column(modifier.padding(top = 8.dp)) {
        HorizontalDivider(color = HubColors.Line)
        Spacer(Modifier.height(6.dp))
        Text(cell.label.uppercase(), color = HubColors.Muted, fontSize = 11.sp, letterSpacing = 0.5.sp)
        Text(
            cell.value,
            color = cell.color ?: HubColors.Text,
            fontSize = 16.sp,
            fontWeight = FontWeight.SemiBold,
            lineHeight = 21.sp,
        )
    }
}

/** 3d 4h, 2h 5m, 4m 10s, as Bedrock Hub shows uptime. */
private fun span(seconds: Long): String {
    val d = seconds / 86_400
    val h = seconds % 86_400 / 3_600
    val m = seconds % 3_600 / 60
    val s = seconds % 60
    return when {
        d > 0 -> "${d}d ${h}h"
        h > 0 -> "${h}h ${m}m"
        m > 0 -> "${m}m ${s}s"
        else -> "${s}s"
    }
}

private fun ago(time: Long, now: Long): String {
    val seconds = ((now - time) / 1000).coerceAtLeast(0)
    return if (seconds < 60) "Just now" else span(seconds).substringBefore(' ') + " ago"
}

/** How an export is going, under the worlds: progress, then where it went or what went wrong. */
@Composable
private fun ExportStatus(export: WorldExport, actions: Actions) {
    val busy = export.busy
    when {
        busy != null -> {
            Text(busy, style = MaterialTheme.typography.bodyMedium)
            val p = export.progress
            if (p != null) LinearProgressIndicator(progress = { p }, modifier = Modifier.fillMaxWidth())
            else LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
        }
        export.error != null -> {
            Text(export.error, color = HubColors.Err, style = MaterialTheme.typography.bodyMedium)
            TextButton(colors = linkColors(), onClick = actions.onDismissExport, contentPadding = PaddingValues(0.dp)) { Text("OK") }
        }
        export.done != null -> {
            Text(export.done, color = HubColors.Ok, style = MaterialTheme.typography.bodyMedium)
            TextButton(colors = linkColors(), onClick = actions.onDismissExport, contentPadding = PaddingValues(0.dp)) { Text("OK") }
        }
        else -> Hint("Export saves a world as a .mcworld, to keep as a backup or open in Minecraft. It's safe while the server runs.")
    }
}

/**
 * Add Pack to World: the packs in the world the server runs, and a button to add a .mcaddon or .mcpack to it,
 * installed as Bedrock Hub and the Mod Loader install them.
 */
@Composable
private fun PacksCard(settings: ServerSettings, actions: Actions) {
    val context = LocalContext.current
    val import by Hub.packImport.collectAsStateWithLifecycle()
    val world = settings.currentWorld
    val worldDir = File(context.filesDir, "server/worlds/$world")
    val packs by produceState(emptyList<WorldPack>(), world, import.done) {
        value = withContext(Dispatchers.IO) { PackInstaller.list(worldDir) }
    }
    val worldName = settings.worlds.firstOrNull { it.folder == world }?.displayName ?: world

    SectionCard("Packs in $worldName") {
        if (packs.isEmpty()) {
            Hint("No add-ons. Vanilla Minecraft.")
        } else {
            Hint("In load order, set automatically as in Bedrock Hub. Lower in the list wins.")
            packs.forEach { pack ->
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(pack.name, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
                    Text(
                        (if (pack.behavior) "Behavior" else "Resource") + pack.version.takeIf { it.isNotEmpty() }?.let { " $it" }.orEmpty(),
                        color = HubColors.Muted, fontSize = 12.sp,
                    )
                }
            }
        }
        val busy = import.busy
        when {
            busy != null -> {
                Text(busy, style = MaterialTheme.typography.bodyMedium)
                LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
            }
            import.error != null -> {
                Text(import.error!!, color = HubColors.Err, style = MaterialTheme.typography.bodyMedium)
                TextButton(colors = linkColors(), onClick = actions.onDismissPack, contentPadding = PaddingValues(0.dp)) { Text("OK") }
            }
            import.done != null -> {
                Text(import.done!!, color = HubColors.Ok, style = MaterialTheme.typography.bodyMedium)
                import.warnings.forEach { Text(it, color = HubColors.Warn, style = MaterialTheme.typography.bodySmall) }
                TextButton(colors = linkColors(), onClick = actions.onDismissPack, contentPadding = PaddingValues(0.dp)) { Text("OK") }
            }
            else -> {
                Button(shape = MaterialTheme.shapes.small, onClick = actions.onAddPack) { Text("Add pack to world") }
                Hint("A .mcaddon or .mcpack. Newer versions replace older ones. The server loads packs when it starts.")
            }
        }
    }
}

@Composable
internal fun RestartBanner(onRestartServer: () -> Unit) {
    Card(Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.secondaryContainer)) {
        Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(
                "Some changes take effect when the server restarts.",
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.weight(1f),
            )
            TextButton(colors = linkColors(), onClick = onRestartServer) { Text("Restart now") }
        }
    }
}

/**
 * Bedrock's server ships with the allow list on and empty, so everyone is turned away with "You are not invited
 * to this server". Says so plainly, since the game's own message doesn't.
 */
@Composable
private fun AllowListNotice(settings: ServerSettings, onOpenSettings: () -> Unit) {
    if (!settings.allowListOn) return
    val empty = settings.allowList.isEmpty()
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = if (empty) MaterialTheme.colorScheme.errorContainer else MaterialTheme.colorScheme.surfaceVariant,
        ),
    ) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(
                if (empty) "Nobody can join yet" else "Allow list on: ${settings.allowList.size} ${if (settings.allowList.size == 1) "player" else "players"}",
                style = MaterialTheme.typography.titleSmall,
            )
            Text(
                if (empty) "The allow list is on and empty, so everyone gets \"You are not invited to this server\". " +
                    "Add players' gamertags, or turn the allow list off."
                else "Anyone else gets \"You are not invited to this server\".",
                style = MaterialTheme.typography.bodyMedium,
            )
            TextButton(colors = linkColors(), onClick = onOpenSettings, contentPadding = PaddingValues(0.dp)) { Text("Manage the allow list") }
        }
    }
}

@Composable
private fun WorldsCard(settings: ServerSettings, state: RunState, actions: Actions) {
    val context = LocalContext.current
    var switchTo by rememberSaveable { mutableStateOf<String?>(null) }
    var creating by rememberSaveable { mutableStateOf(false) }
    val running = state == RunState.Running || state == RunState.Starting
    val export by Hub.worldExport.collectAsStateWithLifecycle()
    var removing by remember { mutableStateOf<World?>(null) }

    removing?.let { world ->
        AlertDialog(
            onDismissRequest = { removing = null },
            title = { Text("Remove \"${world.displayName}\"?") },
            text = {
                Text(
                    "This deletes the world from this phone, ${Formatter.formatShortFileSize(context, world.sizeBytes)}, and it " +
                        "can't be undone. Export it first if you might want it back.",
                    style = MaterialTheme.typography.bodyMedium,
                )
            },
            confirmButton = {
                TextButton(colors = linkColors(), onClick = {
                    removing = null
                    actions.onRemoveWorld(world.folder)
                }) { Text("Remove", color = HubColors.Err) }
            },
            dismissButton = {
                Row {
                    TextButton(colors = linkColors(), onClick = {
                        removing = null
                        actions.onExportWorld(world.folder, world.displayName)
                    }) { Text("Export first") }
                    TextButton(colors = linkColors(), onClick = { removing = null }) { Text("Cancel") }
                }
            },
        )
    }

    switchTo?.let { folder ->
        ConfirmDialog(
            title = "Play \"$folder\"?",
            text = if (running) "The server saves and restarts with this world. Anyone playing is disconnected for a moment."
            else "The server loads this world next time it starts.",
            confirm = if (running) "Switch and restart" else "Switch",
            onConfirm = {
                switchTo = null
                actions.onSelectWorld(folder)
            },
            onDismiss = { switchTo = null },
        )
    }
    if (creating) {
        NewWorldDialog(
            existing = settings.worlds.map { it.folder },
            running = running,
            onCreate = { name, seed ->
                creating = false
                actions.onCreateWorld(name, seed)
            },
            onDismiss = { creating = false },
        )
    }

    SectionCard("Worlds") {
        val current = settings.currentWorld
        val worlds = settings.worlds.ifEmpty { listOf(World(current, current, 0, 0)) }
        val listed = if (worlds.none { it.folder == current }) listOf(World(current, current, 0, 0)) + worlds else worlds
        // Keyed by folder, so a world added at the top doesn't take over another row's radio button animation.
        listed.forEach { world -> key(world.folder) {
            val isCurrent = world.folder == current
            Row(
                Modifier
                    .fillMaxWidth()
                    .selectable(
                        selected = isCurrent,
                        role = Role.RadioButton,
                        enabled = state != RunState.Stopping,
                        onClick = { if (!isCurrent) switchTo = world.folder },
                    )
                    .padding(vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                RadioButton(selected = isCurrent, onClick = null)
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Text(world.displayName, style = MaterialTheme.typography.bodyLarge)
                    Hint(
                        when {
                            world.sizeBytes == 0L -> "Made when the server next starts"
                            else -> listOfNotNull(
                                Formatter.formatShortFileSize(context, world.sizeBytes),
                                world.lastPlayed.takeIf { it > 0 }?.let {
                                    val now = System.currentTimeMillis()
                                    if (now - it < DateUtils.MINUTE_IN_MILLIS) "played just now"
                                    else "played " + DateUtils.getRelativeTimeSpanString(it, now, DateUtils.MINUTE_IN_MILLIS)
                                },
                                world.folder.takeIf { it != world.displayName }?.let { "folder $it" },
                            ).joinToString(", ")
                        },
                    )
                }
                Column(horizontalAlignment = Alignment.End) {
                    if (world.sizeBytes > 0) {
                        TextButton(colors = linkColors(), onClick = { actions.onExportWorld(world.folder, world.displayName) }, enabled = export.busy == null) {
                            Text("Export")
                        }
                    }
                    // The server's own world can't go; switch to another first.
                    if (!isCurrent && world.sizeBytes > 0) {
                        TextButton(colors = linkColors(), onClick = { removing = world }) { Text("Remove", color = HubColors.Err) }
                    }
                }
            }
        } }
        ExportStatus(export, actions)
        OutlinedButton(shape = MaterialTheme.shapes.small, onClick = { creating = true }) { Text("New world") }
        HorizontalDivider()
        ImportSection(actions, onPlay = { switchTo = it })
    }
}

/**
 * Bringing a world from Minecraft: a .mcworld file or a world folder, through Android's picker, which opens in
 * Minecraft's worlds folder when other apps can reach it and in Downloads otherwise.
 */
@Composable
private fun ImportSection(actions: Actions, onPlay: (String) -> Unit) {
    val import by Hub.worldImport.collectAsStateWithLifecycle()
    val minecraft by Hub.minecraft.collectAsStateWithLifecycle()

    if (import.choices.isNotEmpty()) {
        AlertDialog(
            onDismissRequest = actions.onDismissImport,
            title = { Text("Which world?") },
            text = {
                Column {
                    Text("That folder has ${import.choices.size} worlds. Pick one to copy to the server.", style = MaterialTheme.typography.bodyMedium)
                    Spacer(Modifier.height(8.dp))
                    import.choices.forEach { choice ->
                        TextButton(colors = linkColors(), onClick = { actions.onChooseImport(choice) }, modifier = Modifier.fillMaxWidth()) {
                            Text(choice.name, modifier = Modifier.fillMaxWidth())
                        }
                    }
                }
            },
            confirmButton = { TextButton(colors = linkColors(), onClick = actions.onDismissImport) { Text("Cancel") } },
        )
    }

    Text("Bring in a world", style = MaterialTheme.typography.titleSmall)
    val mc = minecraft
    Hint(
        when {
            mc?.installed == true && mc.worldsFolder != null ->
                "Minecraft${mc.version?.let { " $it" } ?: ""} is on this phone. The picker opens in its worlds folder."
            mc?.worldsFolder != null ->
                "Minecraft isn't installed, but its worlds folder is still on this phone. The picker opens there."
            mc?.installed == true ->
                "Minecraft${mc.version?.let { " $it" } ?: ""} is on this phone, but keeps its worlds where other apps can't reach " +
                    "them. In Minecraft, edit the world, tap Export World and save it, then pick the .mcworld here. " +
                    "The picker opens in Downloads."
            else -> "Pick a .mcworld file, or a world's folder copied from another device. The picker opens in Downloads."
        },
    )

    val busy = import.busy
    when {
        busy != null -> {
            Text(busy, style = MaterialTheme.typography.bodyMedium)
            val p = import.progress
            if (p != null) LinearProgressIndicator(progress = { p }, modifier = Modifier.fillMaxWidth())
            else LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
            TextButton(colors = linkColors(), onClick = actions.onCancelImport, contentPadding = PaddingValues(0.dp)) { Text("Cancel") }
        }
        import.error != null -> {
            Text(import.error!!, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.error)
            TextButton(colors = linkColors(), onClick = actions.onDismissImport, contentPadding = PaddingValues(0.dp)) { Text("OK") }
        }
        import.imported != null -> {
            val folder = import.imported!!
            Text("\"$folder\" is ready.", style = MaterialTheme.typography.bodyMedium)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(shape = MaterialTheme.shapes.small, onClick = {
                    actions.onDismissImport()
                    onPlay(folder)
                }) { Text("Play it") }
                TextButton(colors = linkColors(), onClick = actions.onDismissImport) { Text("Later") }
            }
        }
        else -> Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(shape = MaterialTheme.shapes.small, onClick = actions.onImportFile) { Text(".mcworld file") }
            OutlinedButton(shape = MaterialTheme.shapes.small, onClick = actions.onImportFolder) { Text("Folder") }
        }
    }
    Hint("Marketplace worlds are locked to Minecraft and won't load on a server.")
}

@Composable
private fun NewWorldDialog(existing: List<String>, running: Boolean, onCreate: (String, String) -> Unit, onDismiss: () -> Unit) {
    var name by rememberSaveable { mutableStateOf("") }
    var seed by rememberSaveable { mutableStateOf("") }
    val trimmed = name.trim()
    val problem = when {
        trimmed.isEmpty() -> null
        !ServerConfig.isValidWorldName(trimmed) -> "Use letters, numbers, spaces, - _ and ', up to 40"
        existing.any { it.equals(trimmed, ignoreCase = true) } -> "There's already a world with that name"
        else -> null
    }
    val seedProblem = seed.trim().takeIf { it.isNotEmpty() && !it.matches(Regex("-?\\d{1,19}")) }?.let { "A seed is a whole number" }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("New world") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    label = { Text("Name") },
                    singleLine = true,
                    isError = problem != null,
                    supportingText = { problem?.let { Text(it) } },
                )
                OutlinedTextField(
                    value = seed,
                    onValueChange = { seed = it },
                    label = { Text("Seed (optional)") },
                    singleLine = true,
                    isError = seedProblem != null,
                    supportingText = { Text(seedProblem ?: "Empty for a random one") },
                )
                Text(
                    if (running) "The server saves the current world and restarts to make this one."
                    else "The server makes it when it next starts.",
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        },
        confirmButton = {
            TextButton(colors = linkColors(), 
                onClick = { onCreate(trimmed, seed.trim()) },
                enabled = trimmed.isNotEmpty() && problem == null && seedProblem == null,
            ) { Text(if (running) "Create and restart" else "Create") }
        },
        dismissButton = { TextButton(colors = linkColors(), onClick = onDismiss) { Text("Cancel") } },
    )
}
