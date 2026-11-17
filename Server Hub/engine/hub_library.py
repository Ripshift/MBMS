"""The mod library: extracted pack folders, and nothing else worth backing up.

The folder is the source of truth. Worlds and the server get their copies from it, so a mod only needs to be in one place.
When a mod is updated the old folder is replaced, so no space goes on old versions. Before that happens, what changed is
written down in library.json, which keeps the changed lines of text files but none of the files themselves.
"""
import difflib
import hashlib
import json
import os
import re
import time
import zlib
from pathlib import Path, PurePosixPath

import addon_engine as E

PACK_EXT = {".mcaddon", ".mcpack", ".zip"}
TEXT_EXT = {".json", ".lang", ".js", ".mjs", ".ts", ".mcfunction", ".txt", ".md", ".material", ".fragment", ".vertex", ".properties", ".html", ".xml", ".yml", ".yaml", ".csv"}
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".tga"}
AUTHOR_NOTES = re.compile(r"(change.?log|release.?notes|what.?s.?new|updates?)(\.\w+)?$", re.I)
MAX_TEXT = 400_000
MAX_LINES = 20_000
MAX_ROWS_PER_FILE = 400
MAX_LINE_CHARS = 300
KEPT_LINES = 150_000        # characters of changed lines kept for one update
KEPT_CHANGES = 8            # updates remembered for one pack
COUNT_SECONDS = 4
RECYCLE = True
CATEGORY_NAMES = {"entity": "Entities", "item": "Items", "block": "Blocks", "recipe": "Recipes", "biome": "Biomes", "geometry": "Models",
                  "animation": "Animations", "animation controller": "Animation controllers", "render controller": "Render controllers",
                  "custom component": "Custom components", "command": "Commands", "feature": "World features", "feature_rules": "Feature rules",
                  "spawn_rules": "Spawn rules", "client_entity": "Entity visuals", "attachable": "Attachables", "loot": "Loot tables"}


def recycle(path):
    """Send a file or folder to the Recycle Bin, so a deletion can still be undone by hand. Raises if it couldn't."""
    path = Path(path)
    if not RECYCLE:
        if path.is_dir():
            E.rmtree(path)
        else:
            os.remove(E.lp(path))
        return
    import ctypes
    from ctypes import wintypes

    class Op(ctypes.Structure):
        _fields_ = [("hwnd", wintypes.HWND), ("wFunc", wintypes.UINT), ("pFrom", wintypes.LPCWSTR), ("pTo", wintypes.LPCWSTR),
                    ("fFlags", ctypes.c_ushort), ("fAnyOperationsAborted", wintypes.BOOL), ("hNameMappings", wintypes.LPVOID),
                    ("lpszProgressTitle", wintypes.LPCWSTR)]
    silent_undoable = 0x0004 | 0x0010 | 0x0040 | 0x0400   # no window, no question, allow undo, no error window
    op = Op(None, 3, str(path.resolve()) + "\0", None, silent_undoable, False, None, None)
    code = ctypes.windll.shell32.SHFileOperationW(ctypes.byref(op))
    if code or op.fAnyOperationsAborted or path.exists():
        raise OSError(f"Windows couldn't move {path.name} to the Recycle Bin (code {code}). Close anything using it, then try again.")


def clean_name(text):
    return re.sub(r"\s+", " ", re.sub(r"§.", "", str(text))).strip()


def safe_parts(rel):
    parts = PurePosixPath(rel).parts
    if not parts or any(p in ("..", "") or ":" in p or p.startswith("/") or p.startswith("\\") for p in parts):
        return None
    return parts


def is_text(path):
    return os.path.splitext(path)[1].lower() in TEXT_EXT


def text_lines(path, raw):
    """A file as lines. JSON is laid out the same way on both sides, so only real changes show up."""
    text = raw.decode("utf-8-sig", "replace")
    if path.lower().endswith(".json"):
        try:
            text = json.dumps(E.parse_json_lenient(text), indent=2, ensure_ascii=False)
        except Exception:
            pass
    return text.splitlines()


def line_hunks(old, new):
    """Changed lines with 3 lines around them. -> (hunks, added, removed, cut short)"""
    hunks, adds, dels, shown, cut = [], 0, 0, 0, False
    matcher = difflib.SequenceMatcher(None, old, new)
    for group in matcher.get_grouped_opcodes(3):
        rows = []
        for tag, i1, i2, j1, j2 in group:
            if tag == "equal":
                rows += [[" ", old[i][:MAX_LINE_CHARS], i + 1, j1 + (i - i1) + 1] for i in range(i1, i2)]
                continue
            if tag in ("replace", "delete"):
                rows += [["-", old[i][:MAX_LINE_CHARS], i + 1, None] for i in range(i1, i2)]
                dels += i2 - i1
            if tag in ("replace", "insert"):
                rows += [["+", new[j][:MAX_LINE_CHARS], None, j + 1] for j in range(j1, j2)]
                adds += j2 - j1
        if shown < MAX_ROWS_PER_FILE:
            hunks.append(rows[:MAX_ROWS_PER_FILE - shown])
            cut = cut or len(rows) > MAX_ROWS_PER_FILE - shown
            shown += len(rows)
        else:
            cut = True
    return hunks, adds, dels, cut


def _manifest(raw):
    try:
        return E.parse_json_lenient(raw.decode("utf-8-sig", "replace")) if raw else {}
    except Exception:
        return {}


def _vtext(value):
    return ".".join(str(n) for n in value) if isinstance(value, list) else str(value)


def manifest_notes(old, new):
    """What changed in the manifest, in words."""
    notes = []
    a, b = old.get("header") or {}, new.get("header") or {}
    if a.get("name") != b.get("name") and a.get("name") and b.get("name"):
        notes.append(f"Renamed from \"{a['name']}\" to \"{b['name']}\".")
    if a.get("description") != b.get("description") and b.get("description"):
        notes.append(f"New description: {b['description']}")
    if a.get("min_engine_version") != b.get("min_engine_version"):
        notes.append(f"Minimum game version changed from {_vtext(a.get('min_engine_version', 'none'))} to {_vtext(b.get('min_engine_version', 'none'))}.")

    def deps(man):
        out = {}
        for d in man.get("dependencies") or []:
            if isinstance(d, dict):
                out[str(d.get("module_name") or d.get("uuid") or "?")] = _vtext(d.get("version", ""))
        return out
    da, db = deps(old), deps(new)
    for key in sorted(db):
        if key not in da:
            notes.append(f"Now needs {key} {db[key]}.")
        elif da[key] != db[key]:
            notes.append(f"{key} changed from {da[key]} to {db[key]}.")
    notes += [f"No longer needs {key}." for key in sorted(da) if key not in db]
    return notes


def idents_in(path, raw):
    """What one file defines, as (category, identifier)."""
    low = path.lower()
    if len(raw) > 3_000_000:
        return set()
    try:
        if low.endswith(".json") and low != "manifest.json":
            return set(E.extract_idents(E.parse_json_lenient(raw.decode("utf-8-sig", "replace"))))
        if low.endswith((".js", ".mjs")):
            text = raw.decode("utf-8", "replace")
            return {("custom component", m.group(1)) for m in E._RE_COMP.finditer(text)} | {("command", m.group(1)) for m in E._RE_CMD.finditer(text)}
    except Exception:
        pass
    return set()


def grouped(idents):
    out = {}
    for cat, ident in sorted(idents):
        out.setdefault(CATEGORY_NAMES.get(cat, cat.replace("_", " ").capitalize() + "s"), []).append(ident)
    return {k: v[:60] for k, v in out.items()}


def read_files(pack):
    """{path: bytes} of one pack, wherever it is stored."""
    files = {}
    entries, close = E.pack_files(pack)
    try:
        for rel, _size, reader in entries:
            rel = rel.replace("\\", "/")
            parts = safe_parts(rel)
            if parts and not any(p.lower() in E.COPY_IGNORE for p in parts):
                files[rel] = reader()
    finally:
        close()
    return files


def digest_of(files_or_pack):
    files = files_or_pack if isinstance(files_or_pack, dict) else read_files(files_or_pack)
    return hashlib.sha256(json.dumps(sorted((k, hashlib.sha256(v).hexdigest()) for k, v in files.items())).encode()).hexdigest()


def digest_of_folder(folder):
    base, files = Path(folder), {}
    for dp, dns, fns in os.walk(base):
        dns[:] = [d for d in dns if d.lower() not in E.COPY_IGNORE]
        for fn in fns:
            if fn.lower() not in E.COPY_IGNORE:
                full = Path(dp) / fn
                files[full.relative_to(base).as_posix()] = Path(E.lp(full)).read_bytes()
    return digest_of(files)


def describe_change(old_pack, new_pack):
    """What changed between two copies of a pack, small enough to keep after the old copy has gone."""
    fa, fb = read_files(old_pack), read_files(new_pack)
    la, lb = {k.lower(): k for k in fa}, {k.lower(): k for k in fb}
    rows, before, after, touched = [], set(), set(), set()
    stop_counting = time.monotonic() + COUNT_SECONDS
    budget = KEPT_LINES
    notes_by_author = ""
    for key in sorted(set(la) | set(lb)):
        pa, pb = la.get(key), lb.get(key)
        ra, rb = fa[pa] if pa else b"", fb[pb] if pb else b""
        if pa and pb and ra == rb:
            continue
        path = pb or pa
        row = {"path": path, "status": "changed" if pa and pb else ("added" if pb else "removed"),
               "kind": "image" if os.path.splitext(path)[1].lower() in IMAGE_EXT else ("text" if is_text(path) else "other"),
               "before": len(ra) if pa else None, "after": len(rb) if pb else None, "adds": None, "dels": None}
        ia, ib = idents_in(path, ra), idents_in(path, rb)
        before |= ia
        after |= ib
        if row["status"] == "changed":
            touched |= ia & ib
        if row["kind"] == "text" and time.monotonic() < stop_counting and max(len(ra), len(rb)) <= MAX_TEXT:
            old, new = text_lines(path, ra), text_lines(path, rb)
            if max(len(old), len(new)) <= MAX_LINES:
                hunks, row["adds"], row["dels"], cut = line_hunks(old, new)
                if row["status"] == "changed" and not row["adds"] and not row["dels"]:
                    continue               # only the layout changed
                size = len(json.dumps(hunks))
                if size <= budget:
                    budget -= size
                    row["hunks"], row["cut"] = hunks, cut
        if row["status"] != "removed" and row["kind"] == "text" and not notes_by_author and AUTHOR_NOTES.search(PurePosixPath(path).name):
            notes_by_author = rb.decode("utf-8-sig", "replace")[:6000]
        rows.append(row)
    man_a = fa[la["manifest.json"]] if "manifest.json" in la else b""
    man_b = fb[lb["manifest.json"]] if "manifest.json" in lb else b""
    return {"from": E.vstr(old_pack.version), "to": E.vstr(new_pack.version), "at": time.time() * 1000, "edited": tuple(old_pack.version) == tuple(new_pack.version),
            "notes": manifest_notes(_manifest(man_a), _manifest(man_b)), "authorNotes": notes_by_author,
            "added": grouped(after - before), "removed": grouped(before - after), "changed": grouped(touched), "files": rows,
            "counts": {s: sum(1 for r in rows if r["status"] == s) for s in ("added", "removed", "changed")}}


class Library:
    def __init__(self, folder, log=lambda msg, lvl="info": None):
        self.folder = Path(folder)
        self.log = log
        os.makedirs(E.lp(self.folder), exist_ok=True)
        self.index_path = self.folder / "library.json"
        self.index = {"known": [], "digests": {}, "changes": {}, "unread": []}
        try:
            saved = json.loads(self.index_path.read_text(encoding="utf-8"))
            if isinstance(saved, dict):
                self.index.update({k: saved[k] for k in self.index if isinstance(saved.get(k), type(self.index[k]))})
        except FileNotFoundError:
            pass
        except (OSError, ValueError) as e:
            log(f"library.json couldn't be read ({e}), so the record of past updates starts again.", "warn")
        self.migrate_archives()

    def save(self):
        E.write_text_safely(self.index_path, json.dumps(self.index))

    # ------------------------------------------------------------------ what's in the folder
    def archives(self):
        try:
            return sorted(f for f in self.folder.iterdir() if f.is_file() and f.suffix.lower() in PACK_EXT)
        except OSError:
            return []

    def scan(self, issues=None):
        packs = []
        issues = issues if issues is not None else []
        try:
            paths = sorted(self.folder.iterdir())
        except OSError:
            return packs
        for path in paths:
            if path.name.startswith("."):
                continue
            if path.is_file() and path.suffix.lower() in PACK_EXT:
                found = E.scan_archive(path, issues)
            elif path.is_dir():
                found = E.gather([str(path)], issues, find_folders=True)
            else:
                continue
            for p in found:
                p.in_library = True
                packs.append(p)
        return packs

    def current(self):
        """uuid -> the newest copy of each pack in the folder."""
        best = {}
        for p in self.scan():
            if p.uuid not in best or tuple(p.version) > tuple(best[p.uuid].version):
                best[p.uuid] = p
        return best

    def digest(self, pack):
        """A library pack's digest, remembered until its file or folder contents change."""
        source = Path(pack.src_path)
        key = f"{source.name}|{pack.uuid}"
        if pack.src_kind == "dir":
            stats = []
            for dp, dns, fns in os.walk(source):
                dns[:] = [d for d in dns if d.lower() not in E.COPY_IGNORE]
                for fn in fns:
                    if fn.lower() in E.COPY_IGNORE:
                        continue
                    full = Path(dp) / fn
                    st = full.stat()
                    stats.append((full.relative_to(source).as_posix(), st.st_size, st.st_mtime_ns))
            sig = json.dumps(sorted(stats))
        else:
            st = os.stat(E.lp(source))
            sig = f"{st.st_size}|{st.st_mtime_ns}"
        known = self.index["digests"].get(key)
        if known and known[0] == sig:
            return known[1]
        value = digest_of(pack)
        self.index["digests"][key] = [sig, value]
        return value

    def storage(self):
        packs = self.scan()
        size = 0
        counted = set()
        for pack in packs:
            if pack.src_kind == "dir":
                for dp, dns, fns in os.walk(pack.src_path):
                    dns[:] = [d for d in dns if d.lower() not in E.COPY_IGNORE]
                    for fn in fns:
                        if fn.lower() not in E.COPY_IGNORE:
                            try:
                                size += os.path.getsize(E.lp(Path(dp) / fn))
                            except OSError:
                                pass
            else:
                source = Path(pack.src_path)
                if source not in counted:
                    counted.add(source)
                    try:
                        size += os.path.getsize(E.lp(source))
                    except OSError:
                        pass
        return {"path": str(self.folder), "folders": len([p for p in packs if p.src_kind == "dir"]),
                "bytes": size, "text": E.human_size(size)}

    # ------------------------------------------------------------------ adding
    def status_of(self, packs, current=None):
        """How these packs compare with the library: new, same, update, edited or older."""
        current = self.current() if current is None else current
        words = set()
        for p in packs:
            have = current.get(p.uuid)
            if not have:
                words.add("new")
            elif tuple(p.version) > tuple(have.version):
                words.add("update")
            elif tuple(p.version) < tuple(have.version):
                words.add("older")
            else:
                words.add("same" if digest_of(p) == self.digest(have) else "edited")
        for word in ("older", "update", "edited", "new"):
            if word in words:
                return word
        return "same"

    def _folder_name(self, pack, replacing=()):
        stem = f"{E.safe_name(clean_name(pack.name), 48) or 'Mod'}_{pack.uuid[:8]}"
        dest = self.folder / stem
        replacing = set(replacing)
        n = 2
        while dest.exists() and dest not in replacing:
            dest = self.folder / f"{stem} ({n})"
            n += 1
        return dest

    def _write_pack_folder(self, pack, dest):
        token = os.urandom(8).hex()
        tmp = self.folder / f".hubtmp-{token}"
        backup = self.folder / f".hubbak-{token}"
        try:
            os.makedirs(E.lp(tmp), exist_ok=False)
            for rel, raw in read_files(pack).items():
                parts = safe_parts(rel)
                if not parts:
                    continue
                target = tmp.joinpath(*parts)
                os.makedirs(E.lp(target.parent), exist_ok=True)
                with open(E.lp(target), "wb") as out:
                    out.write(raw)
            checked = E.scan_pack_dir(tmp, [])
            if not checked or checked.uuid != pack.uuid:
                raise ValueError(f"The extracted folder for {clean_name(pack.name)} didn't pass its manifest check.")
            if dest.exists():
                os.replace(E.lp(dest), E.lp(backup))
            try:
                os.replace(E.lp(tmp), E.lp(dest))
            except Exception:
                if backup.exists():
                    os.replace(E.lp(backup), E.lp(dest))
                raise
            if backup.exists():
                E.rmtree(backup)
        finally:
            if tmp.exists():
                E.rmtree(tmp)

    def put(self, name, packs, archive=None):
        """Extract a mod's packs into the library, replacing older copies and keeping update notes."""
        wanted = {p.uuid for p in packs}
        inside = archive and Path(archive).resolve().parent == self.folder.resolve()
        existing = [p for p in self.scan()
                    if not (inside and p.src_kind == "zip" and Path(p.src_path).resolve() == Path(archive).resolve())]
        changes = []
        newest = {}
        for p in existing:
            if p.uuid in wanted and (p.uuid not in newest or tuple(p.version) > tuple(newest[p.uuid].version)):
                newest[p.uuid] = p
        for p in packs:
            old = newest.get(p.uuid)
            if old and digest_of(p) != self.digest(old):
                try:
                    change = describe_change(old, p)
                except Exception as e:
                    self.log(f"Couldn't work out what changed in {clean_name(p.name)}: {E.explain_error(e)[0]}", "warn")
                    change = {"from": E.vstr(old.version), "to": E.vstr(p.version), "at": time.time() * 1000, "edited": False, "notes": [],
                              "authorNotes": "", "added": {}, "removed": {}, "changed": {}, "files": [], "counts": {"added": 0, "removed": 0, "changed": 0}}
                self.index["changes"][p.uuid] = ([change] + self.index["changes"].get(p.uuid, []))[:KEPT_CHANGES]
                if p.uuid not in self.index["unread"]:
                    self.index["unread"].append(p.uuid)
                changes.append({"uuid": p.uuid, "name": clean_name(p.name), "from": change["from"], "to": change["to"], "edited": change["edited"]})
        replaced = {}
        for pack in packs:
            prior = [p for p in existing if p.uuid == pack.uuid]
            old_dirs = [Path(p.src_path) for p in prior
                        if p.src_kind == "dir" and Path(p.src_path).parent.resolve() == self.folder.resolve()]
            dest = self._folder_name(pack, old_dirs)
            self._write_pack_folder(pack, dest)
            replaced[pack.uuid] = dest

        for old in existing:
            if old.uuid not in wanted or old.src_kind != "dir":
                continue
            path = Path(old.src_path)
            if path != replaced[old.uuid] and self._inside(path, self.folder) and path.exists():
                E.rmtree(path)

        archives_to_remove = set()
        if archive and Path(archive).is_file() and Path(archive).parent.resolve() == self.folder.resolve():
            archive_packs = E.scan_archive(archive, [])
            if archive_packs and {p.uuid for p in archive_packs}.issubset(wanted):
                archives_to_remove.add(Path(archive))
        for old_archive in self.archives():
            if archive and old_archive.resolve() == Path(archive).resolve():
                continue
            old_packs = E.scan_archive(old_archive, [])
            if old_packs and {p.uuid for p in old_packs}.issubset(wanted):
                archives_to_remove.add(old_archive)
        self._remember_packs()
        self.save()
        removed = False
        for old_archive in archives_to_remove:
            if old_archive.exists():
                try:
                    old_archive.unlink()
                    removed = True
                except OSError as e:
                    self.log(f"Couldn't remove extracted archive {old_archive.name}: {E.explain_error(e)[0]}", "warn")
        if removed:
            self._remember_packs()
            self.save()
        return changes

    def _inside(self, path, parent):
        try:
            Path(path).resolve().relative_to(Path(parent).resolve())
            return True
        except (ValueError, OSError):
            return False

    def _remember_packs(self):
        present = {f"{Path(p.src_path).name}|{p.uuid}" for p in self.scan()}
        self.index["digests"] = {k: v for k, v in self.index["digests"].items() if k in present}
        self.index["known"] = sorted({Path(p.src_path).name for p in self.scan()})

    def migrate_archives(self):
        """Unpack old library archives, keeping the original until all extracted folders are verified."""
        migrated, changes = 0, []
        for archive in self.archives():
            packs = E.scan_archive(archive, [])
            if not packs:
                continue
            current = self.current()
            to_import = []
            for pack in packs:
                old = current.get(pack.uuid)
                if old and Path(old.src_path).resolve() == archive.resolve():
                    old = None
                if old and tuple(pack.version) < tuple(old.version):
                    continue
                if old and tuple(pack.version) == tuple(old.version) and digest_of(pack) == self.digest(old):
                    continue
                to_import.append(pack)
            try:
                for mod in E.group_mods(to_import):
                    changes.extend(self.put(mod.name, mod.packs, archive=archive))
                if archive.exists():
                    archive.unlink()
                migrated += 1
                self.log(f"Unpacked {archive.name} into the library.", "ok")
            except Exception as e:
                self.log(f"Couldn't unpack {archive.name}; the original was kept: {E.explain_error(e)[0]}", "warn")
        if migrated:
            self._remember_packs()
            self.save()
        return {"moved": migrated, "changes": changes}

    def take_in_dropped(self):
        """Archives dropped into the library are extracted just like imported ones."""
        return self.migrate_archives()

    # ------------------------------------------------------------------ removing
    def delete(self, uuids):
        """Take packs out of the folder."""
        uuids = set(uuids)
        everything = self.scan()
        touched = {Path(p.src_path) for p in everything if p.uuid in uuids}
        for path in touched:
            if path.is_dir():
                recycle(path)
            elif path.is_file():
                rest = [p for p in everything if Path(p.src_path) == path and p.uuid not in uuids]
                if rest:
                    for pack in rest:
                        self._write_pack_folder(pack, self._folder_name(pack))
                recycle(path)
        for uuid in uuids:
            self.index["changes"].pop(uuid, None)
        self.index["unread"] = [u for u in self.index["unread"] if u not in uuids]
        self._remember_packs()
        self.save()
        return len(touched)

    def review(self, uuids):
        self.index["unread"] = [u for u in self.index["unread"] if u not in set(uuids)]
        self.save()

    # ------------------------------------------------------------------ bringing over the version store of the build before this
    def migrate_store(self, old_root):
        """That build kept every version. The newest of each pack becomes a pack file here, then the rest is deleted."""
        old_root = Path(old_root)
        if not (old_root / "packs").is_dir() or not (old_root / "objects").is_dir():
            return 0
        work = old_root / "work-migrate"
        if work.exists():
            E.rmtree(work)
        present = self.current()
        unpacked = []
        failed = 0
        for record in (old_root / "packs").glob("*.json"):
            try:
                rec = json.loads(record.read_text(encoding="utf-8"))
                if rec["uuid"] in present or not rec["versions"]:
                    continue
                best = max(rec["versions"], key=lambda v: (tuple(v["version"]), v.get("seen", 0)))
                folder = work / rec["uuid"]
                for rel, (sha, _size) in best["files"].items():
                    parts = safe_parts(rel)
                    if parts:
                        target = folder.joinpath(*parts)
                        os.makedirs(E.lp(target.parent), exist_ok=True)
                        Path(E.lp(target)).write_bytes(zlib.decompress((old_root / "objects" / sha[:2] / sha).read_bytes()))
                pack = E.scan_pack_dir(folder, [])
                if pack:
                    unpacked.append(pack)
            except Exception as e:
                failed += 1
                self.log(f"Couldn't bring over a saved mod ({record.stem}): {E.explain_error(e)[0]}", "warn")
        added = 0
        for mod in E.group_mods(unpacked):
            try:
                self.put(mod.name, mod.packs)
                added += 1
            except Exception as e:
                failed += 1
                self.log(f"Couldn't bring over {clean_name(mod.name)}: {E.explain_error(e)[0]}", "warn")
        if work.exists():
            E.rmtree(work)
        if failed:
            self.log("The old saved versions were kept because some couldn't be brought over. It tries again next time.", "warn")
        else:
            E.rmtree(old_root)
            self.log(f"Moved {added} mods into the library folder and deleted the old saved versions.", "ok")
        return added
