@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)

package app.babs.ui

import android.text.format.DateUtils
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.babs.core.CloudState
import app.babs.core.CloudSync
import app.babs.core.CloudWorld
import app.babs.core.Hub
import app.babs.core.RunState

/** A fine-grained token, which can be limited to the one repo. */
private const val NEW_TOKEN_URL = "https://github.com/settings/personal-access-tokens/new"
private val REPO_NAME = Regex("^[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}$")

private fun ago(at: Long?) = at?.takeIf { it > 0 }?.let { DateUtils.getRelativeTimeSpanString(it).toString() }

/**
 * Settings' GitHub Cloud card, as Bedrock Hub's: sign in, link or create the repo the worlds are saved to, and
 * the two switches. The same repo works from the PC and the phone.
 */
@Composable
internal fun CloudSettingsCard(actions: Actions) {
    val cloud by Hub.cloud.collectAsStateWithLifecycle()
    val uri = LocalUriHandler.current
    var askToken by rememberSaveable { mutableStateOf(false) }
    var linking by rememberSaveable { mutableStateOf(false) }
    var creating by rememberSaveable { mutableStateOf(false) }

    if (askToken) {
        TokenDialog(
            onOpenGitHub = { uri.openUri(NEW_TOKEN_URL) },
            onSave = {
                askToken = false
                CloudSync.launch { CloudSync.useToken(it) }
            },
            onDismiss = { askToken = false },
        )
    }
    if (linking) {
        TextInputDialog(
            title = "Link a repo",
            initial = "",
            placeholder = "owner/name",
            note = "A repo you already use for Bedrock Hub's GitHub Cloud, or any empty private repo.",
            problem = { if (REPO_NAME.matches(it)) null else "As owner/name, for example steve/bedrock-worlds" },
            onSave = {
                linking = false
                CloudSync.launch { CloudSync.link(it, create = false, allowPublic = false) }
            },
            onDismiss = { linking = false },
        )
    }
    if (creating) {
        TextInputDialog(
            title = "Create a private repo",
            initial = "bedrock-worlds",
            note = "Made on ${cloud.login}'s GitHub account. Only you can see it.",
            problem = { if (Regex("^[A-Za-z0-9._-]{1,100}$").matches(it)) null else "Letters, numbers, dots, dashes and underscores" },
            onSave = {
                creating = false
                CloudSync.launch { CloudSync.link(it, create = true, allowPublic = false) }
            },
            onDismiss = { creating = false },
        )
    }
    if (cloud.confirmPublic.isNotEmpty()) {
        val name = cloud.confirmPublic
        ConfirmDialog(
            title = "Use a public repo?",
            text = "$name is public, so anyone can download these worlds, and world saves can hold things like signs and books " +
                "you wrote. A private repo is safer.",
            confirm = "Use it anyway",
            onConfirm = { CloudSync.launch { CloudSync.link(name, create = false, allowPublic = true) } },
            onDismiss = CloudSync::dismissPublic,
        )
    }

    SectionCard("GitHub Cloud") {
        Hint(
            "Saves each world to a private GitHub repo after every session, the same way Bedrock Hub does. Link the same " +
                "repo on the PC and here, and a world carries on from one to the other.",
        )
        val signIn = cloud.signIn
        when {
            signIn != null -> {
                Text("Enter this code on GitHub:", style = MaterialTheme.typography.bodyMedium)
                Text(signIn.code, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold, fontSize = 26.sp, letterSpacing = 2.sp)
                Button(shape = MaterialTheme.shapes.small, onClick = { uri.openUri(signIn.url) }) { Text("Open GitHub") }
                TextButton(colors = linkColors(), onClick = CloudSync::cancelSignIn, contentPadding = PaddingValues(0.dp)) { Text("Cancel") }
            }
            !cloud.signedIn -> FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (cloud.deviceFlow) {
                    Button(shape = MaterialTheme.shapes.small, enabled = cloud.busy.isEmpty(), onClick = CloudSync::startSignIn) { Text("Sign in with GitHub") }
                    OutlinedButton(shape = MaterialTheme.shapes.small, enabled = cloud.busy.isEmpty(), onClick = { askToken = true }) { Text("Use a token") }
                } else {
                    Button(shape = MaterialTheme.shapes.small, enabled = cloud.busy.isEmpty(), onClick = { askToken = true }) { Text("Sign in with a token") }
                }
            }
            cloud.repo.isEmpty() -> {
                Text("Signed in as ${cloud.login}", style = MaterialTheme.typography.bodyLarge)
                Hint("Now choose where the worlds go.")
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(shape = MaterialTheme.shapes.small, enabled = cloud.busy.isEmpty(), onClick = { creating = true }) { Text("Create a private repo") }
                    OutlinedButton(shape = MaterialTheme.shapes.small, enabled = cloud.busy.isEmpty(), onClick = { linking = true }) { Text("Link a repo") }
                }
                TextButton(colors = linkColors(), onClick = CloudSync::signOut, contentPadding = PaddingValues(0.dp)) { Text("Sign out") }
            }
            else -> {
                Text(cloud.repo, style = MaterialTheme.typography.bodyLarge)
                Hint(
                    listOfNotNull(
                        "Signed in as ${cloud.login}",
                        when (cloud.repoPrivate) {
                            true -> "private"
                            false -> "public"
                            null -> null
                        },
                        ago(cloud.lastCheck)?.let { "checked $it" },
                    ).joinToString(", "),
                )
                if (cloud.repoPrivate == false) {
                    Text("This repo is public. Anyone can download these worlds.", color = HubColors.Warn, style = MaterialTheme.typography.bodySmall)
                }
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(shape = MaterialTheme.shapes.small, enabled = cloud.busy.isEmpty(), onClick = actions.onCloudCheck) { Text("Check now") }
                    if (cloud.repoUrl.isNotEmpty()) {
                        TextButton(colors = linkColors(), onClick = { uri.openUri(cloud.repoUrl) }) { Text("Open on GitHub") }
                    }
                }
                HorizontalDivider()
                SwitchRow(
                    title = "Upload automatically",
                    detail = "After each session, and every 15 minutes while BABS runs a server, worlds not uploaded yet are sent. " +
                        "Off, use Upload on the Worlds tab",
                    checked = cloud.autoUpload,
                    onChange = { CloudSync.autoUpload = it },
                )
                SwitchRow(
                    title = "Keep older saves",
                    detail = "Every upload stays in the repo's history. Off, only the latest is kept, which keeps the repo small",
                    checked = cloud.keepHistory,
                    onChange = { CloudSync.keepHistory = it },
                )
                Hint("While GitHub Cloud is linked, AutoSave copies every session, since those copies are what's uploaded.")
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TextButton(colors = linkColors(), onClick = CloudSync::unlink, contentPadding = PaddingValues(0.dp)) { Text("Use another repo") }
                    TextButton(colors = linkColors(), onClick = CloudSync::signOut, contentPadding = PaddingValues(0.dp)) { Text("Sign out") }
                }
            }
        }
        CloudBusyAndError(cloud.busy, cloud.error)
    }
}

@Composable
private fun CloudBusyAndError(busy: String, error: String) {
    if (busy.isNotEmpty()) {
        Text(busy, style = MaterialTheme.typography.bodySmall)
        LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
    }
    if (error.isNotEmpty()) {
        Text(error, color = HubColors.Err, style = MaterialTheme.typography.bodySmall)
        TextButton(colors = linkColors(), onClick = { CloudSync.showError("") }, contentPadding = PaddingValues(0.dp)) { Text("OK") }
    }
}

@Composable
private fun TokenDialog(onOpenGitHub: () -> Unit, onSave: (String) -> Unit, onDismiss: () -> Unit) {
    var text by remember { mutableStateOf("") }
    val ok = Regex("^[\\w-]{20,255}$").matches(text.trim())
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Sign in with a token") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    "Make a fine-grained token on GitHub. Under Repository access pick only the repo for your worlds " +
                        "(make it on GitHub first, private), and set Contents to Read and write. To have BABS create the repo " +
                        "instead, give it All repositories and Administration read and write too. Then paste it here.",
                    style = MaterialTheme.typography.bodyMedium,
                )
                TextButton(colors = linkColors(), onClick = onOpenGitHub, contentPadding = PaddingValues(0.dp)) { Text("Make a token on GitHub") }
                OutlinedTextField(
                    value = text,
                    onValueChange = { text = it },
                    singleLine = true,
                    placeholder = { Text("github_pat_...") },
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done),
                )
                Hint("It's kept encrypted on this phone, and only sent to GitHub.")
            }
        },
        confirmButton = { TextButton(colors = linkColors(), enabled = ok, onClick = { onSave(text.trim()) }) { Text("Sign in") } },
        dismissButton = { TextButton(colors = linkColors(), onClick = onDismiss) { Text("Cancel") } },
    )
}

/** The Worlds tab's GitHub Cloud card: each world's state, with Upload and Download, as Bedrock Hub's Cloud page. */
@Composable
internal fun CloudWorldsCard(state: RunState, hosted: String?, actions: Actions) {
    val cloud by Hub.cloud.collectAsStateWithLifecycle()
    if (!cloud.linked) return
    var downloading by remember { mutableStateOf<CloudWorld?>(null) }
    val running = state == RunState.Running || state == RunState.Starting || state == RunState.Stopping

    downloading?.let { world ->
        ConfirmDialog(
            title = "Download \"${world.name}\"?",
            text = "This replaces the world on this phone with the save from ${world.cloudDevice ?: "GitHub Cloud"}" +
                (ago(world.cloudAt)?.let { ", $it" } ?: "") + ". The copy it replaces is kept under Backups.",
            confirm = "Download",
            onConfirm = {
                downloading = null
                actions.onCloudDownload(world.folder)
            },
            onDismiss = { downloading = null },
        )
    }

    SectionCard("GitHub Cloud") {
        Hint(cloud.repo)
        if (cloud.worlds.isEmpty()) Hint("Nothing saved yet. Worlds are uploaded after their next session.")
        cloud.worlds.forEachIndexed { i, world ->
            if (i > 0) HorizontalDivider()
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(world.name, style = MaterialTheme.typography.bodyLarge)
                Text(
                    if (world.uploading) "Uploading" else world.state.word,
                    style = MaterialTheme.typography.bodySmall,
                    color = when (world.state) {
                        CloudState.Same -> HubColors.Ok
                        CloudState.CloudNewer, CloudState.CloudOnly -> HubColors.Accent
                        CloudState.Both -> HubColors.Warn
                        else -> HubColors.Muted
                    },
                )
                val lines = listOfNotNull(
                    ago(world.localAt)?.let { "This phone: $it" },
                    ago(world.cloudAt)?.let { "Cloud: $it${world.cloudDevice?.let { d -> " on $d" } ?: ""}" },
                )
                if (lines.isNotEmpty()) Hint(lines.joinToString(". "))
                val idle = cloud.busy.isEmpty() && !world.uploading
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (world.localAt != null && world.state != CloudState.Same) {
                        TextButton(colors = linkColors(), enabled = idle, onClick = { actions.onCloudUpload(world.folder) }, contentPadding = PaddingValues(0.dp)) {
                            Text("Upload")
                        }
                    }
                    if (world.cloudAt != null && world.state != CloudState.Same && world.state != CloudState.LocalNewer) {
                        TextButton(
                            colors = linkColors(),
                            enabled = idle && !(running && world.folder == hosted),
                            onClick = { downloading = world },
                            contentPadding = PaddingValues(0.dp),
                        ) { Text("Download") }
                    }
                }
            }
        }
        CloudBusyAndError(cloud.busy, cloud.error)
    }
}

/** Asked before a start when GitHub Cloud has a newer save of the world, as Bedrock Hub asks. */
@Composable
internal fun CloudPromptDialog(actions: Actions) {
    val cloud by Hub.cloud.collectAsStateWithLifecycle()
    val prompt = cloud.prompt ?: return
    AlertDialog(
        onDismissRequest = { actions.onCloudChoice(null) },
        title = { Text("Newer save in GitHub Cloud") },
        text = {
            Text(
                "\"${prompt.name}\" was saved on ${prompt.device}${ago(prompt.at)?.let { " $it" } ?: ""}, after this phone's copy" +
                    (ago(prompt.localAt)?.let { " ($it)" } ?: "") + "." +
                    (if (prompt.both) " This phone's copy has changes that weren't uploaded, and they'll be lost if you use the cloud save. The copy it replaces is kept under Backups." else " The copy it replaces is kept under Backups."),
                style = MaterialTheme.typography.bodyMedium,
            )
        },
        confirmButton = { TextButton(colors = linkColors(), onClick = { actions.onCloudChoice("cloud") }) { Text("Use the cloud save") } },
        dismissButton = {
            Column {
                TextButton(colors = linkColors(), onClick = { actions.onCloudChoice("local") }) { Text("Keep this phone's") }
                TextButton(colors = linkColors(), onClick = { actions.onCloudChoice(null) }) { Text("Cancel") }
            }
        },
    )
}
