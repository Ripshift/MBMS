#!/usr/bin/env python3
"""
Bedrock Addon Loader
====================
Installs many Minecraft Bedrock add-ons (.mcaddon / .mcpack / .zip / pack folders)
in one go, so you do not have to import them one at a time and close Minecraft
between each one.

How it works: instead of asking Minecraft to import each file (which is what forces
the "one at a time" limit), this tool unzips every pack straight into the game's
data folder (behavior_packs / resource_packs) and, if you want, switches the packs
on in the worlds you pick. Works for the Windows game and for a Bedrock dedicated
server folder. Standard library only, no installs needed beyond Python 3.8+.

Run:   pythonw addon_loader.py          (or double-click "Addon Loader.bat")
CLI:   python addon_loader.py --cli --help
"""
import io
import json
import os
import queue
import re
import shutil
import stat
import struct
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import webbrowser
import zipfile
import zlib
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path, PurePosixPath
from urllib.parse import quote as urllib_quote

APP_NAME = "Bedrock Addon Loader"
APP_DIR = Path(__file__).resolve().parent
CONFIG_PATH = APP_DIR / "addon_loader_config.json"
LOG_PATH = APP_DIR / "addon_loader.log"
ARCHIVE_EXT = {".mcaddon", ".mcpack", ".zip"}
SKIP_DIR_NAMES = {"node_modules", "__pycache__", "__macosx"}
SKIP_PREFIXES = ("_", ".")
BACKUP_JSON = True          # keep a one-time .bak_addonloader of a world's pack list before editing it
PLURAL = {"entity": "entities", "item": "items", "block": "blocks", "recipe": "recipes", "biome": "biomes",
          "feature": "features", "feature_rule": "feature rules", "loot_table": "loot tables"}
ALIASES = {}                # pack uuid -> label the user gave it (used instead of a missing/unhelpful name)
WRITE_LOG = True


def set_scan_skip(spec):
    """spec: comma separated folder names; a trailing * means 'starts with' (e.g. "_*, .*, node_modules")."""
    global SKIP_PREFIXES
    prefixes, names = [], {"__pycache__", "__macosx"}
    for part in (spec or "").split(","):
        part = part.strip()
        if not part:
            continue
        if part.endswith("*"):
            if part[:-1]:
                prefixes.append(part[:-1])
        else:
            names.add(part.lower())
    SKIP_PREFIXES = tuple(prefixes) or ("\0",)
    SKIP_DIR_NAMES.clear()
    SKIP_DIR_NAMES.update(names)
COPY_IGNORE = {".git", ".vscode", "__pycache__", ".ds_store", "thumbs.db"}

# folder names inside the game data folder, per install mode
FOLDERS = {
    "standard": {"behavior": "behavior_packs", "resource": "resource_packs", "skin": "skin_packs"},
    "development": {"behavior": "development_behavior_packs", "resource": "development_resource_packs",
                    "skin": "development_skin_packs"},
}
KIND_LABEL = {"behavior": "Behavior", "resource": "Resource", "skin": "Skin", "template": "World template",
              "unknown": "Unknown"}


# --------------------------------------------------------------------------- helpers
def lp(path):
    """Long-path-safe string for Windows file calls."""
    p = str(path)
    if os.name == "nt" and not p.startswith("\\\\?\\"):
        p = os.path.abspath(p)
        if p.startswith("\\\\"):
            return "\\\\?\\UNC\\" + p[2:]
        return "\\\\?\\" + p
    return p


def rmtree(path):
    def fix(func, p, *_):
        os.chmod(p, stat.S_IWRITE)
        func(p)
    if sys.version_info >= (3, 12):
        shutil.rmtree(lp(path), onexc=fix)
    else:
        shutil.rmtree(lp(path), onerror=fix)


def parse_json_lenient(text):
    """Bedrock manifests in the wild often contain comments, BOMs and trailing commas."""
    text = text.lstrip("﻿")
    try:
        return json.loads(text)
    except ValueError:
        pass
    out, i, n, in_str = [], 0, len(text), False
    while i < n:
        c = text[i]
        if in_str:
            out.append(c)
            if c == "\\" and i + 1 < n:
                out.append(text[i + 1])
                i += 2
                continue
            if c == '"':
                in_str = False
            i += 1
            continue
        if c == '"':
            in_str = True
            out.append(c)
        elif c == "/" and text[i:i + 2] == "//":
            while i < n and text[i] not in "\r\n":
                i += 1
            continue
        elif c == "/" and text[i:i + 2] == "/*":
            j = text.find("*/", i + 2)
            i = n if j < 0 else j + 2
            continue
        else:
            out.append(c)
        i += 1
    return json.loads(re.sub(r",(\s*[}\]])", r"\1", "".join(out)))


def to_version(v):
    """[1,2,3] or "1.2.3" -> (1,2,3)"""
    try:
        if isinstance(v, str):
            v = re.findall(r"\d+", v)
        t = tuple(int(x) for x in v)[:3]
        return t + (0,) * (3 - len(t))
    except Exception:
        return (0, 0, 0)


def vstr(v):
    return ".".join(str(x) for x in v)


def safe_name(s, limit=40):
    s = re.sub(r"§.", "", s)
    s = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "", s).strip(" .")
    s = re.sub(r"\s+", " ", s)
    return (s[:limit].strip(" .")) or "pack"


def minecraft_running():
    if os.name != "nt":
        return False
    try:
        out = subprocess.run(["tasklist", "/FI", "IMAGENAME eq Minecraft.Windows.exe"], capture_output=True,
                             text=True, creationflags=0x08000000, timeout=5).stdout
        return "Minecraft.Windows.exe" in out
    except Exception:
        return False


# --------------------------------------------------------------------------- errors, logging, safe writes
class ScanIssue(str):
    """A problem found while scanning: text plus the file/folder it is about."""
    path = None
    hint = ""


def scan_issue(issues, path, msg, hint=""):
    s = ScanIssue(f"{Path(path).name}: {msg}")
    s.path, s.hint = str(path), hint
    issues.append(s)


def explain_error(e):
    """-> (short message, what to try). Turns Python/Windows errors into something a person can act on."""
    msg = str(e) or e.__class__.__name__
    win = getattr(e, "winerror", None)
    err = getattr(e, "errno", None)
    if isinstance(e, zipfile.BadZipFile):
        return "The file is not a valid zip (damaged or only partly downloaded).", \
            "Re-export or re-download the pack. A .mcaddon/.mcpack is a zip file."
    if isinstance(e, (json.JSONDecodeError, ValueError)) and "json" in msg.lower():
        return f"A JSON file is invalid: {msg}", "Open the file and fix the syntax error named above."
    if win == 32 or "being used by another process" in msg:
        return "A file is in use by another program.", "Close Minecraft (and any editor or Explorer window open in " \
            "that folder), then try again."
    if isinstance(e, PermissionError) or win == 5 or err == 13:
        return "Windows refused access to a file or folder.", "Close Minecraft, check the folder is not read-only, " \
            "and that the program is allowed to write there (try a folder outside Program Files)."
    if err == 28 or win == 112:
        return "The disk is full.", "Free some space on the drive that holds the Minecraft folder."
    if win in (206, 3) and "path" in msg.lower() or err == 36:
        return "A file path is too long for Windows.", "Move the Minecraft folder or the pack to a shorter path, " \
            "or shorten the pack's file names."
    if isinstance(e, FileNotFoundError):
        return f"A file or folder was not found: {getattr(e, 'filename', '') or msg}", \
            "It was moved or deleted after the scan. Press Rescan and try again."
    if isinstance(e, MemoryError):
        return "Ran out of memory reading a very large file.", "Close other programs or exclude that file."
    if isinstance(e, OSError):
        return f"Disk error: {msg}", "Check the drive is connected and not full or read-only."
    return f"{e.__class__.__name__}: {msg}", "If this keeps happening, copy the details and check addon_loader.log."


def log_to_file(msg, lvl="info"):
    if not WRITE_LOG:
        return
    try:
        if LOG_PATH.exists() and LOG_PATH.stat().st_size > 1_000_000:
            old = LOG_PATH.with_suffix(".old.log")
            if old.exists():
                old.unlink()
            LOG_PATH.replace(old)
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} [{lvl}] {msg}\n")
    except Exception:
        pass


def write_text_safely(path, text):
    """Write via a temp file and rename, so a crash or full disk never leaves a half-written file behind."""
    path = Path(path)
    tmp = path.with_name(path.name + ".addonloader_tmp")
    try:
        with open(lp(tmp), "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(lp(tmp), lp(path))
    except Exception:
        try:
            if tmp.exists():
                tmp.unlink()
        except OSError:
            pass
        raise


# --------------------------------------------------------------------------- pack model
@dataclass
class Pack:
    uuid: str
    name: str
    version: tuple
    kind: str                      # behavior | resource | skin | template | unknown
    deps: list = field(default_factory=list)
    src_kind: str = "zip"          # zip | dir
    src_path: Path = None          # archive file, or pack folder
    nested: tuple = ()             # chain of archive names inside src_path
    prefix: str = ""               # folder inside the (nested) zip that holds manifest.json
    label: str = ""                # shown in the Source column
    mtime: float = 0.0
    superseded: bool = False       # an equal/newer copy of the same pack exists elsewhere in the list
    description: str = ""
    origin: str = "source"         # source (your mod folders / builds) | minecraft (already in the game folders)
    dep_req: dict = field(default_factory=dict)   # dependency uuid -> required version tuple
    named: bool = True             # False: no real name could be found (generic or missing)
    name_src: str = "manifest"     # manifest | lang file | folder name | your label
    authors: list = field(default_factory=list)
    license: str = ""
    url: str = ""

    @property
    def key(self):
        return "|".join([str(self.src_path), "/".join(self.nested), self.prefix, self.uuid])

    @property
    def supported(self):
        return self.kind in ("behavior", "resource", "skin")


@dataclass
class Installed:
    uuid: str
    name: str
    version: tuple
    kind: str
    folder: Path


def classify(modules):
    types = {str(m.get("type", "")).lower() for m in modules if isinstance(m, dict)}
    if "resources" in types:
        return "resource"
    if "skin_pack" in types:
        return "skin"
    if "world_template" in types:
        return "template"
    if types & {"data", "script", "client_data", "interface", "javascript", "gametest"}:
        return "behavior"
    return "unknown"


GENERIC_NAME = re.compile(
    r"^(?:pack|bp|rp|add-?on|mod|untitled|default|behou?rs?|resources?|"
    r"(?:my|new|test|example|sample)[\s_-]*(?:pack|add-?on|mod)?[\s_-]*\d*|"
    r"(?:behaviou?r|resource)[\s_-]*(?:pack)?s?[\s_-]*\d*|"
    r"[0-9a-f]{8}(?:-[0-9a-f]{4}){0,3}[0-9a-f-]*)$", re.I)
LANG_KEY = re.compile(r"^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_:]+)+$")


def lang_lookup(lang_text, key):
    if not lang_text or not key:
        return ""
    m = re.search(r"^[ \t]*" + re.escape(key) + r"[ \t]*=(.*)$", lang_text, re.M)
    return re.split(r"\s+##", m.group(1))[0].strip() if m else ""


def pack_from_manifest(manifest, fallback_name, lang_text=None):
    header = manifest["header"]
    uuid = str(header["uuid"]).lower()
    if not re.fullmatch(r"[\w-]{1,64}", uuid):      # it comes from the mod and ends up in folder names
        raise ValueError("header.uuid isn't a valid id")
    raw = str(header.get("name", "")).strip()
    name, src_of = raw, "manifest"
    if raw and LANG_KEY.match(raw):                     # a text key such as pack.name
        name, src_of = lang_lookup(lang_text, raw), "lang file"
    if not name:
        name, src_of = fallback_name, "folder name"
    named = src_of != "folder name" and not GENERIC_NAME.match(name)
    desc = str(header.get("description", "")).strip()
    if LANG_KEY.match(desc):
        desc = lang_lookup(lang_text, desc) or ""
    dep_list = [d for d in manifest.get("dependencies", []) if isinstance(d, dict) and "uuid" in d]
    deps = [str(d["uuid"]).lower() for d in dep_list]
    dep_req = {str(d["uuid"]).lower(): to_version(d.get("version", [0, 0, 0])) for d in dep_list}
    meta = manifest.get("metadata") if isinstance(manifest.get("metadata"), dict) else {}
    authors = [str(a) for a in meta.get("authors", [])] if isinstance(meta.get("authors"), list) else []
    if uuid in ALIASES:
        name, src_of, named = ALIASES[uuid], "your label", True
    return Pack(uuid=uuid, name=name, version=to_version(header.get("version", [1, 0, 0])),
                kind=classify(manifest.get("modules", [])), deps=deps, dep_req=dep_req, description=desc,
                named=named, name_src=src_of, authors=authors, license=str(meta.get("license", "") or ""),
                url=str(meta.get("url", "") or ""))


def read_lang_dir(path):
    """Text of the pack's best .lang file (en_US first)."""
    tdir = Path(path) / "texts"
    try:
        files = sorted(tdir.glob("*.lang"), key=lambda f: (f.name.lower() != "en_us.lang", f.name.lower()))
        return files[0].read_text(encoding="utf-8-sig", errors="replace") if files else None
    except OSError:
        return None


def scan_zip(z, archive_path, nested, issues, depth=0):
    packs = []
    names = [n for n in z.namelist() if not n.endswith("/") and "__MACOSX" not in n]
    mans = {}
    for n in names:
        pp = PurePosixPath(n)
        if pp.name.lower() == "manifest.json":
            par = str(pp.parent)
            mans["" if par == "." else par + "/"] = n
    roots = []
    for r in sorted(mans, key=lambda s: s.count("/")):
        if not any(r.startswith(k) for k in roots):
            roots.append(r)
    stem = Path(archive_path).stem
    for r in roots:
        try:
            man = parse_json_lenient(z.read(mans[r]).decode("utf-8-sig", "replace"))
            langs = sorted((n for n in names if n.startswith(r + "texts/") and n.lower().endswith(".lang")
                            and n.count("/") == (r.count("/") + 1)),
                           key=lambda n: (not n.lower().endswith("/en_us.lang"), n.lower()))
            lang = z.read(langs[0]).decode("utf-8-sig", "replace") if langs else None
            fb = PurePosixPath(r.rstrip("/")).name if r else stem
            p = pack_from_manifest(man, fb or stem, lang)
        except Exception as e:
            scan_issue(issues, archive_path, f"manifest in '{r or '/'}' is unreadable ({e})",
                       "Open the zip and check manifest.json is valid JSON with header.uuid, header.version and modules.")
            continue
        p.src_kind, p.src_path, p.nested, p.prefix = "zip", Path(archive_path), tuple(nested), r
        p.label = Path(archive_path).name + ("".join(" > " + PurePosixPath(x).name for x in nested))
        try:
            p.mtime = Path(archive_path).stat().st_mtime
        except OSError:
            pass
        packs.append(p)
    if depth < 3:
        for n in names:
            if Path(n).suffix.lower() in ARCHIVE_EXT and not any(n.startswith(r) and r for r in roots):
                try:
                    with zipfile.ZipFile(io.BytesIO(z.read(n))) as nz:
                        packs += scan_zip(nz, archive_path, list(nested) + [n], issues, depth + 1)
                except Exception:
                    scan_issue(issues, archive_path, f"could not open the archive inside it: '{n}'",
                               "The inner file is damaged or not a zip.")
    return packs


def scan_zip_file(path, issues):
    """The packs in a zip, whatever its name ends in."""
    with zipfile.ZipFile(lp(path)) as z:
        return scan_zip(z, path, [], issues)


def scan_archive(path, issues):
    try:
        with zipfile.ZipFile(path) as z:
            return scan_zip(z, path, [], issues)
    except Exception as e:
        scan_issue(issues, path, f"not a readable zip ({e})",
                   "Damaged or partly downloaded. Re-export it, or remove it from the library folder.")
        return []


def scan_pack_dir(path, issues):
    path = Path(path)
    try:
        man = parse_json_lenient((path / "manifest.json").read_text(encoding="utf-8-sig", errors="replace"))
        p = pack_from_manifest(man, path.name, read_lang_dir(path))
    except Exception as e:
        scan_issue(issues, path, f"manifest.json is unreadable ({e})",
                   "Open manifest.json and fix the JSON, or check header.uuid and header.version exist.")
        return None
    p.src_kind, p.src_path, p.label = "dir", path, "folder: " + str(path)
    try:
        p.mtime = (path / "manifest.json").stat().st_mtime
    except OSError:
        pass
    return p


def gather(paths, issues, find_folders=False):
    """paths: files, pack folders, or folders to scan. Returns list[Pack].
    find_folders=True (library mode) also picks up pack source folders (anything with a manifest.json)."""
    packs = []
    for raw in paths:
        p = Path(raw)
        if p.is_file() and p.suffix.lower() in ARCHIVE_EXT:
            packs += scan_archive(p, issues)
        elif p.is_dir():
            if (p / "manifest.json").exists():
                one = scan_pack_dir(p, issues)
                if one:
                    packs.append(one)
            else:
                for dp, dns, fns in os.walk(p):
                    dns[:] = sorted(d for d in dns if not d.startswith(SKIP_PREFIXES) and d.lower() not in SKIP_DIR_NAMES)
                    if find_folders and "manifest.json" in fns and Path(dp) != p:
                        one = scan_pack_dir(dp, issues)
                        if one:
                            packs.append(one)
                        dns[:] = []          # a pack folder is a leaf: do not look inside it
                        continue
                    for fn in sorted(fns):
                        if Path(fn).suffix.lower() in ARCHIVE_EXT:
                            packs += scan_archive(Path(dp) / fn, issues)
        else:
            scan_issue(issues, p, "not found or not a pack",
                       "The library entry points at something that no longer exists. Remove it in Settings.")
    # de-duplicate exact repeats
    seen, uniq = set(), []
    for pk in packs:
        if pk.key not in seen:
            seen.add(pk.key)
            uniq.append(pk)
    mark_superseded(uniq)
    return uniq


def scan_minecraft_packs(root, issues):
    """Packs already sitting in the Minecraft data folder (both normal and development folders)."""
    out = []
    for mode in ("standard", "development"):
        for sub in FOLDERS[mode].values():
            d = Path(root) / sub
            if not d.is_dir():
                continue
            for f in sorted(d.iterdir()):
                if f.is_dir() and not f.name.startswith(".") and (f / "manifest.json").is_file():
                    p = scan_pack_dir(f, issues)
                    if p:
                        p.origin = "minecraft"
                        p.label = f"Minecraft: {sub}\\{f.name}"
                        out.append(p)
    return out


def mark_superseded(packs):
    best = {}
    for p in packs:
        rank = (p.version, 1 if p.origin != "minecraft" else 0, 1 if p.src_kind == "zip" else 0, p.mtime)
        if p.uuid not in best or rank > best[p.uuid][0]:
            best[p.uuid] = (rank, p.key)
    for p in packs:
        p.superseded = best[p.uuid][1] != p.key


# --------------------------------------------------------------------------- game folders
def detect_roots():
    """Find Minecraft Bedrock 'com.mojang' data folders on this PC."""
    roots = []
    ap, la = os.environ.get("APPDATA"), os.environ.get("LOCALAPPDATA")
    if ap:
        for folder, label in (("Minecraft Bedrock", "Minecraft"), ("Minecraft Bedrock Preview", "Minecraft Preview")):
            users = Path(ap) / folder / "Users"
            if users.is_dir():
                kids = sorted(users.iterdir(), key=lambda u: (u.name.lower() != "shared", u.name))
                for u in kids:
                    g = u / "games" / "com.mojang"
                    if g.is_dir():
                        who = "Shared" if u.name.lower() == "shared" else f"user {u.name}"
                        roots.append((f"{label} - {who}", g))
    if la:
        for pkg, label in (("Microsoft.MinecraftUWP_8wekyb3d8bbwe", "Minecraft (older install)"),
                           ("Microsoft.MinecraftWindowsBeta_8wekyb3d8bbwe", "Minecraft Preview (older install)")):
            g = Path(la) / "Packages" / pkg / "LocalState" / "games" / "com.mojang"
            if g.is_dir():
                roots.append((label, g))
    return roots


def list_worlds(roots):
    """roots: iterable of (label, Path). Returns list of (display, Path)."""
    worlds, seen = [], set()
    for label, root in roots:
        for sub in ("minecraftWorlds", "worlds"):
            d = Path(root) / sub
            if not d.is_dir():
                continue
            for w in sorted(d.iterdir()):
                if not w.is_dir() or str(w) in seen:
                    continue
                if not (w / "level.dat").exists() and not (w / "levelname.txt").exists():
                    continue
                seen.add(str(w))
                nm = w.name
                try:
                    nm = (w / "levelname.txt").read_text(encoding="utf-8", errors="replace").strip() or w.name
                except OSError:
                    pass
                worlds.append((f"{nm}   [{label}]", w))
    return worlds


def scan_installed(root, mode):
    found = {}
    for kind, sub in FOLDERS[mode].items():
        d = Path(root) / sub
        if not d.is_dir():
            continue
        for f in d.iterdir():
            m = f / "manifest.json"
            if not m.is_file():
                continue
            try:
                pk = pack_from_manifest(parse_json_lenient(m.read_text(encoding="utf-8-sig", errors="replace")),
                                        f.name, read_lang_dir(f))
                found[pk.uuid] = Installed(pk.uuid, pk.name, pk.version, kind, f)
            except Exception:
                continue
    return found


def status_of(pack, installed):
    if not pack.supported:
        return "unsupported", "Not supported (" + KIND_LABEL.get(pack.kind, pack.kind) + ")"
    inst = installed.get(pack.uuid)
    if not inst:
        return "new", "Not installed"
    if inst.version == pack.version:
        return "installed", "Installed (up to date)"
    if inst.version < pack.version:
        return "update", f"Update: {vstr(inst.version)} -> {vstr(pack.version)}"
    return "newer", f"Newer installed ({vstr(inst.version)})"


# --------------------------------------------------------------------------- install / uninstall
def extract_pack(pack, dest):
    dest = Path(dest)
    os.makedirs(lp(dest), exist_ok=True)
    if pack.src_kind == "dir":
        src = Path(pack.src_path)
        for dp, dns, fns in os.walk(src):
            dns[:] = [d for d in dns if d.lower() not in COPY_IGNORE]
            rel = Path(dp).relative_to(src)
            os.makedirs(lp(dest / rel), exist_ok=True)
            for fn in fns:
                if fn.lower() in COPY_IGNORE:
                    continue
                shutil.copyfile(lp(Path(dp) / fn), lp(dest / rel / fn))
        return
    z = zipfile.ZipFile(pack.src_path)
    try:
        for nested in pack.nested:
            z = zipfile.ZipFile(io.BytesIO(z.read(nested)))
        for info in z.infolist():
            n = info.filename
            if info.is_dir() or not n.startswith(pack.prefix) or "__MACOSX" in n:
                continue
            parts = PurePosixPath(n[len(pack.prefix):]).parts
            if not parts or any(p in ("..", "") or ":" in p or p.startswith("/") for p in parts):
                continue  # zip-slip / odd entries
            if parts[-1].lower() in COPY_IGNORE:
                continue
            target = dest.joinpath(*parts)
            os.makedirs(lp(target.parent), exist_ok=True)
            with z.open(info) as src, open(lp(target), "wb") as out:
                shutil.copyfileobj(src, out)
    finally:
        z.close()


def replace_dir(tmp, final):
    last = None
    for _ in range(4):
        try:
            os.replace(lp(tmp), lp(final))
            return
        except OSError as e:
            last = e
            time.sleep(0.6)
    raise last


def install_pack(pack, root, mode, force, installed):
    """Returns (state, message, effective_version). state: installed|updated|skipped|failed"""
    parent = Path(root) / FOLDERS[mode][pack.kind]
    inst = installed.get(pack.uuid)
    if inst and pack.src_kind == "dir":
        try:
            if Path(pack.src_path).resolve() == Path(inst.folder).resolve():
                return "skipped", "already in place in the Minecraft folder", inst.version
        except OSError:
            pass
    if inst and not force:
        if inst.version == pack.version:
            return "skipped", f"already installed at {vstr(pack.version)}", inst.version
        if inst.version > pack.version:
            return "skipped", f"newer {vstr(inst.version)} already installed (tick Overwrite to downgrade)", inst.version
    tmp = parent / f".addonloader_{pack.uuid[:8]}_tmp"
    try:
        os.makedirs(lp(parent), exist_ok=True)
        if tmp.exists():
            rmtree(tmp)
        extract_pack(pack, tmp)
        if inst and inst.folder.exists():
            final = inst.folder
            rmtree(final)
        else:
            final = parent / f"{safe_name(pack.name)}_{pack.uuid[:8]}"
            if final.exists():
                rmtree(final)
        replace_dir(tmp, final)
        installed[pack.uuid] = Installed(pack.uuid, pack.name, pack.version, pack.kind, final)
        return ("updated" if inst else "installed"), f"-> {final.parent.name}\\{final.name}", pack.version
    except Exception as e:
        short, hint = explain_error(e)
        log_to_file(f"install failed for {pack.name}: {traceback.format_exc()}", "err")
        return "failed", f"{short} Try: {hint}", pack.version
    finally:
        if tmp.exists():
            try:
                rmtree(tmp)
            except Exception:
                pass


def order_by_deps(packs):
    by_id = {p.uuid: p for p in packs}
    done, out = set(), []

    def visit(p, stack=()):
        if p.uuid in done or p.uuid in stack:
            return
        for d in p.deps:
            if d in by_id:
                visit(by_id[d], stack + (p.uuid,))
        done.add(p.uuid)
        out.append(p)
    for p in sorted(packs, key=lambda p: p.name.lower()):
        visit(p)
    return out


def dependency_warnings(selected, all_known, installed):
    sel = {p.uuid for p in selected}
    known = {p.uuid: p for p in all_known}
    msgs = []
    for p in selected:
        for d in p.deps:
            if d in sel or d in installed:
                continue
            if d in known:
                msgs.append(f"'{p.name}' needs '{known[d].name}', which is in the list but not ticked.")
            else:
                msgs.append(f"'{p.name}' depends on pack {d}, which is not in the list or installed.")
    return msgs


def edit_world_packs(world, entries, remove, log, reorder=False, last_wins=True):
    """entries: list of (kind, uuid, version, name). Updates world_behavior_packs.json / world_resource_packs.json."""
    world = Path(world)
    for kind, fname in (("behavior", "world_behavior_packs.json"), ("resource", "world_resource_packs.json")):
        mine = [e for e in entries if e[0] == kind]
        if not mine:
            continue
        f = world / fname
        data = []
        if f.exists():
            try:
                data = parse_json_lenient(f.read_text(encoding="utf-8-sig", errors="replace"))
                if not isinstance(data, list):
                    raise ValueError("not a list")
            except Exception as e:
                log(f"  ! {world.name}/{fname} is not valid JSON ({e}); skipped", "err")
                continue
            bak = f.with_name(fname + ".bak_addonloader")
            if BACKUP_JSON and not bak.exists():
                shutil.copyfile(f, bak)
        changed = False
        for _, uuid, ver, name in mine:
            idx = next((i for i, x in enumerate(data) if str(x.get("pack_id", "")).lower() == uuid), None)
            if remove:
                if idx is not None:
                    data.pop(idx)
                    changed = True
                    log(f"  - removed '{name}' from world '{world.name}'", "info")
            elif idx is None:
                data.append({"pack_id": uuid, "version": list(ver)})
                changed = True
                log(f"  + activated '{name}' in world '{world.name}'", "ok")
            elif to_version(data[idx].get("version")) != tuple(ver):
                data[idx]["version"] = list(ver)
                changed = True
                log(f"  ~ updated '{name}' version in world '{world.name}'", "ok")
        if reorder and not remove:
            ids = [str(x.get("pack_id", "")).lower() for x in data]
            mine_ids = [m[1] for m in mine]
            foreign = [x for x, i in zip(data, ids) if i not in mine_ids]
            byid = {i: x for x, i in zip(data, ids)}
            ours = [byid[u] for u in mine_ids if u in byid]
            new = (foreign + ours) if last_wins else (ours + foreign)
            if [str(x.get("pack_id", "")).lower() for x in new] != ids:
                data = new
                changed = True
                log(f"  ~ load order written to {fname} in world '{world.name}'", "ok")
        if changed:
            write_text_safely(f, json.dumps(data, indent=2))


def install_many(packs, all_known, root, mode, force, worlds, log, order=None, last_wins=True):
    """packs: ticked Pack list. order: {"behavior": [uuid...], "resource": [uuid...]} in world-file order.
    Returns counts dict."""
    counts = {"installed": 0, "updated": 0, "skipped": 0, "failed": 0, "problems": []}
    best = {}
    for p in packs:  # same pack twice in the selection -> only the newest
        if p.uuid not in best or p.version > best[p.uuid].version:
            best[p.uuid] = p
    todo = order_by_deps(list(best.values()))
    pos = {}
    for lst in (order or {}).values():
        for i, u in enumerate(lst):
            pos[u] = i
    if pos:
        todo.sort(key=lambda p: pos.get(p.uuid, 10 ** 6))
    installed = scan_installed(root, mode)
    for w in dependency_warnings(todo, all_known, installed):
        log("! " + w, "warn")
    other = scan_installed(root, "development" if mode == "standard" else "standard")
    activate = []
    for p in todo:
        if p.uuid in other:
            log(f"! '{p.name}' also exists in the {'development' if mode == 'standard' else 'standard'} "
                f"folders; Minecraft may see it twice.", "warn")
        state, msg, ver = install_pack(p, root, mode, force, installed)
        counts[state] += 1
        if state == "failed":
            counts["problems"].append((p.name, msg, p.uuid))
        mark = {"installed": "+", "updated": "^", "skipped": "=", "failed": "X"}[state]
        log(f"{mark} {p.name} {vstr(p.version)} ({KIND_LABEL[p.kind]}): {state} {msg}",
            {"failed": "err", "skipped": "info"}.get(state, "ok"))
        if state != "failed":
            activate.append((p.kind, p.uuid, ver, p.name))
    activate = [a for a in activate if a[0] in ("behavior", "resource")]
    for w in worlds:
        log(f"World: {Path(w).name}", "info")
        try:
            edit_world_packs(w, activate, False, log, reorder=bool(pos), last_wins=last_wins)
        except Exception as e:
            short, hint = explain_error(e)
            log(f"  ! could not edit world '{Path(w).name}': {short} Try: {hint}", "err")
            counts["problems"].append((f"World '{Path(w).name}'", f"{short} Try: {hint}", ""))
    return counts


def uninstall_many(packs, root, mode, worlds, log, problems=None):
    installed = scan_installed(root, mode)
    n = 0
    entries = []
    for p in packs:
        inst = installed.get(p.uuid)
        if not inst:
            log(f"= {p.name}: not installed", "info")
            continue
        try:
            rmtree(inst.folder)
            n += 1
            log(f"- removed {p.name} ({inst.folder.name})", "ok")
            entries.append((p.kind, p.uuid, inst.version, p.name))
        except Exception as e:
            short, hint = explain_error(e)
            log(f"X could not remove {p.name}: {short} Try: {hint}", "err")
            if problems is not None:
                problems.append((p.name, f"{short} Try: {hint}", p.uuid))
    for w in worlds:
        edit_world_packs(w, [e for e in entries if e[0] in ("behavior", "resource")], True, log)
    return n


# --------------------------------------------------------------------------- mods (a mod = the BP + RP that belong together)
@dataclass
class Mod:
    name: str
    packs: list
    older: int = 0                 # older duplicate copies hidden behind this mod

    @property
    def key(self):
        return "|".join(sorted(p.uuid for p in self.packs))

    @property
    def uuids(self):
        return [p.uuid for p in self.packs]

    @property
    def contents(self):
        short = {"behavior": "BP", "resource": "RP", "skin": "Skin", "template": "Template", "unknown": "?"}
        order = ["behavior", "resource", "skin", "template", "unknown"]
        return " + ".join(short[k] for k in order if any(p.kind == k for p in self.packs))

    @property
    def version(self):
        vs = sorted({vstr(p.version) for p in self.packs})
        return " / ".join(vs)

    @property
    def origin(self):
        return "minecraft" if all(p.origin == "minecraft" for p in self.packs) else "source"


_SUFFIX = re.compile(r"[\s_\-]+\(?(?:bp|rp|behaviou?rs?\s+packs?|resources?\s+packs?)\)?\s*$", re.I)


def base_name(name):
    s = _SUFFIX.sub("", name).strip(" _-")
    s = re.sub(r"[\s_\-]+v?\d+(\.\d+)+$", "", s)
    return s or name


def group_mods(packs):
    """Group packs into mods. Same archive = one mod; BP/RP of different kinds that depend on each other and sit
    in the same folder (or share a base name) = one mod. A patch (same kind, depends on another pack) stays separate."""
    n = len(packs)
    parent = list(range(n))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def union(a, b):
        parent[find(a)] = find(b)
    for i in range(n):
        for j in range(i + 1, n):
            a, b = packs[i], packs[j]
            if a.src_kind == "zip" and b.src_kind == "zip" and a.src_path == b.src_path and a.origin == b.origin:
                union(i, j)
                continue
            if a.kind != b.kind and (b.uuid in a.deps or a.uuid in b.deps):
                same_dir = Path(a.src_path).parent == Path(b.src_path).parent
                if same_dir or base_name(a.name).lower() == base_name(b.name).lower():
                    union(i, j)
    groups = {}
    for i, p in enumerate(packs):
        groups.setdefault(find(i), []).append(p)
    mods = []
    for members in groups.values():
        names = [base_name(p.name) for p in members]
        best = max(set(names), key=lambda x: (names.count(x), -len(x)))
        members.sort(key=lambda p: (["behavior", "resource", "skin"].index(p.kind) if p.kind in
                                    ("behavior", "resource", "skin") else 9, p.name.lower()))
        mods.append(Mod(best, members))
    mods.sort(key=lambda m: m.name.lower())
    return mods


# --------------------------------------------------------------------------- content index
@dataclass
class PackIndex:
    paths: set = field(default_factory=set)            # lower-case relative paths
    idents: dict = field(default_factory=dict)         # (category, identifier) -> relpath
    regs: dict = field(default_factory=dict)           # ("custom component"|"command", id) -> relpath
    module_uuids: set = field(default_factory=set)
    header_uuid: str = ""
    script_entries: list = field(default_factory=list)    # (entry path, exists)
    script_deps: list = field(default_factory=list)       # (module_name, version string)
    min_engine: tuple = None
    bad_json: list = field(default_factory=list)
    refs: dict = field(default_factory=dict)           # namespace -> how often this pack's files mention "ns:..."
    error: str = ""


_RE_NS_REF = re.compile(r"(?<![A-Za-z0-9_.:/])([a-z][a-z0-9_]{1,30}):(?=[a-z0-9_])")
_NS_IGNORE = {"minecraft", "http", "https", "file", "data", "text", "ftp"}


def _count_refs(text, into):
    for m in _RE_NS_REF.finditer(text):
        ns = m.group(1)
        if ns not in _NS_IGNORE:
            into[ns] = into.get(ns, 0) + 1


_RE_COMP = re.compile(r"registerCustomComponent\s*\(\s*[\"'`]([^\"'`]+)[\"'`]")
_RE_CMD = re.compile(r"registerCommand\s*\(\s*\{[^}]{0,300}?name\s*:\s*[\"'`]([^\"'`]+)[\"'`]", re.S)
_SKIP_EXT = {".md", ".txt", ".py", ".bbmodel", ".psd", ".ase", ".gitkeep", ".lang", ".bat", ".sh", ".ps1"}
_MERGED = {"textures/item_texture.json", "textures/terrain_texture.json", "textures/flipbook_textures.json",
           "textures/textures_list.json", "sounds/sound_definitions.json", "sounds/music_definitions.json",
           "ui/_ui_defs.json", "ui/_global_variables.json"}


def pack_files(pack):
    """-> (entries [(relpath, size, reader)], close)"""
    entries = []
    if pack.src_kind == "dir":
        src = Path(pack.src_path)
        for dp, dns, fns in os.walk(src):
            dns[:] = [d for d in dns if d.lower() not in COPY_IGNORE]
            for fn in fns:
                if fn.lower() in COPY_IGNORE:
                    continue
                full = Path(dp) / fn
                try:
                    size = os.path.getsize(lp(full))
                except OSError:
                    size = 0
                entries.append((full.relative_to(src).as_posix(), size,
                                lambda f=full: open(lp(f), "rb").read()))
        return entries, (lambda: None)
    z = zipfile.ZipFile(pack.src_path)
    zips = [z]
    for nested in pack.nested:
        z = zipfile.ZipFile(io.BytesIO(z.read(nested)))
        zips.append(z)
    for info in z.infolist():
        n = info.filename
        if info.is_dir() or not n.startswith(pack.prefix) or "__MACOSX" in n:
            continue
        rel = n[len(pack.prefix):]
        if rel and rel.split("/")[0].lower() not in COPY_IGNORE:
            entries.append((rel, info.file_size, lambda i=info, zz=z: zz.read(i)))
    return entries, (lambda: [c.close() for c in zips])


def _desc_id(d):
    if isinstance(d, dict):
        desc = d.get("description")
        if isinstance(desc, dict) and isinstance(desc.get("identifier"), str):
            return desc["identifier"]
    return None


def extract_idents(obj):
    out = []
    if not isinstance(obj, dict):
        return out
    for k, v in obj.items():
        if not isinstance(k, str):
            continue
        if k == "minecraft:geometry" and isinstance(v, list):
            out += [("geometry", _desc_id(g)) for g in v if _desc_id(g)]
        elif k.startswith("minecraft:") and isinstance(v, dict) and _desc_id(v):
            cat = k[len("minecraft:"):]
            out.append(("recipe" if cat.startswith("recipe") else cat, _desc_id(v)))
        elif k.startswith("geometry."):
            out.append(("geometry", k.split(":")[0]))
    for key, cat in (("animations", "animation"), ("animation_controllers", "animation controller"),
                     ("render_controllers", "render controller")):
        v = obj.get(key)
        if isinstance(v, dict):
            out += [(cat, name) for name in v if isinstance(name, str)]
    return out


def index_pack(pack):
    ix = PackIndex()
    try:
        entries, close = pack_files(pack)
    except Exception as e:
        ix.error = f"could not open ({e})"
        return ix
    try:
        for rel, size, rd in entries:
            low = rel.lower()
            ix.paths.add(low)
            if low == "manifest.json":
                try:
                    man = parse_json_lenient(rd().decode("utf-8-sig", "replace"))
                    ix.header_uuid = str(man["header"]["uuid"]).lower()
                    ix.min_engine = to_version(man["header"].get("min_engine_version")) \
                        if man["header"].get("min_engine_version") else None
                    for m in man.get("modules", []):
                        if isinstance(m, dict):
                            if m.get("uuid"):
                                ix.module_uuids.add(str(m["uuid"]).lower())
                            if str(m.get("type", "")).lower() in ("script", "javascript") and m.get("entry"):
                                ix.script_entries.append(str(m["entry"]))
                    for d in man.get("dependencies", []):
                        if isinstance(d, dict) and d.get("module_name"):
                            ix.script_deps.append((str(d["module_name"]), str(d.get("version", ""))))
                except Exception as e:
                    ix.error = f"unreadable manifest ({e})"
        lowset = ix.paths
        ix.script_entries = [(e, e.replace("\\", "/").lower() in lowset) for e in ix.script_entries]
        for rel, size, rd in entries:
            low = rel.lower()
            ext = os.path.splitext(low)[1]
            if low == "manifest.json" or size > 3_000_000:
                continue
            if ext == ".json":
                try:
                    jtext = rd().decode("utf-8-sig", "replace")
                    _count_refs(jtext, ix.refs)
                    obj = parse_json_lenient(jtext)
                except Exception:
                    ix.bad_json.append(rel)
                    continue
                for cat, ident in extract_idents(obj):
                    ix.idents.setdefault((cat, ident), low)
            elif ext in (".js", ".mjs") and low.startswith("scripts/"):
                try:
                    text = rd().decode("utf-8", "replace")
                except Exception:
                    continue
                _count_refs(text, ix.refs)
                for m in _RE_COMP.finditer(text):
                    ix.regs.setdefault(("custom component", m.group(1)), low)
                for m in _RE_CMD.finditer(text):
                    ix.regs.setdefault(("command", m.group(1)), low)
    except Exception as e:
        ix.error = ix.error or str(e)
    finally:
        try:
            close()
        except Exception:
            pass
    return ix


# --------------------------------------------------------------------------- compatibility analysis
@dataclass
class Issue:
    sev: str            # error | warn | info
    title: str
    detail: str
    uuids: list = field(default_factory=list)


_PATCH_NAME = re.compile(r"\b(patch|compat|compatibility|fix|expanded)\b", re.I)


def recommend_order(packs, last_wins=True):
    """Simple order from names and declared dependencies only (used when no content index is available)."""
    return plan_orders({"x": list(packs)}, {}, {}, "scratch", last_wins).order["x"]


_CORE_WORDS = re.compile(r"\b(patch|compat|compatibility|fix|expanded|addon|add-on|bp|rp|behou?rs?|resources?|packs?"
                         r"|v?\d+(\.\d+)*)\b", re.I)


def _core(name):
    return re.sub(r"[^a-z0-9]+", " ", _CORE_WORDS.sub(" ", name.lower())).strip()


def _side_of(p):
    return "behavior" if p.kind == "behavior" else "resource"


@dataclass
class OrderPlan:
    order: dict = field(default_factory=dict)       # kind -> uuids in world-file order
    reasons: dict = field(default_factory=dict)     # uuid -> [why it sits where it does]
    unresolved: list = field(default_factory=list)  # [(uuid, uuid, text)] conflicts that order alone cannot solve
    moved: dict = field(default_factory=dict)       # uuid -> what changed compared with the current order
    violations: int = 0                             # constraints the CURRENT order breaks


_TIER_TOP = re.compile(r"\b(fps|performance|optimi[sz]|16x|32x|resolution|hd|animation|animations|animated|shader|reskin|"
                       r"retexture|texture|textures|actions|ui tweak|clean ui|cosmetic)\b", re.I)
_TIER_MID = re.compile(r"\b(sound|sounds|audio|ambience|ambient|music|ui|hud|minimap|mini-map|map|inventory|sorting|"
                       r"furniture|fishing|utility|tools?)\b", re.I)
_TIER_BASE = re.compile(r"\b(overhaul|biomes?|realism|framework|library|core|api|world|dimension|dimensions|"
                        r"better on bedrock|structures?|generation)\b", re.I)


def _tier(pack, ix):
    """User's recommended stacking: 2 = top (performance, animation, reskins), 1 = middle (sound, UI, small add-ons),
    0 = bottom (big overhauls and frameworks). None = unknown, no opinion."""
    n = pack.name
    if _TIER_TOP.search(n):
        return 2
    if _TIER_BASE.search(n):
        return 0
    if _TIER_MID.search(n):
        return 1
    if ix is not None and len(ix.idents) + len(ix.paths) >= 150:
        return 0
    return None


def _relations(packs, idx):
    """Edges (before, after, strength, reason) within one list of packs. 'after' should win a conflict."""
    by = {p.uuid: p for p in packs}
    edges = []
    # 10: declared dependencies
    for p in packs:
        for d in p.deps:
            if d in by and d != p.uuid:
                edges.append((d, p.uuid, 10, f"{p.name} depends on {by[d].name}"))
    ix = {u: idx.get(u) or PackIndex() for u in by}
    ids = {u: set(ix[u].idents) for u in by}
    paths = {u: {x for x in ix[u].paths if "/" in x and x not in _MERGED and os.path.splitext(x)[1] not in _SKIP_EXT
                 and not x.startswith(("texts/", "scripts/", ".vscode/", "docs/", "tools/"))} for u in by}
    custom_ns = {}
    for u in by:
        for (_, ident) in ids[u]:
            if ":" in ident and not ident.startswith("minecraft:"):
                custom_ns.setdefault(ident.split(":")[0], set()).add(u)
    uu = sorted(by)
    pair_done = set()
    for i, a in enumerate(uu):
        for b in uu[i + 1:]:
            shared_ids = ids[a] & ids[b]
            shared_paths = paths[a] & paths[b]
            custom = [x for x in shared_ids if not x[1].startswith("minecraft:")]
            if shared_ids or shared_paths:
                pair_done.add((a, b))
                pa, pb = by[a], by[b]
                pat_a, pat_b = bool(_PATCH_NAME.search(pa.name)), bool(_PATCH_NAME.search(pb.name))
                ca, cb = _core(pa.name), _core(pb.name)
                related = ca and cb and (ca in cb or cb in ca)
                if pat_a != pat_b:
                    w, l = (a, b) if pat_a else (b, a)
                    edges.append((l, w, 8, f"{by[w].name} is a patch/compat pack that changes the same content as "
                                           f"{by[l].name}, so it goes on top"))
                elif related and ca != cb:
                    w, l = (a, b) if len(ca) > len(cb) else (b, a)
                    edges.append((l, w, 7, f"{by[w].name} looks like an extended version of {by[l].name} and "
                                           "changes the same content"))
                else:
                    # one pack completely contains the other's content -> the bigger one replaces it cleanly
                    sa = ids[a] | paths[a]
                    sb = ids[b] | paths[b]
                    ov = (ids[a] & ids[b]) | shared_paths
                    if ov and ov == sa and sa != sb:
                        edges.append((a, b, 7, f"{pb.name} contains everything {pa.name} changes, plus more"))
                    elif ov and ov == sb and sa != sb:
                        edges.append((b, a, 7, f"{pa.name} contains everything {pb.name} changes, plus more"))
                    else:
                        big, small = (a, b) if len(ix[a].paths) >= len(ix[b].paths) else (b, a)
                        edges.append((big, small, 4, f"both change the same content; {by[small].name} is the smaller "
                                                      f"tweak, so it goes on top of {by[big].name} (guess)"))
    # 6: a pack that mentions another pack's namespace should load after it
    for u in by:
        own = {i[1].split(":")[0] for i in ids[u] if ":" in i[1]}
        for ns, n in ix[u].refs.items():
            if ns in own:
                continue
            for owner in custom_ns.get(ns, ()):
                if owner != u:
                    edges.append((owner, u, 6, f"{by[u].name} refers to '{ns}:' content defined by {by[owner].name}"))
    # 3: patch-style names go after the pack they are named after (neat order even with no overlap)
    for p in packs:
        if _PATCH_NAME.search(p.name):
            cp = _core(p.name)
            for q in packs:
                if q.uuid != p.uuid and not _PATCH_NAME.search(q.name):
                    cq = _core(q.name)
                    if cq and cp and (cq in cp or cp in cq):
                        edges.append((q.uuid, p.uuid, 3, f"{p.name} is named after {q.name}"))
    # 2: the recommended hierarchy: big overhauls / frameworks at the bottom, small add-ons, sound and UI in the
    # middle, performance / animation / reskin packs on top. Weakest rule: only decides what nothing else does.
    tiers = {u: _tier(by[u], idx.get(u)) for u in by}
    names = {0: "a base overhaul/framework", 1: "a utility/small add-on", 2: "a performance/animation/texture pack"}
    for a_ in uu:
        for b_ in uu:
            ta, tb = tiers[a_], tiers[b_]
            if ta is not None and tb is not None and ta < tb:
                edges.append((a_, b_, 2, f"{by[b_].name} looks like {names[tb]} and {by[a_].name} like {names[ta]}"))
    return edges


def _reaches(adj, src_, dst):
    stack, seen = [src_], set()
    while stack:
        n = stack.pop()
        if n == dst:
            return True
        if n in seen:
            continue
        seen.add(n)
        stack += adj.get(n, ())
    return False


def _plan_kind(packs, idx, current, mode, mod_of):
    """Order for one list, canonical form: earlier = lower priority, later wins. Returns (order, reasons,
    unresolved, accepted_edges, dropped)."""
    by = {p.uuid: p for p in packs}
    edges = sorted(_relations(packs, idx), key=lambda e: -e[2])
    adj, accepted, dropped, reasons = {}, [], [], {}
    for a, b, strength, why in edges:
        if a == b or _reaches(adj, b, a):
            dropped.append((a, b, strength, why))
            continue
        if b in adj.get(a, ()):
            continue
        adj.setdefault(a, set()).add(b)
        accepted.append((a, b, strength, why))
        reasons.setdefault(b, []).append(f"after {by[a].name}: {why}")
    layered = {u: bool(_PATCH_NAME.search(by[u].name)) or any(d in by for d in by[u].deps) for u in by}
    mod_rank = {}
    for p in sorted(packs, key=lambda p: p.name.lower()):
        mod_rank.setdefault((mod_of or {}).get(p.uuid, p.uuid), len(mod_rank))
    scratch_key = lambda u: (layered[u], mod_rank.get((mod_of or {}).get(u, u), 0), by[u].name.lower())
    scratch = sorted(by, key=scratch_key)
    keep = [u for u in current if u in by]
    if mode == "scratch" or not keep:
        base = scratch
    else:
        base = merge_new(keep, scratch)
    if mode in ("scratch", "repair"):
        rank = {u: i for i, u in enumerate(base)}
        indeg = {u: 0 for u in by}
        for a, bs in adj.items():
            for b in bs:
                indeg[b] += 1
        ready = sorted((u for u in by if indeg[u] == 0), key=lambda u: rank[u])
        order = []
        while ready:
            u = ready.pop(0)
            order.append(u)
            for v in sorted(adj.get(u, ())):
                indeg[v] -= 1
                if indeg[v] == 0:
                    ready.append(v)
            ready.sort(key=lambda x: rank[x])
        order += [u for u in base if u not in order]
    else:   # slot: keep what is there, insert only the new packs where their relations allow
        order = list(keep)
        preds = {}
        for a, bs in adj.items():
            for b in bs:
                preds.setdefault(b, set()).add(a)
        for u in base:
            if u in order:
                continue
            before = [order.index(x) for x in preds.get(u, ()) if x in order]
            after = [order.index(x) for x in adj.get(u, ()) if x in order]
            j = base.index(u) - 1
            while j >= 0 and base[j] not in order:
                j -= 1
            d = order.index(base[j]) + 1 if j >= 0 else 0
            lo = max(before) + 1 if before else 0
            hi = min(after) if after else len(order)
            pos = min(max(d, lo), hi) if lo <= hi else lo
            order.insert(pos, u)
    unresolved = [(a, b, f"{by[a].name} and {by[b].name}: {why}") for a, b, s, why in accepted if s <= 4]
    unresolved += [(a, b, f"{by[a].name} and {by[b].name}: conflicting hints ({why})") for a, b, s, why in dropped
                   if s >= 6]
    return order, reasons, unresolved, accepted


def plan_orders(packs_by_kind, idx, current, mode="slot", last_wins=True, mod_of=None):
    """mode: scratch (recompute everything), repair (keep the current order, move only what constraints require),
    slot (keep the current order exactly, place only new packs). current/returned lists are in world-file order."""
    plan = OrderPlan()
    for kind, packs in packs_by_kind.items():
        cur = list(current.get(kind, []))
        cur_c = cur if last_wins else cur[::-1]
        order, reasons, unresolved, accepted = _plan_kind(packs, idx, cur_c, mode, mod_of)
        by = {p.uuid: p for p in packs}
        pos_old = {u: i for i, u in enumerate([u for u in cur_c if u in by])}
        plan.violations += sum(1 for a, b, s, _ in accepted if s >= 6 and a in pos_old and b in pos_old
                               and pos_old[a] > pos_old[b])
        for a_, b_, s_, why in accepted:
            if s_ >= 6 and a_ in pos_old and b_ in pos_old and pos_old[a_] > pos_old[b_]:
                plan.moved[b_] = f"moved after {by[a_].name} ({why})"
        plan.order[kind] = order if last_wins else order[::-1]
        plan.reasons.update(reasons)
        plan.unresolved += unresolved
    return plan


def merge_new(keep, rec):
    """keep: existing order; rec: recommended order of everything. Inserts the packs missing from keep at their
    recommended slot (right after the nearest preceding pack that is already placed)."""
    res, placed = list(keep), set(keep)
    for i, u in enumerate(rec):
        if u in placed:
            continue
        j = i - 1
        while j >= 0 and rec[j] not in placed:
            j -= 1
        res.insert(res.index(rec[j]) + 1 if j >= 0 else 0, u)
        placed.add(u)
    return res


def reconcile_order(packs_by_kind, current, auto, last_wins, idx=None, mod_of=None, mode=None):
    """Existing order (current) is kept. New packs go to their recommended slot (auto) or to the end (manual).
    mode scratch / repair re-sorts using what the packs contain. Pass current={} for the full recommended order.
    Returns just the order dict; use plan_orders for the explanations."""
    idx = idx or {}
    if mode in ("scratch", "repair"):
        return plan_orders(packs_by_kind, idx, current, mode, last_wins, mod_of).order
    if auto:
        return plan_orders(packs_by_kind, idx, current, "slot" if current else "scratch", last_wins, mod_of).order
    result = {}
    for kind, packs in packs_by_kind.items():
        rec = plan_orders({kind: packs}, idx, {}, "scratch", last_wins, mod_of).order[kind]
        present = {p.uuid for p in packs}
        keep = [u for u in current.get(kind, []) if u in present]
        result[kind] = keep + [u for u in rec if u not in keep]
    return result


def _examples(items, n=4):
    items = list(items)
    s = ", ".join(items[:n])
    return s + (f" and {len(items) - n} more" if len(items) > n else "")


def analyze(packs, idx, installed, known, game_version, order, last_wins=True, mod_of=None, experiments=None):
    """packs: ticked Pack list. idx: uuid -> PackIndex. installed: uuid -> Installed. known: all library packs.
    order: kind -> uuids in world-file order. Returns list[Issue]."""
    issues = []
    by = {p.uuid: p for p in packs}
    kn = {p.uuid: p for p in known}
    mod_of = mod_of or {}
    pos = {}
    for lst in order.values():
        for i, u in enumerate(lst):
            pos[u] = i

    def prio(p):
        return pos.get(p.uuid, 0) if last_wins else -pos.get(p.uuid, 0)

    def add(sev, title, detail, uuids):
        issues.append(Issue(sev, title, detail, list(uuids)))

    closure = {}

    def deps_of(u, seen=None):
        if u in closure:
            return closure[u]
        seen = seen or set()
        out = set()
        for d in (by[u].deps if u in by else []):
            if d in seen:
                continue
            out.add(d)
            if d in by:
                out |= deps_of(d, seen | {u})
        closure[u] = out
        return out

    def side(p):
        return "behavior" if p.kind == "behavior" else "resource"

    # ---- per pack
    for p in packs:
        ix = idx.get(p.uuid) or PackIndex()
        if ix.error:
            add("error", f"{p.name}: problem reading the pack", ix.error, [p.uuid])
        for entry, ok in ix.script_entries:
            if not ok:
                add("error", f"{p.name}: script entry file is missing",
                    f"manifest.json points at '{entry}' but that file is not in the pack, so the scripts will not run.",
                    [p.uuid])
        betas = [f"{m} {v}" for m, v in ix.script_deps if "beta" in v.lower()]
        if betas:
            if experiments is not None and "gametest" not in experiments:
                add("warn", f"{p.name}: needs Beta APIs, which the selected world does not have on",
                    "Uses " + ", ".join(betas) + ". Switch on Experiments > Beta APIs for this world in Minecraft.",
                    [p.uuid])
            else:
                add("info" if experiments is not None else "warn", f"{p.name}: uses beta script APIs",
                    "Needs the 'Beta APIs' experiment switched on in the world: " + ", ".join(betas), [p.uuid])
        if game_version and ix.min_engine and ix.min_engine > game_version:
            add("error", f"{p.name}: needs a newer Minecraft",
                f"min_engine_version is {vstr(ix.min_engine)} but the target game/server is {vstr(game_version)}.",
                [p.uuid])
        if ix.header_uuid and ix.header_uuid in ix.module_uuids:
            add("warn", f"{p.name}: header and module share one UUID",
                "The pack header uuid and a module uuid are identical. Give the module its own uuid.", [p.uuid])
        if ix.bad_json:
            add("warn", f"{p.name}: {len(ix.bad_json)} file(s) are not valid JSON",
                "Minecraft will skip or choke on: " + _examples(ix.bad_json), [p.uuid])

    # ---- uuid clashes between different packs
    owners = {}
    for p in packs:
        ix = idx.get(p.uuid) or PackIndex()
        for u in {p.uuid} | ix.module_uuids:
            owners.setdefault(u, set()).add(p.uuid)
    for u, ps in owners.items():
        if len(ps) > 1:
            add("error", "Two packs share a UUID",
                f"UUID {u} is used by " + " and ".join(by[x].name for x in ps) +
                ". Minecraft refuses duplicate pack/module UUIDs; one of them needs a new one.", ps)

    # ---- dependencies
    for p in packs:
        for d in p.deps:
            if d == p.uuid:
                continue
            if d in by:
                req = p.dep_req.get(d)
                if req and by[d].version < req:
                    add("warn", f"{p.name}: dependency is older than required",
                        f"Needs {by[d].name} {vstr(req)} or newer but {vstr(by[d].version)} is selected.", [p.uuid, d])
            elif d in installed:
                continue
            elif d in kn:
                add("error", f"{p.name} needs {kn[d].name}",
                    f"'{kn[d].name}' is in your library but is not ticked (and not installed). Tick it too.", [p.uuid])
            else:
                add("error", f"{p.name} has a missing dependency",
                    f"It depends on pack {d}, which is not in your library or installed. "
                    "It will be refused by Minecraft until that pack is available.", [p.uuid])

    # ---- same-kind dependency order
    for p in packs:
        for d in p.deps:
            if d in by and by[d].kind == p.kind and d != p.uuid and prio(by[d]) > prio(p):
                add("warn", f"Load order: {p.name} is below the pack it depends on",
                    f"'{p.name}' builds on '{by[d].name}', so '{by[d].name}' should load first and '{p.name}' should "
                    "win. Use Auto-sort, or move it.", [p.uuid, d])

    # ---- identifier collisions (same side)
    table = {}
    for p in packs:
        for (cat, ident), rel in (idx.get(p.uuid) or PackIndex()).idents.items():
            table.setdefault((side(p), cat, ident), {})[p.uuid] = rel
    covered = set()
    groups = {}
    for (sd, cat, ident), own in table.items():
        if len(own) < 2:
            continue
        for u, rel in own.items():
            covered.add((u, rel))
        g = groups.setdefault((sd, frozenset(own)), {"van": [], "cus": []})
        g["van" if ident.startswith("minecraft:") else "cus"].append(f"{cat} {ident}")

    def explain_group(us):
        members = sorted((by[u] for u in us), key=prio)
        win = members[-1]
        layered = all(b.uuid in deps_of(a.uuid) or a.uuid in deps_of(b.uuid)
                      for i, a in enumerate(members) for b in members[i + 1:])
        return members, win, layered

    for (sd, us), g in groups.items():
        members, win, layered = explain_group(us)
        names = " and ".join(m.name for m in members)
        if g["cus"]:
            sev = "info" if layered else "error"
            what = f"{len(g['cus'])} custom id(s): {_examples(g['cus'])}"
            tail = ("They are layered (one depends on the other), so this looks intentional. "
                    if layered else "Two packs defining the same custom id usually breaks one of them. ")
        else:
            sev = "info" if layered else "warn"
            what = f"{len(g['van'])} vanilla override(s): {_examples(g['van'])}"
            tail = "Both change the same vanilla content; only one version is used. "
        if g["cus"] and g["van"]:
            what += f"; plus {len(g['van'])} vanilla override(s)"
        add(sev, f"{names} define the same {sd} content", f"{what}. {tail}With the current order '{win.name}' wins.",
            us)

    # ---- patch must win over its base
    seen_pair = set()
    for p in packs:
        for d in deps_of(p.uuid):
            if d in by and by[d].kind == p.kind and (p.uuid, d) not in seen_pair:
                seen_pair.add((p.uuid, d))
                shared = any(p.uuid in us and d in us for (_, us) in groups) or _share_paths(p, by[d], idx)
                if shared and prio(p) < prio(by[d]):
                    add("error", f"{p.name} is overridden by the pack it patches",
                        f"'{p.name}' changes files of '{by[d].name}' but loads below it, so its changes are lost. "
                        "Move it down (later) in the load order.", [p.uuid, d])

    # ---- file path collisions (same side, not already reported)
    pt = {}
    for p in packs:
        for low in (idx.get(p.uuid) or PackIndex()).paths:
            if "/" not in low or low in _MERGED or os.path.splitext(low)[1] in _SKIP_EXT:
                continue
            if low.startswith(("texts/", "scripts/", ".vscode/", "docs/", "tools/")):
                continue
            if (p.uuid, low) in covered:
                continue
            pt.setdefault((side(p), low), set()).add(p.uuid)
    pgroups = {}
    for (sd, low), us in pt.items():
        if len(us) > 1:
            pgroups.setdefault((sd, frozenset(us)), []).append(low)
    for (sd, us), paths in pgroups.items():
        members, win, layered = explain_group(us)
        folders = {}
        for pth in paths:
            folders[pth.split("/")[0]] = folders.get(pth.split("/")[0], 0) + 1
        summary = ", ".join(f"{k}/ x{v}" for k, v in sorted(folders.items(), key=lambda kv: -kv[1])[:5])
        add("info" if layered else "warn",
            " and ".join(m.name for m in members) + f" both contain {len(paths)} file(s) at the same path",
            f"{summary}. e.g. {_examples(sorted(paths), 3)}. The file from '{win.name}' replaces the other's. "
            + ("Layered packs: probably intentional." if layered else
               "If they should not replace each other, remove one pack or rename the files."), us)

    # ---- script registrations
    reg = {}
    for p in packs:
        for key, rel in (idx.get(p.uuid) or PackIndex()).regs.items():
            reg.setdefault(key, {})[p.uuid] = rel
    for (kind_, ident), own in reg.items():
        if len(own) > 1:
            add("error", f"{kind_.capitalize()} '{ident}' is registered by two packs",
                "Registered in " + " and ".join(f"{by[u].name} ({rel})" for u, rel in own.items()) +
                ". The second registration throws an error and that pack's script can stop loading.", list(own))

    # ---- shared namespaces between different mods
    ns = {}
    for p in packs:
        ix = idx.get(p.uuid) or PackIndex()
        for (_, ident) in ix.idents:
            if ":" in ident and not ident.startswith("minecraft:"):
                ns.setdefault(ident.split(":")[0], set()).add(p.uuid)
        for (_, ident) in ix.regs:
            if ":" in ident:
                ns.setdefault(ident.split(":")[0], set()).add(p.uuid)
    for nsp, us in ns.items():
        mods = {mod_of.get(u, u) for u in us}
        if len(mods) > 1 and not any(b in deps_of(a) or a in deps_of(b) for a in us for b in us if a != b):
            add("warn", f"Namespace '{nsp}:' is used by more than one mod",
                "Used by " + ", ".join(sorted(by[u].name for u in us)) +
                ". If these are different versions/forks of the same mod, install only one.", us)

    # ---- different script api versions (info)
    vers = {}
    for p in packs:
        for m, v in (idx.get(p.uuid) or PackIndex()).script_deps:
            if m == "@minecraft/server":
                vers.setdefault(v, []).append(p.name)
    if len(vers) > 1:
        add("info", "Packs use different @minecraft/server versions",
            "; ".join(f"{v}: {_examples(n, 3)}" for v, n in sorted(vers.items())) +
            ". Usually fine, but a very old version can miss events the script calls.", [])

    rank = {"error": 0, "warn": 1, "info": 2}
    issues.sort(key=lambda i: (rank[i.sev], i.title.lower()))
    return issues


def _share_paths(a, b, idx):
    ia, ib = idx.get(a.uuid), idx.get(b.uuid)
    if not ia or not ib:
        return False
    return any(p in ib.paths for p in ia.paths if "/" in p and p not in _MERGED and not p.startswith("texts/")
               and not p.startswith("scripts/") and os.path.splitext(p)[1] not in _SKIP_EXT)


def world_active_uuids(world):
    out = set()
    for fn in ("world_behavior_packs.json", "world_resource_packs.json"):
        try:
            data = parse_json_lenient((Path(world) / fn).read_text(encoding="utf-8-sig", errors="replace"))
            out |= {str(x.get("pack_id", "")).lower() for x in data if isinstance(x, dict)}
        except Exception:
            pass
    return out


# --------------------------------------------------------------------------- worlds: info, pack lists, backup
def _nbt_read_le(data, start=0):
    """Minimal little-endian NBT reader (Bedrock level.dat). Returns the root compound as a dict."""
    pos = [start]

    def rd(fmt):
        v = struct.unpack_from(fmt, data, pos[0])
        pos[0] += struct.calcsize(fmt)
        return v[0]

    def rstr():
        n = rd("<H")
        s = bytes(data[pos[0]:pos[0] + n]).decode("utf-8", "replace")
        pos[0] += n
        return s

    def payload(t):
        if t == 1:
            return rd("<b")
        if t == 2:
            return rd("<h")
        if t == 3:
            return rd("<i")
        if t == 4:
            return rd("<q")
        if t == 5:
            return rd("<f")
        if t == 6:
            return rd("<d")
        if t == 7:
            n = rd("<i")
            pos[0] += n
            return None
        if t == 8:
            return rstr()
        if t == 9:
            et, n = rd("<B"), rd("<i")
            return [payload(et) for _ in range(n)]
        if t == 10:
            d = {}
            while True:
                t2 = rd("<B")
                if t2 == 0:
                    return d
                name = rstr()
                d[name] = payload(t2)
        if t == 11:
            n = rd("<i")
            pos[0] += 4 * n
            return None
        if t == 12:
            n = rd("<i")
            pos[0] += 8 * n
            return None
        raise ValueError("bad tag")
    t = rd("<B")
    rstr()
    return payload(t)


def read_level_dat(path):
    try:
        data = Path(path).read_bytes()
        off = 8 if len(data) > 8 and struct.unpack_from("<I", data, 4)[0] == len(data) - 8 else 0
        d = _nbt_read_le(data, off)
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


@dataclass
class WorldInfo:
    path: Path
    name: str
    mode: str = ""
    difficulty: str = ""
    last_played: object = None
    version: str = ""
    experiments: list = field(default_factory=list)
    has_dat: bool = False


_GAME_MODES = {0: "Survival", 1: "Creative", 2: "Adventure", 5: "Default", 6: "Spectator"}
_DIFFICULTY = {0: "Peaceful", 1: "Easy", 2: "Normal", 3: "Hard"}


def world_info(path):
    path = Path(path)
    dat = read_level_dat(path / "level.dat")
    name = dat.get("LevelName") if isinstance(dat.get("LevelName"), str) else ""
    if not name:
        try:
            name = (path / "levelname.txt").read_text(encoding="utf-8", errors="replace").strip()
        except OSError:
            name = ""
    info = WorldInfo(path=path, name=name or path.name, has_dat=bool(dat))
    gt = dat.get("GameType")
    info.mode = _GAME_MODES.get(gt, "") if isinstance(gt, int) else ""
    df = dat.get("Difficulty")
    info.difficulty = _DIFFICULTY.get(df, "") if isinstance(df, int) else ""
    lp_ = dat.get("LastPlayed")
    try:
        if isinstance(lp_, int) and lp_ > 0:
            info.last_played = datetime.fromtimestamp(lp_)
        elif (path / "level.dat").exists():
            info.last_played = datetime.fromtimestamp((path / "level.dat").stat().st_mtime)
    except (OSError, ValueError, OverflowError):
        pass
    ver = dat.get("lastOpenedWithVersion")
    if isinstance(ver, list) and ver:
        info.version = ".".join(str(x) for x in ver[:3] if isinstance(x, int))
    exp = dat.get("experiments")
    if isinstance(exp, dict):
        info.experiments = sorted(k for k, v in exp.items()
                                  if v in (1, True) and k not in ("experiments_ever_used", "saved_with_toggled_experiments"))
    return info


def world_pack_lists(world):
    """-> {"behavior": [(uuid, version)...], "resource": [...]} in world-file order."""
    out = {"behavior": [], "resource": []}
    for kind, fn in (("behavior", "world_behavior_packs.json"), ("resource", "world_resource_packs.json")):
        try:
            data = parse_json_lenient((Path(world) / fn).read_text(encoding="utf-8-sig", errors="replace"))
        except Exception:
            continue
        if isinstance(data, list):
            for x in data:
                if isinstance(x, dict) and x.get("pack_id"):
                    out[kind].append((str(x["pack_id"]).lower(), to_version(x.get("version", [0, 0, 0]))))
    return out


def write_world_list(world, kind, entries):
    """entries: [(uuid, version)]. Writes world_<kind>_packs.json (one-time backup first)."""
    f = Path(world) / ("world_behavior_packs.json" if kind == "behavior" else "world_resource_packs.json")
    if f.exists() and BACKUP_JSON:
        bak = f.with_name(f.name + ".bak_addonloader")
        if not bak.exists():
            shutil.copyfile(f, bak)
    if not entries and not f.exists():
        return
    write_text_safely(f, json.dumps([{"pack_id": u, "version": list(v)} for u, v in entries], indent=2))


def apply_world_order(world, order, versions, last_wins, log):
    """Write the full load order for the packs in `order` ({kind: [uuid]}). Entries of the world that are not in
    `order` (packs we do not know about) stay at the low-priority end."""
    cur = world_pack_lists(world)
    for kind in ("behavior", "resource"):
        ids = order.get(kind) or []
        if not ids:
            continue
        old = dict(cur[kind])
        foreign = [(u, v) for u, v in cur[kind] if u not in ids]
        ours = [(u, versions.get(u) or old.get(u) or (1, 0, 0)) for u in ids]
        new = (foreign + ours) if last_wins else (ours + foreign)
        if new != cur[kind]:
            write_world_list(world, kind, new)
            log(f"  ~ {kind} pack list of '{Path(world).name}' written in load order", "ok")


def remove_from_world(world, uuids, log=None):
    """Take packs out of a world's pack lists. Returns how many entries were removed."""
    cur = world_pack_lists(world)
    n = 0
    for kind in ("behavior", "resource"):
        keep = [(u, v) for u, v in cur[kind] if u not in uuids]
        if len(keep) != len(cur[kind]):
            n += len(cur[kind]) - len(keep)
            write_world_list(world, kind, keep)
    if log and n:
        log(f"  - removed {n} entr{'y' if n == 1 else 'ies'} from world '{Path(world).name}'", "ok")
    return n


def backup_world(world, dest_dir):
    """Zip a world folder into dest_dir. Returns the zip path."""
    world, dest = Path(world), Path(dest_dir)
    os.makedirs(lp(dest), exist_ok=True)
    out = dest / f"{safe_name(world_info(world).name, 60)}_{time.strftime('%Y%m%d-%H%M%S')}.zip"
    with zipfile.ZipFile(lp(out), "w", zipfile.ZIP_DEFLATED, compresslevel=1) as z:
        for dp, dns, fns in os.walk(world):
            for fn in fns:
                full = Path(dp) / fn
                try:
                    z.write(lp(full), (Path(world.name) / full.relative_to(world)).as_posix())
                except OSError:
                    pass          # a file Minecraft has locked: skip it
    return out


def _unique_dir(parent, name):
    d = Path(parent) / name
    n = 2
    while d.exists():
        d = Path(parent) / f"{name} ({n})"
        n += 1
    return d


def import_world(src, worlds_dir):
    """Copy a world folder, or unpack a .mcworld / .zip, into worlds_dir. Returns (new_folder, world_name).
    Never overwrites an existing world: a clash gets a numbered folder name."""
    src, worlds_dir = Path(src), Path(worlds_dir)
    os.makedirs(lp(worlds_dir), exist_ok=True)
    if src.is_dir():
        root = src
        if not (root / "level.dat").exists():
            subs = [d for d in src.iterdir() if d.is_dir() and (d / "level.dat").exists()]
            if len(subs) != 1:
                raise ValueError("That folder is not a Bedrock world (no level.dat inside).")
            root = subs[0]
        name = world_info(root).name
        dest = _unique_dir(worlds_dir, safe_name(root.name if len(root.name) > 8 else name, 60))
        shutil.copytree(lp(root), lp(dest))
        return dest, name
    if not zipfile.is_zipfile(lp(src)):
        raise ValueError("That file is not a .mcworld / zip file.")
    with zipfile.ZipFile(lp(src)) as z:
        members = [m for m in z.namelist() if not m.endswith("/")]
        levels = [m for m in members if m.replace("\\", "/").split("/")[-1] == "level.dat"]
        if not levels:
            raise ValueError("That file does not contain a Bedrock world (no level.dat inside).")
        base = min(levels, key=lambda m: m.count("/"))
        prefix = base[: -len("level.dat")]
        label_ = "world"
        try:
            label_ = z.read(prefix + "levelname.txt").decode("utf-8", "replace").strip() or label_
        except KeyError:
            label_ = src.stem
        dest = _unique_dir(worlds_dir, safe_name(label_, 60))
        os.makedirs(lp(dest))
        for m in members:
            if not m.startswith(prefix):
                continue
            rel = m[len(prefix):].replace("\\", "/")
            tgt = (dest / rel).resolve()
            if dest.resolve() not in tgt.parents:
                continue                      # unsafe path inside the archive: skip
            os.makedirs(lp(tgt.parent), exist_ok=True)
            with z.open(m) as fi, open(lp(tgt), "wb") as fo:
                shutil.copyfileobj(fi, fo)
    return dest, label_


MANAGED_LABEL = "Managed by the loader"
MANAGED_DIR = APP_DIR / "managed_worlds"


def world_root_of(path):
    """The folder that holds level.dat: path itself, or its only world subfolder. None if there is none."""
    path = Path(path)
    if (path / "level.dat").exists():
        return path
    subs = [d for d in path.iterdir() if d.is_dir() and (d / "level.dat").exists()] if path.is_dir() else []
    return subs[0] if len(subs) == 1 else None


def is_preview(root):
    s = str(root).lower()
    return "preview" in s or "windowsbeta" in s


def launch_minecraft(root=None):
    if os.name != "nt":
        raise OSError("Launching Minecraft is only supported on Windows.")
    os.startfile("minecraft-preview:" if root and is_preview(root) else "minecraft:")


# --------------------------------------------------------------------------- config
CONFIG_PROBLEM = ""


def load_config():
    """A missing file is normal (first run). A damaged one is moved aside so it is never silently overwritten."""
    global CONFIG_PROBLEM
    if not CONFIG_PATH.exists():
        return {}
    try:
        data = json.loads(CONFIG_PATH.read_text(encoding="utf-8-sig"))
        if not isinstance(data, dict):
            raise ValueError("not a JSON object")
        return data
    except Exception as e:
        bad = CONFIG_PATH.with_name(f"addon_loader_config.damaged-{time.strftime('%Y%m%d-%H%M%S')}.json")
        try:
            CONFIG_PATH.replace(bad)
            CONFIG_PROBLEM = f"Your settings file was damaged ({e}). It was kept as {bad.name} and defaults were loaded."
        except OSError:
            CONFIG_PROBLEM = f"Your settings file could not be read ({e}); defaults are in use."
        return {}


def save_config(cfg):
    """Returns an error text, or '' when saved."""
    try:
        write_text_safely(CONFIG_PATH, json.dumps(cfg, indent=2))
        return ""
    except Exception as e:
        short, hint = explain_error(e)
        log_to_file(f"could not save settings: {short}", "err")
        return f"{short} {hint}"


def read_pack_icon(pack):
    """Raw bytes of pack_icon.png (or b'')."""
    try:
        if pack.src_kind == "dir":
            f = Path(pack.src_path) / "pack_icon.png"
            return f.read_bytes() if f.is_file() and f.stat().st_size < 600_000 else b""
        z = zipfile.ZipFile(pack.src_path)
        zips = [z]
        try:
            for nested in pack.nested:
                z = zipfile.ZipFile(io.BytesIO(z.read(nested)))
                zips.append(z)
            want = (pack.prefix + "pack_icon.png").lower()
            for info in z.infolist():
                if info.filename.lower() == want and info.file_size < 600_000:
                    return z.read(info)
        finally:
            for c in zips:
                c.close()
    except Exception:
        pass
    return b""


# --------------------------------------------------------------------------- inspecting a pack
@dataclass
class PackInfo:
    files: int = 0
    size: int = 0
    top: list = field(default_factory=list)            # [(folder, file count)]
    idents: dict = field(default_factory=dict)         # category -> [identifier]
    namespaces: dict = field(default_factory=dict)     # namespace -> count
    display_names: list = field(default_factory=list)  # names from the pack's .lang file
    modules: list = field(default_factory=list)        # [(type, version text, detail)]
    deps: list = field(default_factory=list)           # [(uuid or module name, version text)]
    scripts: list = field(default_factory=list)
    min_engine: str = ""
    icon: bytes = b""
    guess: str = ""
    error: str = ""


def inspect_pack(pack):
    info = PackInfo()
    try:
        entries, close = pack_files(pack)
    except Exception as e:
        info.error = explain_error(e)[0]
        return info
    try:
        tops = Counter()
        lang_text = ""
        lang_rank = 9
        json_budget = 700
        for rel, size, rd in entries:
            info.files += 1
            info.size += size
            low = rel.lower()
            parts = low.split("/")
            tops[rel.split("/")[0] if len(parts) > 1 else "(top level)"] += 1
            if low == "pack_icon.png" and size < 400_000:
                try:
                    info.icon = rd()
                except Exception:
                    pass
            elif low == "manifest.json":
                try:
                    man = parse_json_lenient(rd().decode("utf-8-sig", "replace"))
                    h = man.get("header", {})
                    if h.get("min_engine_version"):
                        info.min_engine = vstr(to_version(h["min_engine_version"]))
                    for m in man.get("modules", []):
                        if isinstance(m, dict):
                            info.modules.append((str(m.get("type", "?")), vstr(to_version(m.get("version", [1, 0, 0]))),
                                                 str(m.get("entry") or m.get("language") or "")))
                    for d in man.get("dependencies", []):
                        if isinstance(d, dict):
                            who = d.get("uuid") or d.get("module_name") or "?"
                            v = d.get("version")
                            info.deps.append((str(who), v if isinstance(v, str) else vstr(to_version(v or [0, 0, 0]))))
                except Exception as e:
                    info.error = f"manifest unreadable ({e})"
            elif low.startswith("texts/") and low.endswith(".lang"):
                rank = 0 if low.endswith("/en_us.lang") else 1
                if rank < lang_rank:
                    try:
                        lang_text, lang_rank = rd().decode("utf-8-sig", "replace"), rank
                    except Exception:
                        pass
            elif low.endswith(".json") and json_budget > 0 and size < 1_500_000 and not low.startswith("texts/"):
                json_budget -= 1
                try:
                    obj = parse_json_lenient(rd().decode("utf-8-sig", "replace"))
                except Exception:
                    continue
                for cat, ident in extract_idents(obj):
                    lst = info.idents.setdefault(cat, [])
                    if ident not in lst:
                        lst.append(ident)
            elif (low.endswith(".js") or low.endswith(".mjs")) and low.startswith("scripts/"):
                info.scripts.append(rel)
        info.top = tops.most_common(12)
        ns = Counter()
        for cat, lst in info.idents.items():
            for ident in lst:
                if ":" in ident:
                    n = ident.split(":", 1)[0]
                    if n != "minecraft":
                        ns[n] += 1
        info.namespaces = dict(ns.most_common(8))
        for m in re.finditer(r"^[ \t]*(?:item|tile|entity)\.[^=\n]*?\.name[ \t]*=(.*)$", lang_text, re.M):
            v = re.split(r"\s+##", m.group(1))[0].strip()
            if v and v not in info.display_names:
                info.display_names.append(v)
        info.display_names = info.display_names[:14]
        bits = []
        if info.namespaces:
            bits.append("uses the namespace '" + next(iter(info.namespaces)) + "'")
        counts = [f"{len(info.idents[c])} {c}{'s' if len(info.idents[c]) != 1 else ''}"
                  for c in ("entity", "item", "block", "recipe", "biome", "feature") if info.idents.get(c)]
        if counts:
            bits.append("defines " + ", ".join(counts[:4]))
        if info.scripts:
            bits.append(f"{len(info.scripts)} script file(s)")
        info.guess = "; ".join(bits)
    except Exception as e:
        info.error = info.error or explain_error(e)[0]
    finally:
        try:
            close()
        except Exception:
            pass
    return info


# --------------------------------------------------------------------------- comparing a library pack with its installed copy
@dataclass
class Change:
    kind: str = "same"          # same | version | content | older
    inst_version: tuple = ()
    lib_version: tuple = ()
    added: list = field(default_factory=list)
    removed: list = field(default_factory=list)
    changed: list = field(default_factory=list)
    error: str = ""

    @property
    def files(self):
        return len(self.added) + len(self.removed) + len(self.changed)


def _crc_file(path):
    crc = 0
    with open(lp(path), "rb") as f:
        while True:
            b = f.read(1 << 20)
            if not b:
                break
            crc = zlib.crc32(b, crc)
    return crc & 0xFFFFFFFF


def _source_digests(pack):
    """rel path -> (size, crc or None, mtime or None, full path or None)"""
    out = {}
    if pack.src_kind == "dir":
        src = Path(pack.src_path)
        for dp, dns, fns in os.walk(src):
            dns[:] = [d for d in dns if d.lower() not in COPY_IGNORE]
            for fn in fns:
                if fn.lower() in COPY_IGNORE:
                    continue
                full = Path(dp) / fn
                try:
                    st = os.stat(lp(full))
                except OSError:
                    continue
                out[full.relative_to(src).as_posix()] = (st.st_size, None, st.st_mtime, full)
        return out
    z = zipfile.ZipFile(pack.src_path)
    zips = [z]
    try:
        for nested in pack.nested:
            z = zipfile.ZipFile(io.BytesIO(z.read(nested)))
            zips.append(z)
        for info in z.infolist():
            n = info.filename
            if info.is_dir() or not n.startswith(pack.prefix) or "__MACOSX" in n:
                continue
            rel = n[len(pack.prefix):]
            if rel and rel.split("/")[0].lower() not in COPY_IGNORE and PurePosixPath(rel).name.lower() not in COPY_IGNORE:
                out[rel] = (info.file_size, info.CRC & 0xFFFFFFFF, None, None)
    finally:
        for c in zips:
            c.close()
    return out


def compare_with_installed(pack, folder, inst_version):
    """What differs between the library copy and the installed copy (cheap checks first, CRC only when needed)."""
    ch = Change(inst_version=tuple(inst_version), lib_version=tuple(pack.version))
    try:
        a = _source_digests(pack)
        b = {}
        base = Path(folder)
        for dp, dns, fns in os.walk(base):
            dns[:] = [d for d in dns if d.lower() not in COPY_IGNORE]
            for fn in fns:
                if fn.lower() in COPY_IGNORE:
                    continue
                full = Path(dp) / fn
                try:
                    st = os.stat(lp(full))
                except OSError:
                    continue
                b[full.relative_to(base).as_posix()] = (st.st_size, full, st.st_mtime)
        al = {k.lower(): k for k in a}
        bl = {k.lower(): k for k in b}
        ch.added = sorted(al[k] for k in al if k not in bl)
        ch.removed = sorted(bl[k] for k in bl if k not in al)
        for k in al:
            if k not in bl:
                continue
            size, crc, mt, full = a[al[k]]
            bsize, bfull, bmt = b[bl[k]]
            if size != bsize:
                ch.changed.append(al[k])
                continue
            if crc is None and mt is not None and bmt is not None and mt <= bmt + 1:
                continue                               # source untouched since it was installed
            if crc is None:
                crc = _crc_file(full)
            if crc != _crc_file(bfull):
                ch.changed.append(al[k])
        ch.changed.sort()
    except Exception as e:
        ch.error = explain_error(e)[0]
    if tuple(pack.version) > tuple(inst_version):
        ch.kind = "version"
    elif tuple(pack.version) < tuple(inst_version):
        ch.kind = "older"
    else:
        ch.kind = "content" if ch.files else "same"
    return ch


def manifest_notes(pack, folder):
    """Plain-language differences in the manifest and what the pack defines."""
    notes = []
    try:
        new = inspect_pack(pack)
        old_pack = scan_pack_dir(folder, [])
        old = inspect_pack(old_pack) if old_pack else None
    except Exception as e:
        return [f"Could not compare contents: {explain_error(e)[0]}"], [], []
    added, removed = [], []
    if old:
        for cat, lst in new.idents.items():
            for i in lst:
                if i not in old.idents.get(cat, []):
                    added.append(f"{cat}: {i}")
        for cat, lst in old.idents.items():
            for i in lst:
                if i not in new.idents.get(cat, []):
                    removed.append(f"{cat}: {i}")
        if old.min_engine != new.min_engine:
            notes.append(f"Minimum game version: {old.min_engine or 'none'} -> {new.min_engine or 'none'}")
        od = {d for d in old.deps}
        nd = {d for d in new.deps}
        for d in sorted(nd - od):
            notes.append(f"New dependency: {d[0]} {d[1]}")
        for d in sorted(od - nd):
            notes.append(f"Dependency dropped or changed: {d[0]} {d[1]}")
        om = {(m[0], m[1]) for m in old.modules}
        nm = {(m[0], m[1]) for m in new.modules}
        if om != nm:
            notes.append("Module versions changed: " + ", ".join(f"{t} {v}" for t, v in sorted(om)) + "  ->  " +
                         ", ".join(f"{t} {v}" for t, v in sorted(nm)))
    return notes, added, removed


def bump_world_versions(world, versions, log):
    """For packs a world already lists, write the new version number. Does not add or reorder anything."""
    cur = world_pack_lists(world)
    for kind in ("behavior", "resource"):
        new = [(u, versions.get(u, v)) for u, v in cur[kind]]
        if new != cur[kind]:
            write_world_list(world, kind, new)
            log(f"  ~ pack versions updated in world '{Path(world).name}' ({kind})", "ok")


# --------------------------------------------------------------------------- checks before installing
def estimate_pack(pack):
    """-> (bytes, longest relative path length)"""
    try:
        entries, close = pack_files(pack)
        try:
            return sum(e[1] for e in entries), max((len(e[0]) for e in entries), default=0)
        finally:
            close()
    except Exception:
        return 0, 0


def preflight(root, packs):
    """-> list of (severity, text) problems found before touching anything."""
    out = []
    root = Path(root)
    if not root.is_dir():
        return [("error", f"The Minecraft folder does not exist: {root}")]
    probe = root / f".addonloader_probe_{os.getpid()}"
    try:
        probe.write_text("x")
        probe.unlink()
    except Exception as e:
        short, hint = explain_error(e)
        out.append(("error", f"Cannot write to {root}: {short} {hint}"))
    need, longest = 0, 0
    for p in packs:
        b, l = estimate_pack(p)
        need += b
        longest = max(longest, l)
        if p.src_kind == "zip" and not Path(p.src_path).exists():
            out.append(("error", f"'{p.name}': its source file is gone ({p.src_path}). Rescan the library."))
        elif p.src_kind == "dir" and not Path(p.src_path).is_dir():
            out.append(("error", f"'{p.name}': its source folder is gone ({p.src_path}). Rescan the library."))
    try:
        free = shutil.disk_usage(root).free
        if need * 2 > free:
            out.append(("error", f"Not enough free disk space: about {human_size(need)} needed, "
                                 f"{human_size(free)} free."))
        elif need * 4 > free:
            out.append(("warn", f"Disk space is getting low ({human_size(free)} free)."))
    except OSError:
        pass
    if len(str(root)) + 70 + longest > 258:
        out.append(("warn", "Some file paths will be very long (over about 258 characters). Windows may refuse them "
                            "unless long paths are enabled; a shorter Minecraft/pack path avoids this."))
    return out


def plan_for(packs, installed, force, changes=None):
    """-> [(pack, action, detail)] describing exactly what an install would do."""
    rows = []
    for p in packs:
        inst = installed.get(p.uuid)
        ch = (changes or {}).get(p.uuid)
        if not inst:
            rows.append((p, "Install", f"new, version {vstr(p.version)}"))
        elif inst.version < p.version:
            rows.append((p, "Update", f"{vstr(inst.version)} -> {vstr(p.version)}"))
        elif inst.version == p.version:
            if force:
                rows.append((p, "Reinstall", f"same version {vstr(p.version)}, overwritten"))
            elif ch and ch.kind == "content":
                rows.append((p, "Skip", f"{ch.files} file(s) edited, version unchanged: use Update to overwrite"))
            else:
                rows.append((p, "Skip", "already installed, same version"))
        else:
            rows.append((p, "Downgrade" if force else "Skip",
                         f"installed {vstr(inst.version)} is newer than {vstr(p.version)}"))
    return rows


# --------------------------------------------------------------------------- CLI (also used for testing)
def cli_check(a):
    issues = []
    packs = gather(a.paths, issues, find_folders=True)
    if a.target and Path(a.target).is_dir():
        packs += scan_minecraft_packs(a.target, issues)
    mark_superseded(packs)
    for i in issues:
        print("warning:", i)
    live = [p for p in packs if not p.superseded and p.supported]
    mods = group_mods([p for p in packs if not p.superseded])
    print(f"== {len(mods)} mod(s), {len(live)} pack(s), {sum(1 for p in packs if p.superseded)} older copies ignored ==")
    for m in mods:
        print(f"  {m.name:34} {m.contents:8} {m.version:12} <{m.packs[0].label}>")
    last_wins = not a.first_wins
    by_kind = {}
    for p in live:
        by_kind.setdefault("behavior" if p.kind == "behavior" else "resource", []).append(p)
    gv = to_version(a.game_version) if a.game_version else None
    idx = {p.uuid: index_pack(p) for p in live}
    mod_of = {p.uuid: m.key for m in mods for p in m.packs}
    plan = plan_orders(by_kind, idx, {}, "scratch", last_wins, mod_of)
    order = plan.order
    installed = scan_installed(a.target, "standard") if a.target and Path(a.target).is_dir() else {}
    res = analyze(live, idx, installed, packs, gv, order, last_wins, mod_of)
    print(f"\n== {sum(i.sev == 'error' for i in res)} error(s), {sum(i.sev == 'warn' for i in res)} warning(s), "
          f"{sum(i.sev == 'info' for i in res)} note(s) ==")
    for i in res:
        print(f"[{i.sev.upper():5}] {i.title}\n        {i.detail}")
    pn = {p.uuid: p for p in live}
    for kind in ("behavior", "resource"):
        if order.get(kind):
            print(f"\n== {kind} load order ({'later wins' if last_wins else 'earlier wins'}) ==")
            for n, u in enumerate(order[kind], 1):
                print(f"  {n}. {pn[u].name} {vstr(pn[u].version)}")
    return 0


def cli(argv):
    import argparse
    ap = argparse.ArgumentParser(prog="addon_loader.py --cli", description="Install Bedrock add-ons from the command line.")
    ap.add_argument("paths", nargs="*", help="mcaddon/mcpack/zip files, pack folders, or folders to scan")
    ap.add_argument("--target", help="com.mojang folder (or Bedrock server folder); not needed with --into-world")
    ap.add_argument("--into-world", help="install only into this one world folder (packs copied into the world)")
    ap.add_argument("--mode", choices=["standard", "development"], default="standard")
    ap.add_argument("--world", action="append", default=[], help="world folder to activate packs in (repeatable)")
    ap.add_argument("--force", action="store_true", help="overwrite even if same/newer version is installed")
    ap.add_argument("--uninstall", action="store_true")
    ap.add_argument("--list", action="store_true", help="only list what was found")
    ap.add_argument("--check", action="store_true", help="library mode: list mods, check compatibility and show load order")
    ap.add_argument("--game-version", default="", help="e.g. 1.26.50 (used by --check)")
    ap.add_argument("--first-wins", action="store_true", help="--check: treat the FIRST pack in the world file as winning")
    a = ap.parse_args(argv)
    if a.check:
        return cli_check(a)
    if a.into_world:
        a.target, a.mode, a.world = a.into_world, "standard", [a.into_world]
    elif not a.target and not a.check:
        ap.error("--target or --into-world is required")
    issues = []
    packs = gather(a.paths, issues)
    inst = scan_installed(a.target, a.mode)
    for i in issues:
        print("warning:", i)
    for p in packs:
        print(f"{p.name:40} {vstr(p.version):8} {KIND_LABEL[p.kind]:9} {status_of(p, inst)[1]:34}"
              f"{' (older copy, ignored)' if p.superseded else ''}  <{p.label}>")
    if a.list:
        return 0
    chosen = [p for p in packs if p.supported and not p.superseded and not (a.into_world and p.kind == "skin")]
    log = lambda m, lvl="info": print(m)
    if a.uninstall:
        uninstall_many(chosen, a.target, a.mode, a.world, log)
    else:
        print(install_many(chosen, packs, a.target, a.mode, a.force, a.world, log))
    return 0


# --------------------------------------------------------------------------- GUI (launcher style)
DEFAULT_CFG = {
    "target": "", "world": "", "sources": None, "include_mc": True, "scan_on_startup": True,
    "skip_folders": "_*, .*, node_modules", "mode": "standard", "world_mode": "shared", "force": False, "load_into_mc": True, "force_world_copy": True, "linked_worlds": [],
    "launch_after": False, "backup_json": True, "backup_world": False, "backup_dir": "", "game_version": "",
    "auto_check": True, "auto_order": True, "auto_fix_order": True, "last_wins": True, "confirm_errors": True, "warn_running": True,
    "ticked": [], "aliases": {}, "ignored_updates": [], "confirm_plan": True, "update_worlds": True,
    "check_changes": True, "write_log": True, "meta": {}, "profiles": {}, "sort": "Name", "last_launch": 0,
    "launch_count": 0, "accent": "#3d8bfd", "sidebar_collapsed": False, "notifications": [], "notify_info": True,
}


def human_size(n):
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024



if __name__ == "__main__":
    sys.exit(cli(sys.argv[1:]))
