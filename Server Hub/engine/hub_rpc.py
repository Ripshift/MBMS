#!/usr/bin/env python3
"""Bedrock Hub's connection to the Mod Loader engine.

Reads one JSON request per line on stdin ({"id", "method", "params"}) and writes one JSON reply per line on stdout.
Requests run one at a time, so two jobs can never edit the same world together. Log lines arrive as {"event": "log"}.
All the mod logic lives in addon_engine.py, which is the Mod Loader's own code without its Tk window.
"""
import base64
import hashlib
import json
import os
import re
import shutil
import struct
import sys
import time
import traceback
import uuid as uuidlib
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import addon_engine as E  # noqa: E402
import hub_library as L  # noqa: E402

OUT = sys.stdout
sys.stdout = sys.stderr  # nothing but protocol lines may reach the real stdout

# Mojang's own packs ship in the server's folders. They aren't mods, so the library leaves them out.
BUILT_IN = re.compile(r"^(vanilla|chemistry|experimental|editor|server_editor|server_library|server_ui)([_.\- ].*)?$", re.I)
WORLD_BACKUP = re.compile(r"\.backup-\d{8}-\d{6}$")
ACCENT = re.compile(r"^#[0-9a-fA-F]{6}$")
IMPORTED_KEYS = ("sources", "scan_on_startup", "skip_folders", "force", "force_world_copy", "backup_json", "backup_world",
                 "backup_dir", "game_version", "auto_order", "auto_fix_order", "last_wins", "confirm_errors", "confirm_plan",
                 "update_worlds", "check_changes", "write_log", "ticked", "aliases", "ignored_updates", "meta", "profiles",
                 "sort", "accent", "sidebar_collapsed", "notify_info")
SETTABLE = {"scan_on_startup": bool, "skip_folders": str, "force": bool, "force_world_copy": bool, "backup_json": bool,
            "backup_world": bool, "backup_dir": str, "game_version": str, "auto_order": bool, "auto_fix_order": bool,
            "last_wins": bool, "confirm_errors": bool, "confirm_plan": bool, "update_worlds": bool, "check_changes": bool,
            "write_log": bool, "sort": str, "accent": str, "sidebar_collapsed": bool, "notify_info": bool, "notifications": list}
KINDS = ("behavior", "resource")


def emit(obj):
    OUT.write(json.dumps(obj, ensure_ascii=True) + "\n")
    OUT.flush()


def log(msg, lvl="info"):
    E.log_to_file(msg, lvl)
    emit({"event": "log", "msg": str(msg), "lvl": lvl})


def data_url(raw, kind="png"):
    return f"data:image/{kind};base64,{base64.b64encode(raw).decode('ascii')}" if raw else ""


def clean(name):
    """A name without Minecraft's colour codes."""
    return re.sub(r"\s+", " ", re.sub(r"\u00a7.", "", str(name))).strip()


def _nbt_skip(data, pos, tag):
    """The position just after one NBT value."""
    if tag in (1, 2, 3, 4, 5, 6):
        return pos + {1: 1, 2: 2, 3: 4, 4: 8, 5: 4, 6: 8}[tag]
    if tag == 7:
        return pos + 4 + struct.unpack_from("<i", data, pos)[0]
    if tag == 8:
        return pos + 2 + struct.unpack_from("<H", data, pos)[0]
    if tag == 9:
        inner, count = data[pos], struct.unpack_from("<i", data, pos + 1)[0]
        pos += 5
        for _ in range(count):
            pos = _nbt_skip(data, pos, inner)
        return pos
    if tag == 10:
        while True:
            inner = data[pos]
            pos += 1
            if inner == 0:
                return pos
            pos += 2 + struct.unpack_from("<H", data, pos)[0]
            pos = _nbt_skip(data, pos, inner)
    if tag == 11:
        return pos + 4 + 4 * struct.unpack_from("<i", data, pos)[0]
    if tag == 12:
        return pos + 4 + 8 * struct.unpack_from("<i", data, pos)[0]
    raise ValueError("bad tag")


def with_level_name(data, name):
    """level.dat with LevelName changed and every other byte kept. Raises if the result wouldn't read back the same."""
    has_header = len(data) > 8 and struct.unpack_from("<I", data, 4)[0] == len(data) - 8
    start = 8 if has_header else 0
    if data[start] != 10:
        raise ValueError("not a compound")
    pos = start + 3 + struct.unpack_from("<H", data, start + 1)[0]
    value = name.encode("utf-8")
    new_tag = bytes([8]) + struct.pack("<H", 9) + b"LevelName" + struct.pack("<H", len(value)) + value
    out = None
    while True:
        tag = data[pos]
        if tag == 0:                      # no LevelName yet: add it before the end marker
            out = data[:pos] + new_tag + data[pos:]
            break
        name_len = struct.unpack_from("<H", data, pos + 1)[0]
        key = data[pos + 3:pos + 3 + name_len]
        value_at = pos + 3 + name_len
        end = _nbt_skip(data, value_at, tag)
        if key == b"LevelName" and tag == 8:
            out = data[:pos] + new_tag + data[end:]
            break
        pos = end
    if has_header:
        out = out[:4] + struct.pack("<I", len(out) - 8) + out[8:]
    before, after = E._nbt_read_le(data, start), E._nbt_read_le(out, start)
    if after.get("LevelName") != name:
        raise ValueError("the new name didn't read back")
    before.pop("LevelName", None)
    after.pop("LevelName", None)
    if before != after:
        raise ValueError("other settings would have changed")
    return out


RESERVED = {"con", "prn", "aux", "nul", *(f"com{i}" for i in range(1, 10)), *(f"lpt{i}" for i in range(1, 10))}


def world_name(raw):
    name = clean(raw)
    if not name or len(name) > 60:
        raise ValueError("Use a name of 1 to 60 characters.")
    if WORLD_BACKUP.search(name):
        raise ValueError("That name looks like one of the dated backup folders. Choose another.")
    return name


def folder_for(name):
    # The server reads level-name from server.properties and stops at an =, then quietly makes a new empty world
    folder = re.sub(r"[=#!]", "", E.safe_name(name, 60)).strip(" .")
    if not re.search(r"\w", folder) or folder == "pack" and name.lower() != "pack":
        folder = "World"
    return f"{folder} world" if folder.lower() in RESERVED else folder


def problems(items):
    return [{"name": str(p[0]), "text": str(p[1]), "uuid": str(p[2]) if len(p) > 2 else ""} for p in items]


class Hub:
    def __init__(self):
        self.server = None
        self.worlds_dir = None
        self.cfg = dict(E.DEFAULT_CFG)
        self.world = ""            # folder name inside worlds\
        self.packs = []
        self.mods = []
        self.changes = {}
        self.guesses = {}
        self.ignored = set()
        self.ticked = set()
        self.index_cache = {}
        self.pack_cache = {}
        self.scan_issues = []
        self.last_order = {"behavior": [], "resource": []}
        self.lib = None
        self.old_store = None
        self.pending = {}

    # ------------------------------------------------------------------ setup and settings
    def init(self, serverDir, dataDir, importFrom="", hosted="", libraryDir="", recycle=True):
        self.server = Path(serverDir)
        self.worlds_dir = self.server / "worlds"
        data = Path(dataDir)
        os.makedirs(data, exist_ok=True)
        E.CONFIG_PATH = data / "mods.json"
        E.LOG_PATH = data / "mods.log"
        E.MANAGED_DIR = data / "managed_worlds"
        L.RECYCLE = bool(recycle)
        self.lib = L.Library(libraryDir or data / "Mod Library", log)
        self.old_store = data / "library"
        first_run = not E.CONFIG_PATH.exists()
        saved = E.load_config()
        self.cfg.update({k: v for k, v in saved.items() if k in E.DEFAULT_CFG})
        imported = False
        if first_run and importFrom and Path(importFrom).is_file():
            imported = self._import_settings(Path(importFrom))
        if self.cfg["sources"] is None:
            self.cfg["sources"] = []
        for key in ("aliases", "meta", "profiles"):
            if not isinstance(self.cfg.get(key), dict):
                self.cfg[key] = {}
        E.ALIASES.clear()
        E.ALIASES.update({str(k).lower(): str(v) for k, v in self.cfg["aliases"].items()})
        E.BACKUP_JSON = bool(self.cfg["backup_json"])
        E.WRITE_LOG = bool(self.cfg["write_log"])
        E.set_scan_skip(self.cfg["skip_folders"])
        self.ignored = set(self.cfg["ignored_updates"])
        self.ticked = set(self.cfg["ticked"])
        saved_world = str(self.cfg.get("world") or "")
        self.world = saved_world if self._world_exists(saved_world) else (hosted if self._world_exists(hosted) else "")
        self.cfg["world"] = self.world
        if first_run:
            self._save()
        return {"imported": imported, "problem": E.CONFIG_PROBLEM, "config": self.config()}

    def _import_settings(self, path):
        """Bring over the Mod Loader's settings the first time only. Its own file is never changed."""
        try:
            old = json.loads(path.read_text(encoding="utf-8-sig"))
        except Exception as e:
            log(f"Couldn't read the Mod Loader's settings ({e}). Starting with defaults.", "warn")
            return False
        for key in IMPORTED_KEYS:
            if key in old:
                self.cfg[key] = old[key]
        # Every world and the server's pack folders are scanned anyway, so they don't need to be library folders
        server = str(self.server.resolve()).lower()
        self.cfg["sources"] = [s for s in (self.cfg.get("sources") or []) if os.path.exists(s) and not str(Path(s).resolve()).lower().startswith(server)]
        log(f"Imported your Mod Loader settings from {path}.", "ok")
        return True

    def _save(self):
        self.cfg["ticked"] = sorted(self.ticked)
        self.cfg["ignored_updates"] = sorted(self.ignored)
        err = E.save_config(self.cfg)
        if err:
            log(f"Couldn't save the mod settings: {err}", "err")

    def config(self):
        c = {k: self.cfg.get(k) for k in SETTABLE}
        c.update(sources=list(self.cfg.get("sources") or []), profiles=self.cfg.get("profiles") or {},
                 aliases=self.cfg.get("aliases") or {}, ignored=len(self.ignored), world=self.world)
        return c

    def config_set(self, key, value):
        kind = SETTABLE.get(key)
        if kind is None or not isinstance(value, kind):
            raise ValueError("That setting can't be changed.")
        if key == "accent" and not ACCENT.match(value):
            raise ValueError("That isn't a colour.")
        self.cfg[key] = value
        if key == "skip_folders":
            E.set_scan_skip(value)
        elif key == "backup_json":
            E.BACKUP_JSON = value
        elif key == "write_log":
            E.WRITE_LOG = value
        self._save()
        return self.config()

    # ------------------------------------------------------------------ worlds
    def _world_exists(self, name):
        try:
            self._world_path(name)
            return True
        except ValueError:
            return False

    def _world_path(self, name=None):
        name = self.world if name is None else str(name)
        if not name or name in (".", "..") or "/" in name or "\\" in name or ":" in name:
            raise ValueError("Pick a world first.")
        path = self.worlds_dir / name
        if not (path / "level.dat").is_file():
            raise ValueError(f"The world \"{name}\" isn't in the server's worlds folder.")
        return path

    def _world_folders(self):
        try:
            entries = sorted(self.worlds_dir.iterdir(), key=lambda p: p.name.lower())
        except OSError:
            return []
        return [w for w in entries if w.is_dir() and not w.name.startswith(".hub-clone") and not WORLD_BACKUP.search(w.name) and (w / "level.dat").is_file() and (w / "db").is_dir()]

    def worlds(self):
        out = []
        for path in self._world_folders():
            info = E.world_info(path)
            lists = E.world_pack_lists(path)
            icon = ""
            for name, kind in (("world_icon.jpeg", "jpeg"), ("world_icon.jpg", "jpeg"), ("world_icon.png", "png")):
                f = path / name
                try:
                    if f.is_file() and f.stat().st_size < 1_500_000:
                        icon = data_url(f.read_bytes(), kind)
                        break
                except OSError:
                    pass
            out.append({"folder": path.name, "path": str(path), "name": clean(info.name), "mode": info.mode, "difficulty": info.difficulty,
                        "lastPlayed": info.last_played.timestamp() * 1000 if info.last_played else None, "version": info.version,
                        "experiments": info.experiments, "behavior": len(lists["behavior"]), "resource": len(lists["resource"]),
                        "icon": icon})
        out.sort(key=lambda w: -(w["lastPlayed"] or 0))
        return {"worlds": out, "selected": self.world}

    def world_select(self, folder):
        self._world_path(folder)
        self.world = str(folder)
        self.cfg["world"] = self.world
        self._save()
        self._update_changes()
        return self.mods_view()

    def _installed_all(self):
        out = {}
        if self.server.is_dir():
            for mode in ("standard", "development"):
                out.update(E.scan_installed(self.server, mode))
        if self.world and self._world_exists(self.world):
            out.update(E.scan_installed(self._world_path(), "standard"))
        return out

    def _pack_name(self, uuid, world_names, installed):
        for p in self.packs:
            if p.uuid == uuid and not p.superseded:
                return p.name, "Library"
        if uuid in world_names:
            return world_names[uuid], "This world"
        if uuid in installed:
            return installed[uuid].name, "Server folder"
        return None, "Missing"

    def world_packs(self, folder):
        path = self._world_path(folder)
        lists = E.world_pack_lists(path)
        names = {u: i.name for u, i in E.scan_installed(path, "standard").items()}
        installed = {}
        for mode in ("standard", "development"):
            installed.update(E.scan_installed(self.server, mode))
        in_library = {p.uuid for p in self.packs if getattr(p, "in_library", False)}
        out = {}
        for kind in KINDS:
            out[kind] = []
            for uuid, ver in lists[kind]:
                name, where = self._pack_name(uuid, names, installed)
                out[kind].append({"uuid": uuid, "version": E.vstr(ver), "name": clean(name) if name else f"Not found ({uuid[:8]})", "where": where, "missing": name is None, "inLibrary": uuid in in_library})
        out["hasOriginal"] = any((path / (f + ".bak_addonloader")).exists() for f in ("world_behavior_packs.json", "world_resource_packs.json"))
        out["lastWins"] = bool(self.cfg["last_wins"])
        return out

    def world_save_packs(self, folder, behavior, resource):
        path = self._world_path(folder)
        current = E.world_pack_lists(path)
        for kind, ids in (("behavior", behavior), ("resource", resource)):
            versions = dict(current[kind])
            E.write_world_list(path, kind, [(str(u), versions[str(u)]) for u in ids if str(u) in versions])
        log(f"Saved the pack list of world '{E.world_info(path).name}'.", "ok")
        self._update_changes()
        return {"world": path.name}

    def world_restore(self, folder):
        path = self._world_path(folder)
        restored = 0
        for name in ("world_behavior_packs.json", "world_resource_packs.json"):
            bak = path / (name + ".bak_addonloader")
            if bak.exists():
                E.write_text_safely(path / name, bak.read_text(encoding="utf-8"))
                restored += 1
        if not restored:
            raise ValueError("No saved original found. A copy is made the first time a world's pack lists are edited.")
        log(f"Original pack lists restored for world '{E.world_info(path).name}'.", "ok")
        self._update_changes()
        return {"world": path.name}

    def _backup_dir(self):
        return self.cfg.get("backup_dir") or str(self.server / "backups")

    def world_backup(self, folder):
        path = self._world_path(folder)
        log(f"Backing up world '{E.world_info(path).name}'...", "info")
        out = E.backup_world(path, self._backup_dir())
        log(f"Backup written: {out}", "ok")
        return {"file": str(out)}

    def _set_names(self, path, name):
        """The name shown in game and in the world list. level.dat is only rewritten if it stays otherwise identical."""
        dat = path / "level.dat"
        try:
            new = with_level_name(dat.read_bytes(), name)
        except Exception as e:
            log(f"level.dat in '{path.name}' couldn't be updated ({e}), so only levelname.txt has the new name.", "warn")
        else:
            tmp = dat.with_name("level.dat.hubtmp")
            tmp.write_bytes(new)
            os.replace(tmp, dat)
        E.write_text_safely(path / "levelname.txt", name)

    def world_clone(self, folder, name):
        src = self._world_path(folder)
        name = world_name(name)
        need = sum(f.stat().st_size for f in src.rglob("*") if f.is_file())
        free = shutil.disk_usage(self.worlds_dir).free
        if need * 1.1 > free:
            raise ValueError(f"Not enough disk space: about {E.human_size(need)} needed, {E.human_size(free)} free.")
        dest = E._unique_dir(self.worlds_dir, folder_for(name))
        tmp = E._unique_dir(self.worlds_dir, f".hub-clone-{os.getpid()}")
        log(f"Cloning world '{clean(E.world_info(src).name)}' as '{name}'...", "info")
        try:
            shutil.copytree(E.lp(src), E.lp(tmp))
            self._set_names(tmp, name)
            E.replace_dir(tmp, dest)
        except Exception:
            if tmp.exists():
                E.rmtree(tmp)
            raise
        log(f"Cloned as '{name}' in the folder {dest.name}. It uses its own copy of the packs inside the world.", "ok")
        return {"folder": dest.name, "name": name}

    def world_rename(self, folder, name):
        src = self._world_path(folder)
        name = world_name(name)
        wanted = folder_for(name)
        if wanted.lower() == src.name.lower():
            dest = self.worlds_dir / wanted           # same folder, or only its capitals change
        else:
            dest = E._unique_dir(self.worlds_dir, wanted)
        if dest.name != src.name:
            E.replace_dir(src, dest)                  # first, since an open folder is what usually refuses this
        self._set_names(dest, name)
        if self.world == src.name:
            self.world = dest.name
            self.cfg["world"] = self.world
            self._save()
        log(f"Renamed world '{src.name}' to '{name}' (folder {dest.name}).", "ok")
        return {"folder": dest.name, "name": name, "oldFolder": src.name}

    def world_delete_check(self, folder):
        """What deleting a world would lose, so the question can say."""
        path = self._world_path(folder)
        embedded = E.scan_installed(path, "standard")
        library = {p.uuid for p in self.packs if getattr(p, "in_library", False)}
        elsewhere = set(E.scan_installed(self.server, "standard")) if self.server.is_dir() else set()
        for world in self._world_folders():
            if world.name != path.name:
                elsewhere |= set(E.scan_installed(world, "standard"))
        lost = sorted({clean(i.name) for u, i in embedded.items() if u not in library and u not in elsewhere})
        size = sum(f.stat().st_size for f in path.rglob("*") if f.is_file())
        return {"name": clean(E.world_info(path).name), "onlyHere": lost, "size": E.human_size(size)}

    def world_delete(self, folder):
        path = self._world_path(folder)
        name = clean(E.world_info(path).name)
        L.recycle(path)
        if self.world == path.name:
            self.world = ""
            self.cfg["world"] = ""
            self._save()
        log(f"Deleted world '{name}' (moved to the Recycle Bin).", "ok")
        self.scan()
        return {"folder": path.name, "name": name}

    def world_remove_packs(self, folder, uuids):
        """Stop a world using these packs, and delete the world's own copies of them. The library isn't touched."""
        path = self._world_path(folder)
        ids = {str(u) for u in uuids}
        embedded = E.scan_installed(path, "standard")
        found = []
        n = E.remove_from_world(path, ids, log)
        for uuid in ids:
            inst = embedded.get(uuid)
            if inst:
                try:
                    E.rmtree(inst.folder)
                    log(f"- removed {inst.name} from world '{path.name}'", "ok")
                except Exception as e:
                    short, hint = E.explain_error(e)
                    found.append((inst.name, f"{short} Try: {hint}", uuid))
        self.scan()
        self._update_changes()
        return {"removed": n, "world": path.name, "problems": problems(found)}

    # ------------------------------------------------------------------ backups of worlds
    def _backup_entries(self):
        """Every backup there is: zips and folders in the backup folders, and dated copies beside the worlds."""
        seen, out = set(), []
        roots = [Path(self._backup_dir()), self.server / "backups"]
        for path in roots:
            try:
                key = str(path.resolve()).lower()
                if key in seen or not path.is_dir():
                    continue
                seen.add(key)
                out += [e for e in path.iterdir() if e.is_dir() or e.suffix.lower() in (".zip", ".mcworld")]
            except OSError:
                pass
        try:
            out += [w for w in self.worlds_dir.iterdir() if w.is_dir() and WORLD_BACKUP.search(w.name)]
        except OSError:
            pass
        # AutoSave's copies from before and after each world's last session
        try:
            for world in (self.server / "backups" / "AutoSave").iterdir():
                for kind in ("pregameplay", "postgameplay", "replaced"):
                    if (world / kind / "level.dat").is_file():
                        out.append(world / kind)
        except OSError:
            pass
        return out

    @staticmethod
    def _backup_id(path):
        return hashlib.sha1(str(path).lower().encode("utf-8", "replace")).hexdigest()

    def backups(self):
        rows = []
        for path in self._backup_entries():
            try:
                st = path.stat()
                if path.is_dir():
                    if not (path / "level.dat").is_file():
                        continue
                    name = clean(E.world_info(path).name)
                    size = sum(f.stat().st_size for f in path.rglob("*") if f.is_file())
                else:
                    with zipfile.ZipFile(E.lp(path)) as z:
                        members = [m for m in z.namelist() if m.replace("\\", "/").split("/")[-1] == "level.dat"]
                        if not members:
                            continue
                        base = min(members, key=lambda m: m.count("/"))[:-len("level.dat")]
                        try:
                            name = clean(z.read(base + "levelname.txt").decode("utf-8", "replace")) or path.stem
                        except KeyError:
                            name = path.stem
                    size = st.st_size
            except (OSError, zipfile.BadZipFile, ValueError):
                continue
            autosave = path.parent.parent.name == "AutoSave"
            label = {"pregameplay": "AutoSave: before the last session", "postgameplay": "AutoSave: after the last session", "replaced": "AutoSave: replaced by a cloud download"}.get(path.name) if autosave else ""
            if autosave:
                try:
                    meta = json.loads((path.parent / "world.json").read_text(encoding="utf-8"))
                    taken = (meta.get({"pregameplay": "pre", "postgameplay": "post"}.get(path.name, ""), {}) or {}).get("at")
                    if taken:
                        st = os.stat_result((st.st_mode, 0, 0, 0, 0, 0, st.st_size, 0, taken / 1000, 0))
                except (OSError, ValueError):
                    pass
            rows.append({"id": self._backup_id(path), "file": f"{path.parent.name}\\{path.name}" if autosave else path.name, "name": name, "label": label,
                         "date": st.st_mtime * 1000, "size": E.human_size(size), "where": str(path.parent)})
        rows.sort(key=lambda r: -r["date"])
        return {"backups": rows, "folder": self._backup_dir()}

    def _backup_path(self, id):
        for path in self._backup_entries():
            if self._backup_id(path) == str(id):
                return path
        raise ValueError("That backup isn't there any more.")

    def world_load_backup(self, id, name):
        """A backup always loads as a new world, so nothing is overwritten."""
        src = self._backup_path(id)
        name = world_name(name)
        dest, _old = E.import_world(src, self.worlds_dir)
        wanted = E._unique_dir(self.worlds_dir, folder_for(name))
        E.replace_dir(dest, wanted)
        self._set_names(wanted, name)
        log(f"Loaded the backup {src.name} as a new world, '{name}'. The backup wasn't changed.", "ok")
        self.scan()
        return {"folder": wanted.name, "name": name}

    def backup_delete(self, id):
        path = self._backup_path(id)
        L.recycle(path)
        log(f"Deleted the backup {path.name} (moved to the Recycle Bin).", "ok")
        return self.backups()

    def world_restore_packs(self, folder):
        """Put back packs a world lists but doesn't have, from the Mod Library. Cloud saves leave packs out."""
        path = self._world_path(folder)
        self.scan()
        library = self._library_packs()
        embedded = E.scan_installed(path, "standard")
        shared = E.scan_installed(self.server, "standard") if self.server.is_dir() else {}
        restored, missing, versions = [], [], {}
        for entries in E.world_pack_lists(path).values():
            for uuid, _listed in entries:
                if uuid in embedded or uuid in shared:
                    continue
                pack = library.get(uuid)
                if not pack:
                    missing.append(uuid)
                    continue
                state, msg, ver = E.install_pack(pack, path, "standard", True, embedded)
                if state == "failed":
                    missing.append(uuid)
                    log(f"Couldn't put {clean(pack.name)} back into '{path.name}': {msg}", "err")
                else:
                    restored.append(clean(pack.name))
                    versions[uuid] = ver
        if versions:
            E.bump_world_versions(path, versions, log)
            log(f"Put {len(restored)} packs back into '{path.name}' from the library.", "ok")
        self.scan()
        return {"restored": restored, "missing": missing}

    def world_import(self, src):
        dest, name = E.import_world(src, self.worlds_dir)
        safe = folder_for(dest.name)
        if safe != dest.name:
            moved = E._unique_dir(self.worlds_dir, safe)
            E.replace_dir(dest, moved)
            dest = moved
        log(f"Loaded world '{name}' into the server's worlds folder as {dest.name}. The original wasn't changed.", "ok")
        if not self.world:
            self.world = dest.name
            self.cfg["world"] = self.world
            self._save()
        return {"folder": dest.name, "name": clean(name)}

    # ------------------------------------------------------------------ the library
    def scan(self):
        issues = []
        packs = self.lib.scan(issues)
        for p in packs:
            p.label = f"Library: {Path(p.src_path).name}"
        for p in E.scan_minecraft_packs(self.server, issues) if self.server.is_dir() else []:
            if not BUILT_IN.match(Path(p.src_path).name):
                p.label = f"Server: {Path(p.src_path).parent.name}\\{Path(p.src_path).name}"
                packs.append(p)
        for world in self._world_folders():
            name = E.world_info(world).name
            for p in E.scan_minecraft_packs(world, issues):
                p.label = f"World: {name}"
                packs.append(p)
        E.mark_superseded(packs)
        self.packs = packs
        self.index_cache.clear()
        self.pack_cache.clear()
        self.scan_issues = [{"text": str(i), "path": i.path or "", "hint": i.hint or ""} for i in issues]
        self._group()
        return self.mods_view()

    def _add_saved_copies(self, packs, issues):
        """A mod stays in the library after its original file is deleted, from the copy saved here."""
        present = {p.uuid for p in packs}
        for uuid in list(self.store.records):
            if uuid in present:
                self.store.drop_saved(uuid)
                continue
            if not self.store.records[uuid]["versions"]:
                continue
            try:
                p = E.scan_pack_dir(self.store.saved_copy(uuid), issues)
            except Exception as e:
                log(f"Couldn't restore the saved copy of {self.store.records[uuid]['name']}: {E.explain_error(e)[0]}", "warn")
                continue
            if p:
                p.label = "Saved copy in your library"
                p.saved = True
                packs.append(p)

    def _group(self):
        older = {}
        for p in self.packs:
            if p.superseded:
                older[p.uuid] = older.get(p.uuid, 0) + 1
        self.mods = E.group_mods([p for p in self.packs if not p.superseded])
        for m in self.mods:
            m.older = sum(older.get(u, 0) for u in m.uuids)

    def _maps(self):
        server = E.scan_installed(self.server, "standard") if self.server.is_dir() else {}
        embedded, active = {}, set()
        if self.world and self._world_exists(self.world):
            path = self._world_path()
            embedded = E.scan_installed(path, "standard")
            active = E.world_active_uuids(path)
        return server, embedded, active

    def _change_of(self, pack, ignored=False):
        ch = self.changes.get(pack.uuid)
        if not ch or ch.kind == "same":
            return None
        if not ignored and self._ignore_key(pack, ch) in self.ignored:
            return None
        return ch

    @staticmethod
    def _ignore_key(pack, ch):
        return f"{pack.uuid}@{E.vstr(ch.lib_version)}@{ch.kind}"

    def _status(self, m, merged, active):
        supported = [p for p in m.packs if p.supported]
        if not supported:
            return "muted", "Not supported"
        tags = [E.status_of(p, merged)[0] for p in supported]
        if any(self._change_of(p) and self._change_of(p).kind == "content" for p in supported) and all(t in ("installed", "update") for t in tags):
            return "update", "Edited since install"
        if "update" in tags and "new" not in tags:
            return "update", "Update available"
        if "new" in tags and any(t != "new" for t in tags):
            return "update", "Partly installed"
        if all(t == "new" for t in tags):
            return "new", "Not installed"
        if all(t == "newer" for t in tags):
            return "newer", "Newer installed"
        return ("active", "In this world") if any(p.uuid in active for p in supported) else ("installed", "Installed, not in this world")

    def _mod_id(self, m):
        return min(m.uuids)

    def _mod_view(self, m, server, embedded, active):
        merged = {**server, **embedded}
        meta = (self.cfg.get("meta") or {}).get(self._mod_id(m), {})
        tag, text = self._status(m, merged, active)
        ids = [p.uuid for p in m.packs if p.supported]
        unnamed = not all(p.named for p in m.packs)
        ns = next((self.guesses.get(p.key, ("", ""))[0] for p in m.packs if not p.named and self.guesses.get(p.key, ("", ""))[0]), "")
        return {
            "id": self._mod_id(m), "name": clean(m.name), "unnamed": unnamed, "namespace": ns, "contents": m.contents, "version": m.version,
            "older": m.older, "uuids": m.uuids, "supported": ids,
            "ticked": sum(1 for u in ids if u in self.ticked), "statusTag": tag, "statusText": text,
            "inWorld": sum(1 for u in ids if u in active), "onServer": any(u in server for u in ids),
            "inWorldFiles": any(u in embedded for u in ids), "fav": bool(meta.get("fav")), "tags": meta.get("tags", []),
            "note": meta.get("note", ""), "mtime": max((p.mtime for p in m.packs), default=0),
            "source": m.packs[0].label if m.packs else "",
            "description": clean(next((p.description for p in m.packs if p.description), "")),
        }

    def mods_view(self):
        server, embedded, active = self._maps()
        return {"mods": [self._mod_view(m, server, embedded, active) for m in self.mods], "world": self.world,
                "issues": self.scan_issues, "ticked": sorted(self.ticked), "updates": self._updates_view()["count"]}

    def changes_scan(self):
        self._update_changes(guess=True)
        return self.mods_view()

    def _update_changes(self, guess=False):
        self.changes = {}
        if not self.packs or not self.server:
            return
        server, embedded, _ = self._maps()
        merged = {**server, **embedded}
        if self.cfg["check_changes"]:
            for p in self.packs:
                if p.superseded or p.origin != "source" or not p.supported or p.uuid not in merged:
                    continue
                inst = merged[p.uuid]
                try:
                    if p.src_kind == "dir" and Path(p.src_path).resolve() == Path(inst.folder).resolve():
                        continue
                except OSError:
                    pass
                ch = E.compare_with_installed(p, inst.folder, inst.version)
                if ch.kind != "same" or ch.error:
                    self.changes[p.uuid] = ch
        if guess:
            for p in self.packs:
                if not p.superseded and not p.named and p.key not in self.guesses:
                    try:
                        info = E.inspect_pack(p)
                        self.guesses[p.key] = (next(iter(info.namespaces), ""), info.guess)
                    except Exception:
                        pass

    def icons(self, ids):
        out = {}
        wanted = set(ids)
        for m in self.mods:
            mid = self._mod_id(m)
            if mid in wanted:
                raw = b""
                for p in m.packs:
                    raw = E.read_pack_icon(p)
                    if raw:
                        break
                out[mid] = data_url(raw)
        return out

    def ticks_set(self, uuids):
        self.ticked = {str(u) for u in uuids}
        self._save()
        return {"ticked": sorted(self.ticked)}

    def meta_set(self, id, **fields):
        id = str(id)
        meta = self.cfg.setdefault("meta", {})
        d = dict(meta.get(id, {}))
        d.update({k: v for k, v in fields.items() if k in ("fav", "tags", "note")})
        for k in ("fav", "note", "tags"):
            if not d.get(k):
                d.pop(k, None)
        if d:
            meta[id] = d
        else:
            meta.pop(id, None)
        self._save()
        return self.mods_view()

    def label_set(self, uuid, name):
        uuid, name = str(uuid).lower(), str(name).strip()
        aliases = self.cfg.setdefault("aliases", {})
        if name:
            aliases[uuid] = name[:80]
            E.ALIASES[uuid] = name[:80]
        else:
            aliases.pop(uuid, None)
            E.ALIASES.pop(uuid, None)
        self._save()
        return self.scan()

    def profiles_save(self, name, uuids):
        name = str(name).strip()[:60]
        if not name:
            raise ValueError("Give the profile a name.")
        known = {p.uuid: p.name for p in self.packs}
        ids = [str(u) for u in uuids]
        self.cfg.setdefault("profiles", {})[name] = {"uuids": ids, "names": {u: known.get(u, "") for u in ids}, "saved": time.time()}
        self._save()
        return self.config()

    def profiles_delete(self, name):
        (self.cfg.get("profiles") or {}).pop(str(name), None)
        self._save()
        return self.config()

    # ------------------------------------------------------------------ compatibility and load order
    def _chosen(self, uuids=None):
        wanted = self.ticked if uuids is None else {str(u) for u in uuids}
        return [p for p in self.packs if not p.superseded and p.supported and p.uuid in wanted]

    def _world_pack_objects(self, installed):
        if not self.world or not self._world_exists(self.world):
            return []
        lib = {p.uuid: p for p in self.packs if not p.superseded}
        out = []
        for lst in E.world_pack_lists(self._world_path()).values():
            for uuid, _ in lst:
                p = lib.get(uuid)
                if p is None and uuid in installed:
                    key = str(installed[uuid].folder)
                    if key not in self.pack_cache:
                        self.pack_cache[key] = E.scan_pack_dir(installed[uuid].folder, [])
                    p = self.pack_cache[key]
                if p is not None:
                    out.append(p)
        return out

    def analyze(self, mode=None, order=None, gameVersion=""):
        installed = self._installed_all()
        seen = {p.uuid: p for p in self._chosen()}
        for p in self._world_pack_objects(installed):
            seen.setdefault(p.uuid, p)
        packs = [p for p in seen.values() if p.kind in KINDS]
        names = {p.uuid: clean(p.name) for p in packs}
        versions = {p.uuid: E.vstr(p.version) for p in packs}

        current = E.world_pack_lists(self._world_path()) if self.world and self._world_exists(self.world) else {"behavior": [], "resource": []}
        world_ids = {k: [u for u, _ in v] for k, v in current.items()}
        order_in = {k: list((order or world_ids).get(k) or []) for k in KINDS}

        by_kind, idx = {}, {}
        for p in packs:
            if p.key not in self.index_cache:
                self.index_cache[p.key] = E.index_pack(p)
            idx[p.uuid] = self.index_cache[p.key]
            by_kind.setdefault("behavior" if p.kind == "behavior" else "resource", []).append(p)

        mod_of = {p.uuid: m.key for m in self.mods for p in m.packs}
        last_wins = bool(self.cfg["last_wins"])
        auto = bool(self.cfg["auto_order"])
        pick = mode if mode in ("scratch", "repair", "slot") else None
        if not pick and not order and auto and self.cfg["auto_fix_order"]:
            pick = "repair"
        have = any(order_in.values())
        plan_mode = pick or ("slot" if (auto and have) or not auto else "scratch")
        plan = E.plan_orders(by_kind, idx, order_in, plan_mode, last_wins, mod_of)
        out_order = plan.order if (pick or auto) else E.reconcile_order(by_kind, order_in, auto, last_wins, idx, mod_of)
        out_order.setdefault("behavior", [])
        out_order.setdefault("resource", [])
        self.last_order = {k: list(v) for k, v in out_order.items()}

        text = str(self.cfg.get("game_version") or gameVersion or "").strip()
        game = E.to_version(text) if re.match(r"^\d+(\.\d+)*$", text) else None
        lib = {p.uuid for p in self.packs}
        known = list(self.packs) + [p for p in packs if p.uuid not in lib]
        experiments = set(E.world_info(self._world_path()).experiments) if self.world and self._world_exists(self.world) else None
        issues = E.analyze(packs, idx, installed, known, game, out_order, last_wins, mod_of, experiments) if packs else []

        def row(uuid, kind):
            return {"uuid": uuid, "name": names.get(uuid, f"Not found ({uuid[:8]})"), "version": versions.get(uuid, ""),
                    "inWorld": uuid in world_ids.get(kind, []), "moved": plan.moved.get(uuid, ""),
                    "reason": (plan.reasons.get(uuid) or [""])[0]}
        return {
            "issues": [{"sev": i.sev, "title": i.title, "detail": i.detail, "uuids": list(i.uuids)} for i in issues],
            "order": {k: [row(u, k) for u in out_order.get(k, [])] for k in KINDS},
            # Saving only re-orders what the world lists, so ticked packs that aren't added yet don't count as a change
            "changed": any([u for u in out_order.get(k, []) if u in world_ids.get(k, [])] != [u for u in world_ids.get(k, []) if u in out_order.get(k, [])] for k in KINDS),
            "violations": plan.violations, "lastWins": last_wins, "gameVersion": text,
            "unresolved": [str(x[-1]) for x in plan.unresolved[:8]],
        }

    def save_order(self, order):
        path = self._world_path()
        current = E.world_pack_lists(path)
        versions = {u: v for lst in current.values() for u, v in lst}
        for p in self.packs:
            if not p.superseded and p.uuid not in versions:
                versions[p.uuid] = p.version
        # Only packs the world already lists are re-ordered. Adding a pack is a separate step.
        kept = {k: [str(u) for u in (order.get(k) or []) if str(u) in dict(current[k])] for k in KINDS}
        E.apply_world_order(path, kept, versions, bool(self.cfg["last_wins"]), log)
        self._update_changes()
        return {"world": path.name}

    # ------------------------------------------------------------------ installing and removing
    def _copy_into_world(self):
        return bool(self.cfg["force_world_copy"])

    def plan(self, uuids, target="world", force=False):
        packs = self._chosen(uuids)
        if target == "world":
            path = self._world_path()
            packs = [p for p in packs if p.kind in KINDS]
            root = path if self._copy_into_world() else self.server
            force = force or self._copy_into_world() or bool(self.cfg["force"])
        else:
            root = self.server
            force = force or bool(self.cfg["force"])
        installed = E.scan_installed(root, "standard")
        rows = [{"name": clean(p.name), "kind": E.KIND_LABEL.get(p.kind, p.kind), "action": a, "detail": d}
                for p, a, d in E.plan_for(packs, installed, force, self.changes)]
        return {"rows": rows, "problems": [{"sev": s, "text": t} for s, t in E.preflight(root, packs)],
                "confirm": bool(self.cfg["confirm_plan"]), "confirmErrors": bool(self.cfg["confirm_errors"])}

    def add_to_world(self, uuids, order=None):
        path = self._world_path()
        chosen = self._chosen(uuids)
        skipped = [p for p in chosen if p.kind not in KINDS]
        if skipped:
            log("Skin packs can't be added to a world and were left out.", "warn")
        chosen = [p for p in chosen if p.kind in KINDS]
        if not chosen:
            raise ValueError("Tick at least one behavior or resource pack first.")
        copy = self._copy_into_world()
        root = path if copy else self.server
        force = True if copy else bool(self.cfg["force"])
        lw = bool(self.cfg["last_wins"])
        use_order = order or self.last_order
        existing = {u for lst in E.world_pack_lists(path).values() for u, _ in lst}
        if self.cfg["backup_world"]:
            log(f"Backup written: {E.backup_world(path, self._backup_dir())}", "ok")
        counts = E.install_many(chosen, self.packs, root, "standard", force, [path], log, order=use_order, last_wins=lw)
        inst = E.scan_installed(root, "standard")
        versions = {u: i.version for u, i in inst.items()}
        good = set(inst) | existing
        E.apply_world_order(path, {k: [u for u in v if u in good] for k, v in use_order.items()}, versions, lw, log)
        self._update_changes()
        counts["problems"] = problems(counts["problems"])
        counts["world"] = path.name
        return counts

    def remove_from_world(self, uuids):
        path = self._world_path()
        ids = {str(u) for u in uuids}
        embedded = E.scan_installed(path, "standard")
        chosen = [p for p in self.packs if not p.superseded and p.uuid in ids]
        inside = [p for p in chosen if p.uuid in embedded]
        n = E.remove_from_world(path, ids, log)
        if inside:
            E.uninstall_many(inside, path, "standard", [], log)
        self._update_changes()
        # The library copy may have been the one that was just deleted
        self.scan()
        return {"removed": n, "world": path.name}

    def install_server(self, uuids):
        chosen = self._chosen(uuids)
        if not chosen:
            raise ValueError("Tick some mods first.")
        counts = E.install_many(chosen, self.packs, self.server, "standard", bool(self.cfg["force"]), [], log,
                                order=self.last_order, last_wins=bool(self.cfg["last_wins"]))
        self._update_changes()
        counts["problems"] = problems(counts["problems"])
        return counts

    def usage(self, uuids):
        ids = {str(u) for u in uuids}
        out = []
        for world in self._world_folders():
            if ids & E.world_active_uuids(world):
                out.append({"folder": world.name, "name": clean(E.world_info(world).name)})
        return {"worlds": out}

    def uninstall_server(self, uuids, alsoWorlds=False):
        ids = {str(u) for u in uuids}
        chosen = [p for p in self.packs if not p.superseded and p.uuid in ids]
        found = []
        n = E.uninstall_many(chosen, self.server, "standard", [], log, found)
        if alsoWorlds:
            for world in self._world_folders():
                E.remove_from_world(world, ids, log)
        self.scan()
        return {"removed": n, "problems": problems(found)}

    # ------------------------------------------------------------------ updates
    def _updates_view(self, show_ignored=False):
        rows, count = [], 0
        for m in self.mods:
            items = [(p, self._change_of(p, ignored=show_ignored)) for p in m.packs]
            items = [(p, c) for p, c in items if c]
            if not items:
                continue
            kinds = {c.kind for _, c in items}
            kind = "version" if "version" in kinds else ("content" if "content" in kinds else "older")
            if kind != "older":
                count += 1
            rows.append({
                "id": self._mod_id(m), "name": clean(m.name), "kind": kind,
                "what": {"version": "New version", "content": "Edited, same version", "older": "Installed is newer"}[kind],
                "installed": " / ".join(sorted({E.vstr(c.inst_version) for _, c in items})),
                "library": " / ".join(sorted({E.vstr(c.lib_version) for _, c in items})),
                "added": sum(len(c.added) for _, c in items), "removed": sum(len(c.removed) for _, c in items),
                "changed": sum(len(c.changed) for _, c in items),
                "ignored": all(self._ignore_key(p, c) in self.ignored for p, c in items),
            })
        return {"rows": rows, "count": count, "checking": False, "enabled": bool(self.cfg["check_changes"])}

    def updates(self, showIgnored=False):
        return self._updates_view(bool(showIgnored))

    def update_detail(self, id):
        server, embedded, _ = self._maps()
        merged = {**server, **embedded}
        out = []
        for m in self.mods:
            if self._mod_id(m) != id:
                continue
            for p in m.packs:
                ch = self._change_of(p, ignored=True)
                if not ch:
                    continue
                inst = merged.get(p.uuid)
                notes, added, removed = E.manifest_notes(p, inst.folder) if inst else ([], [], [])
                out.append({"name": clean(p.name), "kind": E.KIND_LABEL.get(p.kind, p.kind), "change": ch.kind,
                            "installed": E.vstr(ch.inst_version), "library": E.vstr(ch.lib_version), "error": ch.error,
                            "notes": notes, "addsContent": added[:12], "removesContent": removed[:12],
                            "addedFiles": ch.added[:14], "removedFiles": ch.removed[:14], "changedFiles": ch.changed[:14],
                            "moreFiles": max(0, len(ch.added) - 14) + max(0, len(ch.removed) - 14) + max(0, len(ch.changed) - 14)})
        return {"packs": out}

    def update_ignore(self, ids):
        wanted = {str(i) for i in ids}
        for m in self.mods:
            if self._mod_id(m) not in wanted:
                continue
            for p in m.packs:
                ch = self._change_of(p, ignored=True)
                if ch:
                    self.ignored.symmetric_difference_update({self._ignore_key(p, ch)})
        self._save()
        return self.mods_view()

    def update_apply(self, ids, downgrade=False):
        wanted = {str(i) for i in ids}
        server, embedded, _ = self._maps()
        todo = []
        for m in self.mods:
            if self._mod_id(m) not in wanted:
                continue
            for p in m.packs:
                ch = self._change_of(p)
                if ch and (ch.kind != "older" or downgrade):
                    todo.append(p)
        if not todo:
            raise ValueError("Nothing to update. Ignored updates and downgrades are skipped.")
        total = {"installed": 0, "updated": 0, "skipped": 0, "failed": 0, "problems": []}
        vers = {p.uuid: p.version for p in todo}
        lw = bool(self.cfg["last_wins"])
        in_world = [p for p in todo if p.uuid in embedded]
        shared = [p for p in todo if p.uuid not in embedded]
        for root, packs in ((self._world_path() if self.world else None, in_world), (self.server, shared)):
            if packs and root:
                c = E.install_many(packs, self.packs, root, "standard", True, [], log, last_wins=lw)
                for key in ("installed", "updated", "skipped", "failed"):
                    total[key] += c[key]
                total["problems"] += c["problems"]
        worlds = []
        if in_world and self.world:
            worlds.append(self._world_path())
        if self.cfg["update_worlds"] and shared:
            worlds += [w for w in self._world_folders() if w not in worlds]
        for world in worlds:
            lists = E.world_pack_lists(world)
            if any(u in vers for k in lists for u, _ in lists[k]):
                try:
                    E.bump_world_versions(world, vers, log)
                except Exception as e:
                    short, hint = E.explain_error(e)
                    log(f"  ! could not update versions in world '{world.name}': {short} Try: {hint}", "err")
                    total["problems"].append((f"World '{world.name}'", f"{short} Try: {hint}", ""))
        self._update_changes()
        total["problems"] = problems(total["problems"])
        total["world"] = self.world if in_world and not shared else None
        return total

    # ------------------------------------------------------------------ the library, needing no world
    def _usage(self):
        """uuid -> every world that lists it, and which copy that world actually loads."""
        shared = E.scan_installed(self.server, "standard") if self.server.is_dir() else {}
        usage = {}
        for world in self._world_folders():
            embedded = E.scan_installed(world, "standard")
            name = clean(E.world_info(world).name)
            for kind, entries in E.world_pack_lists(world).items():
                for uuid, listed in entries:
                    inst = embedded.get(uuid) or shared.get(uuid)
                    usage.setdefault(uuid, []).append({"folder": world.name, "name": name, "kind": kind, "listed": listed, "copy": inst,
                                                       "where": "world" if uuid in embedded else ("server" if uuid in shared else "missing")})
        return usage, shared

    def _library_packs(self):
        return {p.uuid: p for p in self.packs if getattr(p, "in_library", False)}

    def library_check(self):
        """Tidy up after anything done outside the app: the old version store, and files put straight into the folder."""
        moved = self.lib.migrate_store(self.old_store) if self.old_store.is_dir() else 0
        unpacked = self.lib.take_in_dropped()
        updates = unpacked["changes"]
        if moved or unpacked["moved"] or updates:
            self.scan()
        return {"updates": updates, "moved": moved, "unpacked": unpacked["moved"],
                "changed": bool(moved or unpacked["moved"] or updates), "library": self.library_view()}

    def library_view(self):
        usage, shared = self._usage()
        in_lib = self._library_packs()
        unread = set(self.lib.index["unread"])
        rows = []
        for m in self.mods:
            meta = (self.cfg.get("meta") or {}).get(self._mod_id(m), {})
            used, behind, ahead = {}, set(), set()
            for p in m.packs:
                best = in_lib.get(p.uuid)
                for use in usage.get(p.uuid, []):
                    used[use["folder"]] = use["name"]
                    if best and use["copy"]:
                        if tuple(use["copy"].version) < tuple(best.version):
                            behind.add(use["folder"])
                        elif tuple(use["copy"].version) > tuple(best.version):
                            ahead.add(use["folder"])
            held = [p for p in m.packs if p.uuid in in_lib]
            rows.append({
                "id": self._mod_id(m), "name": clean(m.name), "contents": m.contents, "version": m.version, "uuids": m.uuids,
                "kinds": sorted({p.kind for p in m.packs}), "unnamed": not all(p.named for p in m.packs),
                "description": clean(next((p.description for p in m.packs if p.description), "")),
                "authors": sorted({a for p in m.packs for a in p.authors}), "source": m.packs[0].label if m.packs else "",
                "inLibrary": len(held) == len(m.packs), "partlyInLibrary": 0 < len(held) < len(m.packs),
                "worlds": [{"folder": k, "name": v} for k, v in used.items()], "onServer": any(p.uuid in shared for p in m.packs),
                "behind": sorted(behind), "ahead": sorted(ahead), "fresh": any(p.uuid in unread for p in m.packs),
                "updates": sum(len(self.lib.index["changes"].get(p.uuid, [])) for p in m.packs),
                "added": min((Path(p.src_path).stat().st_mtime * 1000 for p in held if Path(p.src_path).exists()), default=0),
                "mtime": max((p.mtime for p in m.packs), default=0), "fav": bool(meta.get("fav")), "tags": meta.get("tags", []), "note": meta.get("note", ""),
            })
        return {"mods": rows, "worlds": [{"folder": w.name, "name": clean(E.world_info(w).name)} for w in self._world_folders()],
                "storage": self.lib.storage(), "issues": self.scan_issues, "oldSources": self._old_sources()}

    def _mod_by_id(self, id):
        for m in self.mods:
            if self._mod_id(m) == str(id):
                return m
        raise ValueError("That mod isn't in the library any more.")

    def _copy_state(self, pack, inst):
        """How an installed copy compares with the one in the library."""
        best = self._library_packs().get(pack.uuid)
        if not best:
            return "unknown"
        have, want = tuple(inst.version), tuple(best.version)
        if have < want:
            return "behind"
        if have > want:
            return "ahead"
        try:
            return "current" if L.digest_of_folder(inst.folder) == self.lib.digest(best) else "edited"
        except OSError:
            return "unknown"

    def library_detail(self, id):
        m = self._mod_by_id(id)
        usage, shared = self._usage()
        in_lib = self._library_packs()
        worlds = {}
        packs = []
        for p in m.packs:
            used = []
            for use in usage.get(p.uuid, []):
                inst = use["copy"]
                used.append({"folder": use["folder"], "name": use["name"], "where": use["where"], "version": E.vstr(inst.version) if inst else E.vstr(use["listed"]),
                             "state": self._copy_state(p, inst) if inst else "missing"})
                worlds[use["folder"]] = use["name"]
            inst = shared.get(p.uuid)
            held = in_lib.get(p.uuid)
            size = None
            if held:
                try:
                    size = 0
                    for dp, dns, fns in os.walk(held.src_path):
                        dns[:] = [d for d in dns if d.lower() not in E.COPY_IGNORE]
                        size += sum(os.path.getsize(E.lp(Path(dp) / fn))
                                    for fn in fns if fn.lower() not in E.COPY_IGNORE)
                    size = E.human_size(size)
                except OSError:
                    pass
            packs.append({"uuid": p.uuid, "name": clean(p.name), "kind": E.KIND_LABEL.get(p.kind, p.kind), "version": E.vstr(p.version),
                          "file": Path(held.src_path).name if held else "", "fileSize": size, "libraryVersion": E.vstr(held.version) if held else "",
                          "source": p.label, "changes": self.lib.index["changes"].get(p.uuid, []), "unread": p.uuid in self.lib.index["unread"], "usage": used,
                          "server": {"version": E.vstr(inst.version), "state": self._copy_state(p, inst)} if inst else None})
        self.lib.save()     # digests worked out just now don't need working out again
        return {"id": self._mod_id(m), "name": clean(m.name), "packs": packs, "worlds": [{"folder": k, "name": v} for k, v in worlds.items()]}

    def library_review(self, id):
        self.lib.review(self._mod_by_id(id).uuids)
        return self.library_view()

    def library_apply(self, id, targets):
        """Install the library's copy of a mod on the server or into worlds that use it: an update, or a reinstall."""
        m = self._mod_by_id(id)
        in_lib = self._library_packs()
        chosen = [in_lib[p.uuid] for p in m.packs if p.uuid in in_lib and in_lib[p.uuid].supported]
        if not chosen:
            raise ValueError("This mod isn't in the library yet. Add it to the library first.")
        total = {"installed": 0, "updated": 0, "skipped": 0, "failed": 0, "problems": []}
        wanted = [str(t) for t in targets]
        if not wanted:
            raise ValueError("Choose where to put it.")
        folders = {w.name: w for w in self._world_folders()}
        for t in wanted:
            if t != "server" and t not in folders:
                raise ValueError(f"The world \"{t}\" isn't in the server's worlds folder.")
        backed_up = set()
        only_world = None
        for pack in E.order_by_deps(chosen):
            for target in wanted:
                world = folders.get(target)
                embedded = E.scan_installed(world, "standard") if world else {}
                inside = pack.uuid in embedded
                root = world if inside else self.server
                if world and self.cfg["backup_world"] and target not in backed_up:
                    log(f"Backup written: {E.backup_world(world, self._backup_dir())}", "ok")
                    backed_up.add(target)
                state, msg, _ver = E.install_pack(pack, root, "standard", True, E.scan_installed(root, "standard"))
                total[state] += 1
                log(f"{clean(pack.name)} {E.vstr(pack.version)}: {state} {msg}", "err" if state == "failed" else "ok")
                if state == "failed":
                    total["problems"].append((clean(pack.name), msg, pack.uuid))
                    continue
                # A copy in the server's folder is shared, so every world relying on it now uses this version
                listing = [world] if inside else [w for w in folders.values() if pack.uuid not in E.scan_installed(w, "standard")]
                for w in listing:
                    if any(pack.uuid == u for lst in E.world_pack_lists(w).values() for u, _ in lst):
                        E.bump_world_versions(w, {pack.uuid: pack.version}, log)
                only_world = world.name if inside and only_world in (None, world.name) else "*"
        self.scan()
        self._update_changes()
        total["problems"] = problems(total["problems"])
        total["world"] = None if only_world in (None, "*") else only_world
        return total

    def _inside(self, path, parent):
        try:
            Path(path).resolve().relative_to(Path(parent).resolve())
            return True
        except (ValueError, OSError):
            return False

    def _plan_import(self, paths):
        """What these files and folders hold, and how each mod compares with the library. Nothing is changed."""
        issues = []
        found = E.gather([str(p) for p in paths], issues, find_folders=True)
        items, rows = {}, []
        current = self.lib.current()
        groups = E.group_mods([p for p in found if not p.superseded]) + E.group_mods([p for p in found if p.superseded])
        for i, mod in enumerate(groups):
            packs = mod.packs
            sources = {str(p.src_path) for p in packs}
            archive = None
            if len(sources) == 1 and packs[0].src_kind == "zip":
                holds = {p.uuid for p in E.scan_archive(Path(packs[0].src_path), [])}
                if holds == {p.uuid for p in packs}:
                    archive = packs[0].src_path
            loose = any(p.src_kind == "dir" for p in packs)
            locked = any(self._inside(s, self.server) or self._inside(s, self.lib.folder) for s in sources)
            status = self.lib.status_of(packs, current)
            key = str(i)
            items[key] = {"name": mod.name, "packs": packs, "archive": archive, "status": status, "locked": locked or (not loose and not archive)}
            have = [current[p.uuid] for p in packs if p.uuid in current]
            rows.append({"key": key, "name": clean(mod.name), "contents": mod.contents, "version": mod.version, "status": status,
                         "libraryVersion": " / ".join(sorted({E.vstr(p.version) for p in have})), "loose": loose, "canMove": not items[key]["locked"],
                         "source": str(packs[0].src_path)})
        token = uuidlib.uuid4().hex
        self.pending = {token: items}
        return {"token": token, "rows": rows, "problems": [str(i) for i in issues]}

    def library_inspect(self, paths):
        return self._plan_import(paths)

    def _old_sources(self):
        """Folders the library used to read mods from. They are offered once, then forgotten."""
        return [s for s in (self.cfg.get("sources") or []) if os.path.exists(s) and not self._inside(s, self.server) and not self._inside(s, self.lib.folder)]

    def library_inspect_old(self):
        return self._plan_import(self._old_sources())

    def library_old_done(self):
        self.cfg["sources"] = []
        self._save()
        return self.library_view()

    def library_import(self, token, mode, keys):
        items = self.pending.pop(str(token), None)
        if items is None:
            raise ValueError("That list of mods is out of date. Choose them again.")
        if mode not in ("copy", "move"):
            raise ValueError("Choose Copy or Move.")
        out = {"added": 0, "updated": 0, "skipped": 0, "moved": 0, "changes": [], "problems": []}
        for key in [str(k) for k in keys]:
            item = items.get(key)
            if not item:
                continue
            label = clean(item["name"])
            try:
                if item["status"] == "same":
                    out["skipped"] += 1
                    log(f"{label} is already in the library.", "info")
                else:
                    changes = self.lib.put(item["name"], item["packs"], item["archive"])
                    out["changes"] += changes
                    out["updated" if item["status"] in ("update", "edited", "older") else "added"] += 1
                    log(f"{label}: {'updated in' if item['status'] != 'new' else 'added to'} the library.", "ok")
            except Exception as e:
                short, hint = E.explain_error(e)
                out["problems"].append({"name": label, "text": f"{short} {hint}".strip(), "uuid": ""})
                continue
            if mode == "move" and not item["locked"]:
                # Only once the library has it. Goes to the Recycle Bin, in case.
                sources = [item["archive"]] if item["archive"] else [p.src_path for p in item["packs"]]
                try:
                    for src in {str(s) for s in sources}:
                        L.recycle(src)
                    out["moved"] += 1
                except Exception as e:
                    out["problems"].append({"name": label, "text": f"It's in the library, but the original couldn't be removed: {E.explain_error(e)[0]}", "uuid": ""})
        self.scan()
        return out

    def library_adopt(self, id=None):
        """Copy mods that are only in worlds or on the server into the library. Those copies stay where they are."""
        in_lib = self._library_packs()
        out = {"added": 0, "updated": 0, "changes": [], "problems": []}
        for m in self.mods:
            if id is not None and self._mod_id(m) != str(id):
                continue
            # The packs that aren't there yet, or that an installed copy has overtaken
            todo = [p for p in m.packs if p.uuid not in in_lib or (tuple(p.version) > tuple(in_lib[p.uuid].version))]
            if not todo:
                continue
            try:
                updating = any(p.uuid in in_lib for p in todo)
                out["changes"] += self.lib.put(m.name, todo)
                out["updated" if updating else "added"] += 1
            except Exception as e:
                short, hint = E.explain_error(e)
                out["problems"].append({"name": clean(m.name), "text": f"{short} {hint}".strip(), "uuid": ""})
        self.scan()
        return out

    def library_delete(self, id, everywhere=False):
        m = self._mod_by_id(id)
        uuids = list(m.uuids)
        n = self.lib.delete(uuids)
        log(f"Removed {clean(m.name)} from the library (moved to the Recycle Bin).", "ok")
        problems_found = []
        if everywhere:
            E.uninstall_many(m.packs, self.server, "standard", [], log, problems_found)
            for world in self._world_folders():
                result = self.world_remove_packs(world.name, uuids)
                problems_found += [(p["name"], p["text"], p["uuid"]) for p in result["problems"]]
        self.scan()
        self._update_changes()
        # Taking it out of the library alone changes nothing the server loads
        return {"files": n, "world": None if everywhere else "", "problems": problems(problems_found), "library": self.library_view()}


    # ------------------------------------------------------------------ pack info
    def _pack_for(self, uuid):
        for p in self.packs:
            if p.uuid == uuid and not p.superseded:
                return p
        inst = self._installed_all().get(uuid)
        if inst and Path(inst.folder).is_dir():
            return E.scan_pack_dir(inst.folder, [])
        return None

    def pack_info(self, uuid):
        uuid = str(uuid).lower()
        p = self._pack_for(uuid)
        if not p:
            raise ValueError("That pack couldn't be found.")
        info = E.inspect_pack(p)
        installed = self._installed_all()
        kn = {x.uuid: x.name for x in self.packs}
        inst = installed.get(uuid)
        return {
            "uuid": p.uuid, "name": clean(p.name), "version": E.vstr(p.version), "kind": E.KIND_LABEL.get(p.kind, p.kind),
            "named": p.named, "nameSource": p.name_src, "description": clean(p.description), "authors": p.authors, "license": p.license,
            "url": p.url, "source": p.label, "sourcePath": str(p.src_path), "installedAt": str(inst.folder) if inst else "",
            "files": info.files, "size": E.human_size(info.size), "icon": data_url(info.icon or E.read_pack_icon(p)),
            "top": [list(t) for t in info.top], "idents": {k: v[:40] for k, v in info.idents.items()}, "namespaces": list(info.namespaces),
            "displayNames": info.display_names, "modules": [list(m) for m in info.modules], "deps": [{"id": d[0], "version": d[1], "name": clean(kn.get(str(d[0]).lower(), ""))} for d in info.deps],
            "scripts": info.scripts[:20], "minEngine": info.min_engine, "guess": info.guess, "error": info.error,
            "usedBy": [clean(E.world_info(w).name) for w in self._world_folders() if uuid in E.world_active_uuids(w)],
            "neededBy": sorted({clean(x.name) for x in self.packs if uuid in x.deps and not x.superseded}),
        }

    def pack_source(self, uuid):
        p = self._pack_for(str(uuid).lower())
        if not p:
            raise ValueError("That pack couldn't be found.")
        return {"path": str(p.src_path)}


METHODS = {
    "init": "init", "config": "config", "config.set": "config_set",
    "worlds": "worlds", "world.select": "world_select", "world.deleteCheck": "world_delete_check", "world.delete": "world_delete", "world.removePacks": "world_remove_packs",
    "backups": "backups", "world.loadBackup": "world_load_backup", "world.restorePacks": "world_restore_packs", "backups.delete": "backup_delete", "world.packs": "world_packs", "world.savePacks": "world_save_packs",
    "world.restore": "world_restore", "world.backup": "world_backup", "world.clone": "world_clone", "world.rename": "world_rename", "world.import": "world_import", "scan": "scan",
    "mods": "mods_view", "changes": "changes_scan", "icons": "icons", "ticks.set": "ticks_set", "meta.set": "meta_set",
    "label.set": "label_set", "profiles.save": "profiles_save", "profiles.delete": "profiles_delete", "analyze": "analyze",
    "order.save": "save_order", "plan": "plan", "mods.addToWorld": "add_to_world", "mods.removeFromWorld": "remove_from_world",
    "mods.install": "install_server", "mods.usage": "usage", "mods.uninstall": "uninstall_server", "updates": "updates",
    "updates.detail": "update_detail", "updates.ignore": "update_ignore", "updates.apply": "update_apply",
    "pack.info": "pack_info", "pack.source": "pack_source",
    "library": "library_view", "library.check": "library_check", "library.detail": "library_detail", "library.review": "library_review",
    "library.apply": "library_apply", "library.inspect": "library_inspect", "library.inspectOld": "library_inspect_old", "library.import": "library_import",
    "library.adopt": "library_adopt", "library.delete": "library_delete", "library.oldDone": "library_old_done",
}


def main():
    hub = Hub()
    emit({"event": "ready", "python": sys.version.split()[0]})
    for line in sys.stdin:
        if not line.strip():
            continue
        req_id = None
        try:
            req = json.loads(line)
            req_id = req.get("id")
            name = METHODS.get(req.get("method"))
            if not name:
                raise ValueError("Unknown request.")
            if not hub.server and name != "init":
                raise ValueError("The mod engine hasn't been set up yet.")
            emit({"id": req_id, "ok": True, "result": getattr(hub, name)(**(req.get("params") or {}))})
        except (ValueError, TypeError) as e:
            E.log_to_file(traceback.format_exc(), "err")
            emit({"id": req_id, "ok": False, "error": str(e)})
        except Exception as e:
            E.log_to_file(traceback.format_exc(), "err")
            short, hint = E.explain_error(e)
            emit({"id": req_id, "ok": False, "error": f"{short} {hint}"})
    return 0


if __name__ == "__main__":
    sys.exit(main())
