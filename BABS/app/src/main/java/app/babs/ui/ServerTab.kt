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
    onOpenWorlds: () -> Unit,
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
            TextButton(colors = linkColors(), onClick = onOpenWorlds, contentPadding = PaddingValues(0.dp)) {
                Text("Worlds, packs and backups")
            }
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

