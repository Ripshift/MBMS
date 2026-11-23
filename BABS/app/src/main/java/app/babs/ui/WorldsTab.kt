package app.babs.ui

import android.text.format.DateUtils
import android.text.format.Formatter
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.selectable
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
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
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.babs.core.Backup
import app.babs.core.ComponentStatus
import app.babs.core.Hub
import app.babs.core.PackInstaller
import app.babs.core.RunState
import app.babs.core.ServerConfig
import app.babs.core.ServerSettings
import app.babs.core.World
import app.babs.core.WorldExport
import app.babs.core.WorldNames
import app.babs.core.WorldOps
import app.babs.core.WorldPack
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

/**
 * Bedrock Hub's Worlds page on a phone: every world in the server's worlds folder, with Host, Manage packs,
 * Clone, Rename, Back up, Export and Delete, then bringing in a world, and the backups (AutoSave's copies and
 * Back up's zips), which load as new worlds. Manage packs opens that world's own page.
 */
@Composable
internal fun WorldsTab(server: ComponentStatus, actions: Actions) {
    val settings by Hub.serverSettings.collectAsStateWithLifecycle()
    val files by Hub.serverFiles.collectAsStateWithLifecycle()
    var managing by rememberSaveable { mutableStateOf<String?>(null) }

    if (files.installed == null) {
        TabPage {
            SectionCard("Worlds") { Hint("Download the Bedrock server on the Server tab first. Then your worlds show here.") }
        }
        return
    }

    val open = managing?.let { folder -> settings.worlds.firstOrNull { it.folder == folder } }
    if (open != null) {
        BackHandler { managing = null }
        WorldPage(open, settings, server.state, actions, onBack = { managing = null })
        return
    }

    TabPage {
        if (settings.restartNeeded && server.state == RunState.Running) RestartBanner(actions.onRestartServer)
        WorldTaskStatus(actions)
        WorldsCard(settings, server.state, actions, onManage = { managing = it })
        BackupsCard(actions)
    }
}

/** A clone, rename, back up or backup load: progress, then what happened. */
@Composable
private fun WorldTaskStatus(actions: Actions) {
    val task by Hub.worldTask.collectAsStateWithLifecycle()
    val busy = task.busy
    if (busy == null && task.error == null && task.done == null) return
    HubCard(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            when {
                busy != null -> {
                    Text(busy, style = MaterialTheme.typography.bodyMedium)
                    LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
                }
                task.error != null -> {
                    Text(task.error!!, color = HubColors.Err, style = MaterialTheme.typography.bodyMedium)
                    TextButton(colors = linkColors(), onClick = actions.onDismissWorldTask, contentPadding = PaddingValues(0.dp)) { Text("OK") }
                }
                else -> {
                    Text(task.done!!, color = HubColors.Ok, style = MaterialTheme.typography.bodyMedium)
                    TextButton(colors = linkColors(), onClick = actions.onDismissWorldTask, contentPadding = PaddingValues(0.dp)) { Text("OK") }
                }
            }
        }
    }
}

@Composable
private fun WorldsCard(settings: ServerSettings, state: RunState, actions: Actions, onManage: (String) -> Unit) {
    val context = LocalContext.current
    var switchTo by rememberSaveable { mutableStateOf<String?>(null) }
    var creating by rememberSaveable { mutableStateOf(false) }
    val running = state == RunState.Running || state == RunState.Starting || state == RunState.Stopping
    val export by Hub.worldExport.collectAsStateWithLifecycle()
    val task by Hub.worldTask.collectAsStateWithLifecycle()
    var removing by remember { mutableStateOf<World?>(null) }
    var cloning by remember { mutableStateOf<World?>(null) }
    var renaming by remember { mutableStateOf<World?>(null) }

    removing?.let { world ->
        AlertDialog(
            onDismissRequest = { removing = null },
            title = { Text("Delete \"${world.displayName}\"?") },
            text = {
                Text(
                    "This deletes the world from this phone, ${Formatter.formatShortFileSize(context, world.sizeBytes)}, and it " +
                        "can't be undone. Back it up or Export it first if you might want it back. AutoSave's copies of it are kept.",
                    style = MaterialTheme.typography.bodyMedium,
                )
            },
            confirmButton = {
                TextButton(colors = linkColors(), onClick = {
                    removing = null
                    actions.onRemoveWorld(world.folder)
                }) { Text("Delete", color = HubColors.Err) }
            },
            dismissButton = {
                Row {
                    TextButton(colors = linkColors(), onClick = {
                        removing = null
                        actions.onBackupWorld(world.folder)
                    }) { Text("Back up first") }
                    TextButton(colors = linkColors(), onClick = { removing = null }) { Text("Cancel") }
                }
            },
        )
    }
    cloning?.let { world ->
        TextInputDialog(
            title = "Clone \"${world.displayName}\"",
            initial = "${world.displayName} copy",
            note = "A full copy, with its own copy of the world's packs. The original isn't changed.",
            problem = { WorldNames.problem(it) },
            onSave = {
                cloning = null
                actions.onCloneWorld(world.folder, it)
            },
            onDismiss = { cloning = null },
        )
    }
    renaming?.let { world ->
        TextInputDialog(
            title = "Rename \"${world.displayName}\"",
            initial = world.displayName,
            note = "Changes the name in the game and the world's folder." +
                if (world.folder == settings.currentWorld) " The server follows it." else "",
            problem = { WorldNames.problem(it) },
            onSave = {
                renaming = null
                actions.onRenameWorld(world.folder, it)
            },
            onDismiss = { renaming = null },
        )
    }
    switchTo?.let { folder ->
        val name = settings.worlds.firstOrNull { it.folder == folder }?.displayName ?: folder
        ConfirmDialog(
            title = "Host \"$name\"?",
            text = if (running) "The server saves and restarts with this world. Anyone playing is disconnected for a moment."
            else "The server loads this world next time it starts.",
            confirm = if (running) "Host and restart" else "Host",
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
        Hint("Every world in the server's worlds folder. The ticked one is the one the server hosts.")
        val current = settings.currentWorld
        val worlds = settings.worlds.ifEmpty { listOf(World(current, current, 0, 0)) }
        val listed = if (worlds.none { it.folder == current }) listOf(World(current, current, 0, 0)) + worlds else worlds
        val idle = task.busy == null
        // Keyed by folder, so a world added at the top doesn't take over another row's radio button animation.
        listed.forEach { world -> key(world.folder) {
            val isCurrent = world.folder == current
            val made = world.sizeBytes > 0
            // The hosted world's files are in use while the server runs, as Bedrock Hub refuses then too.
            val locked = isCurrent && running
            var menu by remember { mutableStateOf(false) }
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
                            !made -> "Made when the server next starts"
                            else -> listOfNotNull(
                                if (isCurrent) (if (running) "Hosted, running" else "Hosted") else null,
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
                if (made) {
                    TextButton(colors = linkColors(), onClick = { onManage(world.folder) }) { Text("Packs") }
                    Box {
                        TextButton(colors = linkColors(), onClick = { menu = true }) {
                            Text("⋮", fontWeight = FontWeight.Bold, fontSize = 18.sp)
                        }
                        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                            if (!isCurrent) {
                                DropdownMenuItem(text = { Text("Host") }, onClick = { menu = false; switchTo = world.folder })
                            }
                            DropdownMenuItem(text = { Text("Manage packs") }, onClick = { menu = false; onManage(world.folder) })
                            DropdownMenuItem(
                                text = { Text(if (locked) "Clone (stop the server first)" else "Clone") },
                                enabled = idle && !locked, onClick = { menu = false; cloning = world },
                            )
                            DropdownMenuItem(
                                text = { Text(if (locked) "Rename (stop the server first)" else "Rename") },
                                enabled = idle && !locked, onClick = { menu = false; renaming = world },
                            )
                            DropdownMenuItem(
                                text = { Text(if (locked) "Back up (stop the server first)" else "Back up") },
                                enabled = idle && !locked, onClick = { menu = false; actions.onBackupWorld(world.folder) },
                            )
                            DropdownMenuItem(
                                text = { Text("Export as .mcworld") },
                                enabled = export.busy == null,
                                onClick = { menu = false; actions.onExportWorld(world.folder, world.displayName) },
                            )
                            // The server's own world can't go; host another first.
                            if (!isCurrent) {
                                DropdownMenuItem(
                                    text = { Text("Delete", color = HubColors.Err) },
                                    enabled = idle, onClick = { menu = false; removing = world },
                                )
                            }
                        }
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
 * Every backup, newest first: AutoSave's copies from before and after each world's last session, and Back up's
 * zips. Each loads as a new world, so nothing is overwritten, as in Bedrock Hub.
 */
@Composable
private fun BackupsCard(actions: Actions) {
    val context = LocalContext.current
    val serverDir = File(context.filesDir, "server")
    val task by Hub.worldTask.collectAsStateWithLifecycle()
    val settings by Hub.serverSettings.collectAsStateWithLifecycle()
    val server by Hub.server.collectAsStateWithLifecycle()
    // Read again after each task, and when a session ends (AutoSave's copy after it).
    val backups by produceState<List<Backup>?>(null, task.done, settings.worlds, server.state) {
        value = withContext(Dispatchers.IO) { runCatching { WorldOps.backups(serverDir) }.getOrDefault(emptyList()) }
    }
    var showAll by rememberSaveable { mutableStateOf(false) }
    var loading by remember { mutableStateOf<Backup?>(null) }
    var deleting by remember { mutableStateOf<Backup?>(null) }

    loading?.let { backup ->
        TextInputDialog(
            title = "Load as a new world",
            initial = "${backup.name} (restored)",
            note = "The backup loads as a new world beside the others, so nothing is overwritten. The backup stays as it is.",
            problem = { WorldNames.problem(it) },
            onSave = {
                loading = null
                actions.onLoadBackup(backup, it)
            },
            onDismiss = { loading = null },
        )
    }
    deleting?.let { backup ->
        ConfirmDialog(
            title = "Delete this backup?",
            text = "\"${backup.name}\"${if (backup.label.isNotEmpty()) ", ${backup.label.removePrefix("AutoSave: ")}" else ""}, " +
                "${Formatter.formatShortFileSize(context, backup.sizeBytes)}. This can't be undone.",
            confirm = "Delete",
            onConfirm = {
                deleting = null
                actions.onDeleteBackup(backup)
            },
            onDismiss = { deleting = null },
        )
    }

    SectionCard("Backups") {
        Hint(
            "AutoSave copies the hosted world when the server starts it and again when it stops, so there's always one " +
                "copy from before the last session and one from after. Back up adds a dated zip. Turn AutoSave off in Settings.",
        )
        val list = backups
        when {
            list == null -> LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
            list.isEmpty() -> Hint("None yet. AutoSave makes the first copies the next time the server starts a world.")
            else -> {
                val shown = if (showAll) list else list.take(6)
                shown.forEach { backup ->
                    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                        Column(Modifier.weight(1f)) {
                            Text(backup.name, style = MaterialTheme.typography.bodyLarge)
                            Hint(
                                listOfNotNull(
                                    backup.label.ifEmpty { "Backup" },
                                    DateUtils.getRelativeTimeSpanString(backup.date, System.currentTimeMillis(), DateUtils.MINUTE_IN_MILLIS).toString(),
                                    Formatter.formatShortFileSize(context, backup.sizeBytes),
                                ).joinToString(", "),
                            )
                        }
                        TextButton(colors = linkColors(), enabled = task.busy == null, onClick = { loading = backup }) { Text("Load") }
                        TextButton(colors = linkColors(), enabled = task.busy == null, onClick = { deleting = backup }) {
                            Text("Delete", color = HubColors.Err)
                        }
                    }
                }
                if (list.size > 6) {
                    TextButton(colors = linkColors(), onClick = { showAll = !showAll }, contentPadding = PaddingValues(0.dp)) {
                        Text(if (showAll) "Show fewer" else "Show all ${list.size}")
                    }
                }
            }
        }
    }
}

/**
 * A world's own page, as Bedrock Hub's Manage mods: the packs it uses in load order, to move or remove, and
 * Add pack to put a .mcaddon or .mcpack in it.
 */
@Composable
private fun WorldPage(world: World, settings: ServerSettings, state: RunState, actions: Actions, onBack: () -> Unit) {
    val context = LocalContext.current
    val import by Hub.packImport.collectAsStateWithLifecycle()
    val changes by Hub.packsChanged.collectAsStateWithLifecycle()
    val worldDir = File(context.filesDir, "server/worlds/${world.folder}")
    val packs by produceState<List<WorldPack>?>(null, world.folder, import.done, changes) {
        value = withContext(Dispatchers.IO) { runCatching { PackInstaller.list(worldDir) }.getOrDefault(emptyList()) }
    }
    val hosted = world.folder == settings.currentWorld
    var removing by remember { mutableStateOf<WorldPack?>(null) }

    removing?.let { pack ->
        ConfirmDialog(
            title = "Remove ${pack.name}?",
            text = "It comes out of \"${world.displayName}\" and the world's copy of it is deleted. BABS has no mod library, " +
                "so to put it back, add its .mcaddon or .mcpack again." +
                if (hosted && state == RunState.Running) " The server drops it when it restarts." else "",
            confirm = "Remove",
            onConfirm = {
                removing = null
                actions.onRemovePack(world.folder, pack)
            },
            onDismiss = { removing = null },
        )
    }

    TabPage {
        TextButton(colors = linkColors(), onClick = onBack, contentPadding = PaddingValues(0.dp)) { Text("‹ Worlds") }
        Column {
            Text(world.displayName, style = MaterialTheme.typography.headlineSmall)
            Hint(if (hosted) "The server's world" else "Not hosted. Host it from the Worlds list.")
        }
        if (settings.restartNeeded && state == RunState.Running && hosted) RestartBanner(actions.onRestartServer)

        val list = packs
        listOf(true to "Behavior packs", false to "Resource packs").forEach { (behavior, title) ->
            SectionCard(title) {
                val these = list?.filter { it.behavior == behavior }
                when {
                    these == null -> LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
                    these.isEmpty() -> Hint("None.")
                    else -> {
                        Hint("In load order. Lower in the list wins where two packs change the same thing.")
                        these.forEachIndexed { i, pack ->
                            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                                Column(Modifier.weight(1f)) {
                                    Text(pack.name, style = MaterialTheme.typography.bodyMedium)
                                    if (pack.version.isNotEmpty()) Hint("Version ${pack.version}")
                                }
                                TextButton(
                                    colors = linkColors(), enabled = i > 0,
                                    onClick = { actions.onMovePack(world.folder, pack, -1) },
                                ) { Text("↑") }
                                TextButton(
                                    colors = linkColors(), enabled = i < these.lastIndex,
                                    onClick = { actions.onMovePack(world.folder, pack, 1) },
                                ) { Text("↓") }
                                TextButton(colors = linkColors(), onClick = { removing = pack }) { Text("Remove", color = HubColors.Err) }
                            }
                        }
                    }
                }
            }
        }

        SectionCard("Add a pack") {
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
                    Button(shape = MaterialTheme.shapes.small, onClick = { actions.onAddPack(world.folder) }) { Text("Add pack to this world") }
                    Hint(
                        "A .mcaddon or .mcpack. Newer versions replace older ones, and new packs go where the load order " +
                            "rules put them, as in Bedrock Hub. The server loads packs when it starts.",
                    )
                }
            }
        }
    }
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
