package app.babs.core

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.os.BatteryManager
import java.io.File
import java.net.Inet4Address

/** What the Server tab shows about the phone itself, next to Bedrock Hub's server stats. */
data class PhoneStats(
    /** Resident memory of the server and of the bridge, in bytes, each with every process it runs. */
    val serverMemory: Long = 0,
    val bridgeMemory: Long = 0,
    val batteryPercent: Int? = null,
    val charging: Boolean = false,
    /** The battery's temperature in °C, the one temperature every phone reports to apps. */
    val batteryTemp: Float? = null,
    /** The phone's address on its network, which players there connect to. */
    val lanAddress: String? = null,
    /** When the running world's level.dat was last written, which the server does when it saves. */
    val lastSaved: Long? = null,
) {
    companion object {
        /** Reads everything once. Blocking, so call from Dispatchers.IO. */
        fun read(context: Context, worldDir: File?): PhoneStats {
            val battery = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
            val level = battery?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
            val scale = battery?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
            val status = battery?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
            val processes = ownProcesses()
            return PhoneStats(
                // proot and box64 show the server's name in their command lines, and Java the jar's.
                serverMemory = processes.filter { "bedrock_server" in it.second }.sumOf { it.first },
                bridgeMemory = processes.filter { "HMBC.jar" in it.second }.sumOf { it.first },
                batteryPercent = if (level >= 0 && scale > 0) level * 100 / scale else null,
                charging = status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL,
                // Reported in tenths of a degree.
                batteryTemp = battery?.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, Int.MIN_VALUE)
                    ?.takeIf { it != Int.MIN_VALUE }?.let { it / 10f },
                lanAddress = lanAddress(context),
                lastSaved = worldDir?.let { File(it, "level.dat").lastModified() }?.takeIf { it > 0 },
            )
        }

        /**
         * Memory and command line of each of BABS's own processes. Android lets an app read /proc for its own
         * processes, which the server and bridge are, since BABS starts them.
         */
        private fun ownProcesses(): List<Pair<Long, String>> =
            File("/proc").listFiles { f -> f.name.all(Char::isDigit) }.orEmpty().mapNotNull { dir ->
                runCatching {
                    val cmdline = File(dir, "cmdline").readText().replace('\u0000', ' ')
                    val rssKb = File(dir, "status").useLines { lines ->
                        lines.firstOrNull { it.startsWith("VmRSS:") }?.split(Regex("\\s+"))?.getOrNull(1)?.toLongOrNull()
                    } ?: return@runCatching null
                    rssKb * 1024 to cmdline
                }.getOrNull()
            }

        private fun lanAddress(context: Context): String? = runCatching {
            val cm = context.getSystemService(ConnectivityManager::class.java)
            cm.getLinkProperties(cm.activeNetwork)?.linkAddresses
                ?.map { it.address }
                ?.firstOrNull { it is Inet4Address && !it.isLoopbackAddress }
                ?.hostAddress
        }.getOrNull()
    }
}
