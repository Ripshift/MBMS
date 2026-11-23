package app.babs.core

import android.content.Context
import androidx.core.content.edit

/** Small settings kept between runs. */
class Prefs(context: Context) {
    private val prefs = context.getSharedPreferences("babs", Context.MODE_PRIVATE)

    /** The user agreed to the Minecraft EULA and Privacy Policy before the server was downloaded. */
    var eulaAccepted: Boolean
        get() = prefs.getBoolean(KEY_EULA, false)
        set(value) = prefs.edit { putBoolean(KEY_EULA, value) }

    /** The address players outside this network reach the server on, given to the bridge. Empty for none. */
    var publicAddress: String
        get() = prefs.getString(KEY_PUBLIC_ADDRESS, "") ?: ""
        set(value) = prefs.edit { putString(KEY_PUBLIC_ADDRESS, value.trim()) }

    /**
     * Whether the bridge accepts friend requests by itself. HMBC forgets a change when it restarts,
     * so BABS keeps it and passes it in at every start.
     */
    var autoAcceptFriends: Boolean
        get() = prefs.getBoolean(KEY_AUTO_ACCEPT, true)
        set(value) = prefs.edit { putBoolean(KEY_AUTO_ACCEPT, value) }

    /** Add people to the server's allow list when their friend request is accepted from BABS. */
    var allowAcceptedFriends: Boolean
        get() = prefs.getBoolean(KEY_ALLOW_FRIENDS, true)
        set(value) = prefs.edit { putBoolean(KEY_ALLOW_FRIENDS, value) }

    /** Start the server again when it stops without being asked, such as when Android kills it for memory. */
    var autoRestart: Boolean
        get() = prefs.getBoolean(KEY_AUTO_RESTART, true)
        set(value) = prefs.edit { putBoolean(KEY_AUTO_RESTART, value) }

    /** AutoSave: copy the world before and after each session, into backups/AutoSave, as Bedrock Hub does. */
    var autoSave: Boolean
        get() = prefs.getBoolean(KEY_AUTOSAVE, true)
        set(value) = prefs.edit { putBoolean(KEY_AUTOSAVE, value) }

    /** The bridge account last seen signed in, and its picture's address, shown while the bridge is off. */
    var lastGamertag: String
        get() = prefs.getString(KEY_GAMERTAG, "") ?: ""
        set(value) = prefs.edit { putString(KEY_GAMERTAG, value) }

    var lastGamerpic: String
        get() = prefs.getString(KEY_GAMERPIC, "") ?: ""
        set(value) = prefs.edit { putString(KEY_GAMERPIC, value) }

    /** The Minecraft menu theme, switched by tapping the grass block. */
    var minecraftTheme: Boolean
        get() = prefs.getBoolean(KEY_MINECRAFT_THEME, false)
        set(value) = prefs.edit { putBoolean(KEY_MINECRAFT_THEME, value) }

    private companion object {
        const val KEY_AUTOSAVE = "autosave"
        const val KEY_MINECRAFT_THEME = "minecraft_theme"
        const val KEY_GAMERTAG = "last_gamertag"
        const val KEY_GAMERPIC = "last_gamerpic"
        const val KEY_AUTO_RESTART = "auto_restart"
        const val KEY_EULA = "eula_accepted"
        const val KEY_PUBLIC_ADDRESS = "public_address"
        const val KEY_AUTO_ACCEPT = "auto_accept_friends"
        const val KEY_ALLOW_FRIENDS = "allow_accepted_friends"
    }
}
