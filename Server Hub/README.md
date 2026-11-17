# Bedrock Hub

A hub for all things Minecraft Bedrock, with four parts, in order of importance: a mod library, the Bedrock Console Bridge, a Bedrock server and a world manager. Each works by itself, and they work together. It used to be called Server Hub, and the first time it runs it moves `%APPDATA%\Server Hub` to `%APPDATA%\Bedrock Hub`. It combines two earlier tools:

| From | What it does here |
| --- | --- |
| **Mod Loader** | Worlds, the mod library, compatibility checks, updates, load order. The theme and sidebar. |
| **HMBC** | The Bedrock server, the Microsoft account and friend requests, the console and Content Log. The cards on the Server page. |

## Pages

- **Mod Library:** every mod you have, with no world or server needed. Search and filter, keep tags and notes, and open any mod for:
  - **Overview:** what it is, what is in it, and its folder in the library.
  - **What changed:** each update: requirements, the items, blocks and entities added, changed and removed, the author's changelog if there is one, and each file's changed lines.
  - **Where it's used:** every world and the server, with the version each has, and buttons to update, reinstall or remove it.
- **Worlds:** every world in the server's `worlds` folder. Host one, clone it, rename it, back it up, delete it, or load a new one from a folder, a `.mcworld` or a backup. Loading and cloning never overwrite a world. **Manage mods** opens that world's own page:
  - **In this world:** the packs it uses. Reorder or remove them.
  - **Add from library:** tick mods, then Add to world, Remove from world, Install to server or Uninstall from server.
  - **Compatibility:** duplicate UUIDs, missing dependencies, two mods defining the same thing, game version and more. It checks against the server's own version unless you set another in Settings.
  - **Updates:** library copies that differ from what's installed, with exactly what changed.
  - **Load order:** works out the order and explains why. Move packs by hand, or use Fix problems only or Sort everything.
- **Bridge:** the Bedrock Console Bridge, which lets friends on Xbox, PlayStation and Switch join from their Friends list. The Microsoft account it uses, sign-in and friend requests, and its own Start and Stop. It runs without the server, and friends don't see a game to join until the server is up.
- **Server:** your public address, the hosted world, live stats, its own Start and Stop, and the server's options from `server.properties` (cheats, allow list, custom skins, idle kick, and an Advanced section), and the allow list: add and remove gamertags, let someone join when the server is full, or add whoever is online now. A running server reloads the list, and switches the allow list on or off, straight away.
- **Console:** live output from the server, the bridge and the mod tools, with server commands. The Content Log tab shows what the server reports about add-ons.
- **Settings:** accent colour, library folders, install and backup options, and separate GitHub repos for worlds, the Mod Library, and encrypted settings.

Start, Restart and Stop at the bottom of the sidebar act on the server and the bridge together. Start brings up whichever isn't running, and Restart restarts only what is.

## The library folder

`%USERPROFILE%\HMBC-Library` holds extracted pack folders. Imported `.mcaddon`, `.mcpack` and `.zip` archives are unpacked here, and existing library archives are converted automatically. Worlds and the server get their copies from the library, so it is what you check against and reinstall from.

- **Adding a mod** asks whether to copy or move it. Move sends the original to the Recycle Bin once the library has its extracted copy. Loose pack folders are copied as folders.
- **Updating a mod** replaces its extracted folder, so **old versions aren't kept and you can't roll back**. If a world still has the older copy, that copy is still there until you update it.
- **What changed** is written down in `library.json` before the old folder goes: what was added, changed and removed, the author's changelog and the changed lines of text files. Pictures and sounds are only listed. The last 8 updates of each pack are remembered.
- **Dropping an archive straight into the library folder** works too. It is extracted on the next scan, the same as adding it here.
- **A mod in a world or on the server but not in the library** is marked, with a button to add it. Those copies aren't touched.
- It can't see new versions on the internet until you've downloaded and added them.

## Deleting things

Each of these asks first. Worlds, backups and library files go to the Recycle Bin. A pack removed from a world or the server is deleted, so the question warns you if it isn't in the library.

| What | Where |
| --- | --- |
| A world | Delete on its card. Refused for the hosted world while the server runs |
| A backup | Worlds, then Backups |
| A mod from one world | That world's In this world tab, or a mod's Where it's used tab |
| A mod from the server folder | A mod's Where it's used tab |
| A mod from the library | A mod's Overview. It can also be removed from every world and the server at once |

## AutoSave

Before the server starts a world, Bedrock Hub copies the world to `backups\AutoSave\<world>\pregameplay`. When the server stops, it copies it again to `postgameplay` beside it. The next session replaces both, so there is always one copy from before the last session and one from after. Each is a full folder copy, and both are listed under Worlds, then Backups, where they can be loaded as a new world. Turn AutoSave off in Settings. It is always on while GitHub Cloud is linked.

A server that crashes while loading isn't copied afterwards, so the copy from before that session stays as it was.

## GitHub Cloud

Optional, in Settings. It keeps each world's AutoSave copies in a private GitHub repo, so another computer with Bedrock Hub can carry on where you stopped. The Mod Library can be backed up manually to its own separate private repo.

- **Signing in.** With a token: make a fine-grained token on GitHub for the repos you link, with Contents set to Read and write. Sign in with GitHub needs an OAuth app with device flow turned on, and its client ID in `BEDROCK_HUB_GITHUB_CLIENT_ID` when the app is built or run. Without one, only the token button shows. The token is stored encrypted with Windows' own protection, and the window never sees it.
- **What goes up.** `<world>/pregameplay`, `<world>/postgameplay` and `<world>/world.json`, which says when each copy was taken and on which computer. Behavior and resource pack folders are left out (the repo's `.gitignore` says so too). Files over 95 MB are skipped, because GitHub refuses files over 100 MB, and the Console says when that happens.
- **When.** Each world uploads when the server stops it. A check runs at launch and every 15 minutes, and uploads anything that didn't get through. Closing the app waits up to two minutes for an upload to finish.
- **Newer saves.** If another computer saved a world since this one last had it, a window lists it with a Download button. Starting that world asks first: use the cloud save, keep this computer's, or cancel. Keeping this computer's puts it on top when the session ends, and the other stays in the repo's history.
- **Downloading** replaces the world on this computer, keeping the copy it replaced as an AutoSave backup. Packs the world uses come back from the Mod Library. Any that aren't in it are listed.
- **Size.** Each upload only sends files that changed, but the repo keeps every version, and a world's database files change a lot. Start the repo's history over (in Settings) uploads every world once with no history. Turning off "Keep older saves" does that every time, which sends the whole world each time.
- It uses [isomorphic-git](https://isomorphic-git.org), a Git written in JavaScript, so Git doesn't need to be installed.

### Mod Library backup

The Mod Library backup uses the same GitHub sign-in but a **separate repo** from world saves. Set or create its private repo in Settings, then press **Sync now** whenever you want to back up the latest extracted pack folders and `library.json`. Files over 95 MB are skipped on upload.

- **Add** keeps a snapshot of a pack's previous version in the repo's `versions\` folder before uploading its update.
- **Replace** updates the current pack in the repo without adding another version snapshot.
- **Restore from GitHub** replaces the local library with the latest backed-up `library\` folder. It asks first and keeps the existing folder beside it as a safety backup. Older Add snapshots are not restored.
- This sync is manual; importing, updating or deleting mods does not upload anything until you press **Sync now**.

### Settings and sign-in backup

Settings can be backed up manually to a third, separate **private** GitHub repo. The bundle includes Bedrock Hub preferences, world and Mod Library repo links, the GitHub sign-in token, the bridge host setting, server properties, the allowlist and server permissions. The Xbox bridge session is optional. When enabled, only the bridge's root and sub-session authentication caches are included; other bridge cache, history and session files are not.

- The entire bundle is encrypted before it reaches GitHub using a passphrase and AES-GCM, with a memory-hard scrypt key derivation. The passphrase is stored locally only through Windows' encrypted storage. Enter it once on each new device to unlock the vault.
- Every new device must first sign in to GitHub to access the private repo. This backup cannot replace that first GitHub sign-in. Xbox/Microsoft session transfer is opt-in; turn the bridge and server off before syncing or restoring.
- **Restore from GitHub** replaces the synced settings on this computer and keeps a local safety copy. It does not transfer worlds or Mod Library contents. Sync and restore are manual.
- A settings repo that is public is rejected. World-save and Mod Library repos may still be linked if public, but Bedrock Hub warns before use because their contents are visible to everyone. Making all three repos private is recommended.

## How the parts work together

- **Changing mods while the server runs.** A banner asks you to restart. That restarts only the server, so the bridge stays online.
- **Copying or renaming the hosted world.** Backing up, cloning and renaming it are refused while the server runs, because it keeps the files locked. Other worlds can be changed any time.
- **Renaming a world** changes its name in game and its folder. If it's the hosted world, `server.properties` is updated to match.
- **World folder names.** The server stops reading `level-name` at an `=`, then quietly creates a new empty world. Worlds from Minecraft often have `=` in their folder name, so Bedrock Hub leaves `=`, `#` and `!` out of folder names, and Start or Host renames any existing folder that has one. The name shown in game can still contain them.
- **The console shows mod actions too,** on lines starting `[mods]`.

## Where things live

Bedrock Hub uses HMBC's folders, so your server, worlds and Microsoft sign-in carry over.

| Folder | What it holds |
| --- | --- |
| `%USERPROFILE%\HMBC-Server` | The Bedrock server, `server.properties`, `worlds\`, `backups\`, `logs\server.log` |
| `%USERPROFILE%\HMBC-Bridge` | The Microsoft sign-in (`cache\`), `config.yml`, `.env` with the public address |
| `%USERPROFILE%\HMBC-Tools` | Java 21 (`jdk\`), plus Node for building |
| `%USERPROFILE%\HMBC-Library` | The mod library: extracted pack folders, and `library.json` |
| `%APPDATA%\Bedrock Hub` | Mod settings (`mods.json`), `mods.log`, the remembered gamerpic, and `runtime\`: the bridge and mod engine, copied here at launch because the exe's temp folder can be emptied by a second launch |

Set other locations with `HMBC_SERVER_DIR`, `HMBC_BRIDGE_DIR`, `HMBC_LIBRARY_DIR` and `HMBC_JAVA`.

The first time it runs, Bedrock Hub copies your settings from `Coded\Mod Loader\addon_loader_config.json`: accent colour, library folders, ticked mods, labels, favorites, notes and profiles. That file isn't changed.

**Run one app at a time.** HMBC and Bedrock Hub both run the same server from the same folders. If one is already running, the other's Start refuses because the port is in use. The Mod Loader edits the same worlds too, so close it while Bedrock Hub is changing mods.

## What you need

- **Python 3.8 or newer** on the PATH, for worlds and mods. It only needs the standard library. Without it the Server and Console pages still work, and the other pages say what's missing. Set `HUB_PYTHON` to use a specific one.
- **Java 21** in `HMBC-Tools\jdk`, as for HMBC.

## How it's built

```
src/        Electron main process. Everything except main.js, preload.js and modengine.js is HMBC's code, nearly unchanged
renderer/   The window. renderer.js is HMBC's server and console code, hub.js is the sidebar, worlds and settings, library.js is the Library
src/autosave.js, cloud.js, cloudmanager.js, github.js and librarycloud.js handle AutoSave and GitHub backups
engine/     addon_engine.py is the Mod Loader's code without its Tk window. hub_library.py runs the library folder. hub_rpc.py lets Electron call them
bridge/     HMBC.jar, the Bedrock Console Bridge, built from Coded\HMBS
test/       cloud.test.js runs AutoSave and GitHub Cloud against fakegithub.js, a stand-in that speaks real Git. logic.test.js is HMBC's tests, engine.test.js runs the real Python engine on throwaway folders
```

Electron starts Python once and talks to it over JSON lines. Requests run one at a time, so two jobs can't edit a world together. The window never passes a path from outside the server: files and folders come from a dialog in the main process, and worlds are named by folder and checked by the engine.

To fix a mod rule, change `engine/addon_engine.py`. To change the bridge, build it in `Coded\HMBS` and copy `bootstrap\standalone\build\libs\HMBC.jar` to `bridge\`.

```
$env:Path = "$env:USERPROFILE\HMBC-Tools\node;$env:Path"
npm install
npm test
npm start
npm run dist      # dist\Bedrock Hub.exe
```

## Licence

GPL-3.0, the same as HMBC, which is based on [MCXboxBroadcast](https://github.com/MCXboxBroadcast/Broadcaster) by rtm516 and contributors. See `LICENSE`.
