"""The files of an application, as the server touches them.

An application is a folder (applications/<id>/):

    application.json   the manifest: format, name, description, robot,
                       which grippers and items it has, the loop
    layout.json        what stands where
    grippers/<id>/     gripper.json + its meshes
    items/<id>/        item.json + its meshes
    steps/<name>.ts    the steps
    robots/<robot>.json   what was taught on one robot
    print/ notes/ materials/

The viewer reads all of it itself (viewer/cell-data.js); the server only
lists applications, creates an empty one, and saves the loop's order.
"""
import json
import os
import re
import shutil
import uuid

FORMAT = 1

_FLAT = re.compile(r"\[\s*([^\[\]{}]*?)\s*\]", re.S)


def dumps(obj):
    """JSON as the application files are written: one key per line, but a
    list of plain values (a position, a row of ids) on ONE line — a pose
    reads as a pose, and a moved fixture is a one-line change."""
    text = json.dumps(obj, indent=1, ensure_ascii=False)
    return _FLAT.sub(lambda m: "[" + re.sub(r",\s*\n\s*", ", ", m.group(1)) + "]", text) + "\n"


def read_manifest(app_dir):
    with open(os.path.join(app_dir, "application.json"), encoding="utf-8") as f:
        return json.load(f)


def read_loop(app_dir):
    """{name, steps} — the application's one loop (empty if it names none)."""
    loop = read_manifest(app_dir).get("loop") or {}
    return {"name": loop.get("name") or "loop", "steps": list(loop.get("steps") or [])}


def write_loop_steps(app_dir, steps):
    """Save the loop's order into the manifest. Returns the path if the file
    changed, else None. Nothing else in the manifest is touched."""
    path = os.path.join(app_dir, "application.json")
    with open(path, encoding="utf-8") as f:
        src = f.read()
    manifest = json.loads(src)
    loop = manifest.setdefault("loop", {"name": manifest.get("name", "loop"), "steps": []})
    loop["steps"] = list(steps)
    out = dumps(manifest)
    if out == src:
        return None
    with open(path, "w", encoding="utf-8") as f:
        f.write(out)
    return path


ABOUT = ("An application: one job and its environment, in one folder that can be copied, saved and "
         "shared. This file says what it is; layout.json what stands where; grippers/ and items/ hold "
         "one folder per gripper and per kind of thing (its description and meshes); steps/ the steps; "
         "robots/ what was taught on a particular robot; print/ the CAD the items are made from; notes/ "
         "the agent's notes; materials/ what was attached in the chat. Every pose is in the table frame, "
         "so the application does not depend on which robot runs it; 'robot' names the one it is set up "
         "on now.")
LAYOUT_ABOUT = ("What stands where: each fixture and part is a placement of an item (items/<item>/item.json "
                "says what the thing is; here is only which one, where, and what is particular to this "
                "placement), plus the stands of the tool rack and the gripper each one holds. Poses are in "
                "the table frame.")


def new_application(app_dir, name, like_dir, kit_dir=None):
    """A new application on the same robot as the one in `like_dir`.

    It starts with the robot's KIT, if the robot has one (`<robot>/kit/`:
    kit.json, grippers/, items/): the basic grippers and the tool rack they
    stand in are COPIED into the application, so that it stays one folder
    that can be exported whole and changed freely. Without a kit it starts
    empty."""
    old = read_manifest(like_dir)
    if kit_dir is None and old.get("robot"):
        kit_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(like_dir))), old["robot"], "kit")
    kit = {}
    if kit_dir and os.path.isfile(os.path.join(kit_dir, "kit.json")):
        with open(os.path.join(kit_dir, "kit.json"), encoding="utf-8") as f:
            kit = json.load(f)
    os.makedirs(app_dir)
    for sub in ("steps", "grippers", "items"):
        os.makedirs(os.path.join(app_dir, sub))
    for sub, key in (("grippers", "grippers"), ("items", "items")):
        for ident in kit.get(key, []):
            if not re.fullmatch(r"[A-Za-z0-9_.-]+", str(ident)) or ident in (".", ".."):
                raise ValueError(f"kit: bad id {ident!r}")
            shutil.copytree(os.path.join(kit_dir, sub, ident), os.path.join(app_dir, sub, ident))
    manifest = {
        "format": FORMAT,
        "uid": str(uuid.uuid4()),
        "name": name,
        "description": "",
        "authors": [],
        "about": ABOUT,
        "robot": old.get("robot"),
        "units": old.get("units"),
        "conventions": old.get("conventions", {}),
        "grippers": list(kit.get("grippers", [])),
        "items": list(kit.get("items", [])),
        "mounted_tool": None,
        "loop": {"name": name, "steps": []},
    }
    layout = {"about": LAYOUT_ABOUT, "fixtures": list(kit.get("fixtures", [])), "parts": [],
              "tool_rack": kit.get("tool_rack") or {"stands": []}, "unplaced_parts": []}
    for fn, obj in (("application.json", manifest), ("layout.json", layout)):
        with open(os.path.join(app_dir, fn), "w", encoding="utf-8") as f:
            f.write(dumps(obj))


# ---- one file to share: <name>.microfactory ----
# The whole application folder as one archive (an ordinary zip under its
# own extension), files at the archive's root — application.json first.
# Export writes it; import unpacks it into applications/ after checking it.

EXTENSION = ".microfactory"
SKIP_NAMES = {".DS_Store", "Thumbs.db"}
SKIP_DIRS = {"__pycache__", ".git"}
MAX_FILES = 20_000
MAX_UNPACKED = 2_000_000_000      # 2 GB: an archive claiming more is refused


class ImportError_(ValueError):
    """An archive that is not an application this viewer can take."""


def slug(name):
    return re.sub(r"[^a-z0-9]+", "-", str(name).lower()).strip("-")[:60]


def _files(app_dir):
    """The files an export takes, as (path in the archive, path on disk), sorted."""
    out = []
    for dirpath, dirnames, filenames in os.walk(app_dir):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for fn in filenames:
            full = os.path.join(dirpath, fn)
            if fn in SKIP_NAMES or os.path.islink(full):
                continue
            out.append((os.path.relpath(full, app_dir).replace(os.sep, "/"), full))
    return sorted(out)


def _version(entries):
    """A short hash of WHAT IS IN an application — every file's path and
    contents, in path order. The same contents always give the same hash;
    any change gives another. Used to tell that a file being imported holds
    exactly what is already here. `entries` yields (path, bytes-reader)."""
    import hashlib
    h = hashlib.sha256()
    for rel, read in sorted(entries, key=lambda e: e[0]):
        data = read()
        h.update(rel.encode("utf-8") + b"\0" + str(len(data)).encode() + b"\0")
        h.update(data)
    return h.hexdigest()[:8]


def version_of(app_dir):
    """The version hash of the application folder as it is now."""
    def reader(full):
        def read():
            with open(full, "rb") as f:
                return f.read()
        return read
    return _version((rel, reader(full)) for rel, full in _files(app_dir))


def version_of_archive(z):
    """The version hash of an opened archive — equal to version_of() of the
    folder it was exported from."""
    return _version((i.filename, (lambda i=i: z.read(i))) for i in z.infolist() if not i.is_dir())


STAMP = "%Y%m%d-%H%M%S"


def export_name(app_id, when=None):
    """<application>-<date>-<time>.microfactory: when it was saved, to the
    second, local time — files sort by name in the order they were saved."""
    import time
    return f"{app_id}-{time.strftime(STAMP, time.localtime(when))}{EXTENSION}"


def export_application(app_dir, out):
    """Write the application in `app_dir` to the binary file `out` as one
    archive. Returns the hash of its contents."""
    import zipfile
    files = _files(app_dir)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.write(os.path.join(app_dir, "application.json"), "application.json")
        for rel, full in files:
            if rel != "application.json":
                z.write(full, rel)
    return version_of(app_dir)


def id_from_file_name(name):
    """The application id a file's name gives: without the extension, without
    the " (1)" a browser adds to a second download, and without the date and
    time export put at its end."""
    stem = name[:-len(EXTENSION)] if name.lower().endswith(EXTENSION) else name
    stem = re.sub(r"\s*\(\d+\)\s*$", "", stem)
    stem = re.sub(r"-\d{8}-\d{6}$", "", stem)
    return slug(stem)


def inspect_archive(z):
    """Check an opened archive and return its manifest. Raises ImportError_."""
    infos = z.infolist()
    if len(infos) > MAX_FILES or sum(i.file_size for i in infos) > MAX_UNPACKED:
        raise ImportError_("the file is too large to be an application")
    for i in infos:
        name = i.filename
        parts = name.split("/")
        # nothing may land outside the application's own folder
        if (name.startswith(("/", "\\")) or "\\" in name or ":" in parts[0] or ".." in parts
                or (i.external_attr >> 16) & 0o170000 == 0o120000):
            raise ImportError_(f"the file contains an unsafe path: {name}")
    try:
        manifest = json.loads(z.read("application.json"))
    except KeyError:
        raise ImportError_("not an application: there is no application.json in the file")
    except ValueError:
        raise ImportError_("not an application: its application.json cannot be read")
    if not isinstance(manifest, dict) or manifest.get("format") != FORMAT:
        raise ImportError_(f"the application is in format {manifest.get('format') if isinstance(manifest, dict) else '?'}; "
                           f"this viewer reads format {FORMAT}")
    return manifest


def import_application(apps_root, src, name_hint, existing="ask", backup_root=None):
    """Unpack the archive `src` (a path or binary file) into `apps_root`.

    The application's id is `name_hint` (the file's name) made safe, or its
    manifest name. If that application is already here:
      existing="ask"      nothing is written; says so, and whether it is the
                          same application (same uid) or another by that name
      existing="replace"  the one here is moved to `backup_root` first, never deleted
      existing="copy"     imported beside it under a free id, with a uid of its own
    Returns {"id", "version"} or {"exists": True, "id", "name", "version",
    "same": same uid, "identical": same contents}.
    """
    import shutil
    import time
    import zipfile
    try:
        z = zipfile.ZipFile(src)
    except zipfile.BadZipFile:
        raise ImportError_(f"not a {EXTENSION} file")
    with z:
        manifest = inspect_archive(z)
        version = version_of_archive(z)
        app_id = id_from_file_name(name_hint) or slug(manifest.get("name", "")) or "application"
        target = os.path.join(apps_root, app_id)
        fork = False
        if os.path.exists(target):
            if existing == "ask":
                try:
                    here = read_manifest(target)
                except (OSError, ValueError):
                    here = {}
                return {"exists": True, "id": app_id, "name": here.get("name", app_id), "version": version,
                        "same": bool(manifest.get("uid")) and here.get("uid") == manifest.get("uid"),
                        # the file holds exactly what is here already: nothing to import
                        "identical": version_of(target) == version}
            if existing == "replace":
                if not backup_root:
                    raise ImportError_("no place to keep the application being replaced")
                os.makedirs(backup_root, exist_ok=True)
                shutil.move(target, os.path.join(backup_root, f"{app_id}-{time.strftime('%Y%m%d-%H%M%S')}"))
            else:                                   # copy: a free id beside it
                k = 2
                while os.path.exists(os.path.join(apps_root, f"{app_id}-{k}")):
                    k += 1
                app_id, fork = f"{app_id}-{k}", True
                target = os.path.join(apps_root, app_id)
        staging = target + ".importing"
        if os.path.exists(staging):
            shutil.rmtree(staging)
        try:
            z.extractall(staging)
            if fork:                                # kept beside the original: it is another application now
                manifest["uid"] = str(uuid.uuid4())
                with open(os.path.join(staging, "application.json"), "w", encoding="utf-8") as f:
                    f.write(dumps(manifest))
            for sub in ("steps", "grippers", "items"):
                os.makedirs(os.path.join(staging, sub), exist_ok=True)
            os.rename(staging, target)
        except BaseException:
            shutil.rmtree(staging, ignore_errors=True)
            raise
    return {"id": app_id, "version": version}
