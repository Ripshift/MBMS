# BABS: Bridged Android Bedrock Server

An Android app that runs a Minecraft Bedrock Dedicated Server and the Bedrock Console Bridge (HMBC) on a phone
or tablet, so friends on Xbox, PlayStation and Switch can join from their Friends list.

BABS is the phone member of a family: the Mod Loader and HMBC came first, and Bedrock Hub (`Coded\Server Hub`)
is the current desktop app that brings them together. BABS follows Bedrock Hub's look (its colours, cards, pips
and stats grid, from `renderer/styles.css`) and installs packs the way its add-on engine does.

Scope: **the server and the bridge**, plus Bedrock Hub's world manager (host, clone, rename, back up, AutoSave
and backups), GitHub Cloud (the same repo and format as Bedrock Hub's) and each world's packs (add, remove,
reorder), with a lite mod library to reuse packs across worlds. For Bedrock Hub's full Mod Library, use Bedrock Hub.

## The hard part: Bedrock Server is x86_64 only

Mojang ships Bedrock Dedicated Server (BDS) only for x86_64 Windows and Linux. Phones and tablets are ARM64, so
BDS can't run on them directly. BABS gets around this the same way people run BDS on a Raspberry Pi:

| Piece | Runs as | How |
| --- | --- | --- |
| Bedrock server | x86_64 Linux binary | **box64** turns x86_64 code into ARM64 as it runs, inside a small ARM64 Linux (glibc) rootfs |
| Bridge (`HMBC.jar`) | Java 21 | An **ARM64 OpenJDK** in the same rootfs. The jar already includes `Linux/aarch64` natives for sqlite and JNA, so it runs unchanged |
| Linux rootfs | Ubuntu 26.04 LTS Base | **proot**, so no root is needed |
| App | Kotlin, Jetpack Compose | A foreground service starts and watches both processes and reads and writes their consoles |

```
┌──────────────────────── BABS app (Kotlin) ────────────────────────┐
│ UI: Start / Stop / Restart, Server card, Bridge card, Console      │
│                                │                                   │
│            Foreground service (wakelock, notification)             │
│                 │                               │                  │
│   proot ── box64 ── bedrock_server     proot ── java -jar HMBC.jar │
│        (x86_64, emulated)                   (ARM64, native)        │
│                 └──────── UDP 19132 / NetherNet ─────┘             │
└────────────────────────────────────────────────────────────────────┘
```

## Known constraints

- **Android blocks running files from app storage** (API 29+). proot and its loader ship as `libproot.so` and
  `libproot-loader.so` in `jniLibs/`, so Android puts them in the executable native library folder. Termux and
  UserLAnd do the same. Once proot is running, everything else (box64, Java, the server) runs from the rootfs.
- **Bedrock needs glibc, Android has bionic.** So even on an x86_64 emulator the server runs inside the proot
  rootfs. It just skips box64 there.
- **The Bedrock server can't be bundled.** Mojang's EULA doesn't allow redistributing it. The app downloads it on
  the device after the user accepts the EULA, the same way HMBC's *Check for updates* does.
- **Android kills background apps.** The app needs a foreground service, a partial wakelock, a prompt to turn off
  battery optimisation for BABS, and Wi-Fi kept on while the screen is off.
- **Performance.** box64 costs roughly 30–60% of native speed. A recent flagship (Snapdragon 8 Gen 2 or newer,
  8 GB+ RAM) should handle a small server with a few players. Older devices may struggle with chunk generation.
- **Networking.** The phone is usually behind home NAT on Wi-Fi. HMBC needs the public address
  (`session.public-address`) and UDP ports forwarded on the router. Mobile data (CGNAT) mostly won't work.
- **Storage.** About 1 GB in total: Ubuntu with Java is about 340 MB and BDS about 350 MB (measured on the
  emulator), plus worlds. An update briefly needs another ~420 MB for the zip and the unpacked copy.

## Where things live (on the device)

| Path (app private storage) | What it holds |
| --- | --- |
| `files/rootfs/` | Ubuntu 26.04 LTS, OpenJDK 21, and box64 on ARM. `.babs-base` and `.babs-ready` mark how far the install got |
| `files/server/` | `bedrock_server`, `server.properties`, `worlds/` (bound into the rootfs as `/srv/bedrock`). `.babs-version` holds the installed version |
| `files/server.new/` | A server download being unpacked. Only there during an install or update |
| `files/bridge/` | `HMBC.jar` (copied from the APK), `config.yml`, `cache/` (the Microsoft sign-in). `.babs-jar` holds the copied jar's SHA256 |
| `files/logs/` | `babs.log`: everything the console showed, with times. Becomes `babs.1.log` at 2 MB |
| `cache/share/` | `babs-log.txt`, the log as last shared |

## Roadmap

1. **Proof of concept, no app.** On a test device, in Termux: `proot-distro` Ubuntu, box64, BDS, OpenJDK 21 and
   `HMBC.jar`. Confirm a console player can join through the bridge and measure tick time and RAM. *If this doesn't
   work well, nothing else matters.*
2. ✅ **App skeleton.** Android project (Kotlin, Compose, minSdk 29), foreground service, and proot launching a
   shell from `jniLibs`. Checked on the x86_64 emulator, not yet on an ARM device.
3. ✅ **Rootfs bootstrap.** An Install button downloads and unpacks Ubuntu, then installs Java 21 (and box64 on
   ARM) and checks them. Checked on the x86_64 emulator. The box64 part only runs on ARM, so it isn't tested yet.
4. ✅ **Server.** EULA screen, BDS download and update (keeping `server.properties`, `allowlist.json`,
   `permissions.json` and `worlds/`), start/stop with a graceful `stop`, console in and out. Checked on the x86_64
   emulator (BDS 1.26.63.1, natively under proot, about 340 MB RAM idle). Not yet under box64.
5. ✅ **Bridge.** Bundle `HMBC.jar` (built from `Coded\HMBS`), show the Microsoft sign-in code with a button to open
   it, poll the health endpoint, and pass in the public address. Checked on the emulator (Java about 170 MB RAM):
   sign-in, "Visible to friends", hiding the session when the server crashes and showing it again on Start.
   No one has joined through it yet.
6. **Main screen.** Start, Restart and Stop for both, status cards, console with a command box, and a Content Log
   count.
7. **Hardening.** Restart after crashes, survive Doze, back up before updates, and save the world cleanly on low
   battery.

## Building

Open the `BABS` folder in Android Studio and press Run, or from PowerShell:

```
$env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
.\gradlew.bat assembleDebug        # app\build\outputs\apk\debug\app-debug.apk
.\gradlew.bat installDebug         # onto a running emulator or USB device
```

**Sign in with GitHub.** GitHub Cloud's device sign-in needs a GitHub OAuth app's client id (with Device Flow
turned on in the app's settings). Put `babsGithubClientId=<id>` in `gradle.properties` or
`~\.gradle\gradle.properties`. Without it, BABS asks for a token instead, which works the same.

AGP 9.5, Kotlin 2.4, Jetpack Compose, compileSdk/targetSdk 37, minSdk 29 (Android 10). The APK is built for
`arm64-v8a` (phones and tablets) and `x86_64` (the emulator).

**Emulator.** An x86_64 virtual device runs the server natively (no box64), so you can build and test nearly
everything without a phone. Give it **6–8 GB RAM** and **16 GB+ storage**: at the default 2 GB, Android alone
struggles. Performance and box64 still have to be checked on a real ARM device.

**Real device.** `dist\BABS-<version>-debug.apk` is a copy of the debug build to sideload. Copy it to the phone
and open it (Android asks to allow installs from that app once), or with USB debugging on:
`adb install -r dist\BABS-0.13.0-debug.apk`. It's signed with the debug key, so later builds install over it
without losing data, but a release build would need an uninstall first.

## How it's built

```
app/src/main/java/app/babs/
  MainActivity.kt          Starts the UI, asks for the notification permission on first Start
  core/Hub.kt              Shared state: server and bridge status, the console (last 2000 lines)
  core/Layout.kt           Folders, CPU type, what's missing, and the proot command lines for both
  core/BridgeApi.kt        HMBC's localhost endpoint: /health, /session (hide or show), /friends (requests, auto-accept)
  core/ServerConfig.kt     server.properties (edited line by line), allowlist.json, the worlds folder
  core/Worlds.kt           Clone, rename, back up, backups, AutoSave, world names and level.dat's LevelName
  core/CloudSync.kt        GitHub Cloud: the repo's format, uploads and downloads, and around each session
  core/GitHub.kt           GitHub's REST API: sign-in, repos, and git blobs sent and fetched as streams
  core/SecretStore.kt      The GitHub token, encrypted with a key in Android's keystore
  core/ContentLog.kt       The Content Log: what the server reports about packs, ported from Bedrock Hub
  core/LogFile.kt          The console saved to files/logs, and the export for Share log
  core/ManagedProcess.kt   One child process: output into the console, commands in, graceful stop
  core/Prefs.kt            Settings kept between runs (EULA accepted, public address)
  service/ServerService.kt Foreground service: Install, server download/update, Start / Stop / Restart, locks
  setup/Download.kt        Resumable downloads with retries
  setup/Installer.kt       Downloads Ubuntu, unpacks it, installs Java and box64 with apt
  setup/ServerInstaller.kt Finds the newest Bedrock server, downloads it, installs or updates it
  setup/Tar.kt             Unpacks the rootfs tarball on Android
  ui/MainScreen.kt         The five tabs, the actions they call, shared dialogs
  ui/WorldsTab.kt          Worlds, a world's packs, bringing in worlds, backups
  ui/BridgeTab.kt          Sign-in, account, who can see the game, friend requests
  ui/ServerTab.kt          Install and download cards, status, Start / Restart / Stop, allow list warning
  ui/ConsoleTab.kt         Everything (filters, Share), Server (commands and chat) or Content Log
  ui/SettingsTab.kt        Server (game settings, allow list, version), Bridge (public address), GitHub Cloud, App
  ui/CloudUi.kt            GitHub Cloud's Settings card, its Worlds tab card and the "newer save" question
  ui/Components.kt         Cards, the console view and dialogs used across tabs
```

### Installing Linux

The Install button runs in the foreground service, so it carries on with the screen off.

1. **Download.** [Ubuntu Base 26.04.1](https://cdimage.ubuntu.com/ubuntu-base/releases/26.04/release/) for
   `arm64` or `amd64` (34 MB), checked against a SHA256 pinned in `Installer.kt`. A dropped connection resumes
   where it stopped, up to 5 tries.
2. **Unpack** into `files/rootfs.partial`, then rename it to `files/rootfs`, so a half-unpacked one is never used.
   Android doesn't let apps make hard links, so `Tar.kt` turns each one into a symlink. Copying instead made
   Ubuntu's Rust coreutils (one binary, ~100 hard links) take 1.2 GB.
3. **Configure** for proot: a real `resolv.conf` (Ubuntu's points at systemd-resolved), `/etc/hosts`, apt staying
   root (its `_apt` user can't work under proot), and no docs, man pages or locales. `resolv.conf` lists the
   phone's own DNS servers first, then 1.1.1.1 and 8.8.8.8, and is rewritten at every Start because the phone
   changes networks. Public DNS alone is blocked or unreliable on some networks, and then everything HMBC does
   fails, including saving a sign-in.
4. **apt** installs `openjdk-21-jre-headless` and, on ARM, `box64` (0.3.8, from Ubuntu's universe), then runs
   `java -version` and `box64 --version`, and deletes apt's package lists (about 130 MB).

If it fails, the card shows the error and **Try again** carries on from the last stage that finished.

On the emulator, apt sometimes gets "Hash Sum mismatch". The same files download intact one at a time and from the
PC, so it looks like the emulator's network damaging data under load. apt retries the failed files up to 5 times,
which got through.

### The Bedrock server

Once Linux is installed, a **Bedrock server** card asks the user to agree to the
[Minecraft EULA](https://www.minecraft.net/eula) and Privacy Policy, then **Download server** installs it. BABS
remembers the agreement, so updates don't ask again.

1. **Find the newest version** from the links API that minecraft.net's download page uses (the same one Bedrock
   Hub uses), taking the `serverBedrockLinux` entry. Only `https://www.minecraft.net/bedrockdedicatedserver/` URLs
   are accepted.
2. **Download** the zip (about 98 MB) into the cache, resuming after dropped connections.
3. **Unpack** it into `files/server.new`, checking every file's CRC. Mojang publishes no hash, so this is what
   catches a damaged download. If one fails, the zip is downloaded again, up to 3 times.
4. **Move** the files over `files/server`, merging folders. `server.properties`, `allowlist.json` and
   `permissions.json` are kept if they already exist, and `worlds/` is never touched. Then `bedrock_server` is made
   executable and its version is written to `.babs-version`.

When the app opens it checks for a newer server, and the server card shows **Update to …**. Updating a running
server sends `stop` first (which saves the world), then starts it again afterwards.

The server needs only `libc`, `libm`, `libdl`, `libpthread`, `librt` and `libgcc_s`, all already in Ubuntu Base.
It reads commands on stdin and prints `Server started.` once it accepts players, which turns the card green.

### The bridge

`app/src/main/assets/bridge/` holds `HMBC.jar` and its SHA256. On Start, BABS copies the jar into `files/bridge/`
if it's missing or the SHA256 has changed, so updating the app updates the bridge. To bundle a new build:

```
cd ..\HMBS; .\gradlew.bat :bootstrap-standalone:build -x test; cd ..\BABS
powershell -ExecutionPolicy Bypass -File scripts\fetch-bridge.ps1
```

BABS runs it as `java -Xmx384m -jar HMBC.jar` in the rootfs, with the same `MCXB_` settings Bedrock Hub uses:

| Variable | Value |
| --- | --- |
| `MCXB_SESSION__REMOTE_ADDRESS` / `__REMOTE_PORT` | `127.0.0.1` and `server-port` from `server.properties` |
| `MCXB_SESSION__PUBLIC_ADDRESS` | The public address from the bridge card, or empty |
| `MCXB_RESILIENCE__HEALTH_PORT` | `19180` (Bedrock Hub uses 8080, which is more likely to clash on a phone) |
| `MCXB_NOTIFICATIONS__ENABLED` | `false` |

While the bridge runs, BABS polls `http://127.0.0.1:19180/health` (once a second while a sign-in code is up,
otherwise every 3 s). That drives the bridge card and the **Sign in the bridge** card, which shows the code with
**Copy code and open** (`microsoft.com/link`). The code can also be entered from any other device. HMBC keeps the
sign-in in `files/bridge/cache/`, so it's only needed once. The network security config allows plain HTTP to
`127.0.0.1` only.

When the server stops or crashes, BABS asks HMBC to hide the session (`POST /session?hidden=true` with `X-HMBC: 1`),
and shows it again on `Server started.`, as Bedrock Hub does. The account stays signed in throughout. Stop sends
`stop` to both: the server first, then HMBC, which exits straight away.

**Waiting for the port.** Besides its UDP game port, BDS listens on TCP at the same port (19132) for NetherNet
signalling, which joining through Xbox friends relies on, and HMBC pings it there. After the server stops, Linux
keeps the closed connections on that port for about 60 seconds. If BDS starts again in that time, it quietly skips
the TCP listener: it reports "Server started." but HMBC can't reach it, and friends can't join. So before starting
the server, BABS checks that the port can be bound without `SO_REUSEADDR` (as BDS does), and waits up to 90 seconds
if it can't, showing "Waiting for port 19132 to be freed". Stop cuts the wait short.

**Public address.** The bridge only passes on the connection setup. Players then connect straight to the server,
so for friends outside the home network the bridge also offers the server's ports on the public address. Set it
from the bridge card (it's checked to be a public IPv4 address). Saving it restarts a running bridge. The router
then has to forward those UDP ports to the phone. That, and whether home routers and mobile data allow it at all,
is part of roadmap step 1.

### proot

`app/src/main/jniLibs/<abi>/` holds [Termux's proot](https://github.com/termux/proot) build and its libraries,
renamed to `lib*.so` so Android puts them where they can run. `scripts/fetch-proot.ps1` downloads them from
Termux's package repository at pinned versions, checks their SHA256s, and renames them. Rerun it to update:

```
powershell -ExecutionPolicy Bypass -File scripts\fetch-proot.ps1
```

| File | From |
| --- | --- |
| `libproot.so` | `proot` 5.1.107.102 (GPL-2.0) |
| `libproot-loader.so` | proot's loader, found through `PROOT_LOADER` |
| `libtalloc.so` | `libtalloc` 2.5.0 (LGPL-3.0). proot asks for `libtalloc.so.2`, so the script patches that name |
| `libandroid-shmem.so` | `libandroid-shmem` 0.7 (BSD-3-Clause) |

proot finds its libraries through `LD_LIBRARY_PATH`. Every Linux program starts from `/usr/bin/env -i`, so it
never sees that path or any other Android variable. Until the rootfs exists, Start runs proot with Android's own
`/` as a self-test and prints `proot works: uid 0 inside`.

### Screen

Five tabs along the bottom, in Bedrock Hub's sidebar order, with the bridge's and the server's state as dots in
the top bar on all of them:

- **Worlds**: Bedrock Hub's Worlds page. Every world, with the hosted one ticked; tap another to host it. Each has
  **Packs** (its own page, below) and a menu with Host, Manage packs, Clone, Rename, Back up, Export as .mcworld
  and Delete. Then New world, bringing in a world, and **Backups**.

- **Bridge**: the sign-in card, the bridge's status with Restart bridge (or New code when one ran out), the Xbox
  account with Sign out, who can see the game and the public address, and friend requests. A new sign-in code
  brings this tab forward once. It's badged while a code or a friend request is waiting.
- **Server**: the Linux and server download cards when needed, then the server card with Bedrock Hub's stats:
  the world's picture (`world_icon.jpeg`) and name, players out of `max-players`, uptime (from "Server started."),
  who's online (from the "Player connected" and "Player disconnected" lines), version and any update, game mode,
  world, last saved (`level.dat`'s time) and address (the phone's address on its network, and the public address
  if set). Being a phone, it also shows memory (`VmRSS` of every process whose command line names
  `bedrock_server` or `HMBC.jar`, read from BABS's own `/proc` entries) and the battery. Then Start / Restart /
  Stop for both, the allow list warning, a link to Worlds, and the server's last few lines.
- **Console**: **Everything** (all output, filters for bridge, server or BABS, Share, Clear), **Server**
  (only the server's lines, with a box for commands, or chat that sends `say`, and quick commands) or **Content
  Log**. It follows new lines until you scroll up, then shows a ↓ button back to the latest. The tab is badged with
  the Content Log's error count.
- **Settings**: Server (game settings, allow list, phone performance, AutoSave, version and updates), Bridge
  (public address), GitHub Cloud, and App (Keep running, Share log, About).

**Friend requests.** HMBC has `/friends` (the requests it last saw and whether it accepts them by itself),
`/friends/approve`, `/friends/deny` and `/friends/auto`, all on localhost with `X-HMBC: 1` for changes. BABS reads
it every 15 s while the bridge is signed in. HMBC forgets a change to auto-accept when it restarts, so BABS keeps
the setting and passes it in at every start as `MCXB_FRIEND_SYNC__AUTO_FRIEND`. With the server's allow list on,
accepting a request from BABS also adds that gamertag to the allow list (a switch on the Bridge tab). Requests
HMBC accepts by itself aren't added, since BABS never sees them.

**Allow list.** Bedrock's server ships with `allow-list=true` and an empty `allowlist.json`, so everyone is turned
away with "You are not invited to this server" (the game shows it with an error code). The Server tab says so in
red while the list is on and empty. Turning it on or off writes `server.properties` and, while the server runs,
sends `allowlist on` or `off`, which take effect at once. Adding or removing a player edits `allowlist.json` and
sends `allowlist reload`. No restart either way.

**Server settings** are edited in `server.properties` line by line, keeping Mojang's comments. The server only
reads them at start, so a change while it runs shows a **Restart now** banner, which restarts only the server.

**Worlds** are the folders in `worlds/`, named by `levelname.txt`. Hosting one sets `level-name` and restarts
the server if it's running. **New world** sets `level-name` (and `level-seed` if given) to a name that has no
folder yet, and the server makes it when it starts.

**Bringing in a world** (Worlds card, `core/WorldImporter.kt`) goes through Android's own pickers, since BABS has
no access to other apps' files: **.mcworld file** (`ACTION_OPEN_DOCUMENT`, any type, then checked) or **Folder**
(`ACTION_OPEN_DOCUMENT_TREE`). Both open at `EXTRA_INITIAL_URI`, chosen by `findMinecraft()`:

- Is Minecraft installed? (`com.mojang.minecraftpe`, declared under `<queries>` so Android 11+ shows it.)
- Is its worlds folder in shared storage, `games/com.mojang/minecraftWorlds`? Current versions keep worlds in their
  own private storage unless set otherwise, and nothing else can reach them; there the way out is Minecraft's
  Export World, which makes a `.mcworld`. On Android 10, `Android/data/com.mojang.minecraftpe/...` is tried too.
- The picker opens in the worlds folder when there is one, else in Downloads. You can browse anywhere from there.

A `.mcworld` is a zip of one world. BABS finds `level.dat` (at the top, or one folder down), reads the name from
`levelname.txt`, checks the space, and unzips with a check against names that would land outside the folder. A
picked folder is a world if it has `level.dat`. Otherwise its subfolders with `level.dat` are listed, and with
more than one (such as Minecraft's whole worlds folder) you pick which. Either way the copy goes to a hidden
`worlds/.import-…` folder first and is renamed at the end, so a failed or cancelled import leaves nothing behind.
The folder name, which is the server's `level-name`, is the world's name without colour codes or other
characters, made unique with " (2)" and so on. When it's done, **Play it** switches the server to it.
Marketplace worlds are encrypted for Minecraft and won't load on a server.

**Add pack to this world** (a world's Packs page, `core/PackInstaller.kt`) puts a .mcaddon, .mcpack or .zip
into that world, the same way as Bedrock Hub's `engine/addon_engine.py`:

- Archives inside archives are unpacked (a .mcaddon usually holds a .mcpack per pack), then every folder with a
  `manifest.json` is a pack. Its kind comes from the module types: `resources` is a resource pack; `data`,
  `script` and the like a behavior pack. Skin packs and world templates are left out, and the card says so.
- The name is the manifest's, looked up in `texts/en_US.lang` when it's a key like `pack.name`, without colour
  codes. The pack goes in `behavior_packs` or `resource_packs` as `<name>_<first 8 of its uuid>` (the engine's
  `safe_name`), copied to `.addonloader_<uuid8>_tmp` first and then swapped in. An older copy of the same uuid is
  replaced, so adding a newer version updates it.
- `world_behavior_packs.json` / `world_resource_packs.json` get `{pack_id, version}` appended, or the version
  updated. Before the first change to an existing file, it's copied to `<file>.bak_addonloader`, as the Mod
  Loader does.
- A pack that depends on a `-beta` script module needs the world's Beta APIs experiment, which only Minecraft can
  turn on, so the card warns about it.

The server reads packs when it starts, so adding one while it runs shows the **Restart now** banner.

**Load order is automatic** (`core/PackOrder.kt`), ported from Bedrock Hub's `plan_orders` in "repair" mode,
its default: the order already in the world is kept, new packs go to their recommended place, and only what the
rules require moves. Later packs in the world file win. The rules, strongest first, each winning over weaker
ones that disagree: a pack goes after what it depends on (10); a patch or compat pack goes on top of the pack
whose files it changes (8); an extended version, or a pack that changes everything another does and more, goes on
top (7); of two packs changing the same files, the smaller tweak goes on top (4); a pack named as a patch of
another goes after it (3); overhauls and frameworks at the bottom, small add-ons, sound and UI in the middle,
performance, animation and texture packs on top (2). Bedrock Hub also compares the identifiers packs define;
BABS compares their files only. Entries for packs that aren't in the world's folders stay first, untouched.
A world's Packs page lists packs in this order, and the console says when it changes.

**Deleting a world** (its menu on the Worlds tab) deletes its folder after asking, with **Back up first**
offered. The hosted world can't be deleted; host another first. AutoSave's copies of it are kept.

**Clone, Rename and Back up** work as in Bedrock Hub (`core/Worlds.kt`, from `engine/hub_rpc.py`):

- **Folder names** follow Bedrock Hub's `folder_for`: the name without colour codes and characters folders can't
  have, and without `=`, `#` and `!`, since the server stops reading `level-name` at an `=`. Taken names get
  " (2)" and so on, so a world keeps its folder name when it moves between the two apps.
- **The name in the game** is written to `levelname.txt` and to `LevelName` in `level.dat`, changing only that
  string and keeping every other byte (Bedrock Hub's `with_level_name`). If `level.dat` can't be read back after,
  only `levelname.txt` changes, and the console says so.
- **Clone** copies into a hidden `worlds/.babs-clone-…` folder, renames it at the end and checks the space
  first. **Rename** moves the folder and, for the hosted world, updates `level-name`. **Back up** writes
  `backups/<name>_<yyyyMMdd-HHmmss>.zip` with the world in a folder inside, as Bedrock Hub's `backup_world` does.
- The hosted world's files are in use while the server runs, so all three wait until it's stopped, as Bedrock
  Hub refuses them then too. **Export** works while it runs.

**AutoSave** (`AutoSave` in `core/Worlds.kt`, from Bedrock Hub's `src/autosave.js`, in the same place and format):
before the server starts a world, BABS copies it to `backups/AutoSave/<world>/pregameplay`, and once the server
has stopped it, to `postgameplay` beside it. The next session replaces both, so there is always one copy from
before the last session and one from after. `world.json` says when each was taken and on which phone. A world
that crashes while loading isn't copied after (the copy is only taken once "Server started." was seen), so the
copy from before that session stays as it was. A start waits for the last session's copy to finish. On by
default; turn it off in Settings.

**GitHub Cloud** (`core/CloudSync.kt`, from Bedrock Hub's `src/cloud.js` and `src/cloudmanager.js`) saves each
world's AutoSave copies to a GitHub repo, in Bedrock Hub's layout: `<world>/world.json`, `<world>/pregameplay/`
and `<world>/postgameplay/` on `main`, without pack folders (`.gitignore` says so too) and without files over
95 MB. `world.json`'s `rev` goes up with every upload, and each phone or PC remembers the `syncedRev` it last saw,
so a newer save from the other is spotted. Link the same repo on the PC and the phone.

- There's no git on Android, so BABS uses GitHub's REST Git Data API: it sends only files GitHub doesn't already
  have (by git's SHA-1, cached in `files/cloud-hashes.json`), paced to stay under GitHub's limit for new content,
  builds the world's tree, and commits it on top of the branch. Another device's upload in between is fine, as
  only this world's folder changes; it starts again from the newer commit once. **Keep older saves** off makes
  each commit parentless and forces the branch, as Bedrock Hub's forced push does.
- Sign-in is a pasted fine-grained token (Contents read and write on the repo), or GitHub's device sign-in when
  the build has a client id. The token is encrypted with an Android keystore key. A public repo is only linked
  after a warning.
- Before a start, BABS checks the world. With a newer save in the cloud it asks: **Use the cloud save** (download
  it and load it, keeping the replaced copy under Backups as "replaced"), **Keep this phone's** (the next upload
  wins), or Cancel. A check that fails or takes over 20 s starts with this phone's copy.
- After each session, the AutoSave copy notes the world's packs and is uploaded if **Upload automatically** is
  on. BABS also checks when it comes to the front and every 15 minutes while the service runs, and uploads
  anything not uploaded yet. Uploads and downloads run in the service with their own wake lock.
- While it's linked, AutoSave copies every session even if its switch is off, since those copies are what's
  uploaded. A download names any packs the world uses that this phone doesn't have.

**Mod library** (Worlds tab, `PackInstaller` in `core/PackInstaller.kt`) is a lite take on Bedrock Hub's: one copy
of each pack in `files/library/behavior/` and `files/library/resource/`, named as in a world. Every pack added to
a world is kept there too, **Import a pack** adds one without a world, and **Copy in from worlds** gathers the
packs the worlds already have. A world's Packs page has **Add from the mod library**, which adds and orders them
the same as adding from a file. Delete takes a pack out of the library only; worlds keep their copies. After a
GitHub Cloud download, packs the world lists but doesn't have are put back from the library, as Bedrock Hub does.

**Backups** (Worlds tab) lists AutoSave's copies and everything in `backups/` that holds a world (zips,
`.mcworld` files and world folders), newest first. **Load** always loads one as a new world, so nothing is
overwritten; **Delete** asks first.

**A world's packs** (Packs on the Worlds tab) is Bedrock Hub's Manage mods page for one world: its behavior and
resource packs in load order, each with ↑ and ↓ to move it and Remove, and **Add pack to this world**. Remove
takes the pack out of the world's list and deletes the world's copy; BABS has no mod library, so the dialog says
to add the file again to get it back. Moves keep `world_*_packs.json.bak_addonloader` like any other change, and
the next pack added keeps your order except where a load-order rule needs a pack after another. A change to the
hosted world while it runs shows **Restart now**.

**Content Log** (Console tab, `core/ContentLog.kt`, from Bedrock Hub's `src/contentlog.js`): before each Start BABS
sets `content-log-console-output-enabled=true`, as Bedrock Hub does, so the server prints what it would show in
the game's Content Log. Lines with a `[Category]` after the time and level become entries, a repeat counts up
instead of adding a row, and the lines after a script error are kept as its stack trace (tap the entry). It's
cleared at each Start and keeps up to 1000 entries. Filter by level, search, Share as text, or Clear.

**Public address**: **Find and set it** asks api.ipify.org (or ipv4.icanhazip.com if that doesn't answer) for the
address the internet sees, and saves it. Only the request is sent. It warns when that address can't work: on
mobile data, which almost never lets others connect in, or a carrier-grade NAT address (100.64.0.0/10), shared by
many of a provider's customers. The address dialog has the same button, which fills the field in.

**Splash and header.** BABS opens with Babs, the mascot (an original elephant, `res/drawable/ic_mascot.xml`),
popping up and winking (`ic_mascot_wink.xml`) for about a second and a half, once per launch (`ui/Splash.kt`).
The top bar has the app icon's grass block (`ic_logo.xml`) with "Bridged Android Bedrock Server" under the name.

**Themes.** Tapping the grass block, which has no label on purpose, switches between Bedrock Hub's theme and a
Minecraft menu theme, remembered between runs (`ui/Theme.kt`). The Minecraft one has darkened dirt behind
everything, like the old pause menu (an original 8-pixel pattern drawn once per size, not the game's texture),
dark Minecraft grey panels, green buttons, white text in Monocraft and square corners. Every screen draws through
`HubColors`, which reads the current palette from Compose state, so switching repaints the whole app.

**Names in the friends list.** Friends see the **Server name** from Settings (`server-name`) and the loaded
world's name (its `levelname.txt`), not HMBC's defaults ("HMBC") or the server's own ping. With the server name
left at Bedrock's default "Dedicated Server", the bridge account's gamertag stands in. BABS starts the bridge with
`MCXB_SESSION__QUERY_NAMES=false`, `MCXB_SESSION__SESSION_INFO__HOST_NAME` (or
`MCXB_SESSION__HOST_NAME_FROM_ACCOUNT=true`) and `MCXB_SESSION__SESSION_INFO__WORLD_NAME`, options added to HMBC
for this (off by default, so Bedrock Hub is unchanged). When the server comes up with a different world or server
name than the bridge shows, BABS restarts the bridge so the names follow.
Building HMBC needs a JDK 21 (`.\gradlew.bat :bootstrap-standalone:build -x test` in `Coded\HMBS`, with
`-Porg.gradle.java.installations.paths=<jdk 21>` if Gradle can't find one), then `scripts\fetch-bridge.ps1`.

**Xbox profile picture.** HMBC's `/health` gives the account's `gamerpic` address once signed in, when the
profile has one. BABS shows it round on the Bridge tab, fetched as Bedrock Hub's `profile.js` does: https only,
Microsoft and Xbox hosts only, no redirects, PNG, JPEG or WebP up to 1 MB. The gamertag and picture are
remembered between runs, so they show while the bridge is off; Sign out forgets them.

**Export** (each world in the Worlds card, `core/WorldExporter.kt`) saves a world as a `.mcworld`, through
Android's save dialog, named after the world and the date as Bedrock Hub names its backups. Minecraft opens it,
and BABS imports it. The export runs in the service, so it carries on with the screen off. For the world the
running server has open, it uses Bedrock's own way of copying a live world: `save hold`, then `save query` until
"Data saved. Files are now ready to be copied." and the list of files with how many bytes of each count. Only
those bytes are copied (a file can already be longer), database files not listed are left out, and
`save resume` follows whatever happens. A failed export deletes its half-written file.

**Phone performance** (Settings > Server):

- **Phone-friendly settings**, applied when BABS first downloads the server and offered in Settings with what
  each is now: `view-distance` 10 (Bedrock's 32 makes the server load and send about ten times the land),
  `tick-distance` 4, `client-side-chunk-generation-enabled` (players' games draw distant land) and
  `compression-algorithm` snappy (less CPU per packet than zlib, for a little more data).
- **The bridge's Java** runs with `-XX:+UseSerialGC` (one collector thread, not one per core),
  `-XX:TieredStopAtLevel=1` (the quick JIT only; the bridge mostly waits on the network), a 48 MB code cache,
  512 KB thread stacks, `-Xmx320m`, and a heap that's given back to Android when unused. On the emulator this
  took it from about 193 MB to 161 MB.
- **Restart if it stops**: when the server stops without being asked (a crash, or Android killing it), BABS starts
  it again after 5 seconds, up to 3 times in 10 minutes, then leaves it and says so. Can be turned off. It only
  helps when the server alone is stopped; if Android closes BABS itself, everything goes with it.
- **Restarts hide the session first**, as Stop does: friends don't try to join a server going down, and the
  bridge stops pinging it, which leaves fewer old connections holding the port.

**Temperature.** The Server tab shows the battery's temperature (`EXTRA_TEMPERATURE`, the one every phone gives
apps) and Android's thermal status (`PowerManager`, since Android 10): Normal, Warm, Hot, Too hot, Critical. From
Hot it turns Bedrock Hub's warning colour, and from Too hot its error red. `BabsApp` also listens for changes
(`addThermalStatusListener`): a chip in the top bar shows on every tab from Warm, and the console says when the
phone gets hot, gets too hot (Android is slowing it, so the server lags) and cools down. To try it on the
emulator: `adb shell cmd thermalservice override-status 3`, then `reset`.

**Share log** joins `babs.1.log` and `babs.log` after a header with the phone model, Android version and memory,
and hands it to the share sheet through a `FileProvider`. When BABS opens, it also logs why Android last closed
it, if Android did (`getHistoricalProcessExitReasons`: low memory, killed, crashed, frozen, force stopped).

### Buttons

Start brings up whatever is installed. Stop sends `stop` to the server (which saves the world) and waits up to
30 s before forcing it (on the emulator it quits cleanly in under a second), then sends `stop` to the bridge. Restart restarts only what is running. Typing `stop` in the
command box is refused, as in Bedrock Hub, so the bridge stops too. Until the rootfs exists, Start runs a short
check instead. Start is greyed out while both are up, and Restart and Stop while neither is.

If the server stops without being asked, the card says why. proot exits with 0 whatever happened, but prints
`proot info: vpid 1: terminated with signal N`, so BABS reads the signal from that line: 9 is usually Android
killing it for memory, 15 a stop from outside BABS, 11 or 6 a crash.

If a sign-in code runs out, HMBC waits 5 minutes before showing a new one. The bridge card says so and offers
**New code**, which restarts the bridge for one straight away.

Microsoft only hands a sign-in to the bridge that asked for the code, and HMBC saves it only once every Xbox token
has been fetched. So restarting the bridge mid sign-in, or a network error in that window, means a new code. A
public address saved while a code is showing therefore waits: the bridge restarts for it once it's signed in. If
the bridge stops while a code is up, the console says that code won't work any more. Both bridge and server cards
name the signal when proot reports one.

## Licence

GPL-3.0, the same as HMBC, which is based on [MCXboxBroadcast](https://github.com/MCXboxBroadcast/Broadcaster).
proot (GPL-2.0), libtalloc (LGPL-3.0) and libandroid-shmem (BSD-3-Clause) are bundled as binaries from Termux.
`HMBC.jar` (GPL-3.0) is bundled from `Coded\HMBS`.
The Monocraft font (`res/font/monocraft.ttf`, v4.2.1, by Idrees Hassan) is bundled under the SIL Open Font
License 1.1; its licence is in `assets/licenses/Monocraft-OFL.txt`.
Ubuntu, OpenJDK (GPL-2.0 with Classpath Exception) and box64 (MIT) are downloaded on the device from Ubuntu. Minecraft and the Bedrock Dedicated Server belong to
Mojang/Microsoft and are downloaded by the user.
