package app.babs.core

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/** What HMBC's /health endpoint reports, reduced to what BABS shows. */
data class BridgeHealth(
    /** STARTING, RUNNING, RESTARTING or RETRYING. */
    val state: String,
    /** Running and updated recently. */
    val healthy: Boolean,
    val signInUrl: String? = null,
    val signInCode: String? = null,
    val gamertag: String? = null,
    /** The account's Xbox profile picture, an https address on Xbox's image servers. */
    val gamerpic: String? = null,
    /** Whether the bridge's last ping reached the server, or null before the first one. */
    val serverReachable: Boolean? = null,
    val sessionHidden: Boolean = false,
) {
    companion object {
        fun parse(body: String): BridgeHealth? = runCatching {
            val json = JSONObject(body)
            val auth = json.optJSONObject("auth")
            val waiting = auth?.optString("state") == "WAITING_FOR_SIGN_IN"
            BridgeHealth(
                state = json.optString("state", "STARTING"),
                healthy = json.optBoolean("healthy", false),
                signInUrl = if (waiting) auth.optString("verificationUri").takeIf { it.startsWith("https://") } else null,
                signInCode = if (waiting) auth.optString("userCode").takeIf { it.matches(Regex("[A-Za-z0-9-]{4,16}")) } else null,
                gamertag = auth?.optString("gamertag")?.take(40)?.ifEmpty { null },
                gamerpic = auth?.optString("gamerpic")?.takeIf(::isAllowedImageUrl),
                serverReachable = if (json.has("serverReachable")) json.optBoolean("serverReachable") else null,
                sessionHidden = json.optBoolean("sessionHidden", false),
            )
        }.getOrNull()
    }
}

private val IMAGE_HOSTS = Regex("(^|\\.)(xboxlive\\.com|microsoft\\.com|s-microsoft\\.com|xbox\\.com)$", RegexOption.IGNORE_CASE)

/**
 * As Bedrock Hub's profile.js: only https images from Microsoft and Xbox hosts, so a bad value can't make BABS
 * fetch from anywhere else.
 */
fun isAllowedImageUrl(raw: String): Boolean = runCatching {
    val u = java.net.URI(raw)
    u.scheme == "https" && u.userInfo == null && IMAGE_HOSTS.containsMatchIn(u.host ?: "")
}.getOrDefault(false)

/** Downloads a gamerpic as Bedrock Hub does: no redirects, PNG, JPEG or WebP only, up to 1 MB. Null on any problem. */
fun fetchGamerpic(url: String): ByteArray? = runCatching {
    if (!isAllowedImageUrl(url)) return null
    val conn = (URL(url).openConnection() as HttpURLConnection).apply {
        connectTimeout = 6000
        readTimeout = 6000
        instanceFollowRedirects = false
    }
    try {
        if (conn.responseCode != 200) return null
        val type = conn.contentType.orEmpty().substringBefore(';').trim().lowercase()
        if (type !in setOf("image/png", "image/jpeg", "image/webp")) return null
        val bytes = conn.inputStream.use { input ->
            val out = java.io.ByteArrayOutputStream()
            val buffer = ByteArray(16 * 1024)
            while (true) {
                val n = input.read(buffer)
                if (n < 0) break
                out.write(buffer, 0, n)
                if (out.size() > 1024 * 1024) return null
            }
            out.toByteArray()
        }
        bytes.takeIf { it.isNotEmpty() }
    } finally {
        conn.disconnect()
    }
}.getOrNull()

/** Someone who sent the bridge account a friend request. */
data class FriendRequest(val xuid: String, val gamertag: String)

/** HMBC's friend request state: whether it accepts them by itself, and the ones waiting. */
data class Friends(val autoAccept: Boolean, val requests: List<FriendRequest>) {
    companion object {
        fun parse(body: String): Friends? = runCatching {
            val json = JSONObject(body)
            val list = json.optJSONArray("requests")
            Friends(
                autoAccept = json.optBoolean("autoAccept", true),
                requests = (0 until (list?.length() ?: 0)).mapNotNull { i ->
                    val item = list!!.optJSONObject(i) ?: return@mapNotNull null
                    val xuid = item.optString("xuid").takeIf { it.matches(Regex("\\d{1,20}")) } ?: return@mapNotNull null
                    FriendRequest(xuid, item.optString("gamertag").take(40).ifEmpty { xuid })
                },
            )
        }.getOrNull()
    }
}

/** Talks to the bridge on localhost, the same way Bedrock Hub does. Blocking, so call from Dispatchers.IO. */
object BridgeApi {
    private const val BASE = "http://127.0.0.1:$BRIDGE_HEALTH_PORT"

    /** The friend requests HMBC last saw. With [refresh] it asks Xbox Live first, which takes a few seconds. */
    fun friends(refresh: Boolean = false): Friends? = runCatching {
        val conn = (URL("$BASE/friends${if (refresh) "?refresh=1" else ""}").openConnection() as HttpURLConnection).apply {
            connectTimeout = 1500
            readTimeout = if (refresh) 15_000 else 3000
        }
        try {
            if (conn.responseCode != 200) null else conn.inputStream.bufferedReader().use { Friends.parse(it.readText()) }
        } finally {
            conn.disconnect()
        }
    }.getOrNull()

    fun approve(xuid: String): Boolean = post("/friends/approve?xuid=$xuid")
    fun deny(xuid: String): Boolean = post("/friends/deny?xuid=$xuid")
    fun setAutoAccept(enabled: Boolean): Boolean = post("/friends/auto?enabled=$enabled")

    private fun post(path: String): Boolean = runCatching {
        val conn = (URL(BASE + path).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = 1500
            readTimeout = 15_000
            setRequestProperty("X-HMBC", "1")
        }
        try {
            conn.responseCode == 200
        } finally {
            conn.disconnect()
        }
    }.getOrDefault(false)

    /** The bridge's status, or null if it isn't answering yet. 503 still carries the body (e.g. the sign-in code). */
    fun health(): BridgeHealth? = runCatching {
        val conn = (URL("$BASE/health").openConnection() as HttpURLConnection).apply {
            connectTimeout = 1500
            readTimeout = 1500
        }
        try {
            val stream = if (conn.responseCode >= 400) conn.errorStream else conn.inputStream
            stream?.bufferedReader()?.use { it.readText() }?.let(BridgeHealth::parse)
        } finally {
            conn.disconnect()
        }
    }.getOrNull()

    /**
     * Hides the session from friends while the server is down, or shows it again. The account stays signed in.
     * Changes need the X-HMBC header, which a web page can't send.
     */
    fun setSessionHidden(hidden: Boolean): Boolean = runCatching {
        val conn = (URL("$BASE/session?hidden=$hidden").openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = 1500
            readTimeout = 8000
            setRequestProperty("X-HMBC", "1")
        }
        try {
            conn.responseCode == 200
        } finally {
            conn.disconnect()
        }
    }.getOrDefault(false)
}
