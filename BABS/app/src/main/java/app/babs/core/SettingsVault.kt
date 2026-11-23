package app.babs.core

import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Bedrock Hub's settings vault (`src/settingsvault.js`): the settings bundle as JSON, encrypted with AES-256-GCM
 * under a key made from the passphrase with scrypt (N 2^15, r 8, p 1), in a small JSON envelope. The same
 * passphrase opens it on the PC and the phone.
 */
object SettingsVault {
    const val FORMAT = "bedrock-hub-settings-vault"
    const val VERSION = 1
    private val AAD = "$FORMAT:$VERSION".toByteArray()
    private const val MAX_PLAINTEXT = 16 * 1024 * 1024

    private fun key(passphrase: String, salt: ByteArray): ByteArray {
        val phrase = passphrase.toByteArray(Charsets.UTF_8)
        if (passphrase.length < 12 || phrase.size > 1024) throw IOException("Use a passphrase between 12 and 1024 bytes.")
        return Scrypt.derive(phrase, salt, 1 shl 15, 8, 1, 32)
    }

    fun encrypt(value: JSONObject, passphrase: String): ByteArray {
        val plain = value.toString().toByteArray(Charsets.UTF_8)
        if (plain.size > MAX_PLAINTEXT) throw IOException("The settings bundle is too large to encrypt.")
        val random = SecureRandom()
        val salt = ByteArray(16).also(random::nextBytes)
        val iv = ByteArray(12).also(random::nextBytes)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key(passphrase, salt), "AES"), GCMParameterSpec(128, iv))
        cipher.updateAAD(AAD)
        val sealed = cipher.doFinal(plain)
        // Java puts the tag after the data; the envelope keeps them apart, as Node gives them
        val data = sealed.copyOfRange(0, sealed.size - 16)
        val tag = sealed.copyOfRange(sealed.size - 16, sealed.size)
        return JSONObject()
            .put("format", FORMAT).put("version", VERSION)
            .put("salt", b64(salt)).put("iv", b64(iv)).put("tag", b64(tag)).put("data", b64(data))
            .toString().toByteArray(Charsets.UTF_8)
    }

    fun decrypt(raw: ByteArray, passphrase: String): JSONObject {
        val envelope = runCatching { JSONObject(raw.toString(Charsets.UTF_8)) }
            .getOrElse { throw IOException("The settings repo does not contain a valid encrypted bundle.") }
        if (envelope.optString("format") != FORMAT || envelope.optInt("version") != VERSION || envelope.optString("data").length > MAX_PLAINTEXT * 2) {
            throw IOException("The settings repo contains an unsupported or invalid bundle.")
        }
        val salt = unb64(envelope.optString("salt"), 16, "salt")
        val iv = unb64(envelope.optString("iv"), 12, "nonce")
        val tag = unb64(envelope.optString("tag"), 16, "authentication tag")
        val data = runCatching { Base64.decode(envelope.optString("data"), Base64.NO_WRAP) }
            .getOrElse { throw IOException("The encrypted settings data is invalid.") }
        val k = key(passphrase, salt)
        return try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(k, "AES"), GCMParameterSpec(128, iv))
            cipher.updateAAD(AAD)
            JSONObject(cipher.doFinal(data + tag).toString(Charsets.UTF_8))
        } catch (e: Exception) {
            throw IOException("That passphrase is incorrect, or the encrypted settings bundle was changed.")
        }
    }

    private fun b64(bytes: ByteArray) = Base64.encodeToString(bytes, Base64.NO_WRAP)

    private fun unb64(text: String, length: Int, label: String): ByteArray {
        val bytes = runCatching { Base64.decode(text, Base64.NO_WRAP) }.getOrNull()
        if (bytes == null || bytes.size != length) throw IOException("The encrypted settings $label is invalid.")
        return bytes
    }
}

/**
 * Bedrock Hub's settings bundle (`src/settingsprofile.js`, format "bedrock-hub-settings" version 1) as BABS reads
 * and writes it. BABS fills in what a phone has (server files, the bridge's address and auto-accept, the Xbox
 * sign-in, the GitHub repos) and keeps the rest of an existing bundle (the PC's Mod Library preferences) as it was,
 * so a backup from the phone doesn't wipe what only the PC uses.
 */
object SettingsProfile {
    const val FORMAT = "bedrock-hub-settings"
    private const val MAX_FILE = 16 * 1024 * 1024
    private val SUB_SESSION = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", RegexOption.IGNORE_CASE)
    val SERVER_FILES = mapOf(
        "serverProperties" to "server.properties",
        "allowlist" to "allowlist.json",
        "whitelist" to "whitelist.json",
        "permissions" to "permissions.json",
    )

    /** What the phone has, for [build]. */
    data class Phone(
        val serverDir: File,
        val bridgeDir: File,
        val publicAddress: String,
        val autoAccept: Boolean,
        val gamertag: String,
        val gamerpic: String,
        val cloud: JSONObject,
        val login: String,
        val token: String,
        val includeXbox: Boolean,
    )

    private fun record(file: File): JSONObject {
        if (!file.isFile) return JSONObject().put("present", false)
        if (file.length() > MAX_FILE) throw IOException("${file.name} is too large to include in the settings bundle.")
        return JSONObject().put("present", true).put("data", Base64.encodeToString(file.readBytes(), Base64.NO_WRAP))
    }

    fun decode(record: JSONObject?, label: String): ByteArray? {
        if (record == null || !record.has("present")) throw IOException("The settings bundle has an invalid $label entry.")
        if (!record.optBoolean("present")) return null
        val data = runCatching { Base64.decode(record.getString("data"), Base64.NO_WRAP) }.getOrNull()
        if (data == null || data.size > MAX_FILE) throw IOException("The settings bundle has invalid $label data.")
        return data
    }

    /** A new bundle from the phone, on top of [existing] (the one in the repo, or null). */
    fun build(phone: Phone, existing: JSONObject?): JSONObject {
        val out = existing?.let { JSONObject(it.toString()) } ?: JSONObject()
        out.put("format", FORMAT).put("version", 1).put("createdAt", System.currentTimeMillis())
        // The PC's Mod Library preferences: BABS has none, so they stay as the PC left them
        if (out.optJSONObject("mods") == null) out.put("mods", JSONObject())
        val cloud = out.optJSONObject("cloud") ?: JSONObject()
        for (key in phone.cloud.keys()) {
            val value = phone.cloud.get(key)
            // An empty repo on the phone doesn't unlink the PC's
            if (value is String && value.isEmpty() && cloud.optString(key).isNotEmpty()) continue
            cloud.put(key, value)
        }
        out.put("cloud", cloud)
        out.put("env", JSONObject().put("MC_HOST", phone.publicAddress.replace(Regex("[\\r\\n]"), "")).put("HMBC_AUTO_FRIEND", phone.autoAccept.toString()))
        val account = out.optJSONObject("account") ?: JSONObject()
        if (phone.gamertag.isNotEmpty()) {
            account.put("gamertag", phone.gamertag)
            if (phone.gamerpic.isNotEmpty()) account.put("pictureUrl", phone.gamerpic)
        }
        out.put("account", account)
        val files = JSONObject()
        for ((key, name) in SERVER_FILES) files.put(key, record(File(phone.serverDir, name)))
        out.put("files", files)
        out.put("github", if (phone.token.isNotEmpty()) JSONObject().put("login", phone.login).put("token", phone.token) else JSONObject.NULL)
        if (phone.includeXbox) out.put("xbox", xbox(File(phone.bridgeDir, "cache")))
        else if (!out.has("xbox")) out.put("xbox", JSONObject.NULL)
        return out
    }

    private fun xbox(cacheDir: File): JSONObject {
        val listFile = File(cacheDir, "sub_sessions.json")
        val ids = if (listFile.isFile) {
            val list = runCatching { JSONArray(listFile.readText()) }.getOrElse { throw IOException("Couldn't read the bridge sub-session list: ${it.message}") }
            (0 until list.length()).map { list.optString(it) }.also { found ->
                if (!found.all { SUB_SESSION.matches(it) }) throw IOException("The bridge sub-session list contains an invalid ID.")
            }
        } else emptyList()
        val caches = JSONObject()
        for (id in ids) caches.put(id, record(File(cacheDir, "$id/cache.json")))
        return JSONObject()
            .put("cache", record(File(cacheDir, "cache.json")))
            .put("subSessions", JSONArray(ids))
            .put("subSessionsFile", record(listFile))
            .put("subSessionCaches", caches)
    }

    /** Throws when the bundle isn't one BABS can apply safely. */
    fun check(value: JSONObject): JSONObject {
        if (value.optString("format") != FORMAT || value.optInt("version") != 1 || value.optJSONObject("files") == null ||
            value.optJSONObject("cloud") == null || value.optJSONObject("env") == null
        ) throw IOException("The decrypted settings bundle has an unsupported or invalid format.")
        val env = value.getJSONObject("env")
        if (env.optString("MC_HOST").contains('\n') || env.optString("HMBC_AUTO_FRIEND", "true") !in setOf("true", "false")) {
            throw IOException("The decrypted bridge settings are invalid.")
        }
        for (key in SERVER_FILES.keys) decode(value.getJSONObject("files").optJSONObject(key), key)
        value.optJSONObject("xbox")?.let { x ->
            val ids = x.optJSONArray("subSessions") ?: throw IOException("The decrypted Xbox session data is invalid.")
            for (i in 0 until ids.length()) {
                val id = ids.optString(i)
                if (!SUB_SESSION.matches(id)) throw IOException("The decrypted Xbox session data is invalid.")
                decode(x.optJSONObject("subSessionCaches")?.optJSONObject(id), "Xbox sub-session auth cache")
            }
            decode(x.optJSONObject("cache"), "Xbox auth cache")
        }
        return value
    }

    /**
     * Writes the bundle's server files and Xbox sign-in, keeping what it replaces in a safety folder first, and
     * puts everything back if a write fails. The rest (bridge address, account, repos) is applied by the caller.
     * Returns the safety folder.
     */
    fun applyFiles(profile: JSONObject, serverDir: File, bridgeDir: File, safetyRoot: File): File {
        check(profile)
        val writes = mutableListOf<Pair<File, ByteArray?>>()
        val files = profile.getJSONObject("files")
        for ((key, name) in SERVER_FILES) writes += File(serverDir, name) to decode(files.optJSONObject(key), key)
        val xbox = profile.optJSONObject("xbox")
        val cacheDir = File(bridgeDir, "cache")
        if (xbox != null) {
            writes += File(cacheDir, "cache.json") to decode(xbox.optJSONObject("cache"), "Xbox auth cache")
            writes += File(cacheDir, "sub_sessions.json") to decode(xbox.optJSONObject("subSessionsFile"), "Xbox sub-session list")
            val incoming = xbox.getJSONArray("subSessions").let { ids -> (0 until ids.length()).map { ids.getString(it) }.toSet() }
            cacheDir.listFiles { f -> f.isDirectory && SUB_SESSION.matches(f.name) && f.name !in incoming }.orEmpty()
                .forEach { writes += File(it, "cache.json") to null }
            for (id in incoming) writes += File(cacheDir, "$id/cache.json") to decode(xbox.getJSONObject("subSessionCaches").optJSONObject(id), "Xbox sub-session auth cache")
        }

        val safety = File(safetyRoot, "settings-safety-${System.currentTimeMillis()}").apply { mkdirs() }
        val saved = mutableMapOf<File, File>()
        writes.forEachIndexed { i, (file, _) ->
            if (file.isFile) saved[file] = File(safety, "$i-${file.name}.bak").also { file.copyTo(it, overwrite = true) }
        }
        try {
            for ((file, data) in writes) {
                if (data == null) {
                    if (file.exists() && !file.delete()) throw IOException("couldn't remove ${file.name}")
                } else {
                    file.parentFile?.mkdirs()
                    val tmp = File(file.path + ".babstmp")
                    tmp.writeBytes(data)
                    if (!tmp.renameTo(file)) {
                        file.writeBytes(data)
                        tmp.delete()
                    }
                }
            }
        } catch (e: Exception) {
            for ((file, _) in writes) {
                runCatching { saved[file]?.copyTo(file, overwrite = true) ?: file.delete() }
            }
            throw IOException("Couldn't apply the settings bundle: ${e.message}. The phone's files were put back.")
        }
        return safety
    }
}
