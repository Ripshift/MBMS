package app.babs.ui

import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.produceState
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import app.babs.core.fetchGamerpic
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.babs.core.BridgeHealth
import app.babs.core.ComponentStatus
import app.babs.core.Friends
import app.babs.core.Hub
import app.babs.core.RunState

/** The bridge's Microsoft account, its status, and the friend requests sent to it. */
@Composable
internal fun BridgeTab(
    bridge: ComponentStatus,
    server: ComponentStatus,
    health: BridgeHealth?,
    friends: Friends?,
    settings: AppSettings,
    actions: Actions,
    onOpenSettings: () -> Unit,
) {
    val serverSettings by Hub.serverSettings.collectAsStateWithLifecycle()
    var confirmSignOut by rememberSaveable { mutableStateOf(false) }
    var editingAddress by rememberSaveable { mutableStateOf(false) }

    if (confirmSignOut) {
        ConfirmDialog(
            title = "Sign the bridge out?",
            text = "BABS forgets the Xbox account. To use the bridge again, you sign in with a new code, " +
                "with this account or another one.",
            confirm = "Sign out",
            onConfirm = {
                confirmSignOut = false
                actions.onSignOut()
            },
            onDismiss = { confirmSignOut = false },
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
        if (health?.signInCode != null && health.signInUrl != null) {
            SignInCard(health.signInUrl, health.signInCode)
        }

        StatusCard("Bridge", bridge, Modifier.fillMaxWidth()) {
            // The sign-in code ran out and HMBC is waiting before it shows another. Restarting it is quicker.
            val codeRanOut = health != null && health.state == "RETRYING" && health.gamertag == null && health.signInCode == null
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (codeRanOut && bridge.state != RunState.Stopping) {
                    Button(shape = MaterialTheme.shapes.small, onClick = actions.onNewCode) { Text("New code") }
                }
                if (bridge.state.isActive()) {
                    OutlinedButton(shape = MaterialTheme.shapes.small, onClick = actions.onRestartBridge, enabled = bridge.state != RunState.Stopping) { Text("Restart bridge") }
                } else {
                    // Bedrock Hub's Start is always green.
                    Button(
                        onClick = actions.onStart,
                        shape = MaterialTheme.shapes.small,
                        colors = ButtonDefaults.buttonColors(containerColor = HubColors.Green, contentColor = androidx.compose.ui.graphics.Color.White),
                    ) { Text("Start") }
                }
            }
        }

        SectionCard("Xbox account") {
            val account by Hub.account.collectAsStateWithLifecycle()
            // Live from the bridge, or the account last seen while it's off.
            val gamertag = health?.gamertag ?: account?.first?.takeIf { health?.signInCode == null }
            val picture = health?.gamerpic ?: account?.takeIf { it.first == gamertag }?.second?.ifEmpty { null }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Gamerpic(picture)
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Text(
                        when {
                            gamertag != null -> gamertag
                            health?.signInCode != null -> "Waiting for you to sign in"
                            bridge.state.isActive() -> "Checking"
                            else -> "Start the bridge to see it"
                        },
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.SemiBold,
                    )
                    if (gamertag != null) Hint("Friends add this account. They see the server name from Settings and the world's name")
                }
            }
            Hint(
                "Friends add this account on Xbox, then join its game from their friends list. " +
                    "Use an account made for the bridge, not your own.",
            )
            if (gamertag != null) {
                OutlinedButton(shape = MaterialTheme.shapes.small, onClick = { confirmSignOut = true }) { Text("Sign out") }
            }
        }

        SectionCard("Who can see the game") {
            Text(
                when {
                    health?.gamertag == null -> "Nobody yet: the bridge isn't signed in"
                    health.sessionHidden -> "Hidden from friends until the server is up"
                    server.state != RunState.Running -> "Hidden until the server is running"
                    health.serverReachable == false -> "Shown, but the bridge can't reach the server"
                    else -> "Friends of ${health.gamertag} can see it and join"
                },
                style = MaterialTheme.typography.bodyLarge,
            )
            Text(
                if (settings.publicAddress.isEmpty()) "No public address, so only players on this network can join"
                else "Public address ${settings.publicAddress}",
                style = MaterialTheme.typography.bodyMedium,
            )
            FindAddressButton(onFound = { if (it != settings.publicAddress) actions.onPublicAddress(it) }, label = "Find and set it")
            TextButton(colors = linkColors(), onClick = { editingAddress = true }, contentPadding = PaddingValues(0.dp)) {
                Text(if (settings.publicAddress.isEmpty()) "Type it in" else "Change or clear it")
            }
        }

        FriendRequestsCard(
            friends = friends,
            signedIn = health?.gamertag != null,
            settings = settings,
            allowListOn = serverSettings.allowListOn,
            actions = actions,
            onOpenSettings = onOpenSettings,
        )
    }
}

@Composable
private fun FriendRequestsCard(
    friends: Friends?,
    signedIn: Boolean,
    settings: AppSettings,
    allowListOn: Boolean,
    actions: Actions,
    onOpenSettings: () -> Unit,
) {
    SectionCard("Friend requests") {
        SwitchRow(
            title = "Accept automatically",
            detail = if (settings.autoAcceptFriends) "Anyone who adds the bridge account becomes its friend and can see the game"
            else "Requests wait here for you to accept or decline",
            checked = settings.autoAcceptFriends,
            onChange = actions.onAutoAccept,
        )
        if (allowListOn) {
            SwitchRow(
                title = "Add to the allow list",
                detail = "The server's allow list is on, so only players on it can join. Add people when you accept them here",
                checked = settings.allowAcceptedFriends,
                onChange = actions.onAllowAcceptedFriends,
            )
            if (settings.autoAcceptFriends) {
                Hint("Requests accepted automatically aren't added. Add those players under Settings > Server > Allow list.")
                TextButton(colors = linkColors(), onClick = onOpenSettings, contentPadding = PaddingValues(0.dp)) { Text("Open Settings") }
            }
        }
        HorizontalDivider()
        when {
            !signedIn -> Hint("Requests show here once the bridge is signed in.")
            friends == null -> Hint("Checking for requests")
            friends.requests.isEmpty() -> Hint(
                if (settings.autoAcceptFriends) "None waiting. New ones are accepted within a minute."
                else "None waiting. The bridge checks every minute or so.",
            )
            else -> friends.requests.forEach { request ->
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                    Text(request.gamertag, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
                    TextButton(colors = linkColors(), onClick = { actions.onDenyFriend(request) }) { Text("Decline") }
                    Button(shape = MaterialTheme.shapes.small, onClick = { actions.onApproveFriend(request) }) { Text("Accept") }
                }
            }
        }
        if (signedIn) {
            TextButton(colors = linkColors(), onClick = actions.onRefreshFriends, contentPadding = PaddingValues(0.dp)) { Text("Check now") }
        }
    }
}

/**
 * The account's Xbox profile picture, round, as Xbox shows it. Fetched once per address and kept for as long as
 * BABS runs. Until it loads, or without one, a ring in Bedrock Hub's line colour.
 */
@Composable
private fun Gamerpic(url: String?) {
    val picture by produceState(url?.let { GAMERPICS[it] }, url) {
        if (url != null && value == null) {
            value = withContext(Dispatchers.IO) {
                fetchGamerpic(url)?.let { bytes -> BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap() }
            }?.also { GAMERPICS[url] = it }
        }
    }
    val shape = CircleShape
    val p = picture
    if (p != null) {
        Image(
            p, contentDescription = "Xbox profile picture", contentScale = ContentScale.Crop,
            modifier = Modifier
                .size(56.dp)
                .clip(shape)
                .border(2.dp, HubColors.Line, shape),
        )
    } else {
        Box(
            Modifier
                .size(56.dp)
                .border(2.dp, HubColors.Line, shape),
        )
    }
}

private val GAMERPICS = java.util.concurrent.ConcurrentHashMap<String, ImageBitmap>()

@Composable
internal fun SwitchRow(title: String, detail: String?, checked: Boolean, enabled: Boolean = true, onChange: (Boolean) -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge)
            detail?.let { Hint(it) }
        }
        Spacer(Modifier.width(12.dp))
        Switch(checked = checked, onCheckedChange = onChange, enabled = enabled)
    }
}
