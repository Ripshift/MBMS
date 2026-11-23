package app.babs.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.babs.core.Hub
import app.babs.core.RunState
import app.babs.core.ServerConfig

/** A server.properties setting the Settings tab lets you change. */
private sealed interface Property {
    val key: String
    val title: String
    val hint: String?

    class Choice(override val key: String, override val title: String, val options: List<Pair<String, String>>, override val hint: String? = null) : Property
    class Number(override val key: String, override val title: String, val range: IntRange, override val hint: String? = null) : Property
    class Text(override val key: String, override val title: String, val maxLength: Int, override val hint: String? = null) : Property
    class Toggle(override val key: String, override val title: String, override val hint: String? = null) : Property
}

private val GAME_PROPERTIES = listOf(
    Property.Text(
        "server-name", "Server name", 40,
        "What friends see this server called in their friends list, with the world's name. Left as Dedicated Server, they see the bridge account's gamertag",
    ),
    Property.Choice("gamemode", "Game mode", listOf("survival" to "Survival", "creative" to "Creative", "adventure" to "Adventure")),
    Property.Choice("difficulty", "Difficulty", listOf("peaceful" to "Peaceful", "easy" to "Easy", "normal" to "Normal", "hard" to "Hard")),
    Property.Number("max-players", "Most players at once", 1..30, "A phone handles a handful comfortably"),
    Property.Toggle("allow-cheats", "Allow cheats", "Lets operators use commands such as /give in the game"),
    Property.Choice(
        "default-player-permission-level", "New players are",
        listOf("visitor" to "Visitors (can only look)", "member" to "Members (can build)", "operator" to "Operators (can use commands)"),
    ),
    Property.Number("view-distance", "View distance (chunks)", 5..32, "Lower is easier on the phone"),
    Property.Number("tick-distance", "Simulation distance (chunks)", 4..12, "How far away the world keeps moving. Lower is easier on the phone"),
)

@Composable
internal fun SettingsTab(arch: String, usesBox64: Boolean, appVersion: String, settings: AppSettings, actions: Actions) {
    val server by Hub.server.collectAsStateWithLifecycle()
    val files by Hub.serverFiles.collectAsStateWithLifecycle()
    val serverSettings by Hub.serverSettings.collectAsStateWithLifecycle()
    var editing by rememberSaveable { mutableStateOf<String?>(null) }
    var addingPlayer by rememberSaveable { mutableStateOf(false) }
    var editingAddress by rememberSaveable { mutableStateOf(false) }
    val props = serverSettings.properties

    // The dialog for whichever setting is being changed.
    GAME_PROPERTIES.firstOrNull { it.key == editing }?.let { p ->
        val current = props[p.key].orEmpty()
        val save = { value: String ->
            editing = null
            if (value != current) actions.onSetProperties(mapOf(p.key to value))
        }
        when (p) {
            is Property.Choice -> ChoiceDialog(p.title, p.options, current, onPick = save, onDismiss = { editing = null })
            is Property.Number -> TextInputDialog(
                title = p.title,
                initial = current,
                number = true,
                note = p.hint,
                problem = { t -> if (t.toIntOrNull()?.let { it in p.range } == true) null else "A number from ${p.range.first} to ${p.range.last}" },
                onSave = save,
                onDismiss = { editing = null },
            )
            is Property.Text -> TextInputDialog(
                title = p.title,
                initial = current,
                note = p.hint,
                problem = { t ->
                    when {
                        t.isEmpty() -> "It can't be empty"
                        t.length > p.maxLength -> "Up to ${p.maxLength} characters"
                        t.any { it == ';' || it < ' ' } -> "Not with ; or control characters"
                        else -> null
                    }
                },
                onSave = save,
                onDismiss = { editing = null },
            )
            is Property.Toggle -> Unit
        }
    }
    if (addingPlayer) {
        TextInputDialog(
            title = "Add to the allow list",
            initial = "",
            placeholder = "Gamertag",
            note = "The player's Xbox gamertag, as it shows in the game.",
            problem = { t ->
                when {
                    !ServerConfig.isValidName(t) -> "Letters, numbers and spaces, up to 16"
                    serverSettings.allowList.any { it.equals(t, ignoreCase = true) } -> "Already on the list"
                    else -> null
                }
            },
            onSave = {
                addingPlayer = false
                actions.onAllowList(it, true)
            },
            onDismiss = { addingPlayer = false },
        )
    }
    if (editingAddress) {
        PublicAddressDialog(
            current = settings.publicAddress,
            onSave = {
                editingAddress = false
                actions.onPublicAddress(it)
            },
            onDismiss = { editingAddress = false },
        )
    }

    TabPage {
        SectionTitle("Server")
        if (serverSettings.restartNeeded && server.state == RunState.Running) {
            RestartBanner(actions.onRestartServer)
        }
        if (props.isEmpty()) {
            Hint("The server's settings show here once it's downloaded.")
        } else {
            SectionCard("Game") {
                GAME_PROPERTIES.forEachIndexed { i, p ->
                    if (i > 0) HorizontalDivider()
                    val value = props[p.key].orEmpty()
                    when (p) {
                        is Property.Toggle -> SwitchRow(p.title, p.hint, checked = value == "true") {
                            actions.onSetProperties(mapOf(p.key to it.toString()))
                        }
                        else -> SettingRow(
                            title = p.title,
                            value = (p as? Property.Choice)?.options?.firstOrNull { it.first == value }?.second ?: value.ifEmpty { "Not set" },
                            hint = p.hint,
                            onClick = { editing = p.key },
                        )
                    }
                }
                Hint("The server reads these when it starts. Changing one while it runs asks for a restart.")
            }

            SectionCard("Allow list") {
                SwitchRow(
                    title = "Only listed players can join",
                    detail = if (serverSettings.allowListOn) "Anyone else gets \"You are not invited to this server\""
                    else "Anyone who can reach the server can join",
                    checked = serverSettings.allowListOn,
                ) { actions.onSetProperties(mapOf("allow-list" to it.toString())) }
                if (serverSettings.allowListOn) {
                    HorizontalDivider()
                    if (serverSettings.allowList.isEmpty()) Hint("Nobody yet, so nobody can join.")
                    serverSettings.allowList.forEach { name ->
                        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                            Text(name, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
                            TextButton(colors = linkColors(), onClick = { actions.onAllowList(name, false) }) { Text("Remove") }
                        }
                    }
                    OutlinedButton(shape = MaterialTheme.shapes.small, onClick = { addingPlayer = true }) { Text("Add player") }
                    Hint("Changes apply straight away, even while the server runs.")
                }
            }

            SectionCard("Phone performance") {
                val friendly = ServerConfig.PHONE_FRIENDLY
                val differ = friendly.filter { (key, value) -> props[key] != value.first }
                friendly.forEach { (key, value) ->
                    val (wanted, why) = value
                    val current = props[key] ?: "not set"
                    Row(verticalAlignment = Alignment.Top, modifier = Modifier.fillMaxWidth()) {
                        Text(
                            if (current == wanted) "✓" else "•",
                            color = if (current == wanted) HubColors.Ok else HubColors.Warn,
                            modifier = Modifier.width(22.dp),
                        )
                        Column(Modifier.weight(1f)) {
                            Text(why, style = MaterialTheme.typography.bodyMedium)
                            if (current != wanted) Hint("Now $current, phone-friendly is $wanted")
                        }
                    }
                }
                if (differ.isNotEmpty()) {
                    Button(shape = MaterialTheme.shapes.small, onClick = { actions.onSetProperties(differ.mapValues { it.value.first }) }) {
                        Text("Use phone-friendly settings")
                    }
                } else {
                    Hint("All set for a phone.")
                }
                HorizontalDivider()
                SwitchRow(
                    title = "Restart the server if it stops",
                    detail = "If it crashes or Android stops it to free memory, BABS starts it again after a few seconds. Up to 3 times in 10 minutes",
                    checked = settings.autoRestart,
                    onChange = actions.onAutoRestart,
                )
            }

            SectionCard("Version") {
                Text(files.installed?.let { "Bedrock server $it" } ?: "Not downloaded yet", style = MaterialTheme.typography.bodyLarge)
                Hint(
                    when {
                        files.latest == null -> "Not checked for updates yet"
                        files.updateAvailable -> "Version ${files.latest} is out. Updating keeps your worlds and settings"
                        else -> "Up to date"
                    },
                )
                files.busy?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                if (files.installed != null && files.busy == null) {
                    if (files.updateAvailable) Button(shape = MaterialTheme.shapes.small, onClick = actions.onDownloadServer) { Text("Update to ${files.latest}") }
                    else OutlinedButton(shape = MaterialTheme.shapes.small, onClick = actions.onCheckUpdate) { Text("Check for updates") }
                }
            }
        }

        SectionTitle("Bridge")
        SectionCard("Public address") {
            Text(
                settings.publicAddress.ifEmpty { "None, so only players on this network can join" },
                style = MaterialTheme.typography.bodyLarge,
            )
            Hint(
                "Your home's public IPv4 address, for friends outside this Wi-Fi. Your router also has to forward the " +
                    "server's ports (UDP ${props["server-port"] ?: "19132"} and ${props["server-portv6"] ?: "19133"}) to this device.",
            )
            // One press finds the address and saves it. Change types one in.
            FindAddressButton(onFound = { if (it != settings.publicAddress) actions.onPublicAddress(it) }, label = "Find and set it")
            TextButton(colors = linkColors(), onClick = { editingAddress = true }, contentPadding = PaddingValues(0.dp)) {
                Text(if (settings.publicAddress.isEmpty()) "Type it in" else "Change or clear it")
            }
        }

        SectionTitle("App")
        SectionCard("Keep running") {
            Text(
                if (settings.unrestricted) "BABS can run in the background without battery limits."
                else "Android may pause or close BABS in the background to save battery, which stops the server " +
                    "and the bridge. Allow it to run without limits.",
                style = MaterialTheme.typography.bodyMedium,
            )
            if (!settings.unrestricted) Button(shape = MaterialTheme.shapes.small, onClick = actions.onBatterySettings) { Text("Allow") }
        }
        SectionCard("Log") {
            Text(
                "Everything the console shows is also saved on this device, up to 4 MB. Share it to send it for help. " +
                    "It includes the phone model and Android version, and nothing else about you.",
                style = MaterialTheme.typography.bodyMedium,
            )
            OutlinedButton(shape = MaterialTheme.shapes.small, onClick = actions.onShareLog) { Text("Share log") }
        }
        SectionCard("About") {
            Text("BABS $appVersion", style = MaterialTheme.typography.bodyLarge)
            Hint("$arch. The server runs ${if (usesBox64) "through box64" else "natively"} inside Ubuntu, and the bridge on Java 21.")
        }
    }
}

@Composable
private fun SectionTitle(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.titleSmall,
        color = MaterialTheme.colorScheme.primary,
        modifier = Modifier.padding(top = 4.dp),
    )
}

@Composable
private fun SettingRow(title: String, value: String, hint: String?, onClick: () -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(vertical = 4.dp),
    ) {
        Text(title, style = MaterialTheme.typography.bodyLarge)
        Text(value, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.primary)
        hint?.let { Hint(it) }
    }
}
