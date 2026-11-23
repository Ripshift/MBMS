package app.babs.core

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.core.content.edit
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The GitHub sign-in, kept encrypted with a key in Android's Keystore, as Bedrock Hub keeps it with Windows' own
 * protection. The key never leaves the Keystore, and the screen never sees the token.
 */
class SecretStore(context: Context) {
    private val prefs = context.getSharedPreferences("babs_secrets", Context.MODE_PRIVATE)

    var githubToken: String
        get() = runCatching { prefs.getString(KEY_TOKEN, null)?.let(::decrypt) }.getOrNull().orEmpty()
        set(value) = prefs.edit { if (value.isEmpty()) remove(KEY_TOKEN) else putString(KEY_TOKEN, encrypt(value)) }

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(
                KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build(),
            )
        }.generateKey()
    }

    private fun encrypt(text: String): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        val sealed = cipher.iv + cipher.doFinal(text.toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(sealed, Base64.NO_WRAP)
    }

    private fun decrypt(stored: String): String {
        val sealed = Base64.decode(stored, Base64.NO_WRAP)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
            init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, sealed, 0, 12))
        }
        return cipher.doFinal(sealed, 12, sealed.size - 12).toString(Charsets.UTF_8)
    }

    private companion object {
        const val ALIAS = "babs_github"
        const val KEY_TOKEN = "github_token"
    }
}
