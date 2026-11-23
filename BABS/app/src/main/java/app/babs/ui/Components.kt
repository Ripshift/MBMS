package app.babs.ui

import android.content.ClipData
import android.content.ClipboardManager
import androidx.compose.foundation.background
import androidx.compose.foundation.BorderStroke
import app.babs.core.PublicAddress
import androidx.compose.foundation.border
import androidx.compose.material3.CardDefaults
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.SmallFloatingActionButton
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.key
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.zIndex
import kotlinx.coroutines.launch
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.style.TextOverflow
import app.babs.R
import app.babs.core.BridgeHealth
import androidx.compose.material3.AlertDialog
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.Checkbox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.babs.core.ComponentStatus
import app.babs.core.ConsoleLine
import app.babs.core.Hub
import app.babs.core.RunState
import app.babs.core.ServerFiles
import app.babs.core.SetupStage
import app.babs.core.SetupStatus
import app.babs.core.Source


@Composable
internal fun SetupCard(setup: SetupStatus, usesBox64: Boolean, onInstall: () -> Unit) {
    HubCard(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Linux system", style = MaterialTheme.typography.titleMedium)
            when (setup.stage) {
                SetupStage.NotInstalled, SetupStage.Failed -> {
                    Text(
                        if (setup.stage == SetupStage.Failed) setup.step
                        else "The server and bridge run inside Ubuntu, with Java 21${if (usesBox64) " and box64" else ""}. " +
                            "Downloads about 100 MB and uses about 350 MB.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = if (setup.stage == SetupStage.Failed) MaterialTheme.colorScheme.error
                        else MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Button(shape = MaterialTheme.shapes.small, onClick = onInstall) {
                        Text(if (setup.stage == SetupStage.Failed) "Try again" else "Install")
                    }
                }
                SetupStage.Working -> {
                    Text(setup.step, style = MaterialTheme.typography.bodyMedium)
                    val progress = setup.progress
                    if (progress != null) {
                        LinearProgressIndicator(progress = { progress }, modifier = Modifier.fillMaxWidth())
                    } else {
                        LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
                    }
                }
                SetupStage.Ready -> Unit
            }
        }
    }
}

/**
 * Before the first download: what gets downloaded and the EULA, which has to be accepted first.
 * Afterwards it only appears while a download or update runs, or when one failed.
 */
@Composable
internal fun ServerDownloadCard(files: ServerFiles, eulaAccepted: Boolean, onDownload: () -> Unit) {
    var agreed by rememberSaveable { mutableStateOf(eulaAccepted) }
    HubCard(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Bedrock server", style = MaterialTheme.typography.titleMedium)
            val busy = files.busy
            when {
                busy != null -> {
                    Text(busy, style = MaterialTheme.typography.bodyMedium)
                    val progress = files.progress
                    if (progress != null) {
                        LinearProgressIndicator(progress = { progress }, modifier = Modifier.fillMaxWidth())
                    } else {
                        LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
                    }
                }
                files.error != null -> {
                    Text(files.error, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.error)
                    Button(shape = MaterialTheme.shapes.small, onClick = onDownload) { Text("Try again") }
                }
                else -> {
                    Text(
                        "BABS downloads Mojang's Bedrock Dedicated Server for Linux from minecraft.net. " +
                            "About 100 MB to download, 320 MB installed.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(checked = agreed, onCheckedChange = { agreed = it })
                        Text(eulaText(), style = MaterialTheme.typography.bodyMedium)
                    }
                    Button(shape = MaterialTheme.shapes.small, onClick = onDownload, enabled = agreed) { Text("Download server") }
                }
            }
        }
    }
}

/** The bridge's Microsoft device sign-in, from its health endpoint. Shown until the account is signed in. */
@Composable
internal fun SignInCard(url: String, code: String) {
    val context = LocalContext.current
    val uriHandler = LocalUriHandler.current
    val copy = {
        context.getSystemService(ClipboardManager::class.java)
            .setPrimaryClip(ClipData.newPlainText("Sign-in code", code))
    }
    HubCard(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Sign in the bridge", style = MaterialTheme.typography.titleMedium)
            Text(
                "Open the sign-in page and enter this code. Use the Xbox account your friends will add, " +
                    "not your own. BABS only needs to do this once.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            SelectionContainer {
                Text(
                    code,
                    style = MaterialTheme.typography.headlineMedium,
                    fontFamily = FontFamily.Monospace,
                    letterSpacing = 2.sp,
                )
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(shape = MaterialTheme.shapes.small, onClick = {
                    copy()
                    uriHandler.openUri(url)
                }) { Text("Copy code and open") }
                OutlinedButton(shape = MaterialTheme.shapes.small, onClick = copy) { Text("Copy code") }
            }
        }
    }
}

@Composable
internal fun PublicAddressDialog(current: String, onSave: (String) -> Unit, onDismiss: () -> Unit) {
    var text by rememberSaveable { mutableStateOf(current) }
    val trimmed = text.trim()
    val problem = when {
        trimmed.isEmpty() -> null
        !isIpv4(trimmed) -> "Enter an IPv4 address, like 203.0.113.7"
        isPrivateIpv4(trimmed) -> "That's a private address. Friends outside this network can't reach it"
        else -> null
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Public address") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    "Your home's public IPv4 address, so friends outside this Wi-Fi can join. Your router also has to " +
                        "forward the ports to this device. Leave it empty if only players on this network will join.",
                    style = MaterialTheme.typography.bodyMedium,
                )
                FindAddressButton(onFound = { text = it })
                OutlinedTextField(
                    value = text,
                    onValueChange = { text = it },
                    singleLine = true,
                    isError = problem != null && !isIpv4(trimmed),
                    supportingText = { problem?.let { Text(it) } },
                    placeholder = { Text("Empty: this network only") },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Done),
                )
                Text(
                    "A running bridge restarts to use it, which takes a few seconds. If it's waiting for sign-in, " +
                        "it restarts once you've signed in, so the code keeps working.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        },
        confirmButton = {
            TextButton(colors = linkColors(), onClick = { onSave(trimmed) }, enabled = trimmed.isEmpty() || isIpv4(trimmed)) { Text("Save") }
        },
        dismissButton = { TextButton(colors = linkColors(), onClick = onDismiss) { Text("Cancel") } },
    )
}

/**
 * Finds the public address with one press, and says why it may not work (mobile data, a provider's shared
 * address). [onFound] gets the address: the dialog fills it in, the cards save it straight away.
 */
@Composable
internal fun FindAddressButton(onFound: (String) -> Unit, label: String = "Find my public address") {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var note by remember { mutableStateOf<Pair<String, Boolean>?>(null) }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        OutlinedButton(
            onClick = {
                busy = true
                note = null
                scope.launch {
                    val found = PublicAddress.find(context)
                    busy = false
                    found.address?.let(onFound)
                    note = when {
                        found.warning != null -> found.warning to true
                        found.address != null -> "Found ${found.address}" to false
                        else -> null
                    }
                }
            },
            enabled = !busy,
            shape = MaterialTheme.shapes.small,
        ) { Text(if (busy) "Finding it…" else label) }
        note?.let { (text, warn) ->
            Text(text, style = MaterialTheme.typography.bodySmall, color = if (warn) HubColors.Warn else HubColors.Ok)
        }
    }
}

internal fun ipv4Parts(text: String): List<Int>? =
    text.split('.').takeIf { it.size == 4 }
        ?.map { part -> part.takeIf { it.length in 1..3 && it.all(Char::isDigit) }?.toInt() ?: return null }
        ?.takeIf { parts -> parts.all { it in 0..255 } }

internal fun isIpv4(text: String) = ipv4Parts(text) != null

/** Private, loopback, link-local and carrier-grade NAT ranges, none of which friends can reach. */
internal fun isPrivateIpv4(text: String): Boolean {
    val (a, b) = ipv4Parts(text) ?: return false
    return a == 10 || a == 127 || a == 0 ||
        (a == 172 && b in 16..31) || (a == 192 && b == 168) ||
        (a == 169 && b == 254) || (a == 100 && b in 64..127)
}

@Composable
internal fun eulaText() = buildAnnotatedString {
    val link = TextLinkStyles(SpanStyle(color = MaterialTheme.colorScheme.primary, textDecoration = TextDecoration.Underline))
    append("I agree to the ")
    withLink(LinkAnnotation.Url(EULA_URL, link)) { append("Minecraft End User License Agreement") }
    append(" and ")
    withLink(LinkAnnotation.Url(PRIVACY_URL, link)) { append("Privacy Policy") }
    append(".")
}

private const val EULA_URL = "https://www.minecraft.net/eula"
private const val PRIVACY_URL = "https://go.microsoft.com/fwlink/?LinkId=521839"

@Composable
internal fun StatusCard(
    title: String,
    status: ComponentStatus,
    modifier: Modifier = Modifier,
    extra: @Composable () -> Unit = {},
) {
    HubCard(modifier) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            // As Bedrock Hub's card heads: the title, and the state as a pill on the right.
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                Pill(status.state)
            }
            if (status.detail.isNotEmpty()) {
                Text(
                    status.detail,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            extra()
        }
    }
}

// Read from the palette each time, so they follow the theme.
internal val CONSOLE_BACKGROUND get() = HubColors.Console
internal val CONSOLE_DIM get() = HubColors.Muted

/**
 * Follows new lines while scrolled to the bottom. Scrolled up to read, it stays put and offers a button
 * back to the latest, since the bridge can print a lot.
 */
@Composable
internal fun Console(lines: List<ConsoleLine>, modifier: Modifier = Modifier) {
    // Opens at the latest line, whether that's on first showing, a tab switch or a new filter.
    val listState = rememberLazyListState(initialFirstVisibleItemIndex = lines.lastIndex.coerceAtLeast(0))
    val atBottom by remember {
        derivedStateOf {
            val info = listState.layoutInfo
            val last = info.visibleItemsInfo.lastOrNull()?.index ?: -1
            info.totalItemsCount == 0 || last >= info.totalItemsCount - 2
        }
    }
    // Follows new lines until the person scrolls up, and again once they scroll back to the bottom.
    // Decided when a scroll by hand ends, not when a line arrives, so a burst of lines can't switch it off.
    var follow by remember { mutableStateOf(true) }
    LaunchedEffect(listState) {
        snapshotFlow { listState.isScrollInProgress }.collect { scrolling ->
            if (!scrolling) follow = atBottom
        }
    }
    LaunchedEffect(lines.lastOrNull()?.id) {
        if (lines.isNotEmpty() && follow) listState.scrollToItem(lines.lastIndex)
    }
    val scope = rememberCoroutineScope()
    Box(
        modifier
            .fillMaxWidth()
            .background(CONSOLE_BACKGROUND, MaterialTheme.shapes.medium)
            .padding(8.dp),
    ) {
        if (lines.isEmpty()) {
            Text("Press Start. Output from the server and bridge appears here.", color = CONSOLE_DIM, fontSize = 13.sp)
        }
        if (!follow) {
            SmallFloatingActionButton(
                onClick = {
                    follow = true
                    scope.launch { listState.scrollToItem(lines.lastIndex.coerceAtLeast(0)) }
                },
                modifier = Modifier
                    .align(Alignment.BottomEnd)
                    .zIndex(1f),
            ) { Text("↓", fontSize = 18.sp) }
        }
        LazyColumn(state = listState, modifier = Modifier.fillMaxSize()) {
            items(lines, key = { it.id }) { line ->
                Text(
                    "[${line.source.tag}] ${line.text}",
                    color = line.source.color(),
                    fontFamily = FontFamily.Monospace,
                    fontSize = 12.sp,
                    lineHeight = 15.sp,
                )
            }
        }
    }
}

@Composable
internal fun CommandBox(enabled: Boolean, onCommand: (String) -> Unit) {
    var text by remember { mutableStateOf("") }
    val send = {
        val command = text.trim()
        if (command.isNotEmpty()) {
            onCommand(command)
            text = ""
        }
    }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedTextField(
            value = text,
            onValueChange = { text = it },
            enabled = enabled,
            singleLine = true,
            placeholder = { Text(if (enabled) "Server command, e.g. list" else "Server isn't running") },
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
            keyboardActions = KeyboardActions(onSend = { send() }),
            modifier = Modifier.weight(1f),
        )
        Button(shape = MaterialTheme.shapes.small, onClick = send, enabled = enabled && text.isNotBlank()) { Text("Send") }
    }
}

/** Bedrock Hub's words for the states. */
internal fun RunState.label() = when (this) {
    RunState.Stopped -> "Off"
    RunState.Starting -> "Starting"
    RunState.Running -> "Running"
    RunState.Stopping -> "Stopping"
    RunState.NotInstalled -> "Not installed"
    RunState.Crashed -> "Stopped unexpectedly"
}

/** Bedrock Hub's pip colours: ok green, wait blue, bad red, off a hollow ring. */
internal fun RunState.color() = when (this) {
    RunState.Running -> HubColors.Ok
    RunState.Starting, RunState.Stopping -> HubColors.Accent
    RunState.Crashed -> HubColors.Err
    RunState.Stopped, RunState.NotInstalled -> HubColors.Muted
}

/** Bedrock Hub's status pip: lit and glowing when running, a ring when off. */
@Composable
internal fun Pip(state: RunState, size: Dp = 10.dp) {
    val color = state.color()
    val lit = state != RunState.Stopped && state != RunState.NotInstalled
    Box(
        Modifier
            .size(size)
            .then(if (state == RunState.Running || state == RunState.Crashed) Modifier.shadow(6.dp, CircleShape, ambientColor = color, spotColor = color) else Modifier)
            .then(if (lit) Modifier.background(color, CircleShape) else Modifier.border(2.dp, color, CircleShape)),
    )
}

/** A pip and the state's word, as Bedrock Hub's pills. */
@Composable
internal fun Pill(state: RunState, prefix: String = "") {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Pip(state)
        Spacer(Modifier.width(8.dp))
        Text(prefix + state.label(), style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
    }
}

/** Bedrock Hub's card: a panel with a 1px line and 10px corners. */
@Composable
internal fun HubCard(modifier: Modifier = Modifier, containerColor: Color = HubColors.Panel, content: @Composable () -> Unit) {
    Card(
        modifier,
        shape = MaterialTheme.shapes.medium,
        colors = CardDefaults.cardColors(containerColor = containerColor),
        border = BorderStroke(1.dp, HubColors.Line),
    ) { content() }
}

internal fun Source.color() = when (this) {
    Source.Server -> Color(0xFFD7DCE2)
    Source.Bridge -> Color(0xFF7FB8E6)
    Source.Setup -> Color(0xFFC9A6E0)
    Source.Babs -> Color(0xFF9CCB7E)
}
