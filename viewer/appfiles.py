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
         "the agents' notes; materials/ what was attached in the chat. Every pose is in the table frame, "
         "so the application does not depend on which robot runs it; 'robot' names the one it is set up "
         "on now.")
LAYOUT_ABOUT = ("What stands where: each fixture and part is a placement of an item (items/<item>/item.json "
                "says what the thing is; here is only which one, where, and what is particular to this "
                "placement), plus the stands of the tool rack and the gripper each one holds. Poses are in "
                "the table frame.")


def new_application(app_dir, name, like_dir):
    """An empty application on the same robot as the one in `like_dir`."""
    old = read_manifest(like_dir)
    os.makedirs(app_dir)
    for sub in ("steps", "grippers", "items"):
        os.makedirs(os.path.join(app_dir, sub))
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
        "grippers": [],
        "items": [],
        "mounted_tool": None,
        "loop": {"name": name, "steps": []},
    }
    layout = {"about": LAYOUT_ABOUT, "fixtures": [], "parts": [], "tool_rack": {"stands": []}, "unplaced_parts": []}
    for fn, obj in (("application.json", manifest), ("layout.json", layout)):
        with open(os.path.join(app_dir, fn), "w", encoding="utf-8") as f:
            f.write(dumps(obj))
