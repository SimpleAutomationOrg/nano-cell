# Agent guide

You are a coding agent working in (or asked to install) **nano-cell**, a
simulated robot cell installed on the user's computer: a viewer in the
browser with a local server behind it for the agents, files and tools. This file is your contract: how to
install it, how to verify it, and how to add or edit steps without
re-learning this project's hard-won rules.

If you are Claude Code, also read `CLAUDE.md` (loaded automatically) —
it holds the same working rules in condensed form.

## Install (what to do when the user says "install")

1. Clone the repository and enter it.
2. Check prerequisites: `python3 --version` (3.8+) and Node 18+.
3. `npm install` — REQUIRED: MuJoCo (WebAssembly) is the geometry and
   physics engine; without it steps are disabled (the scene still
   renders, and the panel says so).
4. Start the viewer: `python3 viewer/serve.py` (background). It serves
   the repo root on port 8742 (pass another port as the first argument
   if taken), opens the browser, and live-reloads on any file change.
5. Verify: run `./scripts/check.sh` (should end `check: OK`), then in
   the viewer select the `pick-place-case` step in the steps dock under the 3D view and press its ▶ —
   it must end with **step done** in the status line: the arm picks a
   case from the 45° stack and inserts it into the holder pocket.
6. Report to the user: the viewer URL, check results, and that editing
   any file hot-reloads the page.

There is no build step. Do not add bundlers, package installs, or
frameworks during installation.

## The architecture in one paragraph

A **cell is data**, in two halves. A **robot**
(`cell_fr3/`: `robot.json`, flange-stack `meshes/`, and the arm's link
meshes in `arm/` — the whole design of the cell): arm and mount, table,
enclosure, flange stack, cameras, IO. An **application**
(`applications/<name>/`): one job and its environment, in one folder
that can be copied, saved and shared — grippers, tool rack, fixtures,
parts, steps (see "The application folder"). `viewer/cell-data.js`
puts the application's files together, composes it onto the robot into
the cell everything else works on, and refuses a robot that lacks what
the application needs (an IO line a gripper switches, a tool changer).
The **planner**
(`viewer/planner.js`, pure, node-testable) turns step commands into
collision-checked joint paths on the MuJoCo backend
(`viewer/mj-world.js`; obstacles box-decomposed by `viewer/boxify.js`,
which also supplies the measurement points and corridor heights). The **host** (`viewer/cell-host.js`)
animates them in the three.js scene and owns run state. Tools not on
the arm rest in their rack stands (`changer.stands[].tool_id`) and are
obstacles like any fixture; a move that deliberately reaches one names
the tool id in `ignore`. **Steps** live
in `applications/<application>/steps/`, one file each: `<name>.ts` says its
name and tool and holds a typed async function against the cell API
(`viewer/cell.d.ts`). The server (`viewer/serve.py`) also exposes
`/__applications`, `/__steps?app=<application>` (step list) and
`/__reload` (live reload).

## The application folder

```
applications/<name>/
  application.json     the manifest: format, uid, name, description, authors,
                       robot, the grippers and items it has, mounted_tool,
                       and the loop (name + ordered steps)
  layout.json          what stands where: fixtures, parts, the tool rack
  grippers/<id>/       gripper.json + <id>.glb + <id>.collision.stl
  items/<id>/          item.json + <id>.glb + <id>.collision.stl
  steps/<name>.ts      one file per step
  robots/<robot>.json  what was taught on one robot (joint values)
  print/               the CAD (STEP) the items are made from
  notes/               the agents' notes: plan.md, design.md, purchasing.md, budget.md
  materials/           what the user attached in the chat (git-ignored)
  chats/<agent>.json   the conversations with the agents (git-ignored)
```

- **`application.json` is small on purpose**: it answers "what is this"
  without loading geometry. `format` is the format's version (the
  viewer refuses one it does not read); `uid` identifies the
  application wherever its folder goes; `grippers` and `items` list
  its folders explicitly, in order — a folder that is not listed is not
  loaded, and a test fails for it.
- **What a thing IS, once; where it stands, as often as needed.**
  `items/<id>/item.json` describes an item (name, `kind` fixture or
  part, mesh, `mesh_source`, mass, features such as a pocket).
  `layout.json` only places items: `{ "id": "front_case_1", "item":
  "front_case", "pose_table": … }`, plus what is particular to that
  placement (its name, what it lies `on`, a note). Six front cases are
  one item and six placements. Never repeat a mesh, a mass or a
  `mesh_source` in the layout.
- **A gripper or an item is a self-contained folder**: its description
  and its meshes side by side, mesh named by file name only. Copying
  the folder into another application (and listing it) moves it whole.
- **JSON style**: one key per line, a list of plain values on one line
  (`"xyz_m": [0.9, 0.087, 0.0]`) — a moved fixture is a one-line diff.
  Keep it that way when editing by hand.
- **Steps import the cell API by name**: `import type { CellAPI, Ctx,
  Entry } from 'nano-cell'` (mapped in `tsconfig.json`), never by a
  relative path into the engine — an application must work wherever
  its folder lives.

**One file to share**: **Export** in the right panel packs the open
application's whole folder into `<name>-<date>-<time>.microfactory`
(an ordinary zip under its own extension, `application.json` first) —
to keep or to send to someone. The name says when it was saved, to the
second, in local time (`case-assembly-20261128-143005.microfactory`),
so files sort by name in the order they were saved. **Import** takes such a file, checks it (safe paths only, a
manifest in a format this viewer reads), unpacks it into
`applications/` under the file's name (without the date and time) and
opens it. A file that holds exactly what is already here is recognised
(by a hash of the contents) and not imported again. If that
application is already here it asks: replace (the one here is moved to
`.backups/applications/`, never deleted) or import as a separate copy
(which gets a `uid` of its own). `viewer/appfiles.py` does both.

An application must stay movable to another robot. So:

- Everything an application places is in the **table frame**; it holds
  no arm data, no IO definitions and no joint values. Grippers name the
  IO lines they need (`vacuum.output`); the robot defines them.
- Joint-space values taught on one robot (tool-stand joint poses, the
  changer's unlock interlock) sit in `robots/<robot>.json` and do not
  follow the application to another robot.
- `"robot"` in application.json is the robot it is set up on now. To
  look at it on another one: `?robot=<name>` in the viewer URL.
- The viewer's right panel lists the applications; picking one opens it
  (`?app=<name>`; without it, the one opened last). **New** makes an
  empty application on the same robot — a manifest and a layout with
  nothing in them, empty `grippers/`, `items/` and `steps/` — and opens
  it; fill it from there.
- A robot is a folder in the repository root named after it (`cell_fr3/`);
  a new robot is a new such folder with its `robot.json`.
  `test/cell-data.test.mjs` holds these rules.

## Geometry comes from the print files

The STEP files in `applications/<name>/print/` (what the parts are actually printed or
machined from) are the source of truth for geometry. The meshes in
`applications/<name>/items/<item>/` are generated from them with
`scripts/step-to-mesh.mjs`, which writes the visual and the collision
mesh from the same triangles; `mesh_source` in the item's `item.json` says which
file and body (path relative to the application). Never hand-edit or simplify a mesh, and when physics
says a part does not fit, compare the mesh with its STEP before
believing it.

**A part that is designed here** (a nest, a tray, a stand — nobody handed
over CAD for it) is modelled in code: `print/<part>.model.mjs` builds the
solids with the replicad API (Open CASCADE as WebAssembly: cylinders,
bores, fillets, booleans) and `node scripts/model-step.mjs
applications/<name>/print/<part>.model.mjs` writes `print/<part>.step`
beside it, printing each body's size and volume to check. The model stays
next to its STEP; change the model and rebuild, never edit the STEP. From
there it is a print file like any other. Two more tools read exact
geometry (`scripts/cad-kernel.mjs` is what the three share):
`scripts/inspect-step.mjs <file.step> [--fit <other.step>]` measures a
STEP — sizes, bores and bosses, flat faces, and the gap or interference
between two files as placed — and `scripts/look.mjs <file.step ...|
applications/<name>> <out.png>` draws a part, or an application's whole
layout, as four shaded views at one scale, so a design can be looked at
(an agent opens the PNG with Read). `scripts/poly-step.mjs` is an
earlier, simpler writer for solids with flat faces only; `dippackage`'s
generic parts are drawn with it (`print/make-prints.mjs`). New parts
use `model-step.mjs`.

**A new suction-cup gripper** is built with `scripts/cup-tool.mjs
<cup.step> <reference gripper folder> <new gripper folder>`: the cup comes from its print file,
the body (changer half, arm, nozzle) from an existing cup tool, and the
cup's mount face is seated on the nozzle's end, on its axis. The script
prints the tool's lip frame (`vacuum.lip_centre_flange_m`,
`lip_normal_flange`, radii) for its `gripper.json`; list the new id
under `grippers` in application.json. Give such a tool
`"collision_detail": "coarse"` — its collision mesh is the full print
geometry, and boxed exactly it is tens of thousands of boxes. Then put
its id in a stand of `tool_rack` in layout.json (`tool_id`).

## What physics is for

Physics is there for what is meaningful to see: a released part
dropping and settling, a hand push, a touch descent. Fine fits that add
nothing to the picture — a screw in its hole in the feeder disc — are
NOT simulated: place them from measured geometry and leave them. Do not
spend effort making such contacts settle.

## The loop

An application has ONE loop: `"loop"` in its `application.json` names
it and lists, in order, the steps that make up one cycle of work (front
case, then back case). When you add a step that belongs to the cycle,
add it there in its place. Steps not in the loop still exist and run on
their own (a fallback, a demo).

The page is three columns: the chat on the left, the 3D view with the
steps dock under it in the middle, the cell panel on the right. The
viewer shows the loop as the **steps dock** under the 3D view, in one
column: the loop's steps in order, and below them the steps not in the
loop. Dragging a step reorders the loop or moves the step in or out of
it, and the server writes the new order into the manifest (nothing but
the loop's `steps` changes). Each
row's ▶ runs that step alone; **▶ Run loop** runs the loop's steps
back to back (status line ends "loop done"): the arm starts at the
first step's `entry`, and each later step carries on from where the
one before left the arm and the parts — so a step in the loop must not
assume it starts from its own `entry`.

## Adding a new step

1. Create one file, `applications/<application>/steps/<name>.ts`. It
   starts by saying what it is called and which gripper it uses (plain
   string literals — the server reads these two lines to list the step):
   ```ts
   export const name = 'Human-readable name';
   export const tool = 'rcup16_p0';
   ```
2. Write the rest by **copying the matching recipe**, not from scratch:
   - `recipes/suction-pick-place.md` — vacuum-cup picking and flat
     set-down.
   - `recipes/holder-insertion.md` — placing a held part INTO a pocket
     (alignment, centring, touch descent).
   The step imports types from `viewer/cell.d.ts`; hover any API call
   for its contract. It exports `entry` (a safe standalone
   start pose, tool pointing down, mid-cell) and a default async
   function `(cell, ctx) => Promise<void>`.
3. The step appears in the viewer's steps dock automatically, under
   "Not in the loop" (the server scans the application's `steps/`). Run
   it with its ▶ while
   iterating; every run starts from `entry`.

## Editing existing steps or the engine

- Follow the rules in `CLAUDE.md` (measured geometry only; steps
  state intent; `ignore` lists name exactly what a move deliberately
  touches; tip speeds in m/s). The recipes explain the reasoning.
- New motion behavior goes in `viewer/planner.js` (pure functions),
  never in `cell-host.js` (animation and scene only). That keeps it
  testable under node.
- **After any change** to `viewer/`, a robot or an application: run
  `./scripts/check.sh` AND re-run the pick-place step in the viewer to
  "step done" before telling the user the change works. The checks
  encode every regression this project has already paid for once.
- When you fix a motion bug, add an assertion to
  `test/motion.test.mjs` in the same change.

## The chat and its agents

The left column of the viewer is a chat with the project's **agents**: a
narrow bar of profiles, and beside it the conversation with the one
picked. Each agent is a Markdown file in `agents/`:

| file | agent | what it does | keeps |
| --- | --- | --- | --- |
| `lead-engineer.md` | Lead engineer | turns a goal into tasks and says who does each | `notes/plan.md` |
| `cad-designer.md` | CAD designer | print files, meshes, fixtures, parts, placement | `notes/design.md`, `layout.json`, `items/`, `grippers/` |
| `programmer.md` | Programmer | steps, the loop, the viewer's code | `steps/`, the loop |
| `component-buyer.md` | Component buyer | finds components to buy (web search) | `notes/purchasing.md` |
| `accountant.md` | Accountant | what the application costs | `notes/budget.md` |

(the "keeps" files live in the application's folder). A file starts with
a header — `name`, `role` (one line under the name), `initials`, `color`,
`order`, `hint` (shown in an empty conversation) and optionally `tools`
and `hands_off`
— and the text below it is the agent's description, used as its
instructions. To add an agent, add a file; to change how one behaves,
edit its description (it is re-read with every message).

How it runs (`viewer/chat.js`, `viewer/chat.py`, served by `serve.py`
under `/__chat/*`): every message runs the Claude Code CLI (`claude`,
installed and signed in) headless in the repository root, continuing
that agent's own conversation. There is one conversation per agent
**per application**, and it is kept on disk in
`applications/<application>/chats/<agent>.json` — so it survives page
reloads and server restarts, belongs to the application it is about,
and goes along in an export. What lets the agent *remember* it (its
CLI session) is local to this machine, in `.chat-sessions.json` at the
repository root. When an agent has a saved conversation but no session
for it — the application was imported on another machine, or the
session has expired — the saved conversation is handed to it as
background with the next message, so it carries on from where it ends. **New** forgets the one shown, on disk too. Both
are git-ignored. Every agent
may read, search and edit files and run `./scripts/check.sh`; `tools:`
in its header can add only what `EXTRA_TOOLS` in `chat.py` lists (web
search for the buyer; `Bash(node:*)`, the whole geometry pipeline, for
the CAD designer only). Agents
cannot see or drive the viewer.
The endpoints answer only to the page's own origin.

**Handing work over**: an agent whose header says `hands_off: true`
(the Lead engineer) gives tasks to colleagues itself, by ending its
message with a ```` ```handoff ```` block: `[{"to": "<agent id>",
"task": "..."}]`. The server then sends each task to that agent's own
chat as a new message — the colleague gets only the task text, nothing
of the sender's conversation — one after another in the order listed,
each starting when the one before has finished; a failure stops the
rest. The sender's chat shows who was handed what and when they
finished (click to open that chat), the colleague's chat shows the task
as "from the Lead engineer", and the replies are given to the sender
with the user's next message. Other agents' handoff blocks do nothing.

**Questions with options**: when an agent needs a decision and can name
the likely answers, it ends its message with a ```` ```questions ````
block (JSON: questions, each with 2–4 options, optionally a
description, `"recommended": true` on the one it would choose, and
`"multi": true` where several may be picked). The chat shows each
question as a card with its options as buttons, the recommended one
first and marked, plus a field for an answer in the user's own words;
**Send answers** sends them as one message. The format is given to
every agent in `chat.py`'s brief; `viewer/ask.js` reads it.

**Attachments**: the user can attach files to a message — the `+`
button, pasting (a screenshot) or dropping them on the conversation.
They are saved when the message is sent, in
`applications/<application>/materials/` (never over an existing file),
and their paths are given to the agent, which opens them itself. That
folder is git-ignored: photos and datasheets stay on this machine. A
STEP a part is really made from belongs in `print/`, not there.

## Debugging

- The status line shows the running command with elapsed time; the
  browser console carries the full `[step]` log including per-command
  durations and planner decisions (which transfer candidate won, what
  a touch move landed on).
- Show panel → **collision points** (orange: the obstacle world every
  query runs against, at live poses) and **collision capsules** (blue:
  the arm/tool shapes that do the hitting). Every collision message is
  "a blue capsule met orange points" — with both on, you can see it.
- A rejected move's error names the colliding link, the item, and the
  position, and suggests the fix (`transitTip` to route around, or the
  exact `ignore` id when the contact is deliberate).
- **Moving the camera**: drag to orbit, or fly — all relative to the
  camera: `W`/`S` up and down the screen, `A`/`D` left and right,
  `E`/`Q` forward and back along the view, `Shift` for
  3x speed. Flight speed scales with the orbit distance, so you crawl
  when nose-up to a part. After a flight the next drag (or scroll)
  re-anchors the orbit pivot on the surface at the centre of the view,
  so you always orbit around what you are looking at. `F` frames the selected part, or returns to
  the overview when nothing is selected — that is the way back if you
  fly off into the void.
- **Pushing parts by hand**: click a part to select it (yellow box),
  then each key press is a real capped-force physics push — arrows
  push horizontally (camera-relative, 8 N), `Z` presses down firmly
  (30 N, seats a jammed part), `X` lifts (8 N), `Shift` makes 0.1 mm fine
  steps, `Esc` deselects. The status line reports how far it actually
  moved; "blocked" means a wall or fit stopped it. `PgDn`/`PgUp` work
  too; WASD is deliberately unused. From the console,
  `selectPart('front_case_1')` selects programmatically.
