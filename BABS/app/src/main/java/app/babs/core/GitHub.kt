package app.babs.core

import android.util.Base64
import app.babs.BuildConfig
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.security.MessageDigest

/** A problem worth showing as it is, such as GitHub turning a sign-in down. */
class GitHubException(message: String, val status: Int = 0) : IOException(message)

/** A linked repo, as Bedrock Hub's checkRepo returns it. */
data class GitHubRepo(val fullName: String, val private: Boolean, val url: String)

/** The person signed in, from GitHub's /user. */
data class GitHubUser(val login: String, val name: String)

/** A device sign-in under way: the code to enter at [url]. */
data class DeviceSignIn(val deviceCode: String, val code: String, val url: String, val every: Int, val expiresAt: Long)

/**
 * Talking to GitHub, ported from Bedrock Hub's `src/github.js`: signing in, and finding or making the repo that
 * holds the cloud saves. Bedrock Hub moves files with git itself (isomorphic-git); BABS uses GitHub's Git Data API
 * (blobs, trees, commits and refs) for the same commits, so it needs no git on the phone.
 */
object GitHub {
    private const val WEB = "https://github.com"
    private const val API = "https://api.github.com"
    val REPO_NAME = Regex("^[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}$")

    /**
     * Sign in with GitHub needs an OAuth app with device flow turned on. Its client ID isn't a secret. Set it with
     * the Gradle property babsGithubClientId; until then people sign in with a token.
     */
    val clientId: String get() = BuildConfig.GITHUB_CLIENT_ID

    class Response(val status: Int, val body: String) {
        val ok get() = status in 200..299
        fun json(): JSONObject = runCatching { JSONObject(body) }.getOrDefault(JSONObject())
        fun array(): JSONArray = runCatching { JSONArray(body) }.getOrDefault(JSONArray())
    }

    /** One call. [path] is an API path such as /user, or a full https://github.com address. */
    fun call(
        path: String,
        token: String? = null,
        method: String = "GET",
        body: JSONObject? = null,
        form: Map<String, String>? = null,
        accept: String = "application/vnd.github+json",
    ): Response {
        val connection = open(path, token, method, accept)
        try {
            val payload = when {
                form != null -> {
                    connection.setRequestProperty("Content-Type", "application/x-www-form-urlencoded")
                    form.entries.joinToString("&") { "${enc(it.key)}=${enc(it.value)}" }
                }
                body != null -> {
                    connection.setRequestProperty("Content-Type", "application/json")
                    body.toString()
                }
                else -> null
            }
            if (payload != null) {
                connection.doOutput = true
                connection.outputStream.use { it.write(payload.toByteArray(Charsets.UTF_8)) }
            }
            return read(connection)
        } catch (e: GitHubException) {
            throw e
        } catch (e: RateLimited) {
            throw e
        } catch (e: IOException) {
            throw GitHubException("Couldn't reach GitHub: ${e.message ?: e.javaClass.simpleName}")
        } finally {
            connection.disconnect()
        }
    }

    internal fun open(path: String, token: String?, method: String, accept: String): HttpURLConnection {
        val url = URL(if (path.startsWith("https://")) path else API + path)
        require(url.host == "api.github.com" || url.host == "github.com") { "Not a GitHub address" }
        return (url.openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 20_000
            readTimeout = 120_000
            instanceFollowRedirects = false
            setRequestProperty("Accept", accept)
            setRequestProperty("User-Agent", "BABS")
            setRequestProperty("X-GitHub-Api-Version", "2022-11-28")
            if (!token.isNullOrEmpty()) setRequestProperty("Authorization", "Bearer $token")
        }
    }

    internal fun read(connection: HttpURLConnection): Response {
        val status = connection.responseCode
        val stream = if (status >= 400) connection.errorStream else connection.inputStream
        val text = stream?.use { it.readBytes().toString(Charsets.UTF_8) }.orEmpty()
        if (status == 403 || status == 429) {
            val retry = connection.getHeaderField("Retry-After")?.toLongOrNull()
            val remaining = connection.getHeaderField("X-RateLimit-Remaining")
            if (retry != null || remaining == "0" || text.contains("rate limit", ignoreCase = true)) {
                throw RateLimited(retry ?: 60)
            }
        }
        return Response(status, text)
    }

    /** GitHub asked to slow down, for about [seconds]. */
    class RateLimited(val seconds: Long) : IOException("GitHub asked to slow down")

    private fun enc(text: String) = URLEncoder.encode(text, "UTF-8")

    // ---------------------------------------------------------------- signing in

    /** Device flow: show the person a code, they enter it on github.com, and [waitForDeviceSignIn] waits for it. */
    fun startDeviceSignIn(): DeviceSignIn {
        if (clientId.isEmpty()) throw GitHubException("Sign in with GitHub isn't set up in this build. Use a token instead.")
        val answer = call("$WEB/login/device/code", method = "POST", form = mapOf("client_id" to clientId, "scope" to "repo"), accept = "application/json")
        val d = answer.json()
        if (!answer.ok || d.optString("device_code").isEmpty()) {
            throw GitHubException("GitHub didn't give a sign-in code" + d.optString("error_description").let { if (it.isEmpty()) "." else ": $it" })
        }
        return DeviceSignIn(
            deviceCode = d.getString("device_code"),
            code = d.optString("user_code"),
            url = d.optString("verification_uri", "$WEB/login/device"),
            every = maxOf(5, d.optInt("interval", 5)),
            expiresAt = System.currentTimeMillis() + d.optInt("expires_in", 900) * 1000L,
        )
    }

    /** Waits for the person to enter the code, and returns the token. Blocking. */
    fun waitForDeviceSignIn(started: DeviceSignIn, cancelled: () -> Boolean): String {
        var every = started.every
        while (System.currentTimeMillis() < started.expiresAt) {
            Thread.sleep(every * 1000L)
            if (cancelled()) throw GitHubException("Sign-in was cancelled.")
            val d = call(
                "$WEB/login/oauth/access_token", method = "POST", accept = "application/json",
                form = mapOf("client_id" to clientId, "device_code" to started.deviceCode, "grant_type" to "urn:ietf:params:oauth:grant-type:device_code"),
            ).json()
            d.optString("access_token").takeIf { it.isNotEmpty() }?.let { return it }
            when (val error = d.optString("error")) {
                "slow_down" -> every += 5
                "authorization_pending", "" -> Unit
                "access_denied" -> throw GitHubException("Sign-in was turned down on GitHub.")
                "expired_token" -> throw GitHubException("The code ran out. Start again.")
                else -> throw GitHubException("GitHub said: ${d.optString("error_description").ifEmpty { error }}")
            }
        }
        throw GitHubException("The code ran out. Start again.")
    }

    fun whoAmI(token: String): GitHubUser {
        val answer = call("/user", token)
        if (answer.status == 401) throw GitHubException("GitHub didn't accept that sign-in. It may have expired or been revoked.", 401)
        val d = answer.json()
        if (!answer.ok || d.optString("login").isEmpty()) throw GitHubException("GitHub couldn't say who is signed in (${answer.status}).")
        return GitHubUser(d.getString("login"), d.optString("name"))
    }

    /** The repo has to exist and this account has to be able to push to it. */
    fun checkRepo(token: String, fullName: String): GitHubRepo {
        if (!REPO_NAME.matches(fullName)) throw GitHubException("Enter the repo as owner/name, for example steve/bedrock-worlds.")
        val answer = call("/repos/$fullName", token)
        if (answer.status == 404) {
            throw GitHubException(
                "$fullName wasn't found, or this sign-in can't see it. If it's a private repo and you signed in with a token, " +
                    "edit the token on GitHub: under Repository access choose Only select repositories and pick this repo, " +
                    "then set Contents to Read and write.",
            )
        }
        if (!answer.ok) throw GitHubException("GitHub couldn't open $fullName (${answer.status}).")
        val d = answer.json()
        val permissions = d.optJSONObject("permissions")
        if (permissions != null && !permissions.optBoolean("push")) throw GitHubException("This account can see $fullName but can't save to it.")
        return GitHubRepo(d.optString("full_name", fullName), d.optBoolean("private"), d.optString("html_url", "$WEB/$fullName"))
    }

    fun createRepo(token: String, name: String): GitHubRepo {
        if (!Regex("^[A-Za-z0-9._-]{1,100}$").matches(name)) throw GitHubException("A repo name can use letters, numbers, dots, dashes and underscores.")
        val body = JSONObject().put("name", name).put("private", true).put("auto_init", false)
            .put("description", "Minecraft Bedrock worlds saved by Bedrock Hub")
        val answer = call("/user/repos", token, "POST", body)
        if (answer.status == 422) throw GitHubException("You already have a repo called $name. Link it instead, or choose another name.")
        if (answer.status == 403 || answer.status == 404) {
            throw GitHubException("This sign-in isn't allowed to create repos. Create a private repo on github.com, then link it here.")
        }
        if (!answer.ok) throw GitHubException("GitHub couldn't create the repo (${answer.status}).")
        return checkRepo(token, answer.json().getString("full_name"))
    }

    // ---------------------------------------------------------------- git objects

    /** Git's id for a file's content, so unchanged files aren't sent again. */
    fun blobSha(file: File): String {
        val digest = MessageDigest.getInstance("SHA-1")
        digest.update("blob ${file.length()}\u0000".toByteArray(Charsets.US_ASCII))
        file.inputStream().use { input ->
            val buffer = ByteArray(256 * 1024)
            while (true) {
                val n = input.read(buffer)
                if (n < 0) break
                digest.update(buffer, 0, n)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    /**
     * Sends a file as a blob, written straight to the connection as base64 so a big world file never sits in
     * memory twice. Returns its id.
     */
    fun uploadBlob(token: String, repo: String, file: File): String {
        val connection = open("/repos/$repo/git/blobs", token, "POST", "application/vnd.github+json")
        try {
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/json")
            connection.setChunkedStreamingMode(64 * 1024)
            connection.outputStream.use { out ->
                out.write("{\"encoding\":\"base64\",\"content\":\"".toByteArray())
                file.inputStream().use { writeBase64(it, out) }
                out.write("\"}".toByteArray())
            }
            val answer = read(connection)
            if (!answer.ok) throw GitHubException("GitHub didn't take ${file.name} (${answer.status}): ${message(answer)}", answer.status)
            return answer.json().getString("sha")
        } catch (e: GitHubException) {
            throw e
        } catch (e: RateLimited) {
            throw e
        } catch (e: IOException) {
            throw GitHubException("Couldn't send ${file.name}: ${e.message ?: e.javaClass.simpleName}")
        } finally {
            connection.disconnect()
        }
    }

    private fun writeBase64(input: InputStream, out: OutputStream) {
        val buffer = ByteArray(3 * 64 * 1024) // a multiple of 3, so the pieces join without padding in between
        while (true) {
            var filled = 0
            while (filled < buffer.size) {
                val n = input.read(buffer, filled, buffer.size - filled)
                if (n < 0) break
                filled += n
            }
            if (filled == 0) break
            out.write(Base64.encode(buffer, 0, filled, Base64.NO_WRAP))
            if (filled < buffer.size) break
        }
    }

    /** Saves a blob's bytes to [target], raw rather than as base64 JSON. */
    fun downloadBlob(token: String, repo: String, sha: String, target: File) {
        val connection = open("/repos/$repo/git/blobs/$sha", token, "GET", "application/vnd.github.raw+json")
        try {
            val status = connection.responseCode
            if (status !in 200..299) {
                read(connection)
                throw GitHubException("GitHub couldn't send ${target.name} ($status)", status)
            }
            connection.inputStream.use { input -> target.outputStream().use { input.copyTo(it, 256 * 1024) } }
        } catch (e: GitHubException) {
            throw e
        } catch (e: RateLimited) {
            throw e
        } catch (e: IOException) {
            throw GitHubException("Couldn't download ${target.name}: ${e.message ?: e.javaClass.simpleName}")
        } finally {
            connection.disconnect()
        }
    }

    fun message(answer: Response) = answer.json().optString("message").ifEmpty { answer.body.take(200) }
}
