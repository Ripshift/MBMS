Mod Loader for Minecraft Bedrock
================================
Double-click "Addon Loader.bat" (needs Python 3.8+ with Tk, included in the normal python.org installer).
Four pages, left sidebar (v3.4):

MINECRAFT
  Shows the Minecraft folder in use (auto-detected; pick another with "Browse"), stat tiles (worlds, behavior /
  resource / development / skin packs), a browsable view of the folder, and every pack installed in it (you can
  remove them here). "Launch Minecraft" starts the game (Windows).

WORLDS
  Lists the worlds in the Minecraft folder with game mode, last played, version and pack counts (read from
  level.dat). Click a world to select it for editing: the Mods page then installs into that world.
  "Load world..." (top right) copies a world from another place into your Minecraft folder: pick a .mcworld / .zip
  file or a world folder. It never overwrites a world (a name clash gets "(2)"), and the new world is selected.
  Tick "Load Into Minecraft" (next to the button) to copy the world into Minecraft. Untick it to only ADD the world
  to the loader's list: a world folder is used where it is (nothing is copied), a .mcworld is unpacked into the
  loader's own "managed_worlds" folder. Such worlds appear in their own group ("Managed", marked "not in Minecraft"; both groups are always shown): use
  them for servers, world copies and backups. Mods added to a managed world are placed inside the world itself.
  "Remove from list" forgets a managed world without deleting any files.
  For the selected world you can see and reorder the packs it uses, remove packs, save the order, open its folder and back it up.

MODS  (the mod library; scanned automatically when the program starts)
  Library: every mod found in your library folders (builds AND pack source folders; BP + RP shown as one mod) plus
  the packs already in Minecraft. Search, filter, tick mods. Columns show whether a mod is installed in Minecraft,
  active in the selected world, and has problems.
  Compatibility: checks the ticked mods together with the packs already in the selected world: missing/unticked
  dependencies, duplicate UUIDs, two mods defining the same item/block/entity, both overriding the same vanilla
  file, same-path files, duplicate script components/commands, missing script file, beta script APIs (also checks
  whether the world has Beta APIs on), a pack needing a newer game than your version, invalid JSON, shared
  namespaces, a patch loaded below its base.
  Updates: compares each mod in your library with the copy installed in Minecraft. It lists mods with a higher
  version AND mods you edited without raising the version ("Edited, same version"). Select one to see exactly what
  changed: added/removed/changed files, items/entities/blocks added or removed, dependency, module and minimum-game
  version changes. "Update selected" / "Update all" overwrite the installed copy and (optional setting) bump the
  version number in worlds that already use the mod. "Ignore this update" hides one until the next version.
  Load order: separate lists for behavior and resource packs. The loader reads what each mod contains and works
  out the order itself: dependencies first; a patch / compat / "expanded" pack goes above the mod it changes; an
  extended version goes above the basic one; a mod that refers to another mod's items or entities goes above it;
  a pack that changes more of the same content goes above one that changes less. Anything it cannot decide keeps
  its current place.
    Fix problems only        moves just the packs that break a rule, nothing else.
    Sort everything          rebuilds the whole order from scratch.
    Reset                    goes back to the order stored in the world.
    Move up / down           manual changes; while you have moved things by hand, nothing is re-ordered behind your back.
  The "Why this order" box lists which packs were moved and the reason, and the conflicts that no order can fix
  (duplicate UUIDs, two mods defining the same item). Setting: "Fix load-order problems automatically".
  Buttons at the bottom:
    Install to Minecraft     copy the ticked mods into Minecraft's pack folders
    Add to "<world>"         install if needed and switch them on in the selected world, in load order
    Remove from world        the world stops using them (they stay installed)
    Uninstall from Minecraft delete the installed copies (offers to clean worlds that still list them)

LOOK AND FEEL
  - Collapsible sidebar: the « button at the top of the sidebar, or Ctrl+B, shrinks it to icons only. It remembers.
  - Notification center: the bell at the top right of every page. A red badge counts unread items. It collects
    available updates, unreadable files, compatibility errors, failed or finished installs, unexpected errors and
    (optionally) routine events. Each item has Open (jumps to the right place) and Dismiss; "Mark all read" and
    "Clear all" are at the top. Click outside or press Esc to close. Notifications are kept between sessions.
  - Accent colours: Settings > Appearance has eight colours plus "Custom colour...". They apply immediately.

LIBRARY EXTRAS (ideas borrowed from Vortex and Hydra)
  - Pack icons: every mod shows its pack_icon.png in the list and in the details panel (a coloured square when it
    has none).
  - Favorites (the star column or the Favorite button), tags and notes per mod. Search also looks in tags and notes.
    Filter "Favorites"; sort by Name, Favorites first, Recently changed or Status.
  - Select menu: tick everything / new + updates / favorites / mods used by the selected world / installed mods.
  - Profiles: save the ticked mods under a name (for example "Server", "Survival"), apply later, delete, export to
    a .modprofile.json file and import it on another PC; mods missing from the library are listed.
  - Play Minecraft button in the sidebar (Windows) with last-launched time.
  - Overview tiles on the Minecraft page: mods in library, updates, favorites, unnamed packs, unreadable files
    (click one to jump there).
  - Worlds: "Restore original" puts a world's pack lists back to how they were before this program first edited them.

UNNAMED PACKS
  Packs with no real name (missing, "Behavior Pack", or a text key that cannot be found) show as "? name [namespace]".
  Double-click a mod (or "Pack info", or right-click > Pack info) to see its icon, UUID, author, namespaces,
  items/entities it defines, names it shows in game, files, scripts, dependencies, where it is installed, which worlds
  use it, and what needs it. Buttons search the web for its UUID or name. "Set my own label" gives it a name that is
  used everywhere (Settings > Manage labels). The filter "Unnamed packs" lists them. Pack info also opens from the
  Minecraft page (installed packs) and by double-clicking a pack in a world's list.

RIGHT-CLICK MENU (Mods > Library)
  Pack info, own label, tick, install/add to world/remove from world/uninstall ONLY this mod, update, ignore update,
  copy UUID, open source folder.

SAFETY AND ERRORS
  - Before installing or updating, a preview shows exactly what will be installed, updated, reinstalled or skipped,
    plus checks for write access, free disk space, missing source files and over-long paths (Settings can turn the
    preview off; errors still stop it).
  - When something fails, a dialog lists each failure in plain language with what to try, and "Try again" repeats only
    the failed packs. Other packs are never affected by one failure.
  - Files that could not be read during a scan show as a warning chip on the Mods page with a list and "Open its
    location".
  - Unexpected errors show a dialog with copyable details instead of failing silently. Everything is also written to
    addon_loader.log (Activity > Open log file).
  - World pack lists and the settings file are written to a temp file and swapped in, so a crash or full disk cannot
    leave a half-written file. A damaged settings file is kept as addon_loader_config.damaged-<time>.json.

SETTINGS (saved automatically)
  Minecraft folder, library folders, scan on startup, folders to skip, install as normal/development packs,
  shared pack vs copy pack into the world, reinstall same versions, launch after install, backups (pack lists and
  whole world + backup folder), Minecraft/server version, auto check, auto order, which pack wins a conflict,
  confirm on errors, warn when Minecraft is running, preview before installing, look for changed mods, update world
  versions when updating, log file, labels and ignored updates, reset.

Notes
- Packs are unzipped straight into the game folders, so Minecraft never has to be opened or closed between packs.
- ASSUMPTION: the LAST pack in a world's pack list wins conflicts. If the game does the opposite, turn off
  "The last pack in a world's list wins conflicts" in Settings.
- Same or newer versions are skipped unless "reinstall" is on, so bump manifest versions when you rebuild a mod.
- Editing a world saves world_*_packs.json.bak_addonloader once per file.
- Command line: python addon_loader.py --cli --help

Adding mods to a world: with the setting "Always copy the packs into the world's own folders" (on by default) the
files are always written into the world's behavior_packs / resource_packs folders, even if the pack is already
installed in Minecraft. Turn it off to let worlds use the shared Minecraft copy (see "Adding a mod to a world").
