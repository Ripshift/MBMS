package app.babs.ui

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AssistChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.babs.core.ContentEntry
import app.babs.core.Hub
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import app.babs.core.Source

private enum class ConsoleMode(val label: String) { Everything("Everything"), Server("Server"), Content("Content Log") }

/**
 * Everything: all output from BABS, the bridge and the server, to read. Server console: only the server's own
 * output, with a box for commands, or chat that players see in the game.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ConsoleTab(serverRunning: Boolean, actions: Actions) {
    val console by Hub.console.collectAsStateWithLifecycle()
    val content by Hub.contentLog.collectAsStateWithLifecycle()
    val contentErrors = content.count { it.level == ContentEntry.Level.Error }
    var mode by rememberSaveable { mutableStateOf(ConsoleMode.Everything) }
    // null shows everything. Setup lines count as BABS's own.
    var filter by rememberSaveable { mutableStateOf<Source?>(null) }
    val shownFilter = if (mode == ConsoleMode.Server) Source.Server else filter
    val lines = remember(console, shownFilter) {
        when (shownFilter) {
            null -> console
            Source.Babs -> console.filter { it.source == Source.Babs || it.source == Source.Setup }
            else -> console.filter { it.source == shownFilter }
        }
    }

    Column(
        Modifier
            .fillMaxSize()
            .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
            ConsoleMode.entries.forEachIndexed { i, m ->
                SegmentedButton(
                    selected = mode == m,
                    onClick = { mode = m },
                    shape = SegmentedButtonDefaults.itemShape(i, ConsoleMode.entries.size),
                ) { Text(if (m == ConsoleMode.Content && contentErrors > 0) "${m.label} ($contentErrors)" else m.label, maxLines = 1) }
            }
        }

        if (mode == ConsoleMode.Everything) {
            Row(
                Modifier.horizontalScroll(rememberScrollState()),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                listOf(null to "All", Source.Bridge to "Bridge", Source.Server to "Server", Source.Babs to "BABS").forEach { (source, label) ->
                    FilterChip(selected = filter == source, onClick = { filter = source }, label = { Text(label) })
                }
                TextButton(colors = linkColors(), onClick = actions.onShareLog) { Text("Share") }
                TextButton(colors = linkColors(), onClick = Hub::clearConsole) { Text("Clear") }
            }
        }

        if (mode == ConsoleMode.Content) {
            ContentLogView(content, serverRunning, actions, Modifier.weight(1f))
        } else {
            // A new list for each view, so it opens at the bottom.
            key(shownFilter) { Console(lines, Modifier.weight(1f)) }
        }

        if (mode == ConsoleMode.Server) {
            ServerInput(serverRunning, actions.onCommand)
        }
    }
}

/** Sends a server command, or with Chat on, a message every player sees (the server's say command). */
@Composable
private fun ServerInput(enabled: Boolean, onCommand: (String) -> Unit) {
    var text by rememberSaveable { mutableStateOf("") }
    var chat by rememberSaveable { mutableStateOf(false) }
    val send = {
        val typed = text.trim()
        if (typed.isNotEmpty()) {
            // Commands work with or without the slash players type in the game.
            onCommand(if (chat) "say $typed" else typed.removePrefix("/"))
            text = ""
        }
    }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(
            Modifier.horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            FilterChip(selected = !chat, onClick = { chat = false }, label = { Text("Command") })
            FilterChip(selected = chat, onClick = { chat = true }, label = { Text("Chat") })
            if (!chat) {
                listOf("list", "time set day", "weather clear").forEach { quick ->
                    AssistChip(onClick = { onCommand(quick) }, enabled = enabled, label = { Text(quick) })
                }
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(
                value = text,
                onValueChange = { text = it },
                enabled = enabled,
                singleLine = true,
                placeholder = {
                    Text(
                        when {
                            !enabled -> "Server isn't running"
                            chat -> "Message to everyone in the game"
                            else -> "Command, e.g. list"
                        },
                    )
                },
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                keyboardActions = KeyboardActions(onSend = { send() }),
                modifier = Modifier.weight(1f),
            )
            Button(shape = MaterialTheme.shapes.small, onClick = send, enabled = enabled && text.isNotBlank()) { Text("Send") }
        }
    }
}

/**
 * Bedrock Hub's Content Log: what the server reported about add-ons and the world since the last Start, the same as
 * the Content Log in the game. Repeats count up. Tap an entry with a stack trace to see it.
 */
@Composable
private fun ContentLogView(entries: List<ContentEntry>, serverRunning: Boolean, actions: Actions, modifier: Modifier) {
    var level by rememberSaveable { mutableStateOf<ContentEntry.Level?>(null) }
    var search by rememberSaveable { mutableStateOf("") }
    var expanded by rememberSaveable { mutableStateOf<Int?>(null) }
    val shown = remember(entries, level, search) {
        val words = search.trim().lowercase()
        entries.filter { e ->
            (level == null || e.level == level) &&
                (words.isEmpty() || "${e.category} ${e.message} ${e.detail}".lowercase().contains(words))
        }
    }
    Row(
        Modifier.horizontalScroll(rememberScrollState()),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        FilterChip(selected = level == null, onClick = { level = null }, label = { Text("All (${entries.size})") })
        ContentEntry.Level.entries.forEach { l ->
            val n = entries.count { it.level == l }
            FilterChip(selected = level == l, onClick = { level = l }, label = { Text("${l.word}s ($n)") })
        }
        TextButton(colors = linkColors(), onClick = actions.onShareContentLog, enabled = entries.isNotEmpty()) { Text("Share") }
        TextButton(colors = linkColors(), onClick = Hub::clearContentLog, enabled = entries.isNotEmpty()) { Text("Clear") }
    }
    if (entries.size > 8) {
        OutlinedTextField(
            value = search, onValueChange = { search = it }, singleLine = true,
            placeholder = { Text("Search") }, modifier = Modifier.fillMaxWidth(),
        )
    }
    Column(
        modifier
            .fillMaxWidth()
            .background(CONSOLE_BACKGROUND, MaterialTheme.shapes.medium)
            .padding(8.dp),
    ) {
        when {
            entries.isEmpty() -> Text(
                if (serverRunning) "Nothing reported. Your add-ons loaded without a message."
                else "Nothing yet. Messages appear here when the server starts.",
                color = CONSOLE_DIM, style = MaterialTheme.typography.bodyMedium,
            )
            shown.isEmpty() -> Text("Nothing matches.", color = CONSOLE_DIM, style = MaterialTheme.typography.bodyMedium)
            else -> LazyColumn(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                items(shown, key = { it.id }) { e ->
                    val color = when (e.level) {
                        ContentEntry.Level.Error -> HubColors.Err
                        ContentEntry.Level.Warning -> HubColors.Warn
                        ContentEntry.Level.Info -> CONSOLE_DIM
                    }
                    Column(
                        Modifier
                            .fillMaxWidth()
                            .clickable(enabled = e.detail.isNotEmpty()) { expanded = if (expanded == e.id) null else e.id },
                    ) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            Text(e.time, color = CONSOLE_DIM, fontFamily = FontFamily.Monospace, fontSize = 11.sp)
                            Text(e.level.word, color = color, fontWeight = FontWeight.SemiBold, fontSize = 11.sp)
                            Text("[${e.category}]", color = CONSOLE_DIM, fontSize = 11.sp)
                            if (e.count > 1) Text("x${e.count}", color = CONSOLE_DIM, fontSize = 11.sp)
                            if (e.detail.isNotEmpty()) Text(if (expanded == e.id) "▾" else "▸", color = CONSOLE_DIM, fontSize = 11.sp)
                        }
                        Text(e.message, color = HubColors.Text, fontFamily = FontFamily.Monospace, fontSize = 12.sp, lineHeight = 15.sp)
                        if (expanded == e.id) {
                            Text(e.detail, color = CONSOLE_DIM, fontFamily = FontFamily.Monospace, fontSize = 11.sp, lineHeight = 14.sp)
                        }
                    }
                }
            }
        }
    }
}
