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


def run_gui():
    import tkinter as tk
    from tkinter import ttk, filedialog, messagebox, simpledialog
    from tkinter.scrolledtext import ScrolledText

    P = dict(bg="#14171c", side="#0e1014", panel="#1b1f26", panel2="#252a33", line="#2e3440", text="#e7eaee",
             muted="#8b95a5", accent="#3d8bfd", accent_d="#2b6fd1", green="#3fa152", green_d="#2f7e3e",
             red="#c8473f", red_d="#a23932", warn="#e0a030", ok="#4cc16a", err="#ef5b53")

    def F(size=10, bold=False):
        return ("Segoe UI", size, "bold") if bold else ("Segoe UI", size)

    def label(parent, text="", size=10, bold=False, fg=None, bg=None, **kw):
        return tk.Label(parent, text=text, font=F(size, bold), fg=fg or P["text"], bg=bg or parent.cget("bg"), **kw)

    def _btn_cols(kind):
        return {"ghost": (P["panel2"], P["line"], P["text"]), "primary": (P["accent"], P["accent_d"], "#fff"),
                "success": (P["green"], P["green_d"], "#fff"), "danger": (P["red"], P["red_d"], "#fff")}[kind]

    def make_btn(parent, text, cmd, kind="ghost", **kw):
        bg, hv, fg = _btn_cols(kind)
        b = tk.Button(parent, text=text, command=cmd, bg=bg, fg=fg, activebackground=hv, activeforeground=fg,
                      relief="flat", bd=0, padx=14, pady=7, cursor="hand2", font=F(10, kind != "ghost"),
                      disabledforeground=P["muted"], highlightthickness=0, **kw)
        b._kind = kind
        b.bind("<Enter>", lambda e: b.configure(bg=_btn_cols(kind)[1]) if str(b["state"]) != "disabled" else None)
        b.bind("<Leave>", lambda e: b.configure(bg=_btn_cols(kind)[0]))
        return b

    def shade(color, k=0.78):
        c = color.lstrip("#")
        r, g, b = (int(c[i:i + 2], 16) for i in (0, 2, 4))
        return "#%02x%02x%02x" % (int(r * k), int(g * k), int(b * k))

    THEMES = (("Blue", "#3d8bfd"), ("Cyan", "#22b8cf"), ("Emerald", "#2fbf71"), ("Gold", "#e0a030"),
              ("Orange", "#f0883e"), ("Rose", "#e9547e"), ("Violet", "#8b6cf0"), ("Slate", "#7d8ba3"))

    def valid_hex(s):
        return isinstance(s, str) and re.fullmatch(r"#[0-9a-fA-F]{6}", s) is not None

    def card(parent, **kw):
        return tk.Frame(parent, bg=P["panel"], highlightbackground=P["line"], highlightthickness=1, **kw)

    def entry(parent, var, width=30, **kw):
        return tk.Entry(parent, textvariable=var, width=width, bg=P["panel2"], fg=P["text"],
                        insertbackground=P["text"], relief="flat", highlightthickness=1,
                        highlightbackground=P["line"], highlightcolor=P["accent"], font=F(10),
                        disabledbackground=P["panel2"], disabledforeground=P["muted"], **kw)

    def make_tree(parent, cols, heads, height=8, select="browse", show="headings"):
        fr = tk.Frame(parent, bg=P["panel"])
        t = ttk.Treeview(fr, columns=cols, show=show, selectmode=select, height=height)
        for c in cols:
            title, width, anchor, stretch = heads[c]
            t.heading(c, text=title, anchor=anchor if anchor != "center" else "center")
            t.column(c, width=width, anchor=anchor, stretch=stretch)
        sb = ttk.Scrollbar(fr, orient="vertical", command=t.yview)
        t.configure(yscrollcommand=sb.set)
        t.pack(side="left", fill="both", expand=True)
        sb.pack(side="right", fill="y")
        return fr, t

    class Toggle(tk.Canvas):
        def __init__(self, parent, var):
            super().__init__(parent, width=44, height=24, highlightthickness=0, bg=parent.cget("bg"), cursor="hand2")
            self.var = var
            self.bind("<Button-1>", lambda e: self.var.set(not self.var.get()))
            var.trace_add("write", lambda *a: self._draw())
            self._draw()

        def _draw(self):
            self.delete("all")
            on = bool(self.var.get())
            col = P["accent"] if on else P["line"]
            self.create_oval(1, 2, 23, 22, fill=col, outline=col)
            self.create_oval(21, 2, 43, 22, fill=col, outline=col)
            self.create_rectangle(12, 2, 32, 22, fill=col, outline=col)
            x = 32 if on else 12
            self.create_oval(x - 8, 4, x + 8, 20, fill="#ffffff", outline="#ffffff")

    class Bell(tk.Canvas):
        """Notification bell with an unread badge, drawn on a canvas (no emoji, so it renders everywhere)."""
        def __init__(self, parent, on_click):
            super().__init__(parent, width=38, height=32, bg=parent.cget("bg"), highlightthickness=0, cursor="hand2")
            self.count, self.hover = 0, False
            self.bind("<Button-1>", lambda e: on_click())
            self.bind("<Enter>", lambda e: self._set_hover(True))
            self.bind("<Leave>", lambda e: self._set_hover(False))
            self.draw()

        def _set_hover(self, v):
            self.hover = v
            self.draw()

        def set_count(self, n):
            self.count = n
            self.draw()

        def draw(self):
            self.delete("all")
            col = P["text"] if (self.hover or self.count) else P["muted"]
            self.create_polygon(13, 25, 13, 14, 15, 9, 19, 7, 23, 9, 25, 14, 25, 25, fill="", outline=col, width=2,
                                smooth=True)
            self.create_line(10, 25, 28, 25, fill=col, width=2, capstyle="round")
            self.create_line(19, 5, 19, 7, fill=col, width=2)
            self.create_arc(16, 24, 22, 31, start=180, extent=180, style="arc", outline=col, width=2)
            if self.count:
                self.create_oval(19, 0, 37, 17, fill=P["red"], outline=P["bg"], width=2)
                self.create_text(28, 8.5, text=str(self.count) if self.count < 10 else "9+", fill="#fff",
                                 font=F(8, True))

    class ScrollFrame(tk.Frame):
        def __init__(self, parent):
            super().__init__(parent, bg=P["bg"])
            self.canvas = tk.Canvas(self, bg=P["bg"], highlightthickness=0)
            sb = ttk.Scrollbar(self, orient="vertical", command=self.canvas.yview)
            self.inner = tk.Frame(self.canvas, bg=P["bg"])
            self.inner.bind("<Configure>", lambda e: self.canvas.configure(scrollregion=self.canvas.bbox("all")))
            self.win = self.canvas.create_window((0, 0), window=self.inner, anchor="nw")
            self.canvas.bind("<Configure>", lambda e: self.canvas.itemconfigure(self.win, width=e.width))
            self.canvas.configure(yscrollcommand=sb.set)
            self.canvas.pack(side="left", fill="both", expand=True)
            sb.pack(side="right", fill="y")
            self.canvas.bind("<Enter>", lambda e: self.canvas.bind_all("<MouseWheel>", self._wheel))
            self.canvas.bind("<Leave>", lambda e: self.canvas.unbind_all("<MouseWheel>"))

        def _wheel(self, e):
            self.canvas.yview_scroll(int(-e.delta / 120), "units")

    SEV = {"error": "✖ Error", "warn": "⚠ Warning", "info": "ℹ Note"}
    CHECK_ON, CHECK_OFF, CHECK_PART = "☑", "☐", "▣"
    KINDS = (("behavior", "Behavior packs"), ("resource", "Resource packs"))
    SORT_OPTIONS = ["Name", "Favorites first", "Recently changed", "Status"]
    SHOW_OPTIONS = ["All mods", "Installed in Minecraft", "Not installed", "Updates available",
                    "In the selected world", "Ticked", "Has problems", "Unnamed packs", "Favorites"]

    class App(tk.Tk):
        def __init__(self):
            super().__init__()
            self.title(APP_NAME)
            self.geometry("1320x840")
            self.minsize(1120, 700)
            self.configure(bg=P["bg"])
            self.cfg = dict(DEFAULT_CFG)
            self.cfg.update({k: v for k, v in load_config().items() if k in DEFAULT_CFG})
            if self.cfg["sources"] is None:
                guess = APP_DIR.parent if APP_DIR.name.lower() == "mod loader" else None
                self.cfg["sources"] = [str(guess)] if guess and guess.is_dir() else []
                self.first_run = bool(self.cfg["sources"])
            else:
                self.first_run = False
            self.cfg["sources"] = [s for s in self.cfg["sources"] if os.path.exists(s)]
            if valid_hex(self.cfg.get("accent")):
                P["accent"], P["accent_d"] = self.cfg["accent"], shade(self.cfg["accent"])
            if not isinstance(self.cfg.get("notifications"), list):
                self.cfg["notifications"] = []
            self.notes = [n for n in self.cfg["notifications"] if isinstance(n, dict)][:60]
            self.bells, self._nc_open, self._was_running = [], False, False
            self.side_collapsed = bool(self.cfg.get("sidebar_collapsed"))
            if not isinstance(self.cfg.get("aliases"), dict):
                self.cfg["aliases"] = {}
            ALIASES.clear()
            ALIASES.update({str(k).lower(): str(v) for k, v in self.cfg["aliases"].items()})
            globals()["WRITE_LOG"] = bool(self.cfg["write_log"])
            self.ignored = set(self.cfg["ignored_updates"])
            self.changes, self.guesses, self.change_id, self.scan_problems = {}, {}, 0, []
            for k in ("meta", "profiles"):
                if not isinstance(self.cfg.get(k), dict):
                    self.cfg[k] = {}
            self.icon_bytes, self.icon_cache, self.icon_job, self._loading_meta = {}, {}, 0, False
            self.inspect_cbs, self._crash_last, self._save_warned = {}, 0, False
            set_scan_skip(self.cfg["skip_folders"])
            globals()["BACKUP_JSON"] = bool(self.cfg["backup_json"])
            self.roots, self.mc_root, self.mc_label = [], None, ""
            self.worlds, self.world, self.missing_linked = [], None, []
            self.we, self.we_dirty, self.we_names = {"behavior": [], "resource": []}, False, {}
            self.packs, self.mods, self.mod_rows = [], [], {}
            self.ticked = set(self.cfg["ticked"])
            self.order = {"behavior": [], "resource": []}
            self.index_cache, self.inst_pack_cache = {}, {}
            self.issues, self.an_id, self._an_job, self._save_job, self._rescan_job = [], 0, None, None, None
            self.plan, self._force_mode, self._manual, self._last_moved_sig = None, None, False, ()
            self.scanning, self.busy, self.mc_running = False, False, False
            self.installed, self.installed_all, self.active, self.mc_installed = {}, {}, set(), []
            self.q = queue.Queue()
            self.current_page = ""
            self._syncing = False
            self._style()
            self._build_shell()
            self.protocol("WM_DELETE_WINDOW", self._close)
            threading.excepthook = lambda a: self.q.put(("crash", (a.exc_value, "".join(
                traceback.format_exception(a.exc_type, a.exc_value, a.exc_traceback)))))
            self.after(100, self._pump)
            if CONFIG_PROBLEM:
                self.notify("Settings file was damaged", CONFIG_PROBLEM, "warn")
                self.say(CONFIG_PROBLEM, "warn")
                self.after(600, lambda: messagebox.showwarning(APP_NAME, CONFIG_PROBLEM))
            self.find_roots()
            self.show("mods" if self.cfg["sources"] else "minecraft")
            if self.cfg["scan_on_startup"]:
                self.rescan()
            else:
                self.say("Library scan on startup is off. Press Rescan on the Mods page.", "warn")
                self.rebuild()
            if self.first_run:
                self.say(f"First run: added {self.cfg['sources'][0]} as a library folder (change it in Settings).", "info")
            if os.name == "nt":
                threading.Thread(target=self._poll_running, daemon=True).start()

        # ================================================================== style + shell
        def _style(self):
            st = ttk.Style(self)
            st.theme_use("clam")
            st.configure("Treeview", background=P["panel"], fieldbackground=P["panel"], foreground=P["text"],
                         rowheight=30, borderwidth=0, font=F(10))
            st.configure("Treeview.Heading", background=P["panel2"], foreground=P["muted"], relief="flat",
                         font=F(9, True), borderwidth=0, padding=(8, 6))
            st.configure("Lib.Treeview", rowheight=44)
            st.map("Treeview", background=[("selected", P["accent_d"])], foreground=[("selected", "#ffffff")])
            st.map("Treeview.Heading", background=[("active", P["line"])])
            st.layout("Treeview", [("Treeview.treearea", {"sticky": "nswe"})])
            st.configure("Vertical.TScrollbar", background=P["panel2"], troughcolor=P["panel"],
                         bordercolor=P["panel"], arrowcolor=P["muted"], lightcolor=P["panel2"],
                         darkcolor=P["panel2"], gripcount=0)
            st.map("Vertical.TScrollbar", background=[("active", P["line"])])
            st.configure("TCombobox", fieldbackground=P["panel2"], background=P["panel2"], foreground=P["text"],
                         arrowcolor=P["muted"], bordercolor=P["line"], lightcolor=P["panel2"],
                         darkcolor=P["panel2"], selectbackground=P["panel2"], selectforeground=P["text"], padding=5)
            st.map("TCombobox", fieldbackground=[("readonly", P["panel2"])], foreground=[("readonly", P["text"])],
                   selectbackground=[("readonly", P["panel2"])], selectforeground=[("readonly", P["text"])])
            st.configure("Horizontal.TProgressbar", troughcolor=P["line"], background=P["accent"],
                         bordercolor=P["side"], lightcolor=P["accent"], darkcolor=P["accent"])
            for opt, val in (("background", P["panel2"]), ("foreground", P["text"]),
                             ("selectBackground", P["accent_d"]), ("selectForeground", "#ffffff")):
                self.option_add(f"*TCombobox*Listbox.{opt}", val)
            self.option_add("*Font", F(10))

        def _build_shell(self):
            side = tk.Frame(self, bg=P["side"], width=220)
            side.pack(side="left", fill="y")
            side.pack_propagate(False)
            self.side = side
            head = tk.Frame(side, bg=P["side"])
            head.pack(fill="x", pady=(16, 10))
            self.brand_box = tk.Frame(head, bg=P["side"])
            self.brand_box.pack(side="left")
            label(self.brand_box, "MOD LOADER", 15, True, bg=P["side"]).pack(anchor="w", padx=22, pady=(8, 0))
            label(self.brand_box, "for Minecraft Bedrock", 9, fg=P["muted"], bg=P["side"]).pack(anchor="w", padx=22)
            self.side_toggle = tk.Label(head, text="«", bg=P["side"], fg=P["muted"], font=F(15, True), cursor="hand2",
                                        padx=12)
            self.side_toggle.pack(side="right")
            self.side_toggle.bind("<Button-1>", lambda e: self.toggle_sidebar())
            self.side_toggle.bind("<Enter>", lambda e: self.side_toggle.configure(fg=P["text"]))
            self.side_toggle.bind("<Leave>", lambda e: self.side_toggle.configure(fg=P["muted"]))
            self.bind("<Control-b>", lambda e: self.toggle_sidebar())
            self.nav, self.nav_text = {}, {}
            for key, icon, text in (("minecraft", "▦", "Minecraft"), ("worlds", "◎", "Worlds"),
                                    ("mods", "☰", "Mods"), ("settings", "⚙", "Settings")):
                row = tk.Frame(side, bg=P["side"], cursor="hand2")
                row.pack(fill="x")
                bar = tk.Frame(row, width=4, bg=P["side"])
                bar.pack(side="left", fill="y")
                self.nav_text[key] = (icon, text)
                lab = tk.Label(row, text=f"  {icon}   {text}", bg=P["side"], fg=P["muted"], font=F(11), anchor="w",
                               padx=12, pady=12)
                lab.pack(side="left", fill="x", expand=True)
                badge = tk.Label(row, text="", bg=P["side"], fg=P["muted"], font=F(9))
                badge.pack(side="right", padx=12)
                for w in (row, bar, lab, badge):
                    w.bind("<Button-1>", lambda e, k=key: self.show(k))
                    w.bind("<Enter>", lambda e, k=key: self._nav_hover(k, True))
                    w.bind("<Leave>", lambda e, k=key: self._nav_hover(k, False))
                self.nav[key] = (row, bar, lab, badge)
            foot = tk.Frame(side, bg=P["side"])
            foot.pack(side="bottom", fill="x", padx=18, pady=16)
            self.foot = foot
            self.btn_play = make_btn(foot, "▶   Play Minecraft", self._launch, "success")
            self.btn_play.pack(fill="x", pady=(0, 6))
            self.lbl_played = label(foot, "", 9, fg=P["muted"], bg=P["side"], justify="left", wraplength=180)
            self.lbl_played.pack(anchor="w", pady=(0, 10))
            self.foot_sep = tk.Frame(foot, height=1, bg=P["line"])
            self.foot_sep.pack(fill="x", pady=(0, 10))
            self.lbl_side_mc = label(foot, "", 9, fg=P["muted"], bg=P["side"], justify="left", wraplength=180)
            self.lbl_side_mc.pack(anchor="w")
            self.lbl_side_world = label(foot, "", 9, fg=P["muted"], bg=P["side"], justify="left", wraplength=180)
            self.lbl_side_world.pack(anchor="w", pady=(4, 0))

            main = tk.Frame(self, bg=P["bg"])
            main.pack(side="left", fill="both", expand=True)
            sb = tk.Frame(main, bg=P["side"], height=30)
            sb.pack(side="bottom", fill="x")
            sb.pack_propagate(False)
            self.lbl_status = label(sb, "Ready", 9, fg=P["muted"], bg=P["side"])
            self.lbl_status.pack(side="left", padx=14)
            self.btn_log = tk.Label(sb, text="Activity ▲", bg=P["side"], fg=P["muted"], font=F(9), cursor="hand2")
            self.btn_log.pack(side="right", padx=14)
            self.btn_log.bind("<Button-1>", lambda e: self.toggle_log())
            self.progress = ttk.Progressbar(sb, mode="indeterminate", length=120)
            self.lbl_running = label(sb, "", 9, fg=P["ok"], bg=P["side"])
            self.lbl_running.pack(side="right", padx=10)
            self.logbox = tk.Frame(main, bg=P["panel"], height=170)
            lt = tk.Frame(self.logbox, bg=P["panel"])
            lt.pack(fill="x", padx=10, pady=(6, 0))
            label(lt, "Activity", 10, True).pack(side="left")
            for text, cmd in (("Open log file", self.open_log), ("Clear", lambda: self._log_clear()),
                              ("Copy", lambda: self.copy_text(self.log.get("1.0", "end"), "Activity copied"))):
                tk.Label(lt, text=text, bg=P["panel"], fg=P["accent"], font=F(9), cursor="hand2").pack(side="right", padx=8)
                lt.winfo_children()[-1].bind("<Button-1>", lambda e, c=cmd: c())
            self.log = ScrolledText(self.logbox, height=9, state="disabled", wrap="word", font=("Consolas", 9),
                                    bg=P["panel"], fg=P["text"], relief="flat", borderwidth=0,
                                    insertbackground=P["text"])
            self.log.pack(fill="both", expand=True, padx=10, pady=8)
            for tag, col in (("ok", P["ok"]), ("warn", P["warn"]), ("err", P["err"]), ("info", P["muted"])):
                self.log.tag_configure(tag, foreground=col)
            self.content = tk.Frame(main, bg=P["bg"])
            self.content.pack(side="top", fill="both", expand=True)
            self.main = main
            self.pages = {}
            for key, builder in (("minecraft", self._build_minecraft), ("worlds", self._build_worlds),
                                 ("mods", self._build_mods), ("settings", self._build_settings)):
                pg = tk.Frame(self.content, bg=P["bg"])
                self.pages[key] = pg
                builder(pg)
            self._build_nc()
            self._apply_sidebar(self.side_collapsed, animate=False)
            self.bind_all("<Button-1>", self._nc_outside_click, add="+")
            self.bind("<Escape>", lambda e: self.toggle_nc(False))

        def _nav_hover(self, key, on):
            row, bar, lab, badge = self.nav[key]
            if key == self.current_page:
                return
            col = P["panel"] if on else P["side"]
            for w in (row, lab, badge):
                w.configure(bg=col)

        def show(self, key):
            for k, pg in self.pages.items():
                pg.pack_forget()
            self.pages[key].pack(fill="both", expand=True)
            self.current_page = key
            for k, (row, bar, lab, badge) in self.nav.items():
                on = k == key
                for w in (row, lab, badge):
                    w.configure(bg=P["panel"] if on else P["side"])
                bar.configure(bg=P["accent"] if on else P["side"])
                lab.configure(fg=P["text"] if on else P["muted"])
            if key == "worlds":
                self.refresh_worlds()
            elif key == "minecraft":
                self.refresh_minecraft()

        def _header(self, page, title, subtitle=""):
            h = tk.Frame(page, bg=P["bg"])
            h.pack(fill="x", padx=28, pady=(22, 14))
            left = tk.Frame(h, bg=P["bg"])
            left.pack(side="left")
            label(left, title, 20, True).pack(anchor="w")
            if subtitle:
                label(left, subtitle, 10, fg=P["muted"]).pack(anchor="w")
            right = tk.Frame(h, bg=P["bg"])
            right.pack(side="right")
            bell = Bell(right, self.toggle_nc)
            bell.pack(side="right", padx=(10, 0))
            self.bells.append(bell)
            return right

        def say(self, msg, lvl="info"):
            log_to_file(msg, lvl)
            self.log.configure(state="normal")
            self.log.insert("end", msg + "\n", lvl)
            self.log.see("end")
            self.log.configure(state="disabled")

        def _log_clear(self):
            self.log.configure(state="normal")
            self.log.delete("1.0", "end")
            self.log.configure(state="disabled")

        def set_status(self, text):
            self.lbl_status.config(text=text)

        def toggle_log(self, show=None):
            vis = self.logbox.winfo_ismapped()
            show = (not vis) if show is None else show
            if show and not vis:
                self.logbox.pack(side="bottom", fill="x", before=self.content)
                self.btn_log.config(text="Activity ▼")
            elif not show and vis:
                self.logbox.pack_forget()
                self.btn_log.config(text="Activity ▲")

        # ================================================================== background plumbing
        def _pump(self):
            try:
                while True:
                    kind, payload = self.q.get_nowait()
                    if kind == "log":
                        self.say(*payload)
                    elif kind == "scan":
                        self._scan_done(*payload)
                    elif kind == "analysis":
                        aid, issues, order, plan = payload
                        if aid == self.an_id:
                            self.issues, self.order, self.plan = issues, order, plan
                            self._log_moves(plan)
                            self._show_analysis()
                    elif kind == "running":
                        self.mc_running = payload
                        self.lbl_running.config(text="● Minecraft is running" if payload else "")
                        if payload and not self._was_running:
                            self.notify("Minecraft is running", "Pack changes show after you reopen the world.", "info",
                                        key="running", routine=True)
                        elif not payload:
                            self.notify_clear("running")
                        self._was_running = payload
                    elif kind == "done":
                        self._done(payload)
                    elif kind == "changes":
                        cid, res, guesses = payload
                        if cid == self.change_id:
                            self.changes, self.guesses = res, guesses
                            self.rebuild()
                            self._rebuild_updates()
                            n = sum(1 for p in self.packs if self._change_of(p) and self._change_of(p).kind != "older")
                            if n:
                                self.say(f"{n} installed pack(s) differ from your library (see Mods > Updates).", "info")
                                self.notify(f"{n} mod update(s) available", "Newer versions, or mods edited since they "
                                            "were installed.", "warn", "updates", key="updates")
                            else:
                                self.notify_clear("updates")
                            unn = sum(1 for m_ in self.mods if any(not p.named for p in m_.packs))
                            if unn:
                                self.notify(f"{unn} pack(s) have no real name", "Open Pack info to identify them or "
                                            "give them a label.", "info", "unnamed", key="unnamed", routine=True)
                            else:
                                self.notify_clear("unnamed")
                    elif kind == "icons":
                        job, data = payload
                        if job == self.icon_job:
                            self.icon_bytes = data
                            self.icon_cache.clear()
                            for iid, m_ in self.mod_rows.items():
                                self.tree.item(iid, image=self._mod_icon(m_, 36))
                            self._show_detail()
                    elif kind == "inspect":
                        tok, info = payload
                        cb = self.inspect_cbs.pop(tok, None)
                        if cb:
                            cb(info)
                    elif kind == "upd_detail":
                        job, m, out = payload
                        if job == self.upd_job:
                            self._render_update_detail(m, out)
                    elif kind == "crash":
                        self._crash(*payload)
            except queue.Empty:
                pass
            self.after(100, self._pump)

        def _poll_running(self):
            while True:
                self.q.put(("running", minecraft_running()))
                time.sleep(6)

        def _qlog(self, msg, lvl="info"):
            self.q.put(("log", (msg, lvl)))

        def _run(self, title, fn, launch=False, again=None):
            if self.busy:
                return
            self._again = again
            self.busy = True
            self._save()
            self.toggle_log(True)
            self.say(f"--- {title} ---", "info")
            self.set_status(title + "...")
            self.progress.pack(side="right", padx=8, pady=8)
            self.progress.start(12)
            self._set_actions(False)

            def work():
                res = None
                try:
                    res = fn(self._qlog)
                except Exception as e:
                    tb = traceback.format_exc()
                    short, hint = explain_error(e)
                    log_to_file(tb, "err")
                    self._qlog(f"Stopped by an error: {short} {hint}", "err")
                    res = {"crash": (short, hint, tb)}
                self.q.put(("done", (res, launch)))
            threading.Thread(target=work, daemon=True).start()

        def _done(self, payload):
            res, launch = payload
            self.busy = False
            self.progress.stop()
            self.progress.pack_forget()
            self._set_actions(True)
            problems = []
            if isinstance(res, dict) and "crash" in res:
                msg = "Stopped by an error."
                short, hint, tb = res["crash"]
                problems = [("The operation", short, hint, None)]
                detail = tb
            elif isinstance(res, dict) and "installed" in res:
                msg = (f"Done: {res['installed']} installed, {res['updated']} updated, {res['skipped']} skipped, "
                       f"{res['failed']} failed.")
                problems = [(n, m_, "", None) for n, m_, _u in res.get("problems", [])]
                detail = ""
            elif isinstance(res, dict) and "removed" in res:
                msg = f"Done: {res['removed']} removed."
                problems = [(n, m_, "", None) for n, m_, _u in res.get("problems", [])]
                detail = ""
            elif isinstance(res, int):
                msg = f"Done: {res} removed."
                detail = ""
            else:
                msg = "Done."
                detail = ""
            self.say(msg, "err" if problems else "ok")
            if problems:
                self.notify(msg.rstrip(".") + f" ({len(problems)} problem(s))",
                            "; ".join(f"{p[0]}: {p[1].split(' Try: ')[0]}" for p in problems[:3]), "err")
            elif isinstance(res, (dict, int)):
                self.notify(msg, "", "ok", routine=True)
            self.set_status(msg)
            self.rescan()
            self.reload_worlds()
            self.refresh_minecraft()
            pw = getattr(self, "_pending_world", None)
            self._pending_world = None
            if pw and pw.get("dest") and Path(pw["dest"]).is_dir() and getattr(self, "_pending_link", False):
                lw_ = [str(x) for x in self.cfg.get("linked_worlds", [])]
                if str(pw["dest"]) not in lw_ and not any(str(pw["dest"]) == str(w.path) for w, l in self.worlds
                                                          if l != MANAGED_LABEL):
                    self.cfg["linked_worlds"] = lw_ + [str(pw["dest"])]
                    self.reload_worlds()
            self._pending_link = False
            if pw and pw.get("dest") and Path(pw["dest"]).is_dir():
                self.world = Path(pw["dest"])
                self._after_world_change()
            if self.world:
                self.order = {k: [u for u, _ in v] for k, v in world_pack_lists(self.world).items()}
                self._load_editor()
            if problems:
                self.report_dialog("Some things did not work",
                                   "Everything else was completed. Here is what failed and what to try:", problems,
                                   detail=detail, retry=getattr(self, "_again", None))
            elif launch:
                try:
                    launch_minecraft(self.mc_root)
                except Exception as e:
                    self.say(f"Could not launch Minecraft: {e}", "warn")

        def _set_actions(self, on):
            for b in getattr(self, "action_btns", []):
                b.configure(state="normal" if on else "disabled")

        def _schedule_save(self):
            if self._save_job:
                self.after_cancel(self._save_job)
            self._save_job = self.after(500, self._save)

        def _save(self):
            self._save_job = None
            self.cfg["ticked"] = sorted(self.ticked)
            self.cfg["world"] = str(self.world) if self.world else ""
            self.cfg["target"] = str(self.mc_root) if self.mc_root else ""
            self.cfg["notifications"] = self.notes[:60]
            err = save_config(self.cfg)
            if err and not self._save_warned:
                self._save_warned = True
                self.say(f"Could not save settings: {err}", "err")
            elif not err:
                self._save_warned = False

        def _close(self):
            self._save()
            self.destroy()

        # ================================================================== Minecraft folder / roots
        def find_roots(self):
            self.roots = detect_roots()
            self.cb_target["values"] = [str(p) for _, p in self.roots]
            t = Path(self.cfg["target"]) if self.cfg["target"] else None
            pick = t if (t and t.is_dir()) else (self.roots[0][1] if self.roots else None)
            if not self.roots:
                self.say("No Minecraft data folder found automatically. Pick your com.mojang folder (or a Bedrock "
                         "server folder) on the Minecraft page.", "warn")
            self._set_root(pick, rescan=False)
            w = Path(self.cfg["world"]) if self.cfg["world"] else None
            if w and w.is_dir():
                self.world = w
                self._after_world_change(light=True)

        def _root_label(self, path):
            for lab, p in self.roots:
                if p == path:
                    return lab
            return "Custom folder"

        def _set_root(self, path, rescan=True):
            self.mc_root = Path(path) if path else None
            self.mc_label = self._root_label(self.mc_root) if self.mc_root else "No folder selected"
            self.lbl_side_mc.config(text=f"Minecraft\n{self.mc_label}")
            self.var_target.set(str(self.mc_root) if self.mc_root else "")
            self._schedule_save()
            self.reload_worlds()
            self.refresh_minecraft()
            self._update_chips()
            if rescan:
                self.rescan()

        def browse_target(self):
            d = filedialog.askdirectory(title="Pick the com.mojang folder (or a Bedrock server folder)")
            if d:
                self._set_root(os.path.normpath(d))

        def open_folder(self, path):
            if path and Path(path).exists():
                if os.name == "nt":
                    os.startfile(str(path))
                else:
                    subprocess.Popen(["xdg-open", str(path)])

        # ================================================================== Minecraft page
        def _build_minecraft(self, page):
            right = self._header(page, "Minecraft", "Your Minecraft Bedrock folder and what is installed in it")
            body = tk.Frame(page, bg=P["bg"])
            body.pack(fill="both", expand=True, padx=28, pady=(0, 18))
            top = tk.Frame(body, bg=P["bg"])
            top.pack(fill="x")
            c1 = card(top)
            c1.pack(side="left", fill="y", padx=(0, 14))
            label(c1, "Installations found", 11, True).pack(anchor="w", padx=14, pady=(12, 6))
            fr, self.t_roots = make_tree(c1, ("name",), {"name": ("Minecraft install", 330, "w", True)}, height=4)
            fr.pack(fill="x", padx=12)
            self.t_roots.bind("<<TreeviewSelect>>", self._on_root_pick)
            make_btn(c1, "Browse for another folder...", self.browse_target).pack(anchor="w", padx=12, pady=12)

            c2 = card(top)
            c2.pack(side="left", fill="both", expand=True)
            self.mc_title = label(c2, "", 16, True)
            self.mc_title.pack(anchor="w", padx=18, pady=(14, 0))
            self.mc_path = label(c2, "", 9, fg=P["muted"])
            self.mc_path.pack(anchor="w", padx=18, pady=(0, 10))
            brow = tk.Frame(c2, bg=P["panel"])
            brow.pack(fill="x", padx=18)
            self.btn_launch = make_btn(brow, "▶  Launch Minecraft", self._launch, "success")
            self.btn_launch.pack(side="left")
            make_btn(brow, "Open folder", lambda: self.open_folder(self.mc_root)).pack(side="left", padx=8)
            make_btn(brow, "Refresh", self.refresh_minecraft).pack(side="left")
            tiles = tk.Frame(c2, bg=P["panel"])
            tiles.pack(fill="x", padx=14, pady=(14, 14))
            self.tiles = {}
            for key, title in (("worlds", "Worlds"), ("behavior", "Behavior packs"), ("resource", "Resource packs"),
                               ("dev", "Development packs"), ("skin", "Skin packs")):
                t = tk.Frame(tiles, bg=P["panel2"])
                t.pack(side="left", fill="x", expand=True, padx=4)
                v = label(t, "-", 20, True, bg=P["panel2"])
                v.pack(anchor="w", padx=12, pady=(8, 0))
                label(t, title, 9, fg=P["muted"], bg=P["panel2"]).pack(anchor="w", padx=12, pady=(0, 8))
                self.tiles[key] = v

            tiles2 = tk.Frame(c2, bg=P["panel"])
            tiles2.pack(fill="x", padx=14, pady=(0, 14))
            self.tiles2 = {}
            for key, title, cmd in (("lib", "Mods in library", lambda: (self.show("mods"), self._mod_view("library"))),
                                    ("upd", "Updates available", lambda: (self.show("mods"), self._mod_view("updates"))),
                                    ("fav", "Favorites", lambda: self._show_filter("Favorites")),
                                    ("unn", "Unnamed packs", lambda: self._show_filter("Unnamed packs")),
                                    ("bad", "Unreadable files", lambda: self.show_scan_problems())):
                t = tk.Frame(tiles2, bg=P["panel2"], cursor="hand2")
                t.pack(side="left", fill="x", expand=True, padx=4)
                v = label(t, "-", 16, True, bg=P["panel2"])
                v.pack(anchor="w", padx=12, pady=(6, 0))
                tl = label(t, title, 9, fg=P["muted"], bg=P["panel2"])
                tl.pack(anchor="w", padx=12, pady=(0, 6))
                for w_ in (t, v, tl):
                    w_.bind("<Button-1>", lambda e, c=cmd: c())
                self.tiles2[key] = v

            bottom = tk.Frame(body, bg=P["bg"])
            bottom.pack(fill="both", expand=True, pady=(14, 0))
            ce = card(bottom)
            ce.pack(side="left", fill="both", expand=True, padx=(0, 14))
            label(ce, "Folder contents  (double-click to open in Explorer)", 11, True).pack(anchor="w", padx=14, pady=(12, 6))
            fr, self.t_files = make_tree(ce, ("size", "modified"), {"size": ("Size", 72, "e", False),
                                                                   "modified": ("Modified", 140, "w", False)},
                                         height=12, show="tree headings")
            self.t_files.heading("#0", text="Name", anchor="w")
            self.t_files.column("#0", width=300, stretch=True)
            fr.pack(fill="both", expand=True, padx=12, pady=(0, 12))
            self.t_files.tag_configure("dir", foreground=P["accent"])
            self.t_files.bind("<<TreeviewOpen>>", self._explorer_open)
            self.t_files.bind("<Double-1>", lambda e: self.open_folder(self.t_files.focus()) if self.t_files.focus()
                              and "|dummy|" not in self.t_files.focus() else None)
            cp = card(bottom)
            cp.pack(side="left", fill="both", expand=True)
            label(cp, "Installed packs", 11, True).pack(anchor="w", padx=14, pady=(12, 6))
            fr, self.t_inst = make_tree(cp, ("name", "kind", "ver", "where"),
                                        {"name": ("Pack", 220, "w", True), "kind": ("Type", 80, "w", False),
                                         "ver": ("Version", 70, "center", False), "where": ("Folder", 100, "w", False)},
                                        height=12, select="extended")
            fr.pack(fill="both", expand=True, padx=12)
            bar = tk.Frame(cp, bg=P["panel"])
            bar.pack(fill="x", padx=12, pady=10)
            self.btn_inst_remove = make_btn(bar, "Remove selected from Minecraft", self._remove_installed, "danger")
            self.btn_inst_remove.pack(side="left")
            make_btn(bar, "Pack info", self._inspect_installed).pack(side="right")
            self.t_inst.bind("<Double-1>", lambda e: self._inspect_installed())
            self.action_btns = getattr(self, "action_btns", []) + [self.btn_inst_remove]

        def _on_root_pick(self, e=None):
            if self._syncing:
                return
            sel = self.t_roots.selection()
            if sel and Path(sel[0]) != self.mc_root:
                self._set_root(Path(sel[0]))

        def _show_filter(self, option):
            self.show("mods")
            self._mod_view("library")
            self.var_show.set(option)
            self.rebuild()

        def _update_dashboard(self):
            if not hasattr(self, "tiles2"):
                return
            n_up = sum(1 for p in self.packs if not p.superseded and self._change_of(p)
                       and self._change_of(p).kind != "older") if hasattr(self, "changes") else 0
            self.tiles2["lib"].config(text=str(len(self.mods)))
            self.tiles2["upd"].config(text=str(n_up), fg=P["warn"] if n_up else P["text"])
            self.tiles2["fav"].config(text=str(sum(1 for m in self.mods if self._is_fav(m))))
            unn = sum(1 for m in self.mods if any(not p.named for p in m.packs))
            self.tiles2["unn"].config(text=str(unn), fg=P["warn"] if unn else P["text"])
            bad = len(self.scan_problems)
            self.tiles2["bad"].config(text=str(bad), fg=P["err"] if bad else P["text"])

        def _launch(self):
            try:
                launch_minecraft(self.mc_root)
                self.set_status("Launching Minecraft...")
                self.cfg["last_launch"] = time.time()
                self.cfg["launch_count"] = int(self.cfg.get("launch_count", 0)) + 1
                self._update_played()
                self._schedule_save()
            except Exception as e:
                messagebox.showinfo(APP_NAME, str(e))

        def _update_played(self):
            t = self.cfg.get("last_launch") or 0
            self.lbl_played.config(text=(f"Last launched {datetime.fromtimestamp(t).strftime('%b %d, %I:%M %p')}\n"
                                         f"{self.cfg.get('launch_count', 0)} launch(es) from here") if t else
                                   "Not launched from here yet")

        def refresh_minecraft(self):
            self._syncing = True
            self.t_roots.delete(*self.t_roots.get_children())
            rows = list(self.roots)
            if self.mc_root and all(self.mc_root != p for _, p in rows):
                rows.append(("Custom folder", self.mc_root))
            for lab, p in rows:
                self.t_roots.insert("", "end", iid=str(p), values=(lab,))
            if self.mc_root and self.t_roots.exists(str(self.mc_root)):
                self.t_roots.selection_set(str(self.mc_root))
            self._syncing = False
            root = self.mc_root
            self.mc_title.config(text=self.mc_label if root else "No Minecraft folder selected")
            self.mc_path.config(text=str(root) if root else "Pick a folder with Browse, or open Settings.")
            self.btn_launch.configure(state="normal" if (os.name == "nt" and root) else "disabled")
            self.btn_play.configure(state="normal" if (os.name == "nt" and root) else "disabled")
            self._update_played()
            self._update_dashboard()
            self.mc_installed = []
            counts = {"behavior": 0, "resource": 0, "dev": 0, "skin": 0}
            self.t_inst.delete(*self.t_inst.get_children())
            if root and root.is_dir():
                for mode, where in (("standard", "Normal"), ("development", "Development")):
                    for inst in scan_installed(root, mode).values():
                        self.mc_installed.append((inst, mode, where))
                        if mode == "development":
                            counts["dev"] += 1
                        elif inst.kind in counts:
                            counts[inst.kind] += 1
                self.mc_installed.sort(key=lambda x: x[0].name.lower())
                for i, (inst, mode, where) in enumerate(self.mc_installed):
                    self.t_inst.insert("", "end", iid=str(i), values=(inst.name, KIND_LABEL.get(inst.kind, inst.kind),
                                                                       vstr(inst.version), where))
            for k, v in counts.items():
                self.tiles[k].config(text=str(v))
            self.tiles["worlds"].config(text=str(len(self.worlds)))
            self.nav["minecraft"][3].config(text="")
            self._fill_explorer()

        def _fill_explorer(self):
            t = self.t_files
            t.delete(*t.get_children())
            if self.mc_root and self.mc_root.is_dir():
                self._add_children("", self.mc_root)

        def _add_children(self, parent, path):
            t = self.t_files
            try:
                entries = sorted(os.scandir(path), key=lambda e: (not e.is_dir(), e.name.lower()))
            except OSError:
                return
            for e in entries[:400]:
                try:
                    st = e.stat()
                    mod = datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d %H:%M")
                except OSError:
                    st, mod = None, ""
                if e.is_dir():
                    t.insert(parent, "end", iid=e.path, text="  " + e.name, values=("", mod), tags=("dir",))
                    t.insert(e.path, "end", iid=e.path + "|dummy|", text="")
                else:
                    t.insert(parent, "end", iid=e.path, text="  " + e.name,
                             values=(human_size(st.st_size) if st else "", mod))

        def _explorer_open(self, e=None):
            t = self.t_files
            iid = t.focus()
            kids = t.get_children(iid)
            if len(kids) == 1 and kids[0].endswith("|dummy|"):
                t.delete(kids[0])
                self._add_children(iid, iid)

        def _worlds_using(self, uuids):
            out = []
            for info, _lab in self.worlds:
                lists = world_pack_lists(info.path)
                if any(u in uuids for kind in lists for u, _ in lists[kind]):
                    out.append(info)
            return out

        def _inspect_installed(self):
            sel = self.t_inst.selection()
            if sel:
                inst = self.mc_installed[int(sel[0])][0]
                p = scan_pack_dir(inst.folder, [])
                if p:
                    self.inspect_dialog(p)

        def _remove_installed(self):
            sel = [self.mc_installed[int(i)] for i in self.t_inst.selection()]
            if not sel or not self.mc_root:
                return
            names = "\n".join(f"  - {i.name}" for i, _, _ in sel[:10]) + ("\n  ..." if len(sel) > 10 else "")
            if not messagebox.askyesno(APP_NAME, f"Remove {len(sel)} pack(s) from Minecraft?\n\n{names}"):
                return
            using = self._worlds_using({i.uuid for i, _, _ in sel})
            also = []
            if using and messagebox.askyesno(APP_NAME, "These worlds still list some of them:\n\n" +
                                             "\n".join(f"  - {w.name}" for w in using[:8]) +
                                             "\n\nRemove them from those worlds too?"):
                also = using
            root = self.mc_root
            groups = {}
            for inst, mode, _ in sel:
                groups.setdefault(mode, []).append(Pack(uuid=inst.uuid, name=inst.name, version=inst.version,
                                                        kind=inst.kind))
            uuids = {i.uuid for i, _, _ in sel}

            def work(log):
                n, probs = 0, []
                for mode, packs in groups.items():
                    n += uninstall_many(packs, root, mode, [], log, probs)
                for w in also:
                    remove_from_world(w.path, uuids, log)
                return {"removed": n, "problems": probs}
            self._run("Removing packs from Minecraft", work)

        # ================================================================== Worlds
        def reload_worlds(self):
            roots = list(self.roots)
            if self.mc_root and all(self.mc_root != p for _, p in roots):
                roots.append(("Custom folder", self.mc_root))
            roots.sort(key=lambda lp_: lp_[1] != self.mc_root)
            seen, out = set(), []
            for lab, root in roots:
                for sub in ("minecraftWorlds", "worlds"):
                    d = Path(root) / sub
                    if not d.is_dir():
                        continue
                    for w in sorted(d.iterdir()):
                        if w.is_dir() and str(w) not in seen and ((w / "level.dat").exists() or
                                                                  (w / "levelname.txt").exists()):
                            seen.add(str(w))
                            out.append((world_info(w), lab))
            out.sort(key=lambda x: x[0].last_played or datetime.min, reverse=True)
            linked, self.missing_linked = [], []
            for path in self.cfg.get("linked_worlds", []):
                if str(path) in seen:
                    continue
                if Path(path).is_dir() and (Path(path) / "level.dat").exists():
                    seen.add(str(path))
                    linked.append((world_info(Path(path)), MANAGED_LABEL))
                else:
                    self.missing_linked.append(path)
            linked.sort(key=lambda x: x[0].name.lower())
            out += linked
            self.worlds = out
            if self.world and not Path(self.world).is_dir():
                self.world = None
                self._after_world_change(light=True)
            self.nav["worlds"][3].config(text=str(len(out)) if out else "")
            if hasattr(self, "t_worlds"):
                self.refresh_worlds()

        def _build_worlds(self, page):
            right = self._header(page, "Worlds", "Pick the world you want to edit. Mods you add go into this world.")
            make_btn(right, "Refresh", self.reload_worlds).pack(side="right")
            make_btn(right, "Load world...", self._load_world_menu, "primary").pack(side="right", padx=8)
            self.var_into_mc = tk.BooleanVar(value=bool(self.cfg["load_into_mc"]))
            self.var_into_mc.trace_add("write", lambda *a: self._set_into_mc())
            tk.Checkbutton(right, text="Load Into Minecraft", variable=self.var_into_mc, bg=P["bg"], fg=P["text"],
                           selectcolor=P["panel2"], activebackground=P["bg"], activeforeground=P["text"],
                           highlightthickness=0, bd=0, font=F(10), cursor="hand2").pack(side="right")
            body = tk.Frame(page, bg=P["bg"])
            body.pack(fill="both", expand=True, padx=28, pady=(0, 18))
            left = card(body)
            left.pack(side="left", fill="both", expand=True, padx=(0, 14))
            label(left, "Worlds", 11, True).pack(anchor="w", padx=14, pady=(12, 6))
            heads = {"cur": ("", 34, "center", False), "name": ("World", 200, "w", True),
                     "mode": ("Mode", 80, "w", False), "played": ("Last played", 135, "w", False),
                     "ver": ("Version", 76, "w", False), "packs": ("BP / RP", 64, "center", False),
                     "loc": ("Location", 150, "w", False)}
            fr, self.t_worlds = make_tree(left, tuple(heads), heads, height=14)
            fr.pack(fill="both", expand=True, padx=12, pady=(0, 12))
            self.t_worlds.tag_configure("cur", foreground=P["ok"])
            self.t_worlds.bind("<<TreeviewSelect>>", self._on_world_select)

            rt = card(body)
            rt.pack(side="left", fill="both", expand=True)
            self.w_title = label(rt, "No world selected", 16, True)
            self.w_title.pack(anchor="w", padx=18, pady=(14, 0))
            self.w_meta = label(rt, "", 9, fg=P["muted"], justify="left", wraplength=560)
            self.w_meta.pack(anchor="w", padx=18, pady=(2, 8))
            brow = tk.Frame(rt, bg=P["panel"])
            brow.pack(fill="x", padx=18)
            make_btn(brow, "Add mods...", lambda: self.show("mods"), "primary").pack(side="left")
            make_btn(brow, "Open folder", lambda: self.open_folder(self.world)).pack(side="left", padx=8)
            self.btn_backup = make_btn(brow, "Back up world", self._backup_now)
            self.btn_backup.pack(side="left")
            make_btn(brow, "Remove from list", self._unlink_world).pack(side="left", padx=8)
            self.action_btns = getattr(self, "action_btns", []) + [self.btn_backup]
            label(rt, "Packs active in this world (load order)", 11, True).pack(anchor="w", padx=18, pady=(14, 2))
            self.lbl_we_hint = label(rt, "", 9, fg=P["muted"])
            self.lbl_we_hint.pack(anchor="w", padx=18)
            self.we_trees = {}
            wrap = tk.Frame(rt, bg=P["panel"])
            wrap.pack(fill="both", expand=True, padx=14, pady=(6, 0))
            for kind, title in KINDS:
                col = tk.Frame(wrap, bg=P["panel"])
                col.pack(side="left", fill="both", expand=True, padx=4)
                label(col, title, 9, True, fg=P["muted"]).pack(anchor="w")
                fr, t = make_tree(col, ("n", "name", "ver"), {"n": ("#", 30, "center", False),
                                                              "name": ("Pack", 150, "w", True),
                                                              "ver": ("Ver", 60, "center", False)}, height=8)
                fr.pack(fill="both", expand=True)
                t.tag_configure("missing", foreground=P["err"])
                t.bind("<<TreeviewSelect>>", lambda e, k=kind: self._we_pick(k))
                t.bind("<Double-1>", lambda e, k=kind: self._we_inspect(k))
                self.we_trees[kind] = t
            self.we_focus = "behavior"
            bar = tk.Frame(rt, bg=P["panel"])
            bar.pack(fill="x", padx=14, pady=10)
            make_btn(bar, "▲", lambda: self._we_move(-1)).pack(side="left")
            make_btn(bar, "▼", lambda: self._we_move(1)).pack(side="left", padx=6)
            make_btn(bar, "Remove", self._we_remove).pack(side="left")
            make_btn(bar, "Restore original", self._we_restore).pack(side="left", padx=6)
            self.btn_we_save = make_btn(bar, "Save order", self._we_save, "primary")
            self.btn_we_save.pack(side="right")
            self.btn_we_revert = make_btn(bar, "Revert", self._we_revert)
            self.btn_we_revert.pack(side="right", padx=8)
            self.lbl_we_dirty = label(bar, "", 9, fg=P["warn"])
            self.lbl_we_dirty.pack(side="right", padx=8)
            rt.configure(width=600)
            rt.pack_propagate(False)
            left.pack_forget()
            rt.pack_forget()
            rt.pack(side="right", fill="y")
            left.pack(side="left", fill="both", expand=True, padx=(0, 14))

        def refresh_worlds(self):
            t = self.t_worlds
            self._syncing = True
            t.delete(*t.get_children())
            n_mc = sum(1 for _, l in self.worlds if l != MANAGED_LABEL)
            n_man = len(self.worlds) - n_mc
            t.tag_configure("hdr", foreground=P["muted"], font=F(9, True))
            t.insert("", "end", iid="hdr:mc", tags=("hdr",), values=("", f"IN MINECRAFT  ({n_mc})" if n_mc else "IN MINECRAFT  (none)", "", "", "", "", ""))
            groups_done = set()
            for info, lab in sorted(self.worlds, key=lambda x: x[1] == MANAGED_LABEL):
                if lab == MANAGED_LABEL and "m" not in groups_done:
                    groups_done.add("m")
                    t.insert("", "end", iid="hdr:man", tags=("hdr",),
                             values=("", f"MANAGED  ({n_man})", "", "not in Minecraft", "", "", ""))
                lists = world_pack_lists(info.path)
                cur = self.world is not None and Path(info.path) == Path(self.world)
                played = info.last_played.strftime("%Y-%m-%d %H:%M") if info.last_played else ""
                t.insert("", "end", iid=str(info.path), tags=("cur",) if cur else (),
                         values=("●" if cur else "", info.name, info.mode, played, info.version,
                                 f"{len(lists['behavior'])} / {len(lists['resource'])}", lab))
            if "m" not in groups_done:
                t.insert("", "end", iid="hdr:man", tags=("hdr",),
                         values=("", "MANAGED  (none yet)", "", "not in Minecraft", "", "", ""))
            if self.world and t.exists(str(self.world)):
                t.selection_set(str(self.world))
                t.see(str(self.world))
            self._syncing = False
            self._render_world_meta()

        def _info_of(self, path):
            for info, _ in self.worlds:
                if Path(info.path) == Path(path):
                    return info
            return world_info(path)

        def _render_world_meta(self):
            if not self.world:
                self.w_title.config(text="No world selected")
                self.w_meta.config(text="Click a world on the left to edit it.")
                return
            info = self._info_of(self.world)
            friendly = {"gametest": "Beta APIs", "data_driven_items": "Holiday creator features",
                        "upcoming_creator_features": "Upcoming creator features", "cameras": "Cameras",
                        "experimental_custom_ui": "Custom UI", "villager_trades_rebalance": "Villager trade rebalance"}
            exp = ", ".join(friendly.get(x, x) for x in info.experiments) or "none"
            lines = [f"{info.mode or 'Mode unknown'}  ·  {info.difficulty or 'difficulty unknown'}",
                     f"Last played: {info.last_played.strftime('%Y-%m-%d %H:%M') if info.last_played else 'unknown'}"
                     + (f"   ·   Opened with Minecraft {info.version}" if info.version else ""),
                     f"Experiments on: {exp}" + ("" if info.has_dat else "   (level.dat could not be read)"),
                     str(info.path)]
            self.w_title.config(text=info.name)
            self.w_meta.config(text="\n".join(lines))

        def _on_world_select(self, e=None):
            if self._syncing:
                return
            sel = self.t_worlds.selection()
            if not sel:
                return
            if sel[0].startswith("hdr:"):
                self._syncing = True
                self.t_worlds.selection_set(str(self.world)) if self.world and self.t_worlds.exists(str(self.world)) \
                    else self.t_worlds.selection_set(())
                self._syncing = False
                return
            path = Path(sel[0])
            if self.world and path == Path(self.world):
                return
            if self.we_dirty and not messagebox.askyesno(APP_NAME, "You have unsaved changes to this world's pack "
                                                                   "order. Discard them?"):
                self._syncing = True
                self.t_worlds.selection_set(str(self.world))
                self._syncing = False
                return
            self.world = path
            self._manual = False
            self.order = {k: [u for u, _ in v] for k, v in world_pack_lists(path).items()}
            self._after_world_change()

        def _after_world_change(self, light=False):
            self.lbl_side_world.config(text=f"World\n{self._info_of(self.world).name}" if self.world else "")
            self._load_editor()
            if self.world:
                self.order = {k: [u for u, _ in v] for k, v in world_pack_lists(self.world).items()}
            self._update_chips()
            self._schedule_save()
            if not light:
                self.refresh_worlds()
                self.rebuild()
                self._schedule_analysis()

        def _pack_name(self, uuid):
            for p in self.packs:
                if p.uuid == uuid and not p.superseded:
                    return p.name, "Library"
            i = self.installed_all.get(uuid)
            if i:
                return i.name, "Minecraft folder"
            if uuid in self.we_names:
                return self.we_names[uuid], "World folder"
            return None, "missing"

        def _load_editor(self):
            if self.world:
                self.we = world_pack_lists(self.world)
                self.we_names = {u: i.name for u, i in scan_installed(self.world, "standard").items()}
            else:
                self.we, self.we_names = {"behavior": [], "resource": []}, {}
            self.we_dirty = False
            self._render_editor()

        def _render_editor(self, keep=None):
            lw = self.cfg["last_wins"]
            self.lbl_we_hint.config(text="The LAST pack overrides the ones above it." if lw
                                    else "The FIRST pack overrides the ones below it.")
            for kind, _ in KINDS:
                t = self.we_trees[kind]
                t.delete(*t.get_children())
                for n, (u, v) in enumerate(self.we[kind], 1):
                    name, src = self._pack_name(u)
                    t.insert("", "end", iid=u, tags=("missing",) if name is None else (),
                             values=(n, name or f"(not found) {u[:8]}", vstr(v)))
                if keep and keep[0] == kind and t.exists(keep[1]):
                    t.selection_set(keep[1])
            self.lbl_we_dirty.config(text="Unsaved changes" if self.we_dirty else "")
            for b in (self.btn_we_save, self.btn_we_revert):
                b.configure(state="normal" if self.we_dirty else "disabled")

        def _we_inspect(self, kind):
            sel = self.we_trees[kind].selection()
            if sel:
                self.inspect_uuid(sel[0])

        def _we_pick(self, kind):
            self.we_focus = kind
            other = "resource" if kind == "behavior" else "behavior"
            if self.we_trees[kind].selection():
                self.we_trees[other].selection_set(())

        def _we_move(self, delta):
            kind = self.we_focus
            sel = self.we_trees[kind].selection()
            if not sel:
                return
            lst = self.we[kind]
            ids = [u for u, _ in lst]
            i = ids.index(sel[0])
            j = i + delta
            if 0 <= j < len(lst):
                lst[i], lst[j] = lst[j], lst[i]
                self.we_dirty = True
                self._render_editor(keep=(kind, sel[0]))

        def _we_remove(self):
            kind = self.we_focus
            sel = self.we_trees[kind].selection()
            if sel:
                self.we[kind] = [(u, v) for u, v in self.we[kind] if u != sel[0]]
                self.we_dirty = True
                self._render_editor()

        def _we_restore(self):
            if not self.world:
                return
            baks = [(f, Path(self.world) / (f + ".bak_addonloader"))
                    for f in ("world_behavior_packs.json", "world_resource_packs.json")]
            baks = [(f, b) for f, b in baks if b.exists()]
            if not baks:
                messagebox.showinfo(APP_NAME, "No saved original found for this world. A copy is made the first time "
                                              "this program edits a world's pack lists.")
                return
            if not messagebox.askyesno(APP_NAME, "Put this world's pack lists back the way they were before this "
                                                 "program first edited them?\n\n" + "\n".join(f for f, _ in baks)):
                return
            try:
                for f, b in baks:
                    write_text_safely(Path(self.world) / f, b.read_text(encoding="utf-8"))
            except Exception as e:
                short, hint = explain_error(e)
                messagebox.showerror(APP_NAME, f"Could not restore: {short}\n{hint}")
                return
            self.say("Original pack lists restored.", "ok")
            self._after_world_change()

        def _we_revert(self):
            self._load_editor()

        def _we_save(self):
            if not self.world:
                return
            try:
                for kind, _ in KINDS:
                    write_world_list(self.world, kind, self.we[kind])
            except OSError as e:
                messagebox.showerror(APP_NAME, f"Could not save: {e}")
                return
            self.say(f"Saved pack order of world '{self._info_of(self.world).name}'.", "ok")
            self.set_status("Saved world pack order.")
            self.order = {k: [u for u, _ in v] for k, v in self.we.items()}
            self.we_dirty = False
            self._render_editor()
            self.refresh_worlds()
            self.rebuild()
            self._schedule_analysis()

        def _set_into_mc(self):
            self.cfg["load_into_mc"] = bool(self.var_into_mc.get())
            self._schedule_save()

        def _is_managed(self, world):
            return bool(world) and str(world) in {str(x) for x in self.cfg.get("linked_worlds", [])}

        def _unlink_world(self):
            if not self.world or not self._is_managed(self.world):
                messagebox.showinfo(APP_NAME, "Only worlds in the 'Managed by the loader' group can be removed from "
                                              "the list. Worlds in Minecraft are left to Minecraft.")
                return
            name = self._info_of(self.world).name
            if not messagebox.askyesno(APP_NAME, f"Remove '{name}' from the loader's list?\n\nThe world's files are "
                                                 "NOT deleted."):
                return
            self.cfg["linked_worlds"] = [x for x in self.cfg["linked_worlds"] if str(x) != str(self.world)]
            self.world = None
            self._after_world_change(light=True)
            self.reload_worlds()
            self.say(f"Removed '{name}' from the list (files kept).", "info")

        def _load_world_menu(self):
            if self.busy:
                return
            m = tk.Menu(self, tearoff=0, bg=P["panel2"], fg=P["text"], activebackground=P["accent"],
                        activeforeground="#fff", bd=0)
            m.add_command(label="From a .mcworld file...", command=self._load_world_file)
            m.add_command(label="From a world folder...", command=self._load_world_folder)
            try:
                m.tk_popup(self.winfo_pointerx(), self.winfo_pointery())
            finally:
                m.grab_release()

        def _load_world_file(self):
            f = filedialog.askopenfilename(title="Pick a world file",
                                           filetypes=[("Minecraft world", "*.mcworld *.zip"), ("All files", "*.*")])
            if f:
                self._import_world(f)

        def _load_world_folder(self):
            d = filedialog.askdirectory(title="Pick a world folder (the one that contains level.dat)")
            if d:
                self._import_world(d)

        def _import_world(self, src):
            if not self.cfg["load_into_mc"]:
                return self._link_world(src)
            if not self.mc_root:
                messagebox.showinfo(APP_NAME, "Pick your Minecraft folder first (Minecraft page).")
                return
            dest_dir = Path(self.mc_root) / "minecraftWorlds"
            holder = {}

            def work(log):
                dest, name = import_world(src, dest_dir)
                holder["dest"] = dest
                log(f"Loaded world '{name}' into {dest}", "ok")
                return None
            self._run(f"Loading world from {Path(src).name}", work)
            self._pending_world = holder

        def _link_world(self, src):
            """Add a world to the loader's list without installing it into Minecraft."""
            holder = {}

            def work(log):
                sp = Path(src)
                if sp.is_dir():
                    root = world_root_of(sp)
                    if root is None:
                        raise ValueError("That folder is not a Bedrock world (no level.dat inside).")
                    log(f"Added '{world_info(root).name}' in place (nothing was copied).", "ok")
                else:
                    root, name = import_world(sp, MANAGED_DIR)       # a .mcworld has to be unpacked somewhere
                    log(f"Unpacked '{name}' into the loader's own folder: {root}", "ok")
                holder["dest"] = root
                return None
            self._run(f"Adding world from {Path(src).name} to the list", work)
            self._pending_world = holder
            self._pending_link = True

        def _backup_now(self):
            if not self.world or self.busy:
                return
            dest = self.cfg["backup_dir"] or str(APP_DIR / "backups")
            world = self.world

            def work(log):
                out = backup_world(world, dest)
                log(f"Backup written: {out}", "ok")
                return None
            self._run(f"Backing up world '{self._info_of(world).name}'", work)

        # ================================================================== Mods page
        def _build_mods(self, page):
            right = self._header(page, "Mods", "Your mod library. Tick mods, check them, then install them.")
            self.chip_world = tk.Label(right, text="", bg=P["panel2"], fg=P["text"], font=F(10), padx=12, pady=6,
                                       cursor="hand2")
            self.chip_world.pack(side="right")
            self.chip_world.bind("<Button-1>", lambda e: self.show("worlds"))
            self.chip_mc = tk.Label(right, text="", bg=P["panel2"], fg=P["text"], font=F(10), padx=12, pady=6,
                                    cursor="hand2")
            self.chip_mc.pack(side="right", padx=8)
            self.chip_mc.bind("<Button-1>", lambda e: self.show("minecraft"))
            self.chip_prob = tk.Label(right, text="", bg=P["panel2"], fg=P["warn"], font=F(10), padx=12, pady=6,
                                      cursor="hand2")
            self.chip_prob.bind("<Button-1>", lambda e: self.show_scan_problems())

            seg = tk.Frame(page, bg=P["bg"])
            seg.pack(fill="x", padx=28)
            self.seg = {}
            for key, text in (("library", "Library"), ("updates", "Updates"), ("compat", "Compatibility"), ("order", "Load order")):
                lab = tk.Label(seg, text=text, font=F(11, True), fg=P["muted"], bg=P["bg"], padx=16, pady=9,
                               cursor="hand2")
                lab.pack(side="left")
                lab.bind("<Button-1>", lambda e, k=key: self._mod_view(k))
                self.seg[key] = lab
            tk.Frame(page, height=1, bg=P["line"]).pack(fill="x", padx=28)

            bar = tk.Frame(page, bg=P["side"])
            bar.pack(side="bottom", fill="x")
            inner = tk.Frame(bar, bg=P["side"])
            inner.pack(fill="x", padx=28, pady=12)
            self.lbl_summary = label(inner, "", 10, fg=P["muted"], bg=P["side"])
            self.lbl_summary.pack(side="left")
            self.btn_uninstall = make_btn(inner, "Uninstall from Minecraft", self.act_uninstall, "danger")
            self.btn_uninstall.pack(side="right")
            self.btn_world_remove = make_btn(inner, "Remove from world", self.act_remove_world)
            self.btn_world_remove.pack(side="right", padx=8)
            self.btn_world_add = make_btn(inner, "Add to world", self.act_add_world, "success")
            self.btn_world_add.pack(side="right")
            self.btn_mc_install = make_btn(inner, "Install to Minecraft", self.act_install, "primary")
            self.btn_mc_install.pack(side="right", padx=8)
            self.action_btns = getattr(self, "action_btns", []) + [self.btn_uninstall, self.btn_world_remove,
                                                                   self.btn_world_add, self.btn_mc_install]

            self.mod_body = tk.Frame(page, bg=P["bg"])
            self.mod_body.pack(fill="both", expand=True, padx=28, pady=(12, 12))
            self.mod_views = {}
            self._build_library_view()
            self._build_updates_view()
            self._build_compat_view()
            self._build_order_view()
            self._mod_view("library")

        def _mod_view(self, key):
            for k, v in self.mod_views.items():
                v.pack_forget()
            self.mod_views[key].pack(fill="both", expand=True)
            for k, lab in self.seg.items():
                lab.configure(fg=P["text"] if k == key else P["muted"],
                              bg=P["panel"] if k == key else P["bg"])
            if key != "library":
                self._schedule_analysis(30)

        # ---- library view
        def _build_library_view(self):
            v = tk.Frame(self.mod_body, bg=P["bg"])
            self.mod_views["library"] = v
            tb = tk.Frame(v, bg=P["bg"])
            tb.pack(fill="x", pady=(0, 10))
            self.var_filter = tk.StringVar()
            e = entry(tb, self.var_filter, 26)
            e.pack(side="left", ipady=4)
            self.var_filter.trace_add("write", lambda *a: self.rebuild())
            self.var_show = tk.StringVar(value=SHOW_OPTIONS[0])
            cb = ttk.Combobox(tb, textvariable=self.var_show, values=SHOW_OPTIONS, state="readonly", width=22)
            cb.pack(side="left", padx=8)
            cb.bind("<<ComboboxSelected>>", lambda e: self.rebuild())
            b_sel = make_btn(tb, "Select ▾", lambda: self._select_menu(b_sel))
            b_sel.pack(side="left")
            b_prof = make_btn(tb, "Profiles ▾", lambda: self._profiles_menu(b_prof))
            b_prof.pack(side="left", padx=8)
            self.var_sort = tk.StringVar(value=self.cfg.get("sort", "Name"))
            cs = ttk.Combobox(tb, textvariable=self.var_sort, values=SORT_OPTIONS, state="readonly", width=15)
            cs.pack(side="left")
            cs.bind("<<ComboboxSelected>>", lambda e: (self.cfg.__setitem__("sort", self.var_sort.get()),
                                                       self._schedule_save(), self.rebuild()))
            make_btn(tb, "Rescan", self.rescan).pack(side="right")
            make_btn(tb, "Add folder...", self.add_folder).pack(side="right", padx=8)

            split = tk.Frame(v, bg=P["bg"])
            split.pack(fill="both", expand=True)
            tcard = card(split)
            tcard.pack(side="left", fill="both", expand=True)
            heads = {"sel": ("", 34, "center", False), "fav": ("★", 30, "center", False), "name": ("Mod", 200, "w", True),
                     "contents": ("Contains", 66, "center", False), "ver": ("Version", 62, "center", False),
                     "mc": ("In Minecraft", 142, "w", False), "world": ("World", 52, "center", False),
                     "issues": ("Issues", 56, "center", False)}
            self.lbl_count = label(tcard, "", 9, fg=P["muted"])
            self.lbl_count.pack(side="bottom", anchor="w", padx=12, pady=(2, 6))
            fr, self.tree = make_tree(tcard, tuple(heads), heads, height=14, show="tree headings")
            self.tree.configure(style="Lib.Treeview")
            self.tree.column("#0", width=52, stretch=False, anchor="center")
            self.tree.heading("#0", text="")
            self.lib_table = fr
            fr.pack(fill="both", expand=True, padx=1, pady=1)
            for tag, col in (("new", P["text"]), ("installed", P["ok"]), ("update", P["warn"]),
                             ("newer", P["warn"]), ("muted", P["muted"])):
                self.tree.tag_configure(tag, foreground=col)
            self.tree.bind("<Button-1>", self._on_click)
            self.tree.bind("<space>", self._on_space)
            self.tree.bind("<<TreeviewSelect>>", lambda e: self._show_detail())
            self.tree.bind("<Double-1>", self._on_dbl)
            self.tree.bind("<Button-3>", self._lib_menu)
            self.tree.bind("<Button-2>", self._lib_menu)
            self.lib_empty = tk.Frame(tcard, bg=P["panel"])
            label(self.lib_empty, "No mods found yet", 15, True).pack(pady=(70, 4))
            self.lbl_empty = label(self.lib_empty, "Add the folder where your mods live (for example WIP\\Coding).",
                                   10, fg=P["muted"])
            self.lbl_empty.pack()
            make_btn(self.lib_empty, "Add mod folder...", self.add_folder, "primary").pack(pady=14)

            dcard = card(split, width=330)
            dcard.pack(side="left", fill="y", padx=(14, 0))
            dcard.pack_propagate(False)
            self.txt_detail = tk.Text(dcard, bg=P["panel"], fg=P["text"], relief="flat", wrap="word", state="disabled",
                                      font=F(10), padx=16, pady=14, highlightthickness=0, borderwidth=0, cursor="arrow")
            self.txt_detail.pack(fill="both", expand=True)
            t = self.txt_detail
            t.tag_configure("h", font=F(14, True))
            t.tag_configure("b", font=F(10, True))
            t.tag_configure("muted", foreground=P["muted"], font=F(9))
            t.tag_configure("err", foreground=P["err"])
            t.tag_configure("warn", foreground=P["warn"])
            t.tag_configure("ok", foreground=P["ok"])
            brow = tk.Frame(dcard, bg=P["panel"])
            brow.pack(side="bottom", fill="x", padx=14, pady=12)
            self.btn_inspect = make_btn(brow, "Pack info", self._inspect_selected, "primary")
            self.btn_inspect.pack(side="left")
            self.btn_fav = make_btn(brow, "☆ Favorite", self._fav_selected)
            self.btn_fav.pack(side="left", padx=8)
            self.btn_open_src = make_btn(brow, "Open folder", self._open_selected_source)
            self.btn_open_src.pack(side="left")
            nf = tk.Frame(dcard, bg=P["panel"])
            nf.pack(side="bottom", fill="x", padx=14, pady=(0, 4))
            label(nf, "Tags (comma separated)", 9, fg=P["muted"]).pack(anchor="w")
            self.var_tags = tk.StringVar()
            self.ent_tags = entry(nf, self.var_tags, 30)
            self.ent_tags.pack(fill="x", ipady=3, pady=(0, 6))
            label(nf, "Notes", 9, fg=P["muted"]).pack(anchor="w")
            self.txt_note = tk.Text(nf, height=3, wrap="word", bg=P["panel2"], fg=P["text"], relief="flat", font=F(10),
                                    insertbackground=P["text"], highlightthickness=1, highlightbackground=P["line"],
                                    highlightcolor=P["accent"], padx=6, pady=4)
            self.txt_note.pack(fill="x")
            for w_ in (self.ent_tags, self.txt_note):
                w_.bind("<FocusOut>", lambda e: self._save_notes())
            self.txt_detail.pack_forget()
            self.txt_detail.pack(fill="both", expand=True)
            tcard.pack_forget()
            dcard.pack_forget()
            dcard.pack(side="right", fill="y", padx=(14, 0))
            tcard.pack(side="left", fill="both", expand=True)

        # ---- compatibility view
        def _build_compat_view(self):
            v = tk.Frame(self.mod_body, bg=P["bg"])
            self.mod_views["compat"] = v
            top = tk.Frame(v, bg=P["bg"])
            top.pack(fill="x", pady=(0, 8))
            self.lbl_sum = label(top, "", 11, True)
            self.lbl_sum.pack(side="left")
            make_btn(top, "Check now", lambda: self._schedule_analysis(10)).pack(side="right")
            self.lbl_scope = label(v, "", 9, fg=P["muted"])
            self.lbl_scope.pack(anchor="w", pady=(0, 8))
            c = card(v)
            c.pack(fill="both", expand=True)
            fr, self.itree = make_tree(c, ("sev", "title"), {"sev": ("Severity", 100, "w", False),
                                                            "title": ("Problem", 700, "w", True)}, height=10)
            fr.pack(fill="both", expand=True, padx=1, pady=1)
            self.itree.tag_configure("error", foreground=P["err"])
            self.itree.tag_configure("warn", foreground=P["warn"])
            self.itree.tag_configure("info", foreground=P["muted"])
            self.itree.bind("<<TreeviewSelect>>", lambda e: self._show_issue())
            self.txt_issue = tk.Text(v, height=6, wrap="word", state="disabled", relief="flat", bg=P["panel"],
                                     fg=P["text"], font=F(10), padx=14, pady=10, highlightthickness=1,
                                     highlightbackground=P["line"])
            self.txt_issue.pack(fill="x", pady=(8, 0))

        # ---- load order view
        def _build_order_view(self):
            v = tk.Frame(self.mod_body, bg=P["bg"])
            self.mod_views["order"] = v
            self.lbl_orderhint = label(v, "", 10, fg=P["muted"], wraplength=980, justify="left")
            self.lbl_orderhint.pack(anchor="w", pady=(0, 8))
            cols = tk.Frame(v, bg=P["bg"])
            cols.pack(fill="both", expand=True)
            self.otree = {}
            for kind, title in KINDS:
                c = card(cols)
                c.pack(side="left", fill="both", expand=True, padx=(0, 12) if kind == "behavior" else 0)
                label(c, title, 11, True).pack(anchor="w", padx=14, pady=(10, 6))
                fr, t = make_tree(c, ("n", "name", "ver", "state"),
                                  {"n": ("#", 34, "center", False), "name": ("Pack", 220, "w", True),
                                   "ver": ("Version", 70, "center", False), "state": ("", 70, "w", False)}, height=7)
                fr.pack(fill="both", expand=True, padx=12, pady=(0, 12))
                t.tag_configure("new", foreground=P["ok"])
                t.bind("<<TreeviewSelect>>", lambda e, k=kind: self._order_pick(k))
                self.otree[kind] = t
            self.order_focus = "behavior"
            ob = tk.Frame(v, bg=P["bg"])
            ob.pack(fill="x", pady=(10, 0))
            make_btn(ob, "▲ Move up", lambda: self._move(-1)).pack(side="left")
            make_btn(ob, "▼ Move down", lambda: self._move(1)).pack(side="left", padx=8)
            make_btn(ob, "Fix problems only", self._fixonly, kind="primary").pack(side="left")
            make_btn(ob, "Sort everything automatically", self._autosort).pack(side="left", padx=8)
            make_btn(ob, "Reset to the world's current order", self._reset_order).pack(side="left")
            wc = card(v)
            wc.pack(fill="x", pady=(10, 0))
            label(wc, "Why this order", 11, True).pack(anchor="w", padx=14, pady=(8, 2))
            self.txt_why = tk.Text(wc, height=6, wrap="word", bd=0, relief="flat", bg=P["panel"], fg=P["text"],
                                   font=F(10), state="disabled", padx=14, highlightthickness=0)
            self.txt_why.pack(fill="x", padx=2, pady=(0, 8))

        # ---- header chips / counters
        def _update_problem_chip(self):
            n = len(self.scan_problems)
            if n:
                self.chip_prob.config(text=f"⚠ {n} file(s) could not be read")
                self.chip_prob.pack(side="right", padx=(0, 8), before=self.chip_mc) if not self.chip_prob.winfo_ismapped() else None
            else:
                self.chip_prob.pack_forget()

        def show_scan_problems(self):
            rows = [(str(i).split(":")[0], str(i).split(": ", 1)[-1], getattr(i, "hint", ""), getattr(i, "path", None))
                    for i in self.scan_problems]
            self.report_dialog("Files that could not be read",
                               "These files or folders were skipped during the scan. The rest of your library loaded "
                               "normally.", rows, retry=self.rescan, retry_text="Rescan")

        def _update_chips(self):
            if not hasattr(self, "chip_mc"):
                return
            self.chip_mc.config(text=f"Minecraft: {self.mc_label}")
            name = self._info_of(self.world).name if self.world else None
            self.chip_world.config(text=f"World: {name}" if name else "World: none selected")
            self.btn_world_add.config(text=f"Add to “{name}”" if name else "Add to world")
            self.btn_world_remove.config(text="Remove from world")

        # ---- sources + scanning
        def add_folder(self):
            d = filedialog.askdirectory(title="Pick your main mods folder (searched for mods, builds and pack folders)")
            if d:
                self._add_sources([os.path.normpath(d)])

        def add_files(self):
            fs = filedialog.askopenfilenames(title="Pick add-on files",
                                             filetypes=[("Bedrock add-ons", "*.mcaddon *.mcpack *.zip"),
                                                        ("All files", "*.*")])
            self._add_sources(fs)

        def _add_sources(self, items):
            added = 0
            for i in items:
                i = os.path.normpath(i)
                if i not in self.cfg["sources"]:
                    self.cfg["sources"].append(i)
                    added += 1
            if added:
                self._save()
                self._refresh_sources_view()
                self.rescan()

        def rescan(self):
            if self.scanning:
                return
            self.scanning = True
            self.set_status("Scanning your mod library...")
            self.progress.pack(side="right", padx=8, pady=8)
            self.progress.start(12)
            sources = list(self.cfg["sources"])
            mc_root = self.mc_root if (self.cfg["include_mc"] and self.mc_root and self.mc_root.is_dir()) else None

            def work():
                issues = []
                try:
                    packs = gather(sources, issues, find_folders=True)
                    if mc_root:
                        packs += scan_minecraft_packs(mc_root, issues)
                    mark_superseded(packs)
                except Exception as e:
                    packs = []
                    log_to_file(traceback.format_exc(), "err")
                    scan_issue(issues, ",".join(sources) or ".", f"the scan stopped: {explain_error(e)[0]}",
                               explain_error(e)[1])
                self.q.put(("scan", (packs, issues)))
            threading.Thread(target=work, daemon=True).start()

        def _scan_done(self, packs, issues):
            self.scanning = False
            if not self.busy:
                self.progress.stop()
                self.progress.pack_forget()
            self.packs = packs
            self.index_cache.clear()
            self.inst_pack_cache.clear()
            self.scan_problems = list(issues)
            for i in issues:
                self.say("! " + i, "warn")
            self._update_problem_chip()
            if issues:
                self.notify(f"{len(issues)} file(s) could not be read",
                            "They were skipped during the scan. Open the list to see why.", "warn", "scanprob",
                            key="scanprob")
            else:
                self.notify_clear("scanprob")
            self._start_icon_load()
            self._start_change_scan()
            self.rebuild()
            self._rebuild_updates()
            self.refresh_worlds()
            hid = sum(1 for p in packs if p.superseded)
            msg = (f"Library: {len(self.mods)} mod(s), {sum(1 for p in packs if not p.superseded)} pack(s)"
                   + (f"; {hid} older duplicate(s) ignored" if hid else ""))
            self.say(msg + ".", "info")
            self.set_status(msg)
            self._schedule_analysis()

        # ---- library table
        def _installed_all(self):
            out = {}
            if self.mc_root and self.mc_root.is_dir():
                for mode in ("standard", "development"):
                    out.update(scan_installed(self.mc_root, mode))
            if self.world and Path(self.world).is_dir():
                out.update(scan_installed(self.world, "standard"))
            return out

        def rebuild(self):
            if not hasattr(self, "tree"):
                return
            self.installed = scan_installed(self.mc_root, self.cfg["mode"]) \
                if self.mc_root and self.mc_root.is_dir() else {}
            self.installed_all = self._installed_all()
            self.active = world_active_uuids(self.world) if self.world else set()
            older = {}
            for p in self.packs:
                if p.superseded:
                    older[p.uuid] = older.get(p.uuid, 0) + 1
            self.mods = group_mods([p for p in self.packs if not p.superseded])
            for m in self.mods:
                m.older = sum(older.get(u, 0) for u in m.uuids)
            self._sort_mods()
            f = self.var_filter.get().strip().lower()
            show = self.var_show.get()
            self.tree.delete(*self.tree.get_children())
            self.mod_rows.clear()
            for m in self.mods:
                if not self._passes(m, show, f):
                    continue
                iid = str(len(self.mod_rows))
                self.mod_rows[iid] = m
                tag, text = self._mod_status(m)
                self.tree.insert("", "end", iid=iid, tags=(tag,), values=self._mod_values(m, text),
                                 image=self._mod_icon(m, 36))
            empty = not self.mods
            if empty and not self.cfg["sources"]:
                self.lbl_empty.config(text="Add the folder where your mods live (for example WIP\\Coding).")
            elif empty:
                self.lbl_empty.config(text="Nothing found in your library folders yet. Press Rescan, or add another "
                                           "folder.")
            if empty:
                self.lib_table.pack_forget()
                self.lib_empty.pack(fill="both", expand=True)
            else:
                self.lib_empty.pack_forget()
                self.lib_table.pack(fill="both", expand=True, padx=1, pady=1)
            self._count()
            self._show_detail()
            self._update_dashboard()
            if hasattr(self, "we_trees"):
                self._render_editor()

        def _sort_mods(self):
            how = self.var_sort.get() if hasattr(self, "var_sort") else "Name"
            name = lambda m: m.name.lower()
            if how == "Favorites first":
                self.mods.sort(key=lambda m: (not self._is_fav(m), name(m)))
            elif how == "Recently changed":
                self.mods.sort(key=lambda m: -max((p.mtime for p in m.packs), default=0))
            elif how == "Status":
                rank = {"update": 0, "new": 1, "newer": 2, "installed": 3, "muted": 4}
                self.mods.sort(key=lambda m: (rank.get(self._mod_status(m)[0], 5), name(m)))
            else:
                self.mods.sort(key=name)

        def _mod_issue_counts(self, m):
            ids = set(m.uuids)
            e = sum(1 for i in self.issues if i.sev == "error" and set(i.uuids) & ids)
            w = sum(1 for i in self.issues if i.sev == "warn" and set(i.uuids) & ids)
            return e, w

        def _passes(self, m, show, f):
            if f and f not in m.name.lower() and not any(f in p.name.lower() or f in self._guess_ns(p).lower()
                                                         for p in m.packs) \
                    and f not in self._meta(m).get("note", "").lower() \
                    and not any(f in t.lower() for t in self._meta(m).get("tags", [])):
                return False
            if show == "All mods":
                return True
            tag = self._mod_status(m)[0]
            if show == "Installed in Minecraft":
                return any(p.uuid in self.installed for p in m.packs)
            if show == "Not installed":
                return not any(p.uuid in self.installed for p in m.packs)
            if show == "Updates available":
                return tag == "update"
            if show == "In the selected world":
                return any(u in self.active for u in m.uuids)
            if show == "Ticked":
                return any(u in self.ticked for u in m.uuids)
            if show == "Has problems":
                return sum(self._mod_issue_counts(m)) > 0
            if show == "Unnamed packs":
                return any(not p.named for p in m.packs)
            if show == "Favorites":
                return self._is_fav(m)
            return True

        def _mod_status(self, m):
            tags = [status_of(p, self.installed)[0] for p in m.packs if p.supported]
            if not tags:
                return "muted", "Not supported"
            chs = [self._change_of(p) for p in m.packs if p.supported]
            if any(c and c.kind == "content" for c in chs) and all(t in ("installed", "update") for t in tags):
                return "update", "Edited since install"
            if all(t == "installed" for t in tags):
                return "installed", "Installed"
            if all(t in ("installed", "newer") for t in tags):
                return "newer", "Newer installed"
            if all(t == "new" for t in tags):
                return "new", "Not installed"
            if "update" in tags and "new" not in tags:
                return "update", "Update available"
            return "update", "Partly installed"

        def _tick_mark(self, m):
            ids = [p.uuid for p in m.packs if p.supported]
            n = sum(1 for u in ids if u in self.ticked)
            return CHECK_OFF if n == 0 else (CHECK_ON if n == len(ids) else CHECK_PART)

        def _issue_text(self, m):
            if not (any(u in self.ticked for u in m.uuids) or any(u in self.active for u in m.uuids)):
                return ""
            e, w = self._mod_issue_counts(m)
            return ("✖" + str(e) + " " if e else "") + ("⚠" + str(w) if w else "") or "✔"

        def _world_text(self, m):
            ids = [p.uuid for p in m.packs if p.supported]
            if not self.active or not ids:
                return ""
            n = sum(1 for u in ids if u in self.active)
            return "" if n == 0 else ("✓" if n == len(ids) else f"{n}/{len(ids)}")

        def _mod_values(self, m, status_text):
            return (self._tick_mark(m), "★" if self._is_fav(m) else "☆", self._mod_name(m), m.contents, m.version, status_text, self._world_text(m),
                    self._issue_text(m))

        def _count(self):
            n = sum(1 for m in self.mods if any(u in self.ticked for u in m.uuids))
            self.lbl_count.config(text=f"{len(self.mod_rows)} of {len(self.mods)} mods  ·  {n} ticked")
            self.nav["mods"][3].config(text=str(n) if n else "")
            self.lbl_summary.config(text=f"{n} mod(s) ticked" if n else "Tick mods to install them")

        def _refresh_cells(self):
            for iid, m in self.mod_rows.items():
                self.tree.item(iid, values=self._mod_values(m, self._mod_status(m)[1]))

        def _show_detail(self):
            t = self.txt_detail
            t.configure(state="normal")
            t.delete("1.0", "end")
            sel = self.tree.selection()
            m = self.mod_rows.get(sel[0]) if sel else None
            if not m:
                t.insert("end", "Mod details\n", "h")
                t.insert("end", "\nSelect a mod to see its packs, where it comes from and any problems.\n\n"
                                "Click the box in the first column to tick a mod. Ticked mods are what gets "
                                "checked, ordered and installed.", "muted")
                t.configure(state="disabled")
                self.btn_open_src.configure(state="disabled")
                self.btn_inspect.configure(state="disabled")
                self.btn_fav.configure(state="disabled")
                self._load_notes(None)
                return
            self.btn_open_src.configure(state="normal")
            self.btn_inspect.configure(state="normal")
            self.btn_fav.configure(state="normal", text="★ Favorite" if self._is_fav(m) else "☆ Favorite")
            self._load_notes(m)
            img = self._mod_icon(m, 64)
            if img:
                self._detail_img = img
                t.image_create("end", image=img)
                t.insert("end", "\n")
            tag, status = self._mod_status(m)
            t.insert("end", self._mod_name(m) + "\n", "h")
            t.insert("end", f"{m.contents}   ·   {m.version}   ·   {status}\n\n", "muted")
            if any(not p.named for p in m.packs):
                t.insert("end", "This pack has no real name. Press \"Pack info\" to see what it contains, search for "
                                "it online, or give it your own label.\n\n", "warn")
            for p in m.packs:
                ch = self._change_of(p)
                if ch:
                    t.insert("end", {"version": f"Newer version in library ({vstr(ch.inst_version)} -> {vstr(ch.lib_version)}).",
                                     "content": f"Edited since installed: {ch.files} file(s) differ, version not raised.",
                                     "older": "Installed copy is newer than the library."}[ch.kind] + "\n\n", "warn")
                    break
            for p in m.packs:
                t.insert("end", f"{KIND_LABEL[p.kind]} pack\n", "b")
                t.insert("end", f"{p.name} {vstr(p.version)}\n", "")
                if p.deps:
                    names = []
                    for d in p.deps:
                        o = next((x for x in self.packs if x.uuid == d and not x.superseded), None)
                        names.append(o.name if o else d[:8] + "...")
                    t.insert("end", "needs: " + ", ".join(names) + "\n", "muted")
                t.insert("end", p.label + "\n\n", "muted")
            if m.older:
                t.insert("end", f"{m.older} older copy/copies ignored.\n\n", "muted")
            mine = [i for i in self.issues if set(i.uuids) & set(m.uuids)]
            if mine:
                t.insert("end", "Problems\n", "b")
                for i in mine[:8]:
                    t.insert("end", f"{SEV[i.sev]}: {i.title}\n", {"error": "err", "warn": "warn"}.get(i.sev, "muted"))
            elif any(u in self.ticked or u in self.active for u in m.uuids):
                t.insert("end", "✔ No problems found.\n", "ok")
            t.configure(state="disabled")

        # ---- icons
        def _start_icon_load(self):
            self.icon_job += 1
            job = self.icon_job
            items = [p for p in self.packs if not p.superseded]

            def work():
                out = {}
                for p in items:
                    if job != self.icon_job:
                        return
                    b = read_pack_icon(p)
                    if b:
                        out[p.key] = b
                self.q.put(("icons", (job, out)))
            threading.Thread(target=work, daemon=True).start()

        def _png_image(self, data, size):
            img = tk.PhotoImage(data=data)
            big = max(img.width(), img.height())
            if big > size * 1.4:
                img = img.subsample(max(1, round(big / size)))
            elif big and size // big >= 2:
                img = img.zoom(size // big)
            return img

        def _mod_icon(self, m, size):
            ck = (m.key, size)
            if ck in self.icon_cache:
                return self.icon_cache[ck]
            img = None
            for p in sorted(m.packs, key=lambda p: p.kind != "resource"):
                data = self.icon_bytes.get(p.key)
                if data:
                    try:
                        img = self._png_image(data, size)
                        break
                    except Exception:
                        img = None
            if img is None:
                kind = next((p.kind for p in m.packs if p.kind in ("resource", "behavior")), "other")
                col = {"resource": "#2f6f4a", "behavior": "#2f4f7f"}.get(kind, "#444b57")
                img = tk.PhotoImage(width=size, height=size)
                img.put(col, to=(0, 0, size, size))
            self.icon_cache[ck] = img
            return img

        # ---- favorites, notes, tags
        def _mid(self, m):
            return min(m.uuids)

        def _meta(self, m):
            return self.cfg["meta"].get(self._mid(m), {})

        def _is_fav(self, m):
            return bool(self._meta(m).get("fav"))

        def _set_meta(self, m, **kw):
            d = dict(self.cfg["meta"].get(self._mid(m), {}))
            d.update(kw)
            if not d.get("fav"):
                d.pop("fav", None)
            for k in ("note", "tags"):
                if not d.get(k):
                    d.pop(k, None)
            if d:
                self.cfg["meta"][self._mid(m)] = d
            else:
                self.cfg["meta"].pop(self._mid(m), None)
            self._schedule_save()

        def _fav_selected(self):
            m = self._selected_mod()
            if m:
                self._set_meta(m, fav=not self._is_fav(m))
                self.rebuild()

        def _load_notes(self, m):
            self._notes_mod = m
            self._loading_meta = True
            self.ent_tags.configure(state="normal")
            self.txt_note.configure(state="normal")
            self.var_tags.set(", ".join(self._meta(m).get("tags", [])) if m else "")
            self.txt_note.delete("1.0", "end")
            if m:
                self.txt_note.insert("1.0", self._meta(m).get("note", ""))
            st = "normal" if m else "disabled"
            self.ent_tags.configure(state=st)
            self.txt_note.configure(state=st)
            self._loading_meta = False

        def _save_notes(self):
            if self._loading_meta:
                return
            m = getattr(self, "_notes_mod", None) or self._selected_mod()
            if not m:
                return
            tags = [t.strip() for t in self.var_tags.get().split(",") if t.strip()]
            self._set_meta(m, tags=tags, note=self.txt_note.get("1.0", "end").strip())

        # ---- select / profiles menus
        def _dark_menu(self):
            return tk.Menu(self, tearoff=0, bg=P["panel2"], fg=P["text"], activebackground=P["accent"],
                           activeforeground="#fff", bd=0, relief="flat", disabledforeground=P["muted"])

        def _popup_under(self, menu, btn):
            menu.tk_popup(btn.winfo_rootx(), btn.winfo_rooty() + btn.winfo_height())

        def _select_menu(self, btn):
            m = self._dark_menu()
            for text, how in (("Tick everything", "all"), ("Tick new + updates", "todo"), ("Tick favorites", "fav"),
                              ("Tick mods used by the selected world", "world"),
                              ("Tick mods installed in Minecraft", "inst"), (None, None), ("Untick all", "none")):
                if text is None:
                    m.add_separator()
                else:
                    m.add_command(label=text, command=lambda h=how: self.tick(h))
            self._popup_under(m, btn)

        def _profiles_menu(self, btn):
            m = self._dark_menu()
            profs = self.cfg["profiles"]
            if profs:
                for name in sorted(profs, key=str.lower):
                    m.add_command(label=f"Use: {name}  ({len(profs[name].get('ticked', []))})",
                                  command=lambda n=name: self._profile_apply(n))
                m.add_separator()
            else:
                m.add_command(label="No profiles yet", state="disabled")
                m.add_separator()
            m.add_command(label="Save ticked mods as a profile...", command=self._profile_save)
            if profs:
                d = self._dark_menu()
                for name in sorted(profs, key=str.lower):
                    d.add_command(label=name, command=lambda n=name: self._profile_delete(n))
                m.add_cascade(label="Delete profile", menu=d)
                e = self._dark_menu()
                for name in sorted(profs, key=str.lower):
                    e.add_command(label=name, command=lambda n=name: self._profile_export(n))
                m.add_cascade(label="Export profile to a file", menu=e)
            m.add_command(label="Import a profile file...", command=self._profile_import)
            self._popup_under(m, btn)

        def _profile_save(self):
            if not self.ticked:
                messagebox.showinfo(APP_NAME, "Tick the mods you want in the profile first.")
                return
            name = simpledialog.askstring(APP_NAME, "Name for this profile (a saved set of ticked mods):", parent=self)
            if not name or not name.strip():
                return
            names = {p.uuid: p.name for p in self.packs if p.uuid in self.ticked and not p.superseded}
            self.cfg["profiles"][name.strip()] = {"ticked": sorted(self.ticked), "names": names}
            self._save()
            self.say(f"Profile '{name.strip()}' saved with {len(self.ticked)} pack(s).", "ok")

        def _profile_apply(self, name):
            prof = self.cfg["profiles"].get(name)
            if not prof:
                return
            known = {p.uuid for p in self.packs if not p.superseded}
            ids = set(prof.get("ticked", []))
            missing = [prof.get("names", {}).get(u, u[:8]) for u in ids - known]
            self.ticked = ids & known
            self._refresh_cells()
            self._count()
            self._schedule_save()
            self._schedule_analysis(10)
            self.say(f"Profile '{name}': {len(self.ticked)} pack(s) ticked"
                     + (f"; {len(missing)} not in your library: {', '.join(missing[:6])}" if missing else "") + ".",
                     "warn" if missing else "ok")
            if missing:
                self.notify(f"Profile '{name}': {len(missing)} mod(s) missing", ", ".join(missing[:6]), "warn")
                messagebox.showwarning(APP_NAME, f"{len(missing)} pack(s) from this profile are not in your library:\n\n"
                                       + "\n".join("  - " + x for x in missing[:12]))

        def _profile_delete(self, name):
            if messagebox.askyesno(APP_NAME, f"Delete the profile '{name}'? (Your mods are not touched.)"):
                self.cfg["profiles"].pop(name, None)
                self._save()

        def _profile_export(self, name):
            prof = self.cfg["profiles"].get(name)
            f = filedialog.asksaveasfilename(title="Export profile", defaultextension=".json",
                                             initialfile=safe_name(name, 40) + ".modprofile.json",
                                             filetypes=[("Mod profile", "*.json")])
            if not f or not prof:
                return
            vers = {p.uuid: vstr(p.version) for p in self.packs if not p.superseded}
            data = {"format": "addon-loader-profile-1", "name": name,
                    "mods": [{"uuid": u, "name": prof.get("names", {}).get(u, ""), "version": vers.get(u, "")}
                             for u in prof.get("ticked", [])]}
            try:
                write_text_safely(f, json.dumps(data, indent=2))
                self.say(f"Profile exported to {f}", "ok")
            except Exception as e:
                short, hint = explain_error(e)
                messagebox.showerror(APP_NAME, f"Could not write the file: {short}\n{hint}")

        def _profile_import(self):
            f = filedialog.askopenfilename(title="Import profile", filetypes=[("Mod profile", "*.json"), ("All", "*.*")])
            if not f:
                return
            try:
                data = json.loads(Path(f).read_text(encoding="utf-8-sig"))
                if data.get("format") != "addon-loader-profile-1":
                    raise ValueError("this is not a profile file made by this program")
                mods = data["mods"]
                name = str(data.get("name") or Path(f).stem)
            except Exception as e:
                messagebox.showerror(APP_NAME, f"Could not read the profile: {e}")
                return
            self.cfg["profiles"][name] = {"ticked": [m["uuid"] for m in mods if "uuid" in m],
                                          "names": {m["uuid"]: m.get("name", "") for m in mods if "uuid" in m}}
            self._save()
            self._profile_apply(name)

        def _selected_mod(self):
            sel = self.tree.selection()
            return self.mod_rows.get(sel[0]) if sel else None

        def _inspect_mod(self, m):
            packs = [p for p in m.packs]
            if len(packs) == 1:
                self.inspect_dialog(packs[0])
                return
            menu = tk.Menu(self, tearoff=0, bg=P["panel2"], fg=P["text"], activebackground=P["accent"], bd=0)
            for p in packs:
                menu.add_command(label=f"{KIND_LABEL.get(p.kind, p.kind)} pack: {p.name}",
                                 command=lambda p=p: self.inspect_dialog(p))
            menu.tk_popup(self.winfo_pointerx(), self.winfo_pointery())

        def _inspect_selected(self):
            m = self._selected_mod()
            if m:
                self._inspect_mod(m)

        def _on_dbl(self, ev):
            if self.tree.identify_region(ev.x, ev.y) == "cell" and self.tree.identify_column(ev.x) not in ("#1", "#2"):
                self._inspect_selected()

        def _tick_only(self, m):
            self.ticked = {p.uuid for p in m.packs if p.supported}
            self._refresh_cells()
            self._count()
            self._schedule_save()
            self._schedule_analysis(10)

        def _lib_menu(self, ev):
            iid = self.tree.identify_row(ev.y)
            if not iid:
                return
            self.tree.selection_set(iid)
            m = self.mod_rows.get(iid)
            if not m:
                return
            menu = tk.Menu(self, tearoff=0, bg=P["panel2"], fg=P["text"], activebackground=P["accent"],
                           activeforeground="#fff", bd=0, relief="flat")
            menu.add_command(label="Pack info...", command=lambda: self._inspect_mod(m))
            menu.add_command(label="Set my own label...", command=lambda: self.ask_label(m.packs[0]))
            menu.add_separator()
            menu.add_command(label="Tick / untick", command=lambda: self._toggle_mod(iid))
            menu.add_command(label="Install only this mod", command=lambda: (self._tick_only(m), self.act_install()))
            menu.add_command(label="Add only this mod to the selected world",
                             command=lambda: (self._tick_only(m), self.act_add_world()))
            menu.add_command(label="Take only this mod out of the selected world",
                             command=lambda: (self._tick_only(m), self.act_remove_world()))
            menu.add_command(label="Uninstall only this mod from Minecraft",
                             command=lambda: (self._tick_only(m), self.act_uninstall()))
            changes = [(p, self._change_of(p, True)) for p in m.packs if self._change_of(p, True)]
            if changes:
                menu.add_separator()
                menu.add_command(label="Update this mod", command=lambda: self._update_mod(m))
                menu.add_command(label="Ignore / unignore this update", command=lambda: self._ignore_mod(m))
            menu.add_separator()
            menu.add_command(label="Copy UUID(s)", command=lambda: self.copy_text("\n".join(m.uuids), "UUID copied"))
            menu.add_command(label="Open source folder", command=self._open_selected_source)
            menu.tk_popup(ev.x_root, ev.y_root)

        def _update_mod(self, m):
            self._mod_view("updates")
            for iid, (mm, _) in self.upd_rows.items():
                if mm.key == m.key:
                    self.utree.selection_set(iid)
                    break
            self.act_update()

        def _ignore_mod(self, m):
            for p in m.packs:
                ch = self._change_of(p, True)
                if ch:
                    k = self._ignore_key(p, ch)
                    self.ignored.symmetric_difference_update({k})
            self.cfg["ignored_updates"] = sorted(self.ignored)
            self._save()
            self.rebuild()
            self._rebuild_updates()

        def _open_selected_source(self):
            sel = self.tree.selection()
            m = self.mod_rows.get(sel[0]) if sel else None
            if m:
                p = Path(m.packs[0].src_path)
                self.open_folder(p if p.is_dir() else p.parent)

        def _toggle_mod(self, iid):
            m = self.mod_rows.get(iid)
            if not m:
                return
            ids = [p.uuid for p in m.packs if p.supported]
            if not ids:
                return
            if all(u in self.ticked for u in ids):
                self.ticked -= set(ids)
            else:
                self.ticked |= set(ids)
            self.tree.set(iid, "sel", self._tick_mark(m))
            self._count()
            self._schedule_save()
            if self.cfg["auto_check"]:
                self._schedule_analysis()

        def _on_click(self, ev):
            region = self.tree.identify_region(ev.x, ev.y)
            col = self.tree.identify_column(ev.x)
            if region == "cell" and col == "#1":
                self._toggle_mod(self.tree.identify_row(ev.y))
                return "break"
            if region == "cell" and col == "#2":
                m = self.mod_rows.get(self.tree.identify_row(ev.y))
                if m:
                    self._set_meta(m, fav=not self._is_fav(m))
                    self.tree.set(self.tree.identify_row(ev.y), "fav", "★" if self._is_fav(m) else "☆")
                    self._update_dashboard()
                    self._show_detail()
                return "break"
            if region == "heading" and col == "#1":
                self.tick("none" if self.ticked else "all")
                return "break"

        def _on_space(self, ev):
            for iid in self.tree.selection():
                self._toggle_mod(iid)
            return "break"

        def tick(self, how):
            self.ticked.clear()
            if how != "none":
                for m in self.mods:
                    for p in m.packs:
                        if not p.supported:
                            continue
                        if (how == "all" or (how == "todo" and status_of(p, self.installed)[0] in ("new", "update"))
                                or (how == "fav" and self._is_fav(m)) or (how == "world" and p.uuid in self.active)
                                or (how == "inst" and p.uuid in self.installed)):
                            self.ticked.add(p.uuid)
            self._refresh_cells()
            self._count()
            self._schedule_save()
            if self.cfg["auto_check"]:
                self._schedule_analysis()

        def ticked_packs(self):
            return [p for p in self.packs if not p.superseded and p.supported and p.uuid in self.ticked]

        # ================================================================== compatibility + load order
        def _world_packs(self):
            if not self.world:
                return []
            libmap = {p.uuid: p for p in self.packs if not p.superseded}
            out = []
            for kind, lst in world_pack_lists(self.world).items():
                for u, _v in lst:
                    p = libmap.get(u)
                    if p is None:
                        inst = self.installed_all.get(u)
                        if inst:
                            key = str(inst.folder)
                            if key not in self.inst_pack_cache:
                                self.inst_pack_cache[key] = scan_pack_dir(inst.folder, [])
                            p = self.inst_pack_cache[key]
                    if p is not None:
                        out.append(p)
            return out

        def _union_packs(self):
            seen = {}
            for p in self.ticked_packs():
                seen[p.uuid] = p
            for p in self._world_packs():
                seen.setdefault(p.uuid, p)
            return [p for p in seen.values() if p.kind in ("behavior", "resource")]

        def _inputs(self):
            packs = self._union_packs()
            gv = None
            txt = self.cfg["game_version"].strip()
            if txt and re.match(r"^\d+(\.\d+)*$", txt):
                gv = to_version(txt)
            lib = {p.uuid for p in self.packs}
            known = list(self.packs) + [p for p in packs if p.uuid not in lib]
            exp = set(self._info_of(self.world).experiments) if self.world else None
            return (packs, dict(self.installed_all), gv, {p.uuid: m.key for m in self.mods for p in m.packs},
                    {k: list(v) for k, v in self.order.items()}, self.cfg["auto_order"], self.cfg["last_wins"],
                    known, exp, self._take_mode())

        def _take_mode(self):
            """One-shot mode set by the buttons; otherwise repair automatically unless the user moved things by hand."""
            m, self._force_mode = self._force_mode, None
            if m:
                self._manual = False
                return m
            if self.cfg["auto_fix_order"] and not self._manual:
                return "repair"
            return None

        def _compute(self, packs, installed, gv, mod_of, order_in, auto, last_wins, known, exp, mode=None):
            by_kind, idx = {}, {}
            for p in packs:
                if p.key not in self.index_cache:
                    self.index_cache[p.key] = index_pack(p)
                idx[p.uuid] = self.index_cache[p.key]
                by_kind.setdefault("behavior" if p.kind == "behavior" else "resource", []).append(p)
            have = any(order_in.get(k) for k in order_in)
            pm = mode or ("slot" if auto and have else "scratch" if auto else "slot")
            plan = plan_orders(by_kind, idx, order_in, pm, last_wins, mod_of)
            order = plan.order if (mode or auto) else reconcile_order(by_kind, order_in, auto, last_wins, idx, mod_of)
            order.setdefault("behavior", [])
            order.setdefault("resource", [])
            plan.mode = pm
            return analyze(packs, idx, installed, known, gv, order, last_wins, mod_of, exp), order, plan

        def _schedule_analysis(self, delay=600):
            if self._an_job:
                self.after_cancel(self._an_job)
            self._an_job = self.after(delay, self._start_analysis)

        def _start_analysis(self):
            self._an_job = None
            if not hasattr(self, "itree"):
                return
            args = self._inputs()
            self.an_id += 1
            aid = self.an_id
            if not args[0]:
                self.issues = []
                self._show_analysis()
                return
            self.lbl_sum.config(text="Checking...", fg=P["muted"])

            def work():
                try:
                    issues, order, plan = self._compute(*args)
                    self.q.put(("analysis", (aid, issues, order, plan)))
                except Exception as e:
                    self.q.put(("log", (f"Compatibility check failed: {e}", "err")))
            threading.Thread(target=work, daemon=True).start()

        def _analyze_now(self):
            issues, order, plan = self._compute(*self._inputs())
            self.issues, self.order, self.plan = issues, order, plan
            self._log_moves(plan)
            self._show_analysis()
            return issues, order

        def _gate(self):
            """Run the check; if there are errors ask before going on. Returns (ok, order)."""
            self.config(cursor="watch")
            self.update_idletasks()
            try:
                issues, order = self._analyze_now()
            finally:
                self.config(cursor="")
            errs = [i for i in issues if i.sev == "error"]
            if errs and self.cfg["confirm_errors"]:
                self.show("mods")
                self._mod_view("compat")
                shown = "\n".join("  - " + i.title for i in errs[:6]) + ("\n  ..." if len(errs) > 6 else "")
                if not messagebox.askyesno(APP_NAME, f"The compatibility check found {len(errs)} error(s):\n\n{shown}"
                                                     "\n\nContinue anyway?", icon="warning"):
                    return False, order
            return True, order

        def _set_text(self, widget, text):
            widget.configure(state="normal")
            widget.delete("1.0", "end")
            widget.insert("1.0", text)
            widget.configure(state="disabled")

        def _log_moves(self, plan):
            if plan is None or not plan.moved:
                return
            sig = tuple(sorted(plan.moved))
            if sig == self._last_moved_sig:
                return
            self._last_moved_sig = sig
            nm = {p.uuid: p.name for p in self._union_packs()}
            self.say(f"Load order fixed: moved {len(plan.moved)} pack(s) - "
                     + _examples(nm.get(u, "?") for u in plan.moved) + ". See Mods > Load order for why.", "ok")

        def _show_why(self):
            plan = getattr(self, "plan", None)
            nm = {p.uuid: p.name for p in self._union_packs()}
            lines = []
            if plan is None or not nm:
                lines.append("Tick some mods to see how they are ordered.")
            else:
                if plan.moved:
                    lines.append(f"Moved to fix problems ({len(plan.moved)}):")
                    lines += [f"  - {nm.get(u, '?')}: {w}" for u, w in plan.moved.items()]
                elif plan.violations:
                    lines.append(f"{plan.violations} ordering rule(s) are broken. Press 'Fix problems only' to repair them.")
                else:
                    lines.append("No ordering problems. Every rule the loader knows about is satisfied.")
                shown = [(nm.get(u, "?"), r) for u, r in plan.reasons.items() if u in nm and u not in plan.moved]
                if shown:
                    lines.append("")
                    lines.append("Why packs sit where they do:")
                    for n_, rs in shown[:12]:
                        lines.append(f"  - {n_}: {rs[0]}")
                    if len(shown) > 12:
                        lines.append(f"  ... and {len(shown) - 12} more")
                if plan.unresolved:
                    lines.append("")
                    lines.append("Not fixable by ordering:")
                    lines += ["  - " + x[-1] for x in plan.unresolved[:6]]
            self._set_text(self.txt_why, "\n".join(lines))

        def _show_analysis(self):
            e = sum(1 for i in self.issues if i.sev == "error")
            w = sum(1 for i in self.issues if i.sev == "warn")
            n = sum(1 for i in self.issues if i.sev == "info")
            packs = self._union_packs()
            ticked = len(self.ticked_packs())
            if not packs:
                self.lbl_sum.config(text="Nothing to check yet. Tick mods in the Library.", fg=P["muted"])
            elif not self.issues:
                self.lbl_sum.config(text=f"✔ {len(packs)} pack(s) checked: no problems found.", fg=P["ok"])
            else:
                self.lbl_sum.config(text=f"{e} error(s), {w} warning(s), {n} note(s)",
                                    fg=P["err"] if e else (P["warn"] if w else P["muted"]))
            if e and packs and ticked:
                self.notify(f"Compatibility check found {e} error(s)", "In the mods you ticked or the packs already in "
                            "the selected world.", "err", "compat", key="compat")
            else:
                self.notify_clear("compat")
            self.lbl_scope.config(text=f"Checked: {ticked} ticked pack(s)"
                                       + (f" together with the packs already in “{self._info_of(self.world).name}”"
                                          if self.world else " (no world selected)")
                                       + (f"  ·  game version {self.cfg['game_version']}"
                                          if self.cfg["game_version"].strip() else ""))
            self.seg["compat"].config(text="Compatibility" + (f"  ({e + w})" if e + w else ""))
            self.itree.delete(*self.itree.get_children())
            for i, it in enumerate(self.issues):
                self.itree.insert("", "end", iid=str(i), tags=(it.sev,), values=(SEV[it.sev], it.title))
            self._set_text(self.txt_issue, "Select a problem to see the details.")
            lw = self.cfg["last_wins"]
            self.lbl_orderhint.config(text=("The LAST pack in a list overrides the ones above it. " if lw else
                                            "The FIRST pack in a list overrides the ones below it. ")
                                      + "The loader reads what the mods contain and keeps patches, add-ons and "
                                        "dependent mods above what they build on. Packs marked 'new' are ticked ones.")
            by = {p.uuid: p for p in packs}
            ticked_ids = {p.uuid for p in self.ticked_packs()}
            for kind, _ in KINDS:
                t = self.otree[kind]
                t.delete(*t.get_children())
                for n_, u in enumerate(self.order.get(kind, []), 1):
                    if u in by:
                        t.insert("", "end", iid=u, tags=("new",) if u in ticked_ids and u not in self.active else (),
                                 values=(n_, by[u].name, vstr(by[u].version),
                                         "new" if u in ticked_ids and u not in self.active else ""))
            self._show_why()
            self._refresh_cells()
            self._count()
            self._show_detail()
            err_txt = f"  ·  {e} error(s), {w} warning(s)" if e + w else ""
            self.lbl_summary.config(text=self.lbl_summary.cget("text").split("  ·  ")[0] + err_txt)

        def _show_issue(self):
            sel = self.itree.selection()
            if sel:
                it = self.issues[int(sel[0])]
                self._set_text(self.txt_issue, it.title + "\n\n" + it.detail)

        def _order_pick(self, kind):
            self.order_focus = kind
            other = "resource" if kind == "behavior" else "behavior"
            if self.otree[kind].selection():
                self.otree[other].selection_set(())

        def _move(self, delta):
            kind = self.order_focus
            sel = self.otree[kind].selection()
            if not sel or sel[0] not in self.order[kind]:
                return
            self._manual = True
            lst = self.order[kind]
            i = lst.index(sel[0])
            j = i + delta
            if 0 <= j < len(lst):
                lst[i], lst[j] = lst[j], lst[i]
                self._show_analysis()
                self.otree[kind].selection_set(sel[0])
                self._schedule_analysis(200)

        def _autosort(self):
            self.order = {"behavior": [], "resource": []}
            self._force_mode = "scratch"
            self._schedule_analysis(10)

        def _fixonly(self):
            self._force_mode = "repair"
            self._schedule_analysis(10)

        def _reset_order(self):
            self._manual = True
            self.order = ({k: [u for u, _ in v] for k, v in world_pack_lists(self.world).items()}
                          if self.world else {"behavior": [], "resource": []})
            self._schedule_analysis(10)

        # ================================================================== actions
        def _chosen(self):
            c = self.ticked_packs()
            if not c:
                messagebox.showinfo(APP_NAME, "Nothing is ticked. Tick mods in the library first.")
                return None
            return c

        def _need_root(self):
            if not self.mc_root:
                messagebox.showwarning(APP_NAME, "Pick your Minecraft folder first (Minecraft page).")
                self.show("minecraft")
                return False
            if not self.mc_root.is_dir():
                messagebox.showwarning(APP_NAME, f"This folder does not exist:\n{self.mc_root}")
                return False
            return True

        def _need_world(self):
            if not self.world:
                messagebox.showinfo(APP_NAME, "Pick the world to edit first.")
                self.show("worlds")
                return False
            return True

        def _warn_running(self):
            if self.cfg["warn_running"] and self.mc_running:
                self.say("Minecraft is running. New packs show up after you reopen the world list or restart the game; "
                         "a world's pack list is read when the world loads.", "warn")

        def _retry_ticked(self, chosen, action):
            uuids = {p.uuid for p in chosen}

            def go():
                self.ticked = set(uuids)
                self._refresh_cells()
                self._count()
                action()
            return go

        def act_install(self):
            if self.busy or not self._need_root():
                return
            chosen = self._chosen()
            if not chosen:
                return
            ok, order = self._gate()
            if not ok:
                return
            root, mode, force, lw, packs = self.mc_root, self.cfg["mode"], self.cfg["force"], \
                self.cfg["last_wins"], list(self.packs)
            if not self._confirm_plan(f"Install {len(chosen)} pack(s) into Minecraft", chosen, root, mode, force):
                return
            self._warn_running()
            self._run(f"Installing {len(chosen)} pack(s) into Minecraft",
                      lambda log: install_many(chosen, packs, root, mode, force, [], log, order=order, last_wins=lw),
                      launch=self.cfg["launch_after"], again=self._retry_ticked(chosen, self.act_install))

        def act_add_world(self):
            if self.busy or not self._need_world():
                return
            chosen = self._chosen()
            if not chosen:
                return
            skipped = [p for p in chosen if p.kind not in ("behavior", "resource")]
            chosen = [p for p in chosen if p.kind in ("behavior", "resource")]
            if skipped:
                self.say("Skin packs cannot be added to a world and were left out.", "warn")
            if not chosen:
                return
            copy = self.cfg["world_mode"] == "copy" or self.cfg["force_world_copy"] or self._is_managed(self.world)
            if not copy and not self._need_root():
                return
            ok, order = self._gate()
            if not ok:
                return
            world, force, lw, packs = self.world, self.cfg["force"], self.cfg["last_wins"], list(self.packs)
            if copy and self.cfg["force_world_copy"]:
                force = True            # always (re)write the files inside the world, even if Minecraft has them
            root, mode = (world, "standard") if copy else (self.mc_root, self.cfg["mode"])
            if not self._confirm_plan(f"Add {len(chosen)} pack(s) to world '{self._info_of(world).name}'", chosen, root,
                                      mode, force, "They are then switched on in the world's pack lists, in load order."):
                return
            self._warn_running()
            backup = self.cfg["backup_world"]
            dest = self.cfg["backup_dir"] or str(APP_DIR / "backups")
            existing = {u for lst in world_pack_lists(world).values() for u, _ in lst}

            def work(log):
                if backup:
                    log(f"Backup written: {backup_world(world, dest)}", "ok")
                c = install_many(chosen, packs, root, mode, force, [world], log, order=order, last_wins=lw)
                inst = scan_installed(root, mode)
                versions = {u: i.version for u, i in inst.items()}
                good = set(inst) | existing
                apply_world_order(world, {k: [u for u in v if u in good] for k, v in order.items()}, versions, lw, log)
                return c
            self._run(f"Adding {len(chosen)} pack(s) to world '{self._info_of(world).name}'", work,
                      launch=self.cfg["launch_after"], again=self._retry_ticked(chosen, self.act_add_world))

        def act_remove_world(self):
            if self.busy or not self._need_world():
                return
            chosen = self._chosen()
            if not chosen:
                return
            name = self._info_of(self.world).name
            if not messagebox.askyesno(APP_NAME, f"Take {len(chosen)} ticked pack(s) out of world '{name}'?\n\n"
                                                 "(They stay installed in Minecraft; only this world stops using them.)"):
                return
            world, uuids = self.world, {p.uuid for p in chosen}
            embedded = scan_installed(world, "standard")
            emb_packs = [p for p in chosen if p.uuid in embedded]

            def work(log):
                n = remove_from_world(world, uuids, log)
                if emb_packs:
                    uninstall_many(emb_packs, world, "standard", [], log)
                return n
            self._run(f"Removing {len(chosen)} pack(s) from world '{name}'", work)

        def act_uninstall(self):
            if self.busy or not self._need_root():
                return
            chosen = self._chosen()
            if not chosen:
                return
            if not messagebox.askyesno(APP_NAME, f"Uninstall {len(chosen)} ticked pack(s) from\n{self.mc_root}?\n\n"
                                                 "(Only the installed copies are removed, never your source files.)"):
                return
            uuids = {p.uuid for p in chosen}
            using = self._worlds_using(uuids)
            also = []
            if using and messagebox.askyesno(APP_NAME, "These worlds still list some of them:\n\n" +
                                             "\n".join(f"  - {w.name}" for w in using[:8]) +
                                             "\n\nRemove them from those worlds too?"):
                also = using
            root, mode = self.mc_root, self.cfg["mode"]

            def work(log):
                probs = []
                n = uninstall_many(chosen, root, mode, [], log, probs)
                for w in also:
                    remove_from_world(w.path, uuids, log)
                return {"removed": n, "problems": probs}
            self._run(f"Uninstalling {len(chosen)} pack(s) from Minecraft", work)

        # ================================================================== dialogs, errors, inspector, updates (v3.1)
        def make_dialog(self, title, w, h):
            d = tk.Toplevel(self)
            d.title(title)
            d.configure(bg=P["bg"])
            self.update_idletasks()
            x = self.winfo_rootx() + max(20, (self.winfo_width() - w) // 2)
            y = self.winfo_rooty() + max(20, (self.winfo_height() - h) // 3)
            d.geometry(f"{w}x{h}+{x}+{y}")
            d.transient(self)
            d.minsize(min(w, 520), min(h, 300))
            return d

        def copy_text(self, text, what="Copied"):
            self.clipboard_clear()
            self.clipboard_append(text)
            self.set_status(f"{what} to the clipboard.")

        def report_dialog(self, title, intro, rows, detail="", retry=None, retry_text="Try again", ok_text="Close"):
            """rows: [(item, problem, hint, path)]. A table of what went wrong, what to try, and buttons to act."""
            d = self.make_dialog(title, 900, 560)
            label(d, title, 15, True).pack(anchor="w", padx=22, pady=(18, 2))
            label(d, intro, 10, fg=P["muted"], wraplength=840, justify="left").pack(anchor="w", padx=22, pady=(0, 10))
            c = card(d)
            c.pack(fill="both", expand=True, padx=22)
            heads = {"item": ("What", 230, "w", False), "problem": ("Problem", 600, "w", True)}
            fr, t = make_tree(c, ("item", "problem"), heads, height=7)
            fr.pack(fill="both", expand=True, padx=1, pady=1)
            rows = [(r[0], r[1].split(" Try: ")[0], r[2] or (r[1].split(" Try: ", 1)[1] if " Try: " in r[1] else ""), r[3])
                    for r in rows]
            for i, r in enumerate(rows):
                t.insert("", "end", iid=str(i), values=(r[0], r[1].split("\n")[0][:220]))
            box = tk.Text(d, height=7, wrap="word", relief="flat", bg=P["panel"], fg=P["text"], font=F(10),
                          padx=14, pady=10, highlightthickness=1, highlightbackground=P["line"])
            box.pack(fill="x", padx=22, pady=(10, 0))
            box.tag_configure("hint", foreground=P["warn"])
            box.tag_configure("muted", foreground=P["muted"], font=("Consolas", 9))

            def show(e=None):
                box.configure(state="normal")
                box.delete("1.0", "end")
                sel = t.selection()
                if sel:
                    item, problem, hint, path = rows[int(sel[0])]
                    box.insert("end", f"{item}\n", "")
                    box.insert("end", problem + "\n")
                    if hint:
                        box.insert("end", "What to try: " + hint + "\n", "hint")
                    if path:
                        box.insert("end", str(path), "muted")
                elif detail:
                    box.insert("end", detail, "muted")
                box.configure(state="disabled")
            t.bind("<<TreeviewSelect>>", show)
            if rows:
                t.selection_set("0")
            else:
                show()
            bar = tk.Frame(d, bg=P["bg"])
            bar.pack(fill="x", padx=22, pady=14)

            def full_text():
                lines = [f"{title}", ""]
                for item, problem, hint, path in rows:
                    lines.append(f"- {item}: {problem}" + (f"  [try: {hint}]" if hint else "") +
                                 (f"  ({path})" if path else ""))
                if detail:
                    lines += ["", detail]
                return "\n".join(lines)
            make_btn(bar, "Copy details", lambda: self.copy_text(full_text(), "Details copied")).pack(side="left")
            make_btn(bar, "Open log file", self.open_log).pack(side="left", padx=8)

            def open_loc():
                sel = t.selection()
                if sel and rows[int(sel[0])][3]:
                    p = Path(rows[int(sel[0])][3])
                    self.open_folder(p if p.is_dir() else p.parent)
            if any(r[3] for r in rows):
                make_btn(bar, "Open its location", open_loc).pack(side="left")
            make_btn(bar, ok_text, d.destroy, "primary").pack(side="right")
            if retry:
                make_btn(bar, retry_text, lambda: (d.destroy(), retry()), "success").pack(side="right", padx=8)
            return d

        def open_log(self):
            if LOG_PATH.exists():
                self.open_folder(LOG_PATH) if os.name != "nt" else os.startfile(str(LOG_PATH))
            else:
                self.say("There is no log file yet.", "info")

        def _crash(self, val, text):
            log_to_file(text, "err")
            short, hint = explain_error(val) if isinstance(val, BaseException) else (str(val), "")
            self.say(f"Unexpected error: {short}", "err")
            self.notify("Unexpected error", short, "err")
            now = time.time()
            if getattr(self, "_crash_last", 0) + 4 > now:
                return
            self._crash_last = now
            self.report_dialog("Something went wrong",
                               "The program hit an unexpected error. Nothing was left half-written (files are replaced "
                               "only when complete). You can keep working; copy the details if you want to report it.",
                               [(val.__class__.__name__ if isinstance(val, BaseException) else "Error", short, hint,
                                 None)], detail=text)

        def report_callback_exception(self, exc, val, tb):
            self._crash(val, "".join(traceback.format_exception(exc, val, tb)))

        # ---- naming / labels
        def _set_alias(self, uuid, name):
            name = (name or "").strip()
            if name:
                self.cfg["aliases"][uuid] = name
                ALIASES[uuid] = name
            else:
                self.cfg["aliases"].pop(uuid, None)
                ALIASES.pop(uuid, None)
            self._save()
            self.rescan()
            self.refresh_minecraft()
            self._load_editor()

        def ask_label(self, pack):
            cur = ALIASES.get(pack.uuid, "")
            name = simpledialog.askstring(APP_NAME, f"Your own label for this pack (shown everywhere in this program).\n"
                                                    f"UUID: {pack.uuid}\n\nLeave empty to remove the label.",
                                          initialvalue=cur or (pack.name if not pack.named else ""), parent=self)
            if name is not None:
                self._set_alias(pack.uuid, name)

        def _guess_ns(self, pack):
            g = self.guesses.get(pack.key)
            return g[0] if g else ""

        def _mod_name(self, m):
            if all(p.named for p in m.packs):
                return m.name
            ns = next((self._guess_ns(p) for p in m.packs if not p.named and self._guess_ns(p)), "")
            return "? " + m.name + (f"   [{ns}]" if ns else "")

        # ---- pack inspector
        def _pack_for_uuid(self, uuid):
            for p in self.packs:
                if p.uuid == uuid and not p.superseded:
                    return p
            inst = self.installed_all.get(uuid)
            if inst and Path(inst.folder).is_dir():
                return scan_pack_dir(inst.folder, [])
            return None

        def inspect_uuid(self, uuid):
            p = self._pack_for_uuid(uuid)
            if p:
                return self.inspect_dialog(p)
            q = f'"{uuid}" minecraft bedrock'
            if messagebox.askyesno(APP_NAME, f"This pack is not in your library or Minecraft folder, so there is "
                                             f"nothing to read.\n\nUUID: {uuid}\n\nSearch the web for that UUID?"):
                webbrowser.open("https://www.google.com/search?q=" + urllib_quote(q))

        def inspect_dialog(self, pack):
            d = self.make_dialog(f"Pack info: {pack.name}", 940, 740)
            top = tk.Frame(d, bg=P["bg"])
            top.pack(fill="x", padx=22, pady=(18, 8))
            icon = tk.Label(top, bg=P["panel2"], width=8, height=4)
            icon.pack(side="left", padx=(0, 14))
            tt = tk.Frame(top, bg=P["bg"])
            tt.pack(side="left", fill="x", expand=True)
            label(tt, pack.name, 17, True).pack(anchor="w")
            label(tt, f"{KIND_LABEL.get(pack.kind, pack.kind)} pack  ·  version {vstr(pack.version)}"
                      f"  ·  {'named by: ' + pack.name_src}", 10, fg=P["muted"]).pack(anchor="w")
            lab_guess = label(tt, "Reading the pack...", 10, fg=P["warn"], wraplength=640, justify="left")
            lab_guess.pack(anchor="w", pady=(4, 0))
            body = tk.Frame(d, bg=P["bg"])
            body.pack(fill="both", expand=True, padx=22, pady=(0, 16))
            btns = tk.Frame(body, bg=P["bg"], width=230)
            btns.pack(side="right", fill="y", padx=(14, 0))
            btns.pack_propagate(False)
            txt = tk.Text(body, wrap="word", relief="flat", bg=P["panel"], fg=P["text"], font=F(10), padx=18, pady=14,
                          highlightthickness=1, highlightbackground=P["line"], cursor="arrow")
            sb = ttk.Scrollbar(body, command=txt.yview)
            txt.configure(yscrollcommand=sb.set)
            sb.pack(side="right", fill="y")
            txt.pack(side="left", fill="both", expand=True)
            txt.tag_configure("h", font=F(11, True), spacing1=10, spacing3=2)
            txt.tag_configure("muted", foreground=P["muted"])
            txt.tag_configure("warn", foreground=P["warn"])
            txt.tag_configure("err", foreground=P["err"])
            txt.tag_configure("ok", foreground=P["ok"])
            txt.tag_configure("mono", font=("Consolas", 9))

            ids = [p for p in self.packs if p.uuid == pack.uuid]
            inst = self.installed_all.get(pack.uuid)
            folders = []
            for mode in ("standard", "development"):
                if self.mc_root:
                    i = scan_installed(self.mc_root, mode).get(pack.uuid)
                    if i:
                        folders.append((i.folder, vstr(i.version), "development" if mode == "development" else "normal"))
            if self.world:
                i = scan_installed(self.world, "standard").get(pack.uuid)
                if i:
                    folders.append((i.folder, vstr(i.version), "inside the selected world"))
            worlds = [w.name for w in self._worlds_using({pack.uuid})]
            dependents = [p.name for p in self.packs if pack.uuid in p.deps and not p.superseded]
            needs = []
            for u in pack.deps:
                o = self._pack_for_uuid(u)
                needs.append(o.name if o else f"{u} (not found)")
            mine = [i for i in self.issues if pack.uuid in i.uuids]
            ch = self.changes.get(pack.uuid)

            def line(s="", tag=None):
                txt.insert("end", s + "\n", tag) if tag else txt.insert("end", s + "\n")

            def fill(info):
                if not info.icon:
                    icon.pack_forget()
                if info.icon:
                    try:
                        img = tk.PhotoImage(data=info.icon)
                        f = max(1, img.width() // 72)
                        icon.image = img.subsample(f) if f > 1 else img
                        icon.configure(image=icon.image, width=icon.image.width(), height=icon.image.height())
                    except Exception:
                        pass
                lab_guess.config(text=("Looks like: it " + info.guess + "." if info.guess else
                                       "No custom identifiers found, so this pack may be only textures, sounds or UI."),
                                 fg=P["text"] if info.guess else P["muted"])
                txt.configure(state="normal")
                txt.delete("1.0", "end")
                if info.error:
                    line("Problem reading the pack: " + info.error, "err")
                line("Identity", "h")
                line(f"UUID:  {pack.uuid}", "mono")
                line(f"Version:  {vstr(pack.version)}      Type: {KIND_LABEL.get(pack.kind, pack.kind)}")
                if info.min_engine:
                    line(f"Minimum game version:  {info.min_engine}")
                if pack.description:
                    line(f"Description:  {pack.description}")
                if pack.authors:
                    line("Author(s):  " + ", ".join(pack.authors))
                if pack.license:
                    line("License:  " + pack.license)
                if pack.url:
                    line("Link:  " + pack.url)
                if not pack.named:
                    line("This pack has no real name (the manifest name is missing, a placeholder, or points at a "
                         "text key that could not be found). Use \"Set my own label\" to name it; the label is used "
                         "everywhere in this program.", "warn")
                if info.namespaces or info.display_names:
                    line("What it contains", "h")
                    if info.namespaces:
                        line("Namespaces:  " + ", ".join(f"{k} ({v})" for k, v in info.namespaces.items()))
                    for cat in ("entity", "item", "block", "recipe", "biome", "feature", "feature_rule", "loot_table"):
                        if info.idents.get(cat):
                            names = info.idents[cat]
                            line(f"{PLURAL.get(cat, cat + 's').capitalize()} ({len(names)}):  " + ", ".join(names[:8]) +
                                 (" ..." if len(names) > 8 else ""))
                    if info.display_names:
                        line("Names shown in game:  " + ", ".join(info.display_names[:12]))
                line("Files", "h")
                line(f"{info.files} files, {human_size(info.size)}.   Folders:  " +
                     ", ".join(f"{n} ({c})" for n, c in info.top))
                if info.scripts:
                    line("Scripts:  " + ", ".join(info.scripts[:6]) + (" ..." if len(info.scripts) > 6 else ""))
                if info.modules:
                    line("Modules", "h")
                    for t_, v_, det in info.modules:
                        line(f"  {t_}  {v_}" + (f"   {det}" if det else ""))
                if info.deps or needs:
                    line("Needs", "h")
                    for u in pack.deps:
                        o = self._pack_for_uuid(u)
                        line(f"  {o.name if o else u}" + ("" if o else "   (not in your library or Minecraft)"),
                             None if o else "warn")
                    for who, v in info.deps:
                        if who not in pack.deps:
                            line(f"  {who}  {v}", "muted")
                line("Where it is", "h")
                for o in ids:
                    line(f"  Library: {o.label}   (version {vstr(o.version)}"
                         f"{', older copy' if o.superseded else ''})", "muted")
                for f_, v_, how in folders:
                    line(f"  Installed ({how}): {f_}   version {v_}", "muted")
                line("  Used by worlds:  " + (", ".join(worlds) if worlds else "none"))
                line("  Needed by:  " + (", ".join(dependents) if dependents else "no other pack"))
                if ch:
                    line("Update status", "h")
                    line({"version": f"The library has a newer version: {vstr(ch.inst_version)} -> {vstr(ch.lib_version)}.",
                          "content": f"Same version ({vstr(ch.lib_version)}) but {ch.files} file(s) differ from the "
                                     "installed copy.",
                          "older": f"The installed copy ({vstr(ch.inst_version)}) is newer than the library "
                                   f"({vstr(ch.lib_version)})."}.get(ch.kind, ""), "warn")
                if mine:
                    line("Problems found by the check", "h")
                    for i in mine[:8]:
                        line(f"  {SEV[i.sev]}: {i.title}", {"error": "err", "warn": "warn"}.get(i.sev, "muted"))
                txt.configure(state="disabled")
                self._insp_text = txt.get("1.0", "end")

            ns_first = None
            tok = id(d)
            self.inspect_cbs[tok] = lambda info: (d.winfo_exists() and fill(info))
            threading.Thread(target=lambda: self.q.put(("inspect", (tok, inspect_pack(pack)))), daemon=True).start()

            def b(text, cmd, kind="ghost"):
                make_btn(btns, text, cmd, kind).pack(fill="x", pady=3)
            b("Copy UUID", lambda: self.copy_text(pack.uuid, "UUID copied"))
            b("Copy this report", lambda: self.copy_text(txt.get("1.0", "end"), "Report copied"))
            b("Search the web for the UUID", lambda: webbrowser.open(
                "https://www.google.com/search?q=" + urllib_quote(f'"{pack.uuid}" minecraft bedrock')))
            b("Search the web for the name", lambda: webbrowser.open(
                "https://www.google.com/search?q=" + urllib_quote(f'minecraft bedrock addon "{pack.name}"'
                                                                  + (f" {pack.authors[0]}" if pack.authors else ""))))
            tk.Frame(btns, height=8, bg=P["bg"]).pack()
            src = Path(pack.src_path) if pack.src_path else None
            if src:
                b("Open source location", lambda: self.open_folder(src if src.is_dir() else src.parent))
            if folders:
                b("Open installed folder", lambda: self.open_folder(folders[0][0]))
            tk.Frame(btns, height=8, bg=P["bg"]).pack()
            b("Set my own label...", lambda: (d.destroy(), self.ask_label(pack)), "primary")
            if pack.uuid in ALIASES:
                b("Remove my label", lambda: (d.destroy(), self._set_alias(pack.uuid, "")))
            b("Close", d.destroy)
            d.bind("<Escape>", lambda e: d.destroy())
            return d

        # ---- changes between library and installed copies
        def _ignore_key(self, pack, ch):
            return f"{pack.uuid}@{vstr(ch.lib_version)}@{ch.kind}"

        def _change_of(self, pack, ignored=False):
            ch = self.changes.get(pack.uuid)
            if not ch or ch.kind == "same":
                return None
            if not ignored and self._ignore_key(pack, ch) in self.ignored:
                return None
            return ch

        def _start_change_scan(self):
            self.change_id += 1
            cid = self.change_id
            self.changes = {}
            if not self.cfg["check_changes"]:
                self.guesses = {}
            inst_map = {}
            if self.mc_root and self.mc_root.is_dir():
                for mode in ("standard", "development"):
                    inst_map.update(scan_installed(self.mc_root, mode))
            items = [p for p in self.packs if not p.superseded and p.origin == "source" and p.supported
                     and p.uuid in inst_map] if self.cfg["check_changes"] else []
            unnamed = [p for p in self.packs if not p.superseded and not p.named]

            def work():
                res, guesses = {}, {}
                for p in items:
                    if cid != self.change_id:
                        return
                    i = inst_map[p.uuid]
                    try:
                        if p.src_kind == "dir" and Path(p.src_path).resolve() == Path(i.folder).resolve():
                            continue
                    except OSError:
                        pass
                    ch = compare_with_installed(p, i.folder, i.version)
                    if ch.kind != "same" or ch.error:
                        res[p.uuid] = ch
                for p in unnamed:
                    if cid != self.change_id:
                        return
                    try:
                        info = inspect_pack(p)
                        guesses[p.key] = (next(iter(info.namespaces), ""), info.guess)
                    except Exception:
                        pass
                self.q.put(("changes", (cid, res, guesses)))
            threading.Thread(target=work, daemon=True).start()

        # ---- Updates view
        def _build_updates_view(self):
            v = tk.Frame(self.mod_body, bg=P["bg"])
            self.mod_views["updates"] = v
            tb = tk.Frame(v, bg=P["bg"])
            tb.pack(fill="x", pady=(0, 10))
            self.lbl_upd = label(tb, "", 11, True)
            self.lbl_upd.pack(side="left")
            self.var_show_ign = tk.BooleanVar(value=False)
            ck = tk.Checkbutton(tb, text="Show ignored", variable=self.var_show_ign, bg=P["bg"], fg=P["muted"],
                                selectcolor=P["panel2"], activebackground=P["bg"], activeforeground=P["text"],
                                command=self._rebuild_updates, font=F(9), highlightthickness=0, bd=0)
            ck.pack(side="left", padx=14)
            self.btn_upd_all = make_btn(tb, "Update all", lambda: self.act_update(all_=True), "success")
            self.btn_upd_all.pack(side="right")
            self.btn_upd_sel = make_btn(tb, "Update selected", lambda: self.act_update(), "primary")
            self.btn_upd_sel.pack(side="right", padx=8)
            make_btn(tb, "Ignore this update", self._ignore_selected_update).pack(side="right")
            make_btn(tb, "Check again", self._start_change_scan).pack(side="right", padx=8)
            self.action_btns = getattr(self, "action_btns", []) + [self.btn_upd_all, self.btn_upd_sel]
            label(v, "Compares each mod in your library with the copy installed in Minecraft. A mod can be out of date "
                     "because its version is higher, or because you edited files without raising the version.",
                  9, fg=P["muted"], wraplength=1000, justify="left").pack(anchor="w", pady=(0, 8))
            split = tk.Frame(v, bg=P["bg"])
            split.pack(fill="both", expand=True)
            tcard = card(split)
            heads = {"name": ("Mod", 170, "w", True), "inst": ("Installed", 74, "center", False),
                     "lib": ("Library", 74, "center", False), "what": ("What changed", 150, "w", False),
                     "files": ("Files", 118, "center", False)}
            fr, self.utree = make_tree(tcard, tuple(heads), heads, height=12, select="extended")
            fr.pack(fill="both", expand=True, padx=1, pady=1)
            self.utree.tag_configure("version", foreground=P["warn"])
            self.utree.tag_configure("content", foreground=P["accent"])
            self.utree.tag_configure("older", foreground=P["muted"])
            self.utree.tag_configure("ignored", foreground=P["muted"])
            self.utree.bind("<<TreeviewSelect>>", lambda e: self._show_update_detail())
            self.upd_empty = label(tcard, "", 11, fg=P["muted"], wraplength=420, justify="center")
            dcard = card(split, width=420)
            dcard.pack_propagate(False)
            dcard.pack(side="right", fill="y", padx=(14, 0))
            tcard.pack(side="left", fill="both", expand=True)
            self.txt_upd = tk.Text(dcard, bg=P["panel"], fg=P["text"], relief="flat", wrap="word", state="disabled",
                                   font=F(10), padx=16, pady=14, highlightthickness=0, borderwidth=0, cursor="arrow")
            self.txt_upd.pack(fill="both", expand=True)
            t = self.txt_upd
            t.tag_configure("h", font=F(13, True))
            t.tag_configure("b", font=F(10, True), spacing1=8)
            t.tag_configure("muted", foreground=P["muted"], font=F(9))
            t.tag_configure("add", foreground=P["ok"])
            t.tag_configure("rem", foreground=P["err"])
            t.tag_configure("chg", foreground=P["warn"])
            t.tag_configure("mono", font=("Consolas", 9))
            self.upd_rows, self.upd_job = {}, 0

        def _update_candidates(self, show_ignored=False):
            out = []
            for m in self.mods:
                items = []
                for p in m.packs:
                    ch = self._change_of(p, ignored=show_ignored)
                    if ch:
                        items.append((p, ch))
                if items:
                    out.append((m, items))
            return out

        def _rebuild_updates(self):
            if not hasattr(self, "utree"):
                return
            keep = self.utree.selection()
            self.utree.delete(*self.utree.get_children())
            self.upd_rows.clear()
            show_ign = self.var_show_ign.get()
            n_up = 0
            for m, items in self._update_candidates(show_ign):
                iid = str(len(self.upd_rows))
                self.upd_rows[iid] = (m, items)
                kinds = {ch.kind for _, ch in items}
                kind = "version" if "version" in kinds else ("content" if "content" in kinds else "older")
                if kind != "older":
                    n_up += 1
                what = {"version": "New version", "content": "Edited, same version",
                        "older": "Installed is newer"}[kind]
                ign = all(self._ignore_key(p, ch) in self.ignored for p, ch in items)
                a = sum(len(ch.added) for _, ch in items)
                r = sum(len(ch.removed) for _, ch in items)
                c = sum(len(ch.changed) for _, ch in items)
                self.utree.insert("", "end", iid=iid, tags=("ignored" if ign else kind,),
                                  values=(self._mod_name(m) + ("  (ignored)" if ign else ""),
                                          " / ".join(sorted({vstr(ch.inst_version) for _, ch in items})),
                                          " / ".join(sorted({vstr(ch.lib_version) for _, ch in items})), what,
                                          f"+{a}  -{r}  ~{c}"))
            for k in keep:
                if self.utree.exists(k):
                    self.utree.selection_set(k)
            checking = self.cfg["check_changes"] and self.scanning
            self.lbl_upd.config(text=("Checking for changes..." if checking else
                                      f"{n_up} mod(s) can be updated" if n_up else "Everything installed is up to date"))
            if not self.upd_rows:
                self.upd_empty.config(text="Nothing to update.\n\nMods whose files or version differ from the copy in "
                                           "Minecraft will appear here." if self.cfg["check_changes"] else
                                      "Checking for changes is turned off in Settings.")
                self.upd_empty.place(relx=0.5, rely=0.4, anchor="center")
            else:
                self.upd_empty.place_forget()
            self.seg["updates"].config(text=f"Updates ({n_up})" if n_up else "Updates")
            self._show_update_detail()

        def _show_update_detail(self):
            t = self.txt_upd
            sel = self.utree.selection() if hasattr(self, "utree") else ()
            t.configure(state="normal")
            t.delete("1.0", "end")
            if not sel:
                t.insert("end", "What will change\n", "h")
                t.insert("end", "\nSelect a mod to see which files, items and settings differ between your library "
                                "copy and the installed copy.", "muted")
                t.configure(state="disabled")
                return
            m, items = self.upd_rows[sel[0]]
            t.insert("end", m.name + "\n", "h")
            t.insert("end", "Reading both copies...\n", "muted")
            t.configure(state="disabled")
            self.upd_job += 1
            job = self.upd_job
            inst_map = {}
            if self.mc_root:
                for mode in ("standard", "development"):
                    inst_map.update(scan_installed(self.mc_root, mode))

            def work():
                out = []
                for p, ch in items:
                    i = inst_map.get(p.uuid)
                    notes, added, removed = manifest_notes(p, i.folder) if i else ([], [], [])
                    out.append((p, ch, notes, added, removed))
                self.q.put(("upd_detail", (job, m, out)))
            threading.Thread(target=work, daemon=True).start()

        def _render_update_detail(self, m, out):
            t = self.txt_upd
            t.configure(state="normal")
            t.delete("1.0", "end")
            t.insert("end", m.name + "\n", "h")
            for p, ch, notes, added, removed in out:
                t.insert("end", f"\n{KIND_LABEL.get(p.kind, p.kind)} pack: {p.name}\n", "b")
                t.insert("end", {"version": f"Version {vstr(ch.inst_version)} installed, "
                                            f"{vstr(ch.lib_version)} in your library.",
                                 "content": f"Both are version {vstr(ch.lib_version)}, but the files differ. The "
                                            "loader skips same-version packs, so use Update (it overwrites), or raise "
                                            "header.version in the manifest so the change is tracked.",
                                 "older": f"Installed {vstr(ch.inst_version)} is newer than the library "
                                          f"{vstr(ch.lib_version)}. Updating would downgrade it."}[ch.kind] + "\n")
                if ch.error:
                    t.insert("end", f"Could not fully compare: {ch.error}\n", "chg")
                for n in notes:
                    t.insert("end", "• " + n + "\n", "chg")
                if added:
                    t.insert("end", f"\nAdds ({len(added)})\n", "b")
                    t.insert("end", "\n".join("+ " + a for a in added[:12]) + ("\n..." if len(added) > 12 else "") + "\n", "add")
                if removed:
                    t.insert("end", f"\nRemoves ({len(removed)})\n", "b")
                    t.insert("end", "\n".join("- " + a for a in removed[:12]) + ("\n..." if len(removed) > 12 else "") + "\n", "rem")
                for title, lst, tag in (("New files", ch.added, "add"), ("Removed files", ch.removed, "rem"),
                                        ("Changed files", ch.changed, "chg")):
                    if lst:
                        t.insert("end", f"\n{title} ({len(lst)})\n", "b")
                        t.insert("end", "\n".join(lst[:14]) + ("\n..." if len(lst) > 14 else "") + "\n", (tag, "mono"))
            t.configure(state="disabled")

        def _ignore_selected_update(self):
            for iid in self.utree.selection():
                m, items = self.upd_rows[iid]
                for p, ch in items:
                    key = self._ignore_key(p, ch)
                    if key in self.ignored:
                        self.ignored.discard(key)
                    else:
                        self.ignored.add(key)
            self.cfg["ignored_updates"] = sorted(self.ignored)
            self._save()
            self.rebuild()
            self._rebuild_updates()

        def act_update(self, all_=False):
            if self.busy or not self._need_root():
                return
            rows = list(self.upd_rows.values()) if all_ else [self.upd_rows[i] for i in self.utree.selection()]
            if not rows:
                messagebox.showinfo(APP_NAME, "Select the mods to update first, or press Update all.")
                return
            todo, down = [], []
            for m, items in rows:
                for p, ch in items:
                    if self._ignore_key(p, ch) in self.ignored:
                        continue
                    (down if ch.kind == "older" else todo).append(p)
            if down and not all_:
                if messagebox.askyesno(APP_NAME, "These would replace a NEWER installed version with an older one:\n\n" +
                                       "\n".join(f"  - {p.name}" for p in down[:8]) + "\n\nDowngrade them too?"):
                    todo += down
            if not todo:
                messagebox.showinfo(APP_NAME, "Nothing to update (ignored updates and downgrades are skipped).")
                return
            root, mode, packs = self.mc_root, self.cfg["mode"], list(self.packs)
            if not self._confirm_plan(f"Update {len(todo)} pack(s)", todo, root, mode, True):
                return
            self._warn_running()
            worlds = [w.path for w, _ in self.worlds] if self.cfg["update_worlds"] else []
            lw = self.cfg["last_wins"]

            def work(log):
                c = install_many(todo, packs, root, mode, True, [], log, last_wins=lw)
                vers = {p.uuid: p.version for p in todo}
                for w in worlds:
                    lists = world_pack_lists(w)
                    if any(u in vers for k in lists for u, _ in lists[k]):
                        try:
                            bump_world_versions(w, vers, log)
                        except Exception as e:
                            short, hint = explain_error(e)
                            log(f"  ! could not update versions in world '{Path(w).name}': {short} Try: {hint}", "err")
                            c["problems"].append((f"World '{Path(w).name}'", f"{short} Try: {hint}", ""))
                return c
            self._run(f"Updating {len(todo)} pack(s)", work, again=lambda: self.act_update(all_=True))

        # ---- preview before installing
        def _confirm_plan(self, title, packs, root, mode, force, extra=""):
            installed = scan_installed(root, mode)
            rows = plan_for(packs, installed, force, self.changes)
            todo = [p for p, a, _ in rows if a != "Skip"]
            probs = preflight(root, todo) if todo else []
            errors = [t for s, t in probs if s == "error"]
            if not self.cfg["confirm_plan"] and not probs:
                return True
            d = self.make_dialog(title, 900, 560)
            label(d, title, 15, True).pack(anchor="w", padx=22, pady=(18, 2))
            label(d, "This is exactly what will happen. Nothing has been changed yet." + (" " + extra if extra else ""),
                  10, fg=P["muted"], wraplength=840, justify="left").pack(anchor="w", padx=22, pady=(0, 10))
            c = card(d)
            c.pack(fill="both", expand=True, padx=22)
            heads = {"name": ("Pack", 260, "w", True), "kind": ("Type", 70, "w", False),
                     "act": ("Action", 90, "w", False), "why": ("Details", 400, "w", False)}
            fr, t = make_tree(c, tuple(heads), heads, height=9)
            fr.pack(fill="both", expand=True, padx=1, pady=1)
            t.tag_configure("Skip", foreground=P["muted"])
            t.tag_configure("Update", foreground=P["warn"])
            t.tag_configure("Reinstall", foreground=P["warn"])
            t.tag_configure("Downgrade", foreground=P["err"])
            t.tag_configure("Install", foreground=P["ok"])
            for p, a, why in rows:
                t.insert("", "end", tags=(a,), values=(p.name, KIND_LABEL.get(p.kind, p.kind), a, why))
            n_act = len(todo)
            if probs:
                box = tk.Text(d, height=min(5, len(probs) + 1), wrap="word", relief="flat", bg=P["panel"], font=F(10),
                              padx=14, pady=8, highlightthickness=1, highlightbackground=P["line"], fg=P["text"])
                box.tag_configure("error", foreground=P["err"])
                box.tag_configure("warn", foreground=P["warn"])
                for s, text in probs:
                    box.insert("end", ("✖ " if s == "error" else "⚠ ") + text + "\n", s)
                box.configure(state="disabled")
                box.pack(fill="x", padx=22, pady=(10, 0))
            result = {"ok": False}
            bar = tk.Frame(d, bg=P["bg"])
            bar.pack(fill="x", padx=22, pady=14)
            ask = tk.BooleanVar(value=self.cfg["confirm_plan"])
            tk.Checkbutton(bar, text="Always show this preview", variable=ask, bg=P["bg"], fg=P["muted"],
                           selectcolor=P["panel2"], activebackground=P["bg"], activeforeground=P["text"],
                           font=F(9), highlightthickness=0, bd=0).pack(side="left")

            def go():
                result["ok"] = True
                self.cfg["confirm_plan"] = bool(ask.get())
                self._schedule_save()
                d.destroy()
            make_btn(bar, "Cancel", d.destroy).pack(side="right")
            label_go = f"Go ahead ({n_act} to do)" if n_act else "Go ahead (only world changes)"
            b = make_btn(bar, label_go, go, "success")
            b.pack(side="right", padx=8)
            if errors:
                b.configure(state="disabled")
            d.grab_set()
            self.wait_window(d)
            return result["ok"]

        # ================================================================== sidebar, notifications, themes (v3.3)
        def toggle_sidebar(self):
            self.side_collapsed = not self.side_collapsed
            self.cfg["sidebar_collapsed"] = self.side_collapsed
            self._schedule_save()
            self._apply_sidebar(self.side_collapsed, animate=True)

        def _apply_sidebar(self, collapsed, animate=True):
            self.side_collapsed = collapsed
            target = 64 if collapsed else 220
            if collapsed:
                self.brand_box.pack_forget()
                self.side_toggle.configure(text="»")
            else:
                self.side_toggle.pack_forget()
                self.brand_box.pack(side="left")
                self.side_toggle.pack(side="right")
                self.side_toggle.configure(text="«")
            for key, (row, bar, lab, badge) in self.nav.items():
                icon, text = self.nav_text[key]
                if collapsed:
                    lab.configure(text=icon, anchor="center", padx=0, font=F(14))
                    badge.pack_forget()
                else:
                    lab.configure(text=f"  {icon}   {text}", anchor="w", padx=12, font=F(11))
                    badge.pack(side="right", padx=12)
            for w in (self.btn_play, self.lbl_played, self.foot_sep, self.lbl_side_mc, self.lbl_side_world):
                w.pack_forget()
            if collapsed:
                self.btn_play.configure(text="▶", padx=0)
                self.btn_play.pack(fill="x")
            else:
                self.btn_play.configure(text="▶   Play Minecraft", padx=14)
                self.btn_play.pack(fill="x", pady=(0, 6))
                self.lbl_played.pack(anchor="w", pady=(0, 10))
                self.foot_sep.pack(fill="x", pady=(0, 10))
                self.lbl_side_mc.pack(anchor="w")
                self.lbl_side_world.pack(anchor="w", pady=(4, 0))
            cur = int(self.side.cget("width"))
            if not animate or cur == target:
                self.side.configure(width=target)
                return
            steps = 5

            def step(i=1):
                self.side.configure(width=int(cur + (target - cur) * i / steps))
                if i < steps:
                    self.after(16, lambda: step(i + 1))
            step()

        # ---- accent themes
        def _retheme(self, w, m):
            if getattr(w, "_keep", False):
                return
            for opt in ("bg", "fg", "activebackground", "activeforeground", "highlightbackground", "highlightcolor",
                        "selectcolor", "insertbackground", "selectbackground", "troughcolor"):
                try:
                    v = str(w.cget(opt)).lower()
                except tk.TclError:
                    continue
                if v in m:
                    try:
                        w.configure(**{opt: m[v]})
                    except tk.TclError:
                        pass
            kind = getattr(w, "_kind", None)
            if kind:
                bg, hv, fg = _btn_cols(kind)
                w.configure(bg=bg, activebackground=hv)
            if isinstance(w, tk.Text):
                for tg in w.tag_names():
                    for opt in ("foreground", "background"):
                        try:
                            v = str(w.tag_cget(tg, opt)).lower()
                        except tk.TclError:
                            continue
                        if v in m:
                            w.tag_configure(tg, **{opt: m[v]})
            if isinstance(w, (Toggle, Bell)):
                (w._draw if isinstance(w, Toggle) else w.draw)()
            for c in w.winfo_children():
                self._retheme(c, m)

        def set_accent(self, color):
            if not valid_hex(color):
                return
            color = color.lower()
            old = {P["accent"].lower(): color, P["accent_d"].lower(): shade(color)}
            P["accent"], P["accent_d"] = color, shade(color)
            self.cfg["accent"] = color
            self._style()
            self._retheme(self, old)
            if hasattr(self, "t_files"):
                self.t_files.tag_configure("dir", foreground=P["accent"])
            if hasattr(self, "utree"):
                self.utree.tag_configure("content", foreground=P["accent"])
            self.show(self.current_page)
            self._refresh_swatches()
            self._schedule_save()
            self.set_status("Accent colour changed.")

        def pick_custom_accent(self):
            from tkinter import colorchooser
            c = colorchooser.askcolor(color=P["accent"], parent=self, title="Pick an accent colour")
            if c and c[1]:
                self.set_accent(c[1])

        def _refresh_swatches(self):
            for col, sw in getattr(self, "swatches", []):
                sw.configure(highlightbackground="#ffffff" if col.lower() == P["accent"].lower() else P["panel"])

        # ---- notifications
        def notify(self, title, text="", lvl="info", action=None, key=None, routine=False):
            """lvl: info | ok | warn | err. key replaces an earlier notification of the same kind."""
            if routine and not self.cfg.get("notify_info", True):
                return
            if key:
                same = next((n for n in self.notes if n.get("key") == key), None)
                if same and same["title"] == title and same["text"] == text:
                    return
                self.notes = [n for n in self.notes if n.get("key") != key]
            self.notes.insert(0, {"t": time.time(), "lvl": lvl, "title": title, "text": text, "action": action,
                                  "key": key, "read": False})
            del self.notes[60:]
            self._nc_changed()

        def notify_clear(self, key):
            n = len(self.notes)
            self.notes = [x for x in self.notes if x.get("key") != key]
            if len(self.notes) != n:
                self._nc_changed()

        def _unread(self):
            return sum(1 for n in self.notes if not n.get("read"))

        def _nc_changed(self):
            self.cfg["notifications"] = self.notes[:60]
            for b in self.bells:
                b.set_count(self._unread())
            if self._nc_open:
                self._render_nc()
            self._schedule_save()

        def _build_nc(self):
            self.nc = tk.Frame(self, bg=P["panel"], highlightbackground=P["line"], highlightthickness=1)
            top = tk.Frame(self.nc, bg=P["panel"])
            top.pack(fill="x", padx=14, pady=(12, 6))
            label(top, "Notifications", 13, True).pack(side="left")
            for text, cmd in (("✕", lambda: self.toggle_nc(False)), ("Clear all", self._nc_clear),
                              ("Mark all read", self._nc_mark_read)):
                lb = tk.Label(top, text=text, bg=P["panel"], fg=P["muted"] if text == "✕" else P["accent"],
                              font=F(9), cursor="hand2")
                lb.pack(side="right", padx=(10, 0))
                lb.bind("<Button-1>", lambda e, c=cmd: c())
            tk.Frame(self.nc, height=1, bg=P["line"]).pack(fill="x")
            self.nc_list = ScrollFrame(self.nc)
            self.nc_list.pack(fill="both", expand=True)
            self.nc_list.configure(bg=P["panel"])
            self.nc_list.canvas.configure(bg=P["panel"])
            self.nc_list.inner.configure(bg=P["panel"])
            for b in self.bells:
                b.set_count(self._unread())

        def toggle_nc(self, show=None):
            show = (not self._nc_open) if show is None else show
            if show and not self._nc_open:
                self._nc_open = True
                self._render_nc()
                self.nc.place(relx=1.0, x=-22, y=74, anchor="ne", width=430,
                              height=max(260, min(560, self.winfo_height() - 140)))
                self.nc.lift()
            elif not show and self._nc_open:
                self._nc_open = False
                self.nc.place_forget()
                self._nc_mark_read()

        def _nc_outside_click(self, e):
            if not self._nc_open:
                return
            w = e.widget
            if isinstance(w, Bell) or str(w).startswith(str(self.nc)):
                return
            self.toggle_nc(False)

        def _nc_mark_read(self):
            for n in self.notes:
                n["read"] = True
            self._nc_changed()

        def _nc_clear(self):
            self.notes = []
            self._nc_changed()

        def _ago(self, t):
            s = max(0, int(time.time() - t))
            if s < 60:
                return "just now"
            if s < 3600:
                return f"{s // 60} min ago"
            if s < 86400:
                return f"{s // 3600} h ago"
            return datetime.fromtimestamp(t).strftime("%b %d, %I:%M %p")

        def _render_nc(self):
            inner = self.nc_list.inner
            for ch in inner.winfo_children():
                ch.destroy()
            if not self.notes:
                label(inner, "You're all caught up", 11, True, bg=P["panel"]).pack(pady=(60, 4))
                label(inner, "Updates, problems and finished jobs will appear here.", 9, fg=P["muted"],
                      bg=P["panel"]).pack()
                return
            col = {"info": P["muted"], "ok": P["ok"], "warn": P["warn"], "err": P["err"]}
            for n in list(self.notes):
                row = tk.Frame(inner, bg=P["panel2"] if not n.get("read") else P["panel"])
                row.pack(fill="x", padx=8, pady=3)
                tk.Frame(row, width=4, bg=col.get(n["lvl"], P["muted"])).pack(side="left", fill="y")
                body = tk.Frame(row, bg=row.cget("bg"))
                body.pack(side="left", fill="x", expand=True, padx=10, pady=8)
                label(body, n["title"], 10, not n.get("read"), bg=row.cget("bg"), wraplength=330,
                      justify="left").pack(anchor="w")
                if n.get("text"):
                    label(body, n["text"], 9, fg=P["muted"], bg=row.cget("bg"), wraplength=330,
                          justify="left").pack(anchor="w", pady=(2, 0))
                foot = tk.Frame(body, bg=row.cget("bg"))
                foot.pack(fill="x", pady=(4, 0))
                label(foot, self._ago(n["t"]), 8, fg=P["muted"], bg=row.cget("bg")).pack(side="left")
                for text, cmd in (("Dismiss", lambda n=n: self._nc_dismiss(n)),) + \
                        ((("Open", lambda n=n: self._nc_open_action(n)),) if n.get("action") else ()):
                    lb = tk.Label(foot, text=text, bg=row.cget("bg"), fg=P["accent"], font=F(9), cursor="hand2")
                    lb.pack(side="right", padx=(10, 0))
                    lb.bind("<Button-1>", lambda e, c=cmd: c())

        def _nc_dismiss(self, n):
            if n in self.notes:
                self.notes.remove(n)
            self._nc_changed()

        def _nc_open_action(self, n):
            a = n.get("action")
            self.toggle_nc(False)
            if a == "updates":
                self.show("mods")
                self._mod_view("updates")
            elif a == "compat":
                self.show("mods")
                self._mod_view("compat")
            elif a == "scanprob":
                self.show_scan_problems()
            elif a == "unnamed":
                self._show_filter("Unnamed packs")
            elif a == "worlds":
                self.show("worlds")
            elif a == "minecraft":
                self.show("minecraft")

        # ================================================================== Settings page
        def _srow(self, parent, title, desc=""):
            row = tk.Frame(parent, bg=P["panel"])
            row.pack(fill="x", padx=18, pady=7)
            left = tk.Frame(row, bg=P["panel"])
            left.pack(side="left", fill="x", expand=True)
            label(left, title, 10, True).pack(anchor="w")
            if desc:
                label(left, desc, 9, fg=P["muted"], wraplength=620, justify="left").pack(anchor="w")
            right = tk.Frame(row, bg=P["panel"])
            right.pack(side="right", padx=(12, 0))
            return right

        def _swide(self, parent, title, desc=""):
            box = tk.Frame(parent, bg=P["panel"])
            box.pack(fill="x", padx=18, pady=7)
            label(box, title, 10, True).pack(anchor="w")
            if desc:
                label(box, desc, 9, fg=P["muted"], wraplength=760, justify="left").pack(anchor="w", pady=(0, 6))
            return box

        def _watch(self, key, var, conv=None):
            var.trace_add("write", lambda *a: self._setting_changed(key, conv(var.get()) if conv else var.get()))

        def _s_toggle(self, parent, key, title, desc=""):
            var = tk.BooleanVar(value=bool(self.cfg[key]))
            self._watch(key, var, bool)
            Toggle(self._srow(parent, title, desc), var).pack()

        def _s_entry(self, parent, key, title, desc="", width=30):
            var = tk.StringVar(value=str(self.cfg[key]))
            self._watch(key, var)
            entry(self._srow(parent, title, desc), var, width).pack(ipady=4)

        def _s_choice(self, parent, key, title, desc, options):
            labels = [l for _, l in options]
            cur = next((l for v, l in options if v == self.cfg[key]), labels[0])
            var = tk.StringVar(value=cur)
            cb = ttk.Combobox(self._srow(parent, title, desc), textvariable=var, values=labels, state="readonly",
                              width=38)
            cb.pack()
            cb.bind("<<ComboboxSelected>>",
                    lambda e: self._setting_changed(key, next(v for v, l in options if l == var.get())))

        def _build_settings(self, page):
            self._header(page, "Settings", "Paths and preferences. Changes are saved automatically.")
            sf = ScrollFrame(page)
            sf.pack(fill="both", expand=True, padx=(28, 12), pady=(0, 12))
            inner = sf.inner

            def section(title):
                c = card(inner)
                c.pack(fill="x", pady=(0, 14), padx=(0, 16))
                label(c, title, 12, True).pack(anchor="w", padx=18, pady=(14, 2))
                return c

            c = section("Appearance")
            w = self._swide(c, "Accent colour", "Buttons, highlights and the selected page use this colour. Changes "
                                                "apply immediately. Ctrl+B (or the « button) collapses the sidebar.")
            self.swatches = []
            for name, col in THEMES:
                sw = tk.Label(w, text="", bg=col, width=4, height=2, cursor="hand2", highlightthickness=2,
                              highlightbackground=P["panel"])
                sw.pack(side="left", padx=(0, 8))
                sw._keep = True
                sw.bind("<Button-1>", lambda e, c=col: self.set_accent(c))
                self.swatches.append((col, sw))
            make_btn(w, "Custom colour...", self.pick_custom_accent).pack(side="left", padx=(6, 0))
            self._refresh_swatches()
            self._s_toggle(c, "notify_info", "Notify about routine events",
                           "Finished installs, scans and Minecraft starting. Problems and updates always notify.")
            tk.Frame(c, height=6, bg=P["panel"]).pack()

            c = section("Minecraft")
            w = self._swide(c, "Minecraft folder", "The com.mojang folder (or a Bedrock dedicated-server folder) that "
                                                  "mods are installed into.")
            self.var_target = tk.StringVar(value=self.cfg["target"])
            self.cb_target = ttk.Combobox(w, textvariable=self.var_target, width=72)
            self.cb_target.pack(side="left")
            for ev in ("<<ComboboxSelected>>", "<Return>", "<FocusOut>"):
                self.cb_target.bind(ev, self._apply_target_text)
            make_btn(w, "Browse...", self.browse_target).pack(side="left", padx=8)
            make_btn(w, "Open", lambda: self.open_folder(self.mc_root)).pack(side="left")
            tk.Frame(c, height=8, bg=P["panel"]).pack()

            c = section("Mod library")
            w = self._swide(c, "Library folders", "Your mods are found in these folders and everything inside them "
                                                 "(builds and pack folders). Add the folder that holds all your mods.")
            fr, self.t_sources = make_tree(w, ("path",), {"path": ("Folder or file", 700, "w", True)}, height=4,
                                           select="extended")
            fr.pack(fill="x")
            bar = tk.Frame(w, bg=P["panel"])
            bar.pack(fill="x", pady=(8, 0))
            make_btn(bar, "Add folder...", self.add_folder).pack(side="left")
            make_btn(bar, "Add files...", self.add_files).pack(side="left", padx=8)
            make_btn(bar, "Remove selected", self._remove_sources).pack(side="left")
            make_btn(bar, "Rescan now", self.rescan, "primary").pack(side="right")
            self._s_toggle(c, "scan_on_startup", "Scan the library when the program starts",
                           "Turn off if your mods folder is huge and you prefer to press Rescan yourself.")
            self._s_toggle(c, "include_mc", "Also list packs already in the Minecraft folder",
                           "Lets you pick from packs that are installed but not in your library folders.")
            self._s_entry(c, "skip_folders", "Folders to skip while scanning",
                          "Comma separated names. A * at the end means 'starts with', e.g. _* skips _backup folders.", 28)
            tk.Frame(c, height=6, bg=P["panel"]).pack()

            c = section("Installing")
            self._s_choice(c, "mode", "Install packs as", "Normal packs show in Minecraft's pack lists. Development "
                                                          "packs live in the development folders and reload on world load.",
                           [("standard", "Normal packs"), ("development", "Development packs")])
            self._s_choice(c, "world_mode", "Adding a mod to a world",
                           "Shared: the pack stays in the Minecraft folder and the world points at it. Copy: the pack is "
                           "copied into the world's own folder.",
                           [("shared", "Use the shared pack in Minecraft"), ("copy", "Copy the pack into the world")])
            self._s_toggle(c, "force_world_copy", "Always copy the packs into the world's own folders",
                           "On: Add to world always writes the files into the world's behavior_packs / resource_packs "
                           "folders, even when the pack is already installed in Minecraft.")
            self._s_toggle(c, "force", "Reinstall even if the same or a newer version is installed",
                           "Off by default. Bump the manifest version when you rebuild a mod instead.")
            self._s_toggle(c, "launch_after", "Launch Minecraft after installing", "Windows only.")
            self._s_toggle(c, "backup_json", "Keep a backup of a world's pack lists before editing them",
                           "Saves world_*_packs.json.bak_addonloader once per file.")
            self._s_toggle(c, "backup_world", "Back up the whole world before adding mods to it",
                           "Zips the world folder first. Can take a while for big worlds.")
            w = self._swide(c, "Backup folder", "Where world backups are saved (empty = a 'backups' folder next to "
                                                "this program).")
            self.var_backup = tk.StringVar(value=self.cfg["backup_dir"])
            self._watch("backup_dir", self.var_backup)
            entry(w, self.var_backup, 72).pack(side="left", ipady=4)
            make_btn(w, "Browse...", self._browse_backup).pack(side="left", padx=8)
            tk.Frame(c, height=6, bg=P["panel"]).pack()

            c = section("Compatibility and load order")
            self._s_entry(c, "game_version", "Minecraft / server version",
                          "Optional, e.g. 1.26.50. Packs that need a newer game are flagged.", 12)
            self._s_toggle(c, "auto_check", "Check compatibility as you tick mods", "Turn off to check only when you "
                                                                                     "press Check now or install.")
            self._s_toggle(c, "auto_order", "Place new mods in the recommended load order",
                           "Packs already in a world keep their place; new ones go where dependencies and patches say.")
            self._s_toggle(c, "auto_fix_order", "Fix load-order problems automatically",
                           "Re-orders only the packs that break a rule (patches below their base, dependants below what "
                           "they need). Anything you move by hand is left alone.")
            self._s_toggle(c, "last_wins", "The last pack in a world's list wins conflicts",
                           "My best understanding of how Bedrock stacks packs. Turn off if you see the opposite in game.")
            self._s_toggle(c, "confirm_errors", "Ask before installing when the check finds errors")
            tk.Frame(c, height=6, bg=P["panel"]).pack()

            c = section("Updates and safety")
            self._s_toggle(c, "confirm_plan", "Show a preview before installing or updating",
                           "Lists exactly what will be installed, updated or skipped, plus disk-space and path checks.")
            self._s_toggle(c, "check_changes", "Look for mods that changed since they were installed",
                           "Compares your library with the installed copies in the background after each scan.")
            self._s_toggle(c, "update_worlds", "Update the version in worlds that already use a mod",
                           "When a mod is updated, worlds that list it get the new version number in their pack list.")
            self._s_toggle(c, "write_log", "Keep a log file", "addon_loader.log next to the program, including error details.")
            w = self._swide(c, "Labels and ignored updates",
                            "Labels you gave to unnamed packs, and updates you chose to ignore.")
            make_btn(w, "Open log file", self.open_log).pack(side="left")
            make_btn(w, "Manage labels...", self._manage_labels).pack(side="left", padx=8)
            make_btn(w, "Clear ignored updates", self._clear_ignored).pack(side="left")
            tk.Frame(c, height=6, bg=P["panel"]).pack()

            c = section("General")
            self._s_toggle(c, "warn_running", "Warn when Minecraft is running while installing")
            w = self._swide(c, "Program files", "Settings are stored in addon_loader_config.json next to the program.")
            make_btn(w, "Open program folder", lambda: self.open_folder(APP_DIR)).pack(side="left")
            make_btn(w, "Reset settings to defaults", self._reset_settings, "danger").pack(side="left", padx=8)
            tk.Frame(c, height=8, bg=P["panel"]).pack()
            self._refresh_sources_view()

        def _apply_target_text(self, e=None):
            t = self.var_target.get().strip()
            if t and Path(t).is_dir() and Path(t) != self.mc_root:
                self._set_root(Path(t))
            elif t and not Path(t).is_dir():
                self.set_status("That folder does not exist.")

        def _browse_backup(self):
            d = filedialog.askdirectory(title="Pick the folder for world backups")
            if d:
                self.var_backup.set(os.path.normpath(d))

        def _refresh_sources_view(self):
            if not hasattr(self, "t_sources"):
                return
            self.t_sources.delete(*self.t_sources.get_children())
            for i, s in enumerate(self.cfg["sources"]):
                self.t_sources.insert("", "end", iid=str(i), values=(s,))

        def _remove_sources(self):
            sel = {int(i) for i in self.t_sources.selection()}
            if sel:
                self.cfg["sources"] = [s for i, s in enumerate(self.cfg["sources"]) if i not in sel]
                self._save()
                self._refresh_sources_view()
                self.rescan()

        def _setting_changed(self, key, value):
            if key == "game_version":
                value = str(value).strip()
            self.cfg[key] = value
            if key == "skip_folders":
                set_scan_skip(value)
                if self._rescan_job:
                    self.after_cancel(self._rescan_job)
                self._rescan_job = self.after(1200, self.rescan)
            elif key == "backup_json":
                globals()["BACKUP_JSON"] = bool(value)
            elif key == "write_log":
                globals()["WRITE_LOG"] = bool(value)
            elif key == "check_changes":
                self._start_change_scan()
                self._rebuild_updates()
            elif key == "include_mc":
                self.rescan()
            elif key == "mode":
                self.rebuild()
            elif key in ("game_version", "last_wins", "auto_order", "auto_fix_order"):
                if key == "last_wins":
                    self._render_editor()
                self._schedule_analysis()
            self._schedule_save()

        def _manage_labels(self):
            d = self.make_dialog("Your labels", 640, 420)
            label(d, "Labels you gave to packs", 14, True).pack(anchor="w", padx=22, pady=(18, 4))
            label(d, "A label replaces a missing or unhelpful pack name everywhere in this program.", 10,
                  fg=P["muted"]).pack(anchor="w", padx=22)
            c = card(d)
            c.pack(fill="both", expand=True, padx=22, pady=12)
            fr, t = make_tree(c, ("name", "uuid"), {"name": ("Label", 220, "w", False),
                                                    "uuid": ("UUID", 340, "w", True)}, height=8)
            fr.pack(fill="both", expand=True, padx=1, pady=1)
            for u, n in sorted(self.cfg["aliases"].items(), key=lambda x: x[1].lower()):
                t.insert("", "end", iid=u, values=(n, u))
            bar = tk.Frame(d, bg=P["bg"])
            bar.pack(fill="x", padx=22, pady=(0, 16))

            def rename():
                for u in t.selection():
                    n = simpledialog.askstring(APP_NAME, "New label:", initialvalue=self.cfg["aliases"].get(u, ""),
                                               parent=d)
                    if n is not None:
                        self._set_alias(u, n)
                        d.destroy()
                        return

            def remove():
                for u in t.selection():
                    self.cfg["aliases"].pop(u, None)
                    ALIASES.pop(u, None)
                    t.delete(u)
                self._save()
                self.rescan()
            make_btn(bar, "Rename", rename).pack(side="left")
            make_btn(bar, "Remove label", remove, "danger").pack(side="left", padx=8)
            make_btn(bar, "Close", d.destroy, "primary").pack(side="right")

        def _clear_ignored(self):
            self.ignored.clear()
            self.cfg["ignored_updates"] = []
            self._save()
            self.rebuild()
            self._rebuild_updates()
            self.say("Ignored updates cleared.", "ok")

        def _reset_settings(self):
            if not messagebox.askyesno(APP_NAME, "Reset all settings to their defaults?\n\n(Your library folders and "
                                                 "the selected Minecraft folder are kept.)"):
                return
            keep = {k: self.cfg[k] for k in ("sources", "target", "world", "ticked", "aliases", "ignored_updates",
                                                            "meta", "profiles", "accent", "notifications",
                                                            "sidebar_collapsed")}
            self.cfg = dict(DEFAULT_CFG)
            self.cfg.update(keep)
            set_scan_skip(self.cfg["skip_folders"])
            globals()["BACKUP_JSON"] = True
            page = self.pages["settings"]
            for ch in page.winfo_children():
                ch.destroy()
            self._build_settings(page)
            self.cb_target["values"] = [str(p) for _, p in self.roots]
            self._save()
            self.rebuild()
            self.say("Settings reset to defaults.", "ok")

    App().mainloop()


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--cli":
        sys.exit(cli(sys.argv[2:]))
    run_gui()


if __name__ == "__main__":
    main()
