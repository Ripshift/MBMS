package app.babs.core

import android.content.Context
import androidx.core.content.edit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/** How this phone's copy of a world compares with the cloud's, as Bedrock Hub's compare(). */
enum class CloudState(val word: String) {
    Off("GitHub Cloud is off"),
    None("Not saved yet"),
    LocalOnly("Only on this phone"),
    CloudOnly("Only in GitHub Cloud"),
    CloudNewer("Newer save in GitHub Cloud"),
    LocalNewer("Not uploaded yet"),
    Both("Changed here and in GitHub Cloud"),
    Same("Up to date"),
}

data class CloudWorld(
    val folder: String,
    val name: String,
    val state: CloudState,
    val localAt: Long?,
    val localDevice: String?,
    val cloudAt: Long?,
    val cloudDevice: String?,
    val uploading: Boolean,
)

/** Asked before the server starts a world that has a newer save in GitHub Cloud. */
data class CloudPrompt(val world: String, val name: String, val device: String, val at: Long?, val localAt: Long?, val both: Boolean)

/** What the GitHub Cloud card and the Worlds tab show. */
data class CloudView(
    val signedIn: Boolean = false,
    val login: String = "",
    val repo: String = "",
    val repoUrl: String = "",
    val repoPrivate: Boolean? = null,
    val autoUpload: Boolean = true,
    val keepHistory: Boolean = true,
    val deviceFlow: Boolean = false,
    val signIn: DeviceSignIn? = null,
    val worlds: List<CloudWorld> = emptyList(),
    val lastCheck: Long? = null,
    val error: String = "",
    val busy: String = "",
    val prompt: CloudPrompt? = null,
    /** A public repo waiting for the person to agree to it. */
    val confirmPublic: String = "",
) {
    val linked get() = signedIn && repo.isNotEmpty()
    val newer get() = worlds.count { it.state == CloudState.CloudNewer || it.state == CloudState.CloudOnly || it.state == CloudState.Both }
}

/**
 * GitHub Cloud on the phone, the same repo and format as Bedrock Hub's `src/cloud.js`, so a world saved on the PC
 * carries on here and back:
 *
 * ```
 * <world>/world.json      name, when each copy was taken and where, and rev, which goes up with every upload
 * <world>/pregameplay/    the world before its last session
 * <world>/postgameplay/   the world after it
 * ```
 *
 * Pack folders are left out (.gitignore says so too), and files over 95 MB are skipped. Each upload builds one
 * commit from the world's AutoSave folder on top of whatever the repo holds, so one world's upload never touches
 * another's, and only files GitHub doesn't already have are sent.
 */
class Cloud(private val token: String, private val repo: String, private val keepHistory: Boolean) {
    data class Head(val commit: String, val tree: String)
    data class Uploaded(val commit: String, val rev: Int, val skipped: Int)

    private class NotFastForward : IOException("The repo changed while uploading")

    /** The newest commit on main, or null for a repo with nothing in it yet. */
    fun head(): Head? {
        val ref = GitHub.call("/repos/$repo/git/ref/heads/$BRANCH", token)
        if (ref.status == 404 || ref.status == 409) return null
        if (!ref.ok) throw GitHubException("GitHub couldn't open $repo (${ref.status}): ${GitHub.message(ref)}", ref.status)
        val commit = ref.json().getJSONObject("object").getString("sha")
        val c = get("/repos/$repo/git/commits/$commit")
        return Head(commit, c.getJSONObject("tree").getString("sha"))
    }

    private fun get(path: String): JSONObject {
        val answer = GitHub.call(path, token)
        if (!answer.ok) throw GitHubException("GitHub said ${answer.status}: ${GitHub.message(answer)}", answer.status)
        return answer.json()
    }

    private fun post(path: String, body: JSONObject, method: String = "POST"): JSONObject {
        val answer = GitHub.call(path, token, method, body)
        if (answer.status == 422 && path.contains("/git/refs/")) throw NotFastForward()
        if (!answer.ok) throw GitHubException("GitHub said ${answer.status}: ${GitHub.message(answer)}", answer.status)
        return answer.json()
    }

    /** One tree's entries. With [recursive], every file under it, by path. */
    private fun tree(sha: String, recursive: Boolean = false): List<JSONObject> {
        val t = get("/repos/$repo/git/trees/$sha" + if (recursive) "?recursive=1" else "")
        if (t.optBoolean("truncated")) throw GitHubException("That world has more files than GitHub lists at once")
        val list = t.optJSONArray("tree") ?: JSONArray()
        return (0 until list.length()).map { list.getJSONObject(it) }
    }

    private fun rawBlob(sha: String): String {
        val answer = GitHub.call("/repos/$repo/git/blobs/$sha", token, accept = "application/vnd.github.raw+json")
        if (!answer.ok) throw GitHubException("GitHub said ${answer.status}", answer.status)
        return answer.body
    }

    /** world folder to its world.json in the repo. */
    fun worldsAt(head: Head?): Map<String, JSONObject> {
        if (head == null) return emptyMap()
        val out = mutableMapOf<String, JSONObject>()
        for (entry in tree(head.tree)) {
            if (entry.optString("type") != "tree") continue
            val meta = tree(entry.getString("sha")).firstOrNull { it.optString("path") == "world.json" && it.optString("type") == "blob" }
                ?: continue
            runCatching { out[entry.getString("path")] = JSONObject(rawBlob(meta.getString("sha"))) }
        }
        return out
    }

    /**
     * Sends one world's AutoSave copies and returns the new rev. If another device saved in between, it starts
     * again from the newer commit once, as nothing of theirs is overwritten except this world.
     */
    fun upload(world: String, folder: File, meta: JSONObject, hashes: Hashes, progress: (String) -> Unit): Uploaded {
        repeat(2) { attempt ->
            try {
                return uploadOnce(world, folder, meta, hashes, progress)
            } catch (e: NotFastForward) {
                if (attempt == 1) throw GitHubException("Another device kept saving to the repo. Try again in a moment")
            }
        }
        throw IllegalStateException()
    }

    private fun uploadOnce(world: String, folder: File, meta: JSONObject, hashes: Hashes, progress: (String) -> Unit): Uploaded {
        var head = head()
        if (head == null) {
            // GitHub's Git Data API can't write to an empty repo, so the first file goes in through Contents.
            post(
                "/repos/$repo/contents/README.md",
                JSONObject().put("message", "Start the world saves\n").put("branch", BRANCH)
                    .put("content", android.util.Base64.encodeToString(README.toByteArray(), android.util.Base64.NO_WRAP)),
                "PUT",
            )
            head = head() ?: throw GitHubException("The repo is still empty after the first file")
        }
        val root = tree(head.tree)
        val worldSha = root.firstOrNull { it.optString("path") == world && it.optString("type") == "tree" }?.optString("sha")
        val before = worldSha?.let { tree(it, recursive = true) }.orEmpty()
        val have = before.filter { it.optString("type") == "blob" }.map { it.getString("sha") }.toMutableSet()

        val entries = JSONArray()
        var skipped = 0
        for (kind in AutoSave.KINDS) {
            val dir = File(folder, kind)
            if (!File(dir, "level.dat").isFile) {
                // Nothing here: keep what the repo has
                before.firstOrNull { it.optString("path") == kind && it.optString("type") == "tree" }?.let {
                    entries.put(JSONObject().put("path", kind).put("mode", "040000").put("type", "tree").put("sha", it.getString("sha")))
                }
                continue
            }
            val files = dir.walkTopDown()
                .onEnter { it == dir || it.parentFile != dir || it.name.lowercase() !in AutoSave.PACK_DIRS }
                .filter { it.isFile }.toList()
            files.forEachIndexed { i, file ->
                if (file.length() > MAX_FILE) {
                    skipped++
                    return@forEachIndexed
                }
                val sha = hashes.of(file)
                if (sha !in have) {
                    progress("Uploading ${meta.optString("name", world)}: ${kind.removeSuffix("gameplay")} ${i + 1} of ${files.size}")
                    val sent = withRetry { GitHub.uploadBlob(token, repo, file) }
                    if (sent != sha) throw GitHubException("GitHub stored ${file.name} differently than it was sent")
                    have += sha
                    pace()
                }
                entries.put(
                    JSONObject().put("path", "$kind/" + file.relativeTo(dir).invariantSeparatorsPath)
                        .put("mode", "100644").put("type", "blob").put("sha", sha),
                )
            }
        }
        if (entries.length() == 0) throw GitHubException("There's nothing to upload for that world yet")

        val cloudMeta = before.firstOrNull { it.optString("path") == "world.json" }?.let { runCatching { JSONObject(rawBlob(it.getString("sha"))) }.getOrNull() }
        val rev = maxOf(cloudMeta?.optInt("rev") ?: 0, meta.optInt("syncedRev")) + 1
        val record = JSONObject()
            .put("folder", world).put("name", meta.optString("name", world)).put("rev", rev)
            .put("pre", meta.opt("pre") ?: JSONObject.NULL).put("post", meta.opt("post") ?: JSONObject.NULL)
            .put("packs", meta.optJSONArray("packs") ?: JSONArray())
            .put("uploadedBy", AutoSave.device).put("uploadedAt", System.currentTimeMillis())
        entries.put(JSONObject().put("path", "world.json").put("mode", "100644").put("type", "blob").put("content", record.toString(2)))
        progress("Saving ${meta.optString("name", world)} in GitHub Cloud")
        val worldTree = post("/repos/$repo/git/trees", JSONObject().put("tree", entries)).getString("sha")

        val rootTree = post(
            "/repos/$repo/git/trees",
            JSONObject().put("base_tree", head.tree).put(
                "tree",
                JSONArray()
                    .put(JSONObject().put("path", world).put("mode", "040000").put("type", "tree").put("sha", worldTree))
                    .put(JSONObject().put("path", ".gitignore").put("mode", "100644").put("type", "blob").put("content", GITIGNORE))
                    .put(JSONObject().put("path", "README.md").put("mode", "100644").put("type", "blob").put("content", README)),
            ),
        ).getString("sha")
        val parents = if (keepHistory) JSONArray().put(head.commit) else JSONArray()
        val stamp = JSONObject().put("name", AUTHOR).put("email", EMAIL).put("date", iso(System.currentTimeMillis()))
        val commit = post(
            "/repos/$repo/git/commits",
            JSONObject().put("message", "${meta.optString("name", world)}: saved on ${AutoSave.device}\n")
                .put("tree", rootTree).put("parents", parents).put("author", stamp).put("committer", stamp),
        ).getString("sha")
        // Without history the commit has no parent, so it replaces the branch, as Bedrock Hub's forced push does.
        post("/repos/$repo/git/refs/heads/$BRANCH", JSONObject().put("sha", commit).put("force", !keepHistory), "PATCH")
        return Uploaded(commit, rev, skipped)
    }

    /** Brings one world's copies from the repo into its AutoSave folder, and returns its world.json. */
    fun download(world: String, folder: File, progress: (String) -> Unit): JSONObject {
        val head = head() ?: throw GitHubException("GitHub Cloud has no saves yet")
        val worldSha = tree(head.tree).firstOrNull { it.optString("path") == world && it.optString("type") == "tree" }?.optString("sha")
            ?: throw GitHubException("That world isn't in GitHub Cloud")
        val files = tree(worldSha, recursive = true)
        val meta = files.firstOrNull { it.optString("path") == "world.json" }?.let { JSONObject(rawBlob(it.getString("sha"))) }
            ?: throw GitHubException("That world isn't in GitHub Cloud")
        folder.mkdirs()
        for (kind in AutoSave.KINDS) {
            val blobs = files.filter { it.optString("type") == "blob" && it.getString("path").startsWith("$kind/") }
            if (blobs.isEmpty()) continue
            val tmp = File(folder, "$kind.downloading")
            tmp.deleteRecursively()
            val root = tmp.canonicalPath + File.separator
            try {
                blobs.forEachIndexed { i, entry ->
                    progress("Downloading ${meta.optString("name", world)}: ${kind.removeSuffix("gameplay")} ${i + 1} of ${blobs.size}")
                    val target = File(tmp, entry.getString("path").removePrefix("$kind/"))
                    if (!target.canonicalPath.startsWith(root)) throw GitHubException("The save has a file with an unsafe name")
                    target.parentFile?.mkdirs()
                    withRetry { GitHub.downloadBlob(token, repo, entry.getString("sha"), target) }
                }
            } catch (e: Exception) {
                tmp.deleteRecursively()
                throw e
            }
            val final = File(folder, kind)
            final.deleteRecursively()
            if (!tmp.renameTo(final)) throw IOException("Couldn't put the download in place")
        }
        return meta
    }

    /** GitHub allows about 80 new files a minute, so sending is paced, and waits when it asks. */
    private fun pace() = Thread.sleep(800)

    private fun <T> withRetry(work: () -> T): T {
        var tries = 0
        while (true) {
            try {
                return work()
            } catch (e: GitHub.RateLimited) {
                if (++tries > 3) throw GitHubException("GitHub asked to slow down. It carries on at the next check")
                Hub.log(Source.Babs, "GitHub Cloud: GitHub asked to slow down, so waiting ${e.seconds.coerceAtMost(120)} s")
                Thread.sleep(e.seconds.coerceIn(5, 120) * 1000)
            }
        }
    }

    /** Git's ids for files, remembered by path, size and time so an unchanged world isn't read again. */
    class Hashes(private val file: File) {
        private val known: JSONObject = runCatching { JSONObject(file.readText()) }.getOrDefault(JSONObject())
        fun of(f: File): String {
            val key = "${f.path}|${f.length()}|${f.lastModified()}"
            known.optString(key).takeIf { it.length == 40 }?.let { return it }
            return GitHub.blobSha(f).also { known.put(key, it) }
        }
        fun save(keep: (String) -> Boolean = { true }) {
            val names = known.keys().asSequence().toList()
            names.filterNot { keep(it.substringBefore('|')) }.forEach { known.remove(it) }
            runCatching { file.writeText(known.toString()) }
        }
    }

    companion object {
        const val BRANCH = "main"
        const val MAX_FILE = 95L * 1024 * 1024
        private const val AUTHOR = "BABS"
        private const val EMAIL = "bedrock-hub@users.noreply.github.com"
        // The same text as Bedrock Hub writes, so uploads from either don't keep changing it.
        const val GITIGNORE = "# Bedrock Hub: packs come from the Mod Library, so they are not saved here\n*/*/behavior_packs/\n*/*/resource_packs/\n"
        const val README = "# Minecraft Bedrock worlds\n\nSaved by Bedrock Hub. Each folder is one world: `pregameplay` is how it was before its last session, `postgameplay` how it was after.\nBehavior and resource packs are left out. Bedrock Hub puts them back from its Mod Library when a world is downloaded.\n"

        private fun iso(time: Long) = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US)
            .apply { timeZone = TimeZone.getTimeZone("UTC") }.format(Date(time))

        /** How this phone's copy of a world compares with the cloud's. */
        fun compare(local: JSONObject?, cloud: JSONObject?): CloudState {
            val hasLocal = local != null && (local.has("post") && !local.isNull("post") || local.has("pre") && !local.isNull("pre"))
            if (cloud == null) return if (local?.optJSONObject("post") != null) CloudState.LocalOnly else CloudState.None
            if (!hasLocal) return CloudState.CloudOnly
            val cloudNewer = cloud.optInt("rev") > local.optInt("syncedRev")
            val localNewer = local.optBoolean("changed")
            return when {
                cloudNewer && localNewer -> CloudState.Both
                cloudNewer -> CloudState.CloudNewer
                localNewer -> CloudState.LocalNewer
                else -> CloudState.Same
            }
        }
    }
}

/**
 * GitHub Cloud as BABS uses it, after Bedrock Hub's `src/cloudmanager.js`: around each server session, from the
 * Worlds tab and from Settings. The token is kept with [SecretStore]. Uploads and downloads run one at a time.
 */
object CloudSync {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val queue = Mutex()
    private lateinit var app: Context
    private val prefs get() = app.getSharedPreferences("babs_cloud", Context.MODE_PRIVATE)
    private val secrets by lazy { SecretStore(app) }
    private val serverDir get() = File(app.filesDir, "server")
    private val autosave get() = AutoSave(serverDir)

    private var cloudWorlds: Map<String, JSONObject> = emptyMap()
    private val status = mutableMapOf<String, CloudState>()
    private val uploading = mutableSetOf<String>()
    @Volatile private var signIn: DeviceSignIn? = null
    @Volatile private var error = ""
    @Volatile private var busy = ""
    @Volatile private var prompt: CloudPrompt? = null
    @Volatile private var lastCheck: Long? = null
    @Volatile private var confirmPublic = ""

    fun init(context: Context) {
        if (::app.isInitialized) return
        app = context.applicationContext
        publish()
    }

    private val token get() = secrets.githubToken
    private var login: String
        get() = prefs.getString("login", "").orEmpty()
        set(value) = prefs.edit { putString("login", value) }
    private var repo: String
        get() = prefs.getString("repo", "").orEmpty()
        set(value) = prefs.edit { putString("repo", value) }
    private var repoUrl: String
        get() = prefs.getString("repo_url", "").orEmpty()
        set(value) = prefs.edit { putString("repo_url", value) }
    private var repoPrivate: Boolean?
        get() = if (prefs.contains("repo_private")) prefs.getBoolean("repo_private", true) else null
        set(value) = prefs.edit { if (value == null) remove("repo_private") else putBoolean("repo_private", value) }
    var autoUpload: Boolean
        get() = prefs.getBoolean("auto_upload", true)
        set(value) { prefs.edit { putBoolean("auto_upload", value) }; publish() }
    var keepHistory: Boolean
        get() = prefs.getBoolean("keep_history", true)
        set(value) { prefs.edit { putBoolean("keep_history", value) }; publish() }

    val linked: Boolean get() = ::app.isInitialized && login.isNotEmpty() && repo.isNotEmpty() && token.isNotEmpty()

    private fun cloud() = Cloud(token, repo, keepHistory)

    /** Shows the current state on screen. */
    @Synchronized
    fun publish() {
        if (!::app.isInitialized) return
        val names = (autosave.worlds() + cloudWorlds.keys).toSortedSet()
        val worlds = names.map { world ->
            val local = autosave.meta(world)
            val theirs = cloudWorlds[world]
            val last = local.optJSONObject("post") ?: local.optJSONObject("pre")
            CloudWorld(
                folder = world,
                name = theirs?.optString("name")?.ifEmpty { null } ?: local.optString("name", world),
                state = if (linked) status[world] ?: Cloud.compare(local, theirs) else CloudState.Off,
                localAt = last?.optLong("at"), localDevice = last?.optString("device"),
                cloudAt = theirs?.optJSONObject("post")?.optLong("at"), cloudDevice = theirs?.optJSONObject("post")?.optString("device"),
                uploading = world in uploading,
            )
        }
        Hub.setCloud(
            CloudView(
                signedIn = login.isNotEmpty() && token.isNotEmpty(), login = login, repo = repo, repoUrl = repoUrl, repoPrivate = repoPrivate,
                autoUpload = autoUpload, keepHistory = keepHistory, deviceFlow = GitHub.clientId.isNotEmpty(), signIn = signIn,
                worlds = worlds, lastCheck = lastCheck, error = error, busy = busy, prompt = prompt,
                confirmPublic = confirmPublic,
            ),
        )
    }

    // ---------------------------------------------------------------- signing in and linking

    /** Checks a token with GitHub and keeps it. A different account forgets the old repo. */
    suspend fun useToken(raw: String) = withContext(Dispatchers.IO) {
        val token = raw.trim()
        if (!Regex("^[\\w-]{20,255}$").matches(token)) throw GitHubException("That doesn't look like a GitHub token.")
        busy = "Checking the token"
        publish()
        val who = try { GitHub.whoAmI(token) } finally { busy = "" }
        secrets.githubToken = token
        if (login.isNotEmpty() && login != who.login) forgetRepo()
        login = who.login
        error = ""
        Hub.log(Source.Babs, "GitHub Cloud: signed in as ${who.login}")
        publish()
    }

    fun startSignIn() {
        scope.launch {
            try {
                val started = GitHub.startDeviceSignIn()
                signIn = started
                publish()
                val token = GitHub.waitForDeviceSignIn(started) { signIn !== started }
                useToken(token)
            } catch (e: Exception) {
                error = e.message ?: e.javaClass.simpleName
            } finally {
                signIn = null
                publish()
            }
        }
    }

    /** Shows what went wrong with something the person did, on the GitHub Cloud card. */
    fun showError(message: String) {
        error = message
        publish()
    }

    /** Runs [work] for the UI, showing any failure on the card. A public repo asks first. */
    fun launch(work: suspend () -> Unit) {
        scope.launch {
            try {
                work()
            } catch (e: PublicRepo) {
                confirmPublic = e.name
                publish()
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                showError(e.message ?: e.javaClass.simpleName)
            }
        }
    }

    fun dismissPublic() {
        confirmPublic = ""
        publish()
    }

    fun cancelSignIn() {
        signIn = null
        publish()
    }

    fun signOut() {
        secrets.githubToken = ""
        login = ""
        forgetRepo()
        Hub.log(Source.Babs, "GitHub Cloud: signed out")
        publish()
    }

    private fun forgetRepo() {
        repo = ""
        repoUrl = ""
        repoPrivate = null
        cloudWorlds = emptyMap()
        status.clear()
    }

    /** The repo is public, which the person has to agree to first, as Bedrock Hub asks. */
    class PublicRepo(val name: String) : Exception("$name is public. Anyone can see its contents, and world saves can hold private things")

    /** Links an existing repo, or creates a private one. Throws [PublicRepo] for a public one unless [allowPublic]. */
    suspend fun link(name: String, create: Boolean, allowPublic: Boolean) = withContext(Dispatchers.IO) {
        val token = token.ifEmpty { throw GitHubException("Sign in to GitHub first.") }
        confirmPublic = ""
        busy = if (create) "Creating $name" else "Checking ${name.trim()}"
        publish()
        val found = try {
            if (create) GitHub.createRepo(token, name.trim()) else GitHub.checkRepo(token, name.trim())
        } finally {
            busy = ""
        }
        if (!found.private && !allowPublic) throw PublicRepo(found.fullName)
        val switching = repo.isNotEmpty() && !repo.equals(found.fullName, ignoreCase = true)
        repo = found.fullName
        repoUrl = found.url
        repoPrivate = found.private
        if (switching) {
            for (world in autosave.worlds()) autosave.saveMeta(world, autosave.meta(world).put("syncedRev", 0).put("changed", true))
        }
        cloudWorlds = emptyMap()
        status.clear()
        error = ""
        Hub.log(Source.Babs, "GitHub Cloud: linked ${found.fullName}${if (found.private) "" else " (public)"}")
        publish()
        check()
    }

    fun unlink() {
        forgetRepo()
        publish()
    }

    // ---------------------------------------------------------------- around each session

    /** What to do before the server starts a world. */
    sealed interface Before {
        data object Go : Before
        data object Ask : Before
    }

    /**
     * Before a session: when GitHub Cloud has a newer save of [world], asks which to use, unless [choice] already
     * says ("cloud" or "local"). A check that fails starts with this phone's copy, as Bedrock Hub does.
     */
    suspend fun beforeStart(world: String, choice: String?): Before {
        if (!linked) return Before.Go
        try {
            val theirs = withTimeout(CHECK_TIMEOUT_MS) {
                withContext(Dispatchers.IO) {
                    val c = cloud()
                    c.worldsAt(c.head())
                }
            }
            cloudWorlds = theirs
            val local = autosave.meta(world)
            val state = Cloud.compare(local, theirs[world])
            status[world] = state
            if (state == CloudState.CloudNewer || state == CloudState.Both) {
                val cloudMeta = theirs.getValue(world)
                when (choice) {
                    "cloud" -> queue.withLock { bringDown(world) }
                    "local" -> autosave.saveMeta(world, local.put("changed", true).put("syncedRev", cloudMeta.optInt("rev")))
                    else -> {
                        prompt = CloudPrompt(
                            world = world,
                            name = cloudMeta.optString("name", world),
                            device = cloudMeta.optJSONObject("post")?.optString("device")?.ifEmpty { null } ?: "another device",
                            at = cloudMeta.optJSONObject("post")?.optLong("at"),
                            localAt = local.optJSONObject("post")?.optLong("at"),
                            both = state == CloudState.Both,
                        )
                        publish()
                        return Before.Ask
                    }
                }
            }
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException && e !is kotlinx.coroutines.TimeoutCancellationException) throw e
            error = "Couldn't check GitHub Cloud: ${e.message ?: "it took too long"}. Started with this phone's copy."
            Hub.log(Source.Babs, "GitHub Cloud: $error")
        }
        prompt = null
        publish()
        return Before.Go
    }

    fun dismissPrompt() {
        prompt = null
        publish()
    }

    /** After a session's AutoSave copy: notes the world's packs, then uploads it if Upload automatically is on. */
    fun afterStop(world: String): Boolean {
        val post = File(autosave.folderOf(world), "postgameplay")
        autosave.saveMeta(world, autosave.meta(world).put("packs", packsOf(post)))
        publish()
        return linked && autoUpload
    }

    // ---------------------------------------------------------------- moving saves

    /** Sends one world's AutoSave copies. Blocking; the service runs it so it carries on with the screen off. */
    suspend fun upload(world: String) = queue.withLock {
        if (!linked) return@withLock
        synchronized(this) { uploading += world }
        publish()
        try {
            withContext(Dispatchers.IO) {
                val hashes = Cloud.Hashes(File(app.filesDir, "cloud-hashes.json"))
                val meta = autosave.meta(world)
                val done = cloud().upload(world, autosave.folderOf(world), meta, hashes) { busy = it; publish() }
                hashes.save { File(it).exists() }
                autosave.saveMeta(world, autosave.meta(world).put("syncedRev", done.rev).put("changed", false))
                cloudWorlds = cloudWorlds + (world to JSONObject().put("name", meta.optString("name", world)).put("rev", done.rev)
                    .put("post", meta.opt("post") ?: JSONObject.NULL))
                status[world] = CloudState.Same
                error = ""
                Hub.log(
                    Source.Babs,
                    "GitHub Cloud: uploaded \"${meta.optString("name", world)}\"" +
                        if (done.skipped > 0) ". ${done.skipped} files over 95 MB were left out, which GitHub can't hold" else "",
                )
            }
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            error = "Couldn't upload to GitHub Cloud: ${e.message}. It tries again at the next check."
            Hub.log(Source.Babs, error)
        } finally {
            synchronized(this) { uploading -= world }
            busy = ""
            publish()
        }
    }

    /** Replaces the world on this phone with the cloud's latest save, keeping the copy it replaced as a backup. */
    suspend fun download(world: String) = queue.withLock {
        try {
            bringDown(world)
            error = ""
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            error = "Couldn't download from GitHub Cloud: ${e.message}"
            Hub.log(Source.Babs, error)
        } finally {
            busy = ""
            publish()
        }
    }

    private suspend fun bringDown(world: String) = withContext(Dispatchers.IO) {
        val folder = autosave.folderOf(world)
        val meta = cloud().download(world, folder) { busy = it; publish() }
        val local = autosave.meta(world)
        for (key in listOf("pre", "post", "packs")) local.put(key, meta.opt(key) ?: JSONObject.NULL)
        autosave.saveMeta(world, local.put("name", meta.optString("name", world)).put("syncedRev", meta.optInt("rev")).put("changed", false))
        autosave.restoreWorld(world)
        status[world] = CloudState.Same
        // Cloud saves leave packs out. The world keeps its own, the mod library puts back what it has, and the rest are named.
        val worldDir = File(serverDir, "worlds/$world")
        val packs = meta.optJSONArray("packs") ?: JSONArray()
        val listed = (0 until packs.length()).mapNotNull { packs.optJSONObject(it)?.optString("uuid")?.ifEmpty { null } }
        val restored = PackInstaller.restoreFromLibrary(PackInstaller.libraryDir(app), worldDir, listed)
        if (restored.isNotEmpty()) Hub.log(Source.Babs, "Put back from the mod library: ${restored.joinToString()}")
        val have = PackInstaller.installedIds(worldDir)
        val missing = (0 until packs.length()).mapNotNull { packs.optJSONObject(it) }
            .filter { it.optString("uuid").lowercase() !in have }
            .map { it.optString("name").ifEmpty { it.optString("uuid") } }
        Hub.log(Source.Babs, "GitHub Cloud: downloaded \"${meta.optString("name", world)}\"")
        if (missing.isNotEmpty()) {
            Hub.log(Source.Babs, "\"${meta.optString("name", world)}\" uses packs this phone doesn't have: ${missing.joinToString()}. Add them on its Packs page, and they're kept in the mod library for next time")
        }
        Hub.updateServerSettings { ServerConfig(serverDir).load(it.restartNeeded) }
    }

    /**
     * Looks for newer saves, and returns the worlds that should be uploaded (not uploaded yet, or only on this
     * phone), as Bedrock Hub's check does every 15 minutes.
     */
    suspend fun check(): List<String> = withContext(Dispatchers.IO) {
        if (!linked) return@withContext emptyList()
        busy = "Checking"
        publish()
        try {
            val c = cloud()
            val found = withTimeout(CHECK_TIMEOUT_MS * 3) { c.worldsAt(c.head()) }
            runCatching { repoPrivate = GitHub.checkRepo(token, repo).private }
            cloudWorlds = found
            status.clear()
            for (world in (autosave.worlds() + found.keys).toSet()) status[world] = Cloud.compare(autosave.meta(world), found[world])
            lastCheck = System.currentTimeMillis()
            error = ""
            if (autoUpload) status.filter { it.value == CloudState.LocalNewer || it.value == CloudState.LocalOnly }.keys.toList() else emptyList()
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException && e !is kotlinx.coroutines.TimeoutCancellationException) throw e
            error = "Couldn't reach GitHub Cloud: ${e.message ?: "it took too long"}"
            emptyList()
        } finally {
            busy = ""
            publish()
        }
    }

    /** The packs a world lists, with names from its own copies, so a missing pack can be named on another device. */
    private fun packsOf(dir: File): JSONArray {
        val out = mutableListOf<JSONObject>()
        for ((kind, file) in listOf("behavior" to "world_behavior_packs.json", "resource" to "world_resource_packs.json")) {
            val list = runCatching { JSONArray(File(dir, file).readText()) }.getOrDefault(JSONArray())
            for (i in 0 until list.length()) {
                val entry = list.optJSONObject(i) ?: continue
                val id = entry.optString("pack_id").lowercase().ifEmpty { continue }
                val version = entry.optJSONArray("version")?.let { v -> (0 until v.length()).joinToString(".") { v.opt(it).toString() } }.orEmpty()
                out += JSONObject().put("uuid", id).put("version", version).put("kind", kind)
            }
        }
        for (sub in AutoSave.PACK_DIRS) {
            File(dir, sub).listFiles { f -> f.isDirectory }.orEmpty().forEach { pack ->
                runCatching {
                    val header = JSONObject(File(pack, "manifest.json").readText().removePrefix("﻿")).getJSONObject("header")
                    out.firstOrNull { it.getString("uuid") == header.optString("uuid").lowercase() }
                        ?.put("name", header.optString("name").replace(Regex("§."), "").take(80))
                }
            }
        }
        return JSONArray(out)
    }

    private const val CHECK_TIMEOUT_MS = 20_000L
}
