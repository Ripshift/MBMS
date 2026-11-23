package app.babs.core

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.net.HttpURLConnection
import java.net.URL

/** The address the internet sees this phone's network as, and anything that stops friends reaching it there. */
data class FoundAddress(val address: String?, val warning: String?)

/**
 * Finds the public IPv4 address by asking a service that echoes it back. Only the request itself is sent, nothing
 * about the phone. ipify first, icanhazip if it doesn't answer.
 */
object PublicAddress {
    private val SERVICES = listOf("https://api.ipify.org", "https://ipv4.icanhazip.com")

    suspend fun find(context: Context): FoundAddress = withContext(Dispatchers.IO) {
        val found = SERVICES.firstNotNullOfOrNull { ask(it) }
            ?: return@withContext FoundAddress(null, "Couldn't find it. Is the phone online? You can type it in instead")
        val cm = context.getSystemService(ConnectivityManager::class.java)
        val caps = cm.getNetworkCapabilities(cm.activeNetwork)
        val warning = when {
            caps?.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) == true ->
                "The phone is on mobile data, which almost never lets others connect in. Use Wi-Fi, and find it again"
            isCarrierNat(found) ->
                "This address is shared by many customers of your internet provider (carrier-grade NAT), so friends can't reach the server on it. Ask your provider for a public IPv4 address"
            else -> null
        }
        FoundAddress(found, warning)
    }

    private fun ask(url: String): String? = runCatching {
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 5000
            readTimeout = 5000
            setRequestProperty("User-Agent", "BABS")
        }
        try {
            if (conn.responseCode != 200) null
            else conn.inputStream.bufferedReader().use { it.readText().trim() }.takeIf { isIpv4(it) }
        } finally {
            conn.disconnect()
        }
    }.getOrNull()

    private fun parts(text: String) = text.split('.').takeIf { it.size == 4 }?.map { it.toIntOrNull() ?: -1 }

    private fun isIpv4(text: String) = parts(text)?.all { it in 0..255 } == true

    /** 100.64.0.0/10, which providers use when they share one public address between many customers. */
    private fun isCarrierNat(text: String): Boolean {
        val p = parts(text) ?: return false
        return p[0] == 100 && p[1] in 64..127
    }
}
