package app.babs.core

import android.util.Base64
import app.babs.setup.Tar
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.zip.GZIPInputStream

/**
 * One GitHub repo through GitHub's Git Data API, for Bedrock Hub's Mod Library and settings repos. The world repo
 * has its own code in [Cloud].
 */
class GitRepo(private val token: String, val name: String) {
    data class Head(val commit: String, val tree: String)

    class NotFastForward : IOException("The repo changed while saving")

    fun head(): Head? {
        val ref = GitHub.call("/repos/$name/git/ref/heads/${Cloud.BRANCH}", token)
        if (ref.status == 404 || ref.status == 409) return null
        if (!ref.ok) throw GitHubException("GitHub couldn't open $name (${ref.status}): ${GitHub.message(ref)}", ref.status)
        val commit = ref.json().getJSONObject("object").getString("sha")
        return Head(commit, get("/repos/$name/git/commits/$commit").getJSONObject("tree").getString("sha"))
    }

    /** The first commit, through the Contents API, since the Git Data API can't write to an empty repo. */
    fun start(readme: String): Head {
        send(
            "/repos/$name/contents/README.md",
            JSONObject().put("message", "Start the repo\n").put("branch", Cloud.BRANCH)
                .put("content", Base64.encodeToString(readme.toByteArray(), Base64.NO_WRAP)),
            "PUT",
        )
        return head() ?: throw GitHubException("The repo is still empty after the first file")
    }

    private fun get(path: String): JSONObject {
        val answer = GitHub.call(path, token)
        if (!answer.ok) throw GitHubException("GitHub said ${answer.status}: ${GitHub.message(answer)}", answer.status)
        return answer.json()
    }

    private fun send(path: String, body: JSONObject, method: String = "POST"): JSONObject {
        val answer = GitHub.call(path, token, method, body)
        if (answer.status == 422 && path.contains("/git/refs/")) throw NotFastForward()
        if (!answer.ok) throw GitHubException("GitHub said ${answer.status}: ${GitHub.message(answer)}", answer.status)
        return answer.json()
    }

    /** A tree's entries, or every file under it with [recursive]. Null when GitHub cut a recursive list short. */
    fun tree(sha: String, recursive: Boolean = false): List<JSONObject>? {
        val t = get("/repos/$name/git/trees/$sha" + if (recursive) "?recursive=1" else "")
        if (t.optBoolean("truncated")) return null
        val list = t.optJSONArray("tree") ?: JSONArray()
        return (0 until list.length()).map { list.getJSONObject(it) }
    }

    fun entries(sha: String) = tree(sha) ?: throw GitHubException("GitHub cut a folder listing short")

    fun text(sha: String): String {
        val answer = GitHub.call("/repos/$name/git/blobs/$sha", token, accept = "application/vnd.github.raw+json")
        if (!answer.ok) throw GitHubException("GitHub said ${answer.status}", answer.status)
        return answer.body
    }

    fun createTree(entries: JSONArray, base: String? = null): String =
        send("/repos/$name/git/trees", JSONObject().put("tree", entries).apply { if (base != null) put("base_tree", base) }).getString("sha")

    fun commit(message: String, tree: String, parent: String?): String {
        val stamp = JSONObject().put("name", "BABS").put("email", "bedrock-hub@users.noreply.github.com").put("date", iso())
        return send(
            "/repos/$name/git/commits",
            JSONObject().put("message", message).put("tree", tree)
                .put("parents", if (parent != null) JSONArray().put(parent) else JSONArray()).put("author", stamp).put("committer", stamp),
        ).getString("sha")
    }

    fun moveBranch(commit: String) {
        send("/repos/$name/git/refs/heads/${Cloud.BRANCH}", JSONObject().put("sha", commit).put("force", false), "PATCH")
    }

    /** Sends a file unless GitHub has it ([have]), waiting when asked, as GitHub allows about 80 new files a minute. */
    fun blob(file: File, sha: String, have: MutableSet<String>) {
        if (sha in have) return
        var tries = 0
        while (true) {
            try {
                val sent = GitHub.uploadBlob(token, name, file)
                if (sent != sha) throw GitHubException("GitHub stored ${file.name} differently than it was sent")
                have += sha
                Thread.sleep(800)
                return
            } catch (e: GitHub.RateLimited) {
                if (++tries > 3) throw GitHubException("GitHub asked to slow down. Try again in a few minutes")
                Thread.sleep(e.seconds.coerceIn(5, 120) * 1000)
            }
        }
    }

    /**
     * Downloads main as one archive and unpacks it into [into]. Returns the repo's root inside it (GitHub puts
     * everything under one folder). One request, rather than one per file.
     */
    fun downloadAll(into: File): File {
        val first = GitHub.open("/repos/$name/tarball/${Cloud.BRANCH}", token, "GET", "application/vnd.github+json")
        val location = try {
            val status = first.responseCode
            if (status !in 300..399) {
                GitHub.read(first)
                throw GitHubException("GitHub couldn't send the repo ($status)", status)
            }
            first.getHeaderField("Location") ?: throw GitHubException("GitHub didn't say where the repo's archive is")
        } finally {
            first.disconnect()
        }
        val url = URL(location)
        if (url.protocol != "https" || !(url.host == "codeload.github.com" || url.host.endsWith(".github.com"))) {
            throw GitHubException("GitHub sent the archive from an unexpected address")
        }
        // The address carries its own short-lived permission, so the token isn't sent to it.
        val connection = (url.openConnection() as HttpURLConnection).apply {
            connectTimeout = 20_000
            readTimeout = 120_000
            setRequestProperty("User-Agent", "BABS")
        }
        try {
            if (connection.responseCode !in 200..299) throw GitHubException("GitHub couldn't send the repo (${connection.responseCode})")
            into.mkdirs()
            connection.inputStream.use { Tar.extract(GZIPInputStream(it.buffered()), into) }
        } catch (e: GitHubException) {
            throw e
        } catch (e: Exception) {
            throw GitHubException("Couldn't download the repo: ${e.message ?: e.javaClass.simpleName}")
        } finally {
            connection.disconnect()
        }
        return into.listFiles { f -> f.isDirectory }.orEmpty().singleOrNull() ?: throw GitHubException("The repo's archive wasn't laid out as expected")
    }

    private fun iso() = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }.format(Date())
}

/**
 * Bedrock Hub's Mod Library repo (`src/librarycloud.js`): `library/` is the library folder as it is, one folder per
 * pack plus library.json. With update mode Add, a pack folder that changed is kept first under
 * `versions/<uuid>/<version>-<first 8 of its old tree id>`; Replace keeps only the current one.
 */
object LibraryRepo {
    const val README = "# Bedrock Hub Mod Library\n\nBacked up by Bedrock Hub. The `library/` folder contains the current extracted pack folders and library metadata.\n\nWhen update mode is Add, replaced pack folders are kept under `versions/`. Replace mode updates the current folders without adding those snapshots.\n"

    data class Result(val sent: Int, val skipped: Int)

    fun upload(repo: GitRepo, library: File, addMode: Boolean, hashes: Cloud.Hashes, progress: (String) -> Unit): Result {
        repeat(2) { attempt ->
            try {
                return uploadOnce(repo, library, addMode, hashes, progress)
            } catch (e: GitRepo.NotFastForward) {
                if (attempt == 1) throw GitHubException("Another device kept saving to the Mod Library repo. Try again in a moment")
            }
        }
        throw IllegalStateException()
    }

    private fun uploadOnce(repo: GitRepo, library: File, addMode: Boolean, hashes: Cloud.Hashes, progress: (String) -> Unit): Result {
        val head = repo.head() ?: repo.start(README)
        val root = repo.entries(head.tree)
        val oldLibrarySha = root.firstOrNull { it.optString("path") == "library" && it.optString("type") == "tree" }?.optString("sha")
        val oldEntries = oldLibrarySha?.let { repo.entries(it) }.orEmpty()
        val have = oldLibrarySha?.let { repo.tree(it, recursive = true) }.orEmpty()
            .filter { it.optString("type") == "blob" }.map { it.getString("sha") }.toMutableSet()

        val items = library.listFiles { f -> !f.name.startsWith(".") }.orEmpty().sortedBy { it.name }
        val entries = JSONArray()
        val newTrees = mutableMapOf<String, String>()
        var skipped = 0
        var sent = 0
        items.forEachIndexed { i, item ->
            progress("Mod Library: ${item.name} (${i + 1} of ${items.size})")
            if (item.isFile) {
                if (item.length() > Cloud.MAX_FILE) { skipped++; return@forEachIndexed }
                val sha = hashes.of(item)
                if (sha !in have) sent++
                repo.blob(item, sha, have)
                entries.put(JSONObject().put("path", item.name).put("mode", "100644").put("type", "blob").put("sha", sha))
                return@forEachIndexed
            }
            val files = item.walkTopDown().filter { it.isFile }.toList()
            val packEntries = JSONArray()
            for (file in files) {
                if (file.length() > Cloud.MAX_FILE) { skipped++; continue }
                val sha = hashes.of(file)
                if (sha !in have) sent++
                repo.blob(file, sha, have)
                packEntries.put(JSONObject().put("path", file.relativeTo(item).invariantSeparatorsPath).put("mode", "100644").put("type", "blob").put("sha", sha))
            }
            if (packEntries.length() == 0) return@forEachIndexed
            val tree = repo.createTree(packEntries)
            newTrees[item.name] = tree
            entries.put(JSONObject().put("path", item.name).put("mode", "040000").put("type", "tree").put("sha", tree))
        }

        val changes = JSONArray()
        changes.put(
            JSONObject().put("path", "library").put("mode", "040000").put("type", "tree")
                .put("sha", if (entries.length() > 0) repo.createTree(entries) else JSONObject.NULL),
        )
        if (addMode && oldEntries.isNotEmpty()) {
            val versions = keepOldVersions(repo, root, oldEntries, library, newTrees)
            if (versions != null) changes.put(JSONObject().put("path", "versions").put("mode", "040000").put("type", "tree").put("sha", versions))
        }
        if (root.none { it.optString("path") == "README.md" }) {
            changes.put(JSONObject().put("path", "README.md").put("mode", "100644").put("type", "blob").put("content", README))
        }
        progress("Mod Library: saving in GitHub")
        val tree = repo.createTree(changes, base = head.tree)
        if (tree == head.tree) return Result(0, skipped)
        repo.moveBranch(repo.commit("Mod Library backup on ${AutoSave.device}\n", tree, head.commit))
        return Result(sent, skipped)
    }

    /** Add mode: old copies of packs that changed, under versions/, as Bedrock Hub keeps them. Returns the new versions tree, or null for no change. */
    private fun keepOldVersions(repo: GitRepo, root: List<JSONObject>, oldEntries: List<JSONObject>, library: File, newTrees: Map<String, String>): String? {
        val versionsSha = root.firstOrNull { it.optString("path") == "versions" && it.optString("type") == "tree" }?.optString("sha")
        val oldTrees = oldEntries.filter { it.optString("type") == "tree" }
        val oldShas = oldTrees.map { it.getString("sha") }.toSet()
        val manifests = mutableMapOf<String, JSONObject?>()
        fun manifestOf(entry: JSONObject): JSONObject? = manifests.getOrPut(entry.getString("path")) {
            runCatching {
                val m = repo.entries(entry.getString("sha")).firstOrNull { it.optString("path") == "manifest.json" } ?: return@runCatching null
                JSONObject(repo.text(m.getString("sha")).removePrefix("﻿")).optJSONObject("header")
            }.getOrNull()
        }
        val additions = JSONArray()
        for ((folder, tree) in newTrees) {
            if (tree in oldShas) continue
            val uuid = runCatching {
                JSONObject(File(library, "$folder/manifest.json").readText().removePrefix("﻿")).getJSONObject("header").optString("uuid").lowercase()
            }.getOrNull()?.ifEmpty { null } ?: continue
            // The same folder first, then any old folder with this pack's uuid
            val previous = (oldTrees.filter { it.getString("path") == folder } + oldTrees.filter { it.getString("path") != folder })
                .firstOrNull { manifestOf(it)?.optString("uuid")?.lowercase() == uuid } ?: continue
            if (previous.getString("sha") == tree) continue
            val header = manifestOf(previous)
            val version = header?.optJSONArray("version")?.let { v -> (0 until v.length()).joinToString(".") { v.opt(it).toString() } }.orEmpty()
                .replace(Regex("[^A-Za-z0-9._-]"), "_")
            val oldSha = previous.getString("sha")
            val id = uuid.replace(Regex("[^A-Za-z0-9._-]"), "_")
            val name = if (version.isNotEmpty()) "$version-${oldSha.take(8)}" else "snapshot-${oldSha.take(8)}"
            additions.put(JSONObject().put("path", "$id/$name").put("mode", "040000").put("type", "tree").put("sha", oldSha))
        }
        if (additions.length() == 0) return null
        return repo.createTree(additions, base = versionsSha)
    }

    /**
     * Replaces [library] with the repo's `library/`, keeping the one it replaces as `library-before-restore`.
     * Returns how many packs came down.
     */
    fun restore(repo: GitRepo, library: File, work: File, progress: (String) -> Unit): Int {
        repo.head() ?: throw GitHubException("The Mod Library backup repo is empty.")
        progress("Downloading the Mod Library")
        work.deleteRecursively()
        try {
            val top = repo.downloadAll(work)
            val down = File(top, "library")
            if (!down.isDirectory || down.walkTopDown().none { it.isFile }) throw GitHubException("This repo does not contain a backed-up Mod Library.")
            progress("Putting the Mod Library in place")
            val before = File(library.parentFile, "library-before-restore")
            before.deleteRecursively()
            if (library.exists() && !library.renameTo(before)) throw IOException("Couldn't move the phone's library aside")
            if (!down.renameTo(library)) {
                if (!down.copyRecursively(library, overwrite = true)) {
                    library.deleteRecursively()
                    before.renameTo(library)
                    throw IOException("Couldn't put the downloaded library in place")
                }
            }
            return library.listFiles { f -> f.isDirectory && !f.name.startsWith(".") }.orEmpty().size
        } finally {
            work.deleteRecursively()
        }
    }
}

/** Bedrock Hub's settings repo (`src/settingscloud.js`): one encrypted bundle at `bedrock-hub/settings.enc`. */
object SettingsRepo {
    const val README = "# Bedrock Hub settings\n\nThis private repository contains an encrypted Bedrock Hub settings bundle. Only Bedrock Hub can read it with the vault passphrase.\n"

    fun bundle(repo: GitRepo): ByteArray? {
        val head = repo.head() ?: return null
        val dir = repo.entries(head.tree).firstOrNull { it.optString("path") == "bedrock-hub" && it.optString("type") == "tree" } ?: return null
        val file = repo.entries(dir.getString("sha")).firstOrNull { it.optString("path") == "settings.enc" && it.optString("type") == "blob" } ?: return null
        return repo.text(file.getString("sha")).toByteArray(Charsets.UTF_8)
    }

    fun upload(repo: GitRepo, bundle: ByteArray) {
        repeat(2) { attempt ->
            try {
                val head = repo.head() ?: repo.start(README)
                val tree = repo.createTree(
                    JSONArray()
                        .put(JSONObject().put("path", "bedrock-hub/settings.enc").put("mode", "100644").put("type", "blob").put("content", bundle.toString(Charsets.UTF_8)))
                        .put(JSONObject().put("path", "README.md").put("mode", "100644").put("type", "blob").put("content", README)),
                    base = head.tree,
                )
                repo.moveBranch(repo.commit("Bedrock Hub settings backup on ${AutoSave.device}\n", tree, head.commit))
                return
            } catch (e: GitRepo.NotFastForward) {
                if (attempt == 1) throw GitHubException("Another device kept saving to the settings repo. Try again in a moment")
            }
        }
    }
}
