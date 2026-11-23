package app.babs

import android.app.ActivityManager
import android.app.Application
import android.app.ApplicationExitInfo
import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build
import android.os.PowerManager
import app.babs.core.CloudSync
import app.babs.core.Hub
import app.babs.core.LogFile
import app.babs.core.Source
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class BabsApp : Application() {
    override fun onCreate() {
        super.onCreate()
        LogFile.init(this)
        CloudSync.init(this)
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.channel_name),
            NotificationManager.IMPORTANCE_LOW,
        )
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        reportLastExit()
        watchTemperature()
    }

    /**
     * Follows Android's thermal status, which every phone since Android 10 reports, and says in the console when
     * the phone gets hot. A hot phone slows itself down, which the server feels first.
     */
    private fun watchTemperature() {
        val power = getSystemService(PowerManager::class.java)
        Hub.setThermalStatus(power.currentThermalStatus)
        power.addThermalStatusListener(mainExecutor) { status ->
            val before = Hub.thermalStatus.value
            Hub.setThermalStatus(status)
            when {
                status >= PowerManager.THERMAL_STATUS_SEVERE && before < PowerManager.THERMAL_STATUS_SEVERE ->
                    Hub.log(Source.Babs, "The phone is too hot. Android is slowing it down, so the server will lag. Unplug it, take it out of its case or out of the sun, or lower View distance")
                status >= PowerManager.THERMAL_STATUS_MODERATE && before < PowerManager.THERMAL_STATUS_MODERATE ->
                    Hub.log(Source.Babs, "The phone is getting hot. Give it some air")
                status <= PowerManager.THERMAL_STATUS_LIGHT && before >= PowerManager.THERMAL_STATUS_MODERATE ->
                    Hub.log(Source.Babs, "The phone has cooled down")
            }
        }
    }

    /**
     * Says why BABS last closed, if Android closed it rather than the person, since the server and bridge
     * go with it. Each exit is reported once.
     */
    private fun reportLastExit() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return
        val exit = runCatching {
            getSystemService(ActivityManager::class.java).getHistoricalProcessExitReasons(packageName, 0, 1).firstOrNull()
        }.getOrNull() ?: return
        val prefs = getSharedPreferences("babs", MODE_PRIVATE)
        if (exit.timestamp <= prefs.getLong(KEY_LAST_EXIT, 0)) return
        prefs.edit().putLong(KEY_LAST_EXIT, exit.timestamp).apply()

        val why = when (exit.reason) {
            ApplicationExitInfo.REASON_LOW_MEMORY -> "Android ran low on memory and closed it"
            ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE -> "Android closed it for using too much CPU or memory"
            ApplicationExitInfo.REASON_SIGNALED -> "it was killed (signal ${exit.status}), usually by Android to free memory"
            ApplicationExitInfo.REASON_CRASH, ApplicationExitInfo.REASON_CRASH_NATIVE -> "it crashed"
            ApplicationExitInfo.REASON_ANR -> "it stopped responding"
            ApplicationExitInfo.REASON_FREEZER -> "Android froze it in the background"
            ApplicationExitInfo.REASON_USER_REQUESTED -> "it was force stopped or swiped away"
            ApplicationExitInfo.REASON_OTHER -> "Android closed it (${exit.description ?: "no reason given"})"
            else -> return // Closed normally, such as after Stop with the app in the background
        }
        val at = SimpleDateFormat("d MMM HH:mm", Locale.getDefault()).format(Date(exit.timestamp))
        Hub.log(Source.Babs, "BABS last closed at $at because $why. Anything running stopped with it")
    }

    companion object {
        /** Android's thermal status in a word. */
        fun thermalWord(status: Int) = when (status) {
            PowerManager.THERMAL_STATUS_NONE -> "normal"
            PowerManager.THERMAL_STATUS_LIGHT -> "warm"
            PowerManager.THERMAL_STATUS_MODERATE -> "hot"
            PowerManager.THERMAL_STATUS_SEVERE -> "too hot"
            PowerManager.THERMAL_STATUS_CRITICAL -> "critical"
            else -> "overheating"
        }

        const val CHANNEL_ID = "server"
        private const val KEY_LAST_EXIT = "last_exit_reported"
    }
}
