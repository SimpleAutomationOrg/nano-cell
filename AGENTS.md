# Agent guide

You are a coding agent working in (or asked to install) **microfactory**, a
simulated robot cell installed on the user's computer: a viewer in the
browser with a local server behind it for the agent, files and tools. This file is your contract: how to
install it, how to verify it, and how to add or edit steps without
re-learning this project's hard-won rules.

If you are Claude Code, also read `CLAUDE.md` (loaded automatically) —
it holds the same working rules in condensed form.

## Install (what to do when the user says "install")

The user's whole request may be one line — `install <this repository's
URL>`. That is enough: do every step below without asking, and stop only
where a step says to.

1. Clone the repository and enter it. Where: the folder the user named;
   otherwise `microfactory` in the current folder if that is a place for
   projects, else `~/microfactory`. If the folder already holds a clone,
   `git pull` it instead of cloning again. Run every later step from
   inside the clone.
2. Check prerequisites: `python3 --version` (3.8+) and Node 18+. If one
   is missing, say which and how to get it, and stop — do not install
   system software yourself.
3. `npm install` — REQUIRED: MuJoCo (WebAssembly) is the geometry and
   physics engine; without it steps are disabled (the scene still
   renders, and the panel says so).
4. Start the viewer: `python3 viewer/serve.py` (background). It serves
   the repo root on port 8742 (pass another port as the first argument
   if taken), opens the browser, and live-reloads on any file change.
5. Verify: run `./scripts/check.sh` (should end `check: OK`). If you can
   drive a browser, also press ▶ on the first step of the loop in the
   steps dock under the 3D view — it must end with **step done** in the
   status line: the arm picks a case from the 45° stack and inserts it
   into the holder pocket. If you cannot, ask the user to press it.
6. Make the desktop app, if you are Claude and have the **Artifact** tool
   (skip this step otherwise, and say that the browser is the way to use
   it): read `.claude/skills/publish-app/SKILL.md` in the clone and follow
   it. On a computer that did not publish the app before, this makes a
   NEW private artifact in the user's own account — the one named in
   `artifact.json` belongs to the project's author and cannot be written
   to, which the skill handles. Nothing is shared with anyone. The app
   asks for full access to the computer (it runs the local server, the
   agent and the geometry tools); the user allows that themselves, in the
   app's own dialog, when it first starts.
7. Report to the user, briefly: where the clone is; the viewer's URL and
   that editing any file hot-reloads the page; the check result; and, if
   step 6 ran, the artifact's link with how to install it (open it in the
   Claude desktop app → the artifact's menu → **Install as app**; on first
   start choose the clone as the workspace folder, or **Create new**).
   Also what the chat assistant needs: the `claude` CLI installed and
   signed in on this computer.

There is no build step. Do not add bundlers, package installs, or
frameworks during installation.

## The installable app

microfactory is delivered as a Claude artifact that **installs as a desktop
app** (the artifact declares the `desktop` capability; in the Claude
desktop app its menu offers "Install as app"). The step that makes it is
defined once, as the project skill **`/publish-app`**
(`.claude/skills/publish-app/SKILL.md`): check, build
(`node scripts/build-artifact.mjs` → `dist/artifact/`), publish with the
Artifact tool — the first time as a new artifact, afterwards as a new
version of it. Which artifact that is: the one named in `artifact.json`
for the project's author; for anyone else who installed from the
repository, their own, named in `artifact.local.json` (not tracked) — an
app with full access can only be used by the organization that published
it, so every installation publishes its own.

How the installed app works:

- **The artifact holds the page and a workspace pack.** The page is
  `viewer/*.js` and the markup. The pack (`ws/files.json` + the meshes, as
  base64 text, in `ws/b/`) is every file a new workspace is made of: the local programs
  (`viewer/*.py`), `guides/`, `recipes/`, `scripts/`, the robot
  (`cell_fr3/`) and the starter application(s) named in `artifact.json`
  (`"starter"`). What may go in is decided in
  `scripts/build-artifact.mjs` and nowhere else: only files tracked by
  git; of `applications/`, only the starter; text as text; a mesh only
  when `scripts/mesh-check.mjs` accounts for every byte of it as geometry
  (`scripts/clean-mesh.mjs` strips the notes tools leave in a GLB).
  Attachments, conversations, uncommitted CAD and other applications
  never go in. Nothing third-party is carried as code: three.js and
  MuJoCo's module load from the CDN, the tools (MuJoCo's compiled
  physics, the CAD kernel) come from npm when the workspace is made. The
  build writes `dist/artifact-report.txt`, the list of what went in —
  read it before publishing.
- **The workspace** is a folder on the person's computer. On first start
  the app asks where it should be; **Create new** writes the pack into a
  new or empty folder and runs `npm install` there
  (`viewer/workspace-install.js`; needs node and python3, no account
  anywhere). It records what it wrote in `.microfactory.json`, and when a
  newer version of the app opens the folder it updates the files the
  person has not changed, keeps the ones they have, and does not bring
  back a starter application they deleted. A checkout of this repository
  (no `.microfactory.json`) also works as a workspace and is never
  written to by the app.
- **The page cannot open a network connection to the computer**, so
  `viewer/desktop.js` (the installed app's entry, in place of `app.js`
  and `chat.js`) starts the engine there as a child process —
  `python3 viewer/serve.py --stdio` — and `viewer/desktop-bridge.js`
  turns every request the page makes for the cell into a JSON line
  through its pipes. The viewer and the chat run unchanged on top.
- **A page reload ends that process**, and any agent run under it, so
  the installed app reloads for a file change only when no agent is
  working.
- **No browser dialogs**: `prompt()`, `confirm()` and `alert()` do
  nothing in an artifact; use `viewer/dialogs.js`. A file for the user is
  written to their Downloads folder (`window.microfactoryDesktop.saveFile`), not
  offered as a download link.

### The shareable edition

The installed app works only for the organization that published it (full
access is granted to nobody else). So there is a SECOND artifact, built
from the same page, that asks for no access to anyone's computer and can
be given to anybody as a link: `node scripts/build-artifact.mjs --share`
→ `dist/share/`. It declares `sample` (with images) and `downloads`, no
`desktop`, and carries no desktop manifest. It is published by the same
skill as a separate artifact with its own address (`artifact.json` →
`"share"`), never over the installable one.

There is no workspace folder and no local server behind that page. Its
entry, `viewer/share.js` (in place of `viewer/desktop.js`), puts the same
things behind the viewer from what a page has:

- **The files are a pack plus the viewer's own changes.** The share pack
  holds only what the page reads — `cell_fr3/`, the starter
  application(s), `guides/`, `recipes/`, `viewer/cell.d.ts` — with the
  meshes gzip'd before the base64. `viewer/page-fs.js` lays the person's
  changes over it; they are kept in that browser's IndexedDB
  (`viewer/page-store.js`), in memory where the browser gives none (the
  page then says that nothing is kept). **Export is the copy that lasts**;
  "Reset to original" in the application panel drops the changes to an
  application the page came with.
- **The server is the page.** `viewer/page-engine.js` answers every
  request the viewer makes (`/__applications`, `/__steps`, `/__loop/save`,
  `/__run/…`, `/__chat/…`, `/__reload`, files) with the statuses, shapes
  and texts of `serve.py`, through the same `engineFetch` the installed
  app uses. `test/page-engine.test.mjs` runs both against the same
  requests: when an endpoint of `serve.py` changes, change the page engine
  with it. `.microfactory` files are read and written in the page
  (`viewer/zip.js`), so an application moves between the editions.
- **The assistant is asked through the artifact's `sample` function**, on
  the viewer's own account (`viewer/page-agent.js`), with the page's
  functions as its tools (`viewer/page-tools.js`: read, list, write and
  edit files of the open application, run steps in the viewer, measure the
  scene, undo) and `viewer/page-brief.js` as its standing instructions —
  the same guides, minus what needs a computer. Opened outside Claude
  there is no assistant, and the chat says so.
- **MuJoCo's compiled physics is carried** (`ws/mujoco.wasm.txt`, from
  `node_modules` at build time): there is no workspace to `npm install`
  it into, and a page may not fetch it from the CDN. It is the one
  third-party file either artifact carries; the module that runs it still
  comes from the CDN, at exactly that version.
- **A file for the user** goes through the artifact's `downloads`
  function, which saves only kinds of file it knows: an export is saved
  as `<name>.microfactory.zip`, and Import takes either name.
- **Not in this edition**: the CAD pipeline (STEP to mesh, modelling), web
  lookups, changing the engine, git. The assistant says so when asked.

`window.microfactoryDesktop` is set there too, with `kind: 'page'` — it
selects the same branches of `app.js` as the installed app (the
application to open is remembered and the page reloaded, MuJoCo's module
from the CDN with the physics as bytes, export through `saveFile`, a
reload that waits for the assistant), and `kind` marks the few places
where the words differ because there is no folder and no terminal.

Keep the viewer working ALL THREE ways: served by `serve.py` in a
browser, installed, and shared. Code that must differ asks
`window.microfactoryDesktop` (absent in a browser; `kind: 'page'` in the
shareable edition). Every `viewer/*.js` is shipped in both artifacts
(bar the installed app's own two modules, left out of the shareable one).
What cannot be tried from here — the hosted frame's restrictions, the
real `sample` and `downloads` — has to be tried by opening the published
page; `test/share.test.mjs` covers the build, the page engine over the
built pack, and a step of the starter run to its end on it.

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
  notes/               the agent's notes: plan.md, design.md, purchasing.md, budget.md
  materials/           what the user attached in the chat (git-ignored)
  chats/assistant.json the conversation with the agent (git-ignored)
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
  Entry } from 'microfactory'` (mapped in `tsconfig.json`), never by a
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

### The kit: what a new application starts with

The **New** button makes an application that already has the robot's
basic grippers standing in the tool rack. They come from the robot's kit,
`cell_fr3/kit/`: `kit.json` (which grippers and items, the rack stands'
placements and the `tool_rack` stands) with `grippers/<id>/` and
`items/<id>/` beside it, in the same shape as in an application.
`new_application` (`viewer/appfiles.py`) copies them into the new folder
and lists them in its manifest and layout — a copy, so the application
stays one folder that exports whole and can change or drop any of them.

- To add a gripper to the basic set: put its folder in `kit/grippers/`,
  add its id to `kit.json` `grippers`, and give it a stand (a `rack_stand`
  placement in `fixtures` and an entry in `tool_rack.stands`).
- A kit gripper carries no `mesh_source`: the new application has no CAD
  for it.
- Applications that exist already are not changed by editing the kit.

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

## The chat, its agent and the guides

The left column of the viewer is one chat with one agent, about the
application that is open. There are no separate roles to pick: the
agent does the whole job, and **how each kind of work is done is
written down in `guides/`**:

| file | what it is |
| --- | --- |
| `guides/agent.md` | the agent itself: who it is and how it works in general |
| `guides/planning.md` | turning a goal into a plan (`notes/plan.md`) |
| `guides/geometry.md` | designing parts, CAD to meshes, placing things (`notes/design.md`) |
| `guides/steps.md` | writing and changing steps and the loop (with `recipes/`) |
| `guides/buying.md` | finding components to buy (`notes/purchasing.md`) |
| `guides/costing.md` | the budget (`notes/budget.md`) |

`agent.md` starts with a header — `name`, `hint` (shown in an empty
conversation) and `tools` — and its text becomes the agent's standing
instructions. Each guide's header says its `title`, `when` it applies
and its `order`; the agent is given that list and told to **read the
guide that fits before starting work of that kind**, so a guide's text
is read when needed, not carried in every message. To change how a kind
of work is done, edit its guide; to add a kind of work, add a guide
with a header. Both take effect with the next message.

How it runs (`viewer/chat.js`, `viewer/chat.py`, served by `serve.py`
under `/__chat/*`): every message runs the Claude Code CLI (`claude`,
installed and signed in) headless in the repository root, continuing the
conversation. There is one conversation **per application**, kept on
disk in `applications/<application>/chats/assistant.json` — so it
survives page reloads and server restarts, belongs to the application it
is about, and goes along in an export. What lets the agent *remember* it
(its CLI session) is local to this machine, in `.chat-sessions.json` at
the repository root. When there is a saved conversation but no session
for it — the application was imported on another machine, or the
session has expired — the saved conversation is handed to the agent as
background with the next message, so it carries on from where it ends.
**New** forgets the conversation, on disk too. Both files are
git-ignored. The agent may read, search and edit files and run
`./scripts/check.sh`; `tools:` in `agent.md` can add only what
`EXTRA_TOOLS` in `chat.py` lists (web search, and `Bash(node:*)`, the
geometry pipeline). It cannot see or drive the viewer. The endpoints
answer only to the page's own origin.

**Questions with options**: when an agent needs a decision and can name
the likely answers, it ends its message with a ```` ```questions ````
block (JSON: questions, each with 2–4 options, optionally a
description, `"recommended": true` on the one it would choose, and
`"multi": true` where several may be picked). The chat shows each
question as a card with its options as buttons, the recommended one
first and marked, plus a field for an answer in the user's own words;
**Send answers** sends them as one message. The format is given to
the agent in `chat.py`'s brief; `viewer/ask.js` reads it.

**Attachments**: the user can attach files to a message — the `+`
button, pasting (a screenshot) or dropping them on the conversation.
They are saved when the message is sent, in
`applications/<application>/materials/` (never over an existing file),
and their paths are given to the agent, which opens them itself. That
folder is git-ignored: photos and datasheets stay on this machine. A
STEP a part is really made from belongs in `print/`, not there.

## Running a step from outside the page

The chat's agent (or anyone in a terminal) runs steps in the real
simulation with `node scripts/run-step.mjs <application> <step> […]`
(`--loop`, `--headless`, `--last-failure`, `--keep`, `--shot`, `--slow`,
`--timeout N`, `--json`). The
run happens in the viewer that is open on that application, so the user
watches it; the command prints the outcome, the log, the parts that moved
and where they are, what is held, the IO, the joints, and with `--shot`
the paths of two pictures (`.runs/<application>.png`, the whole cell, and
`.runs/<application>-close.png`, framed on the tool and the parts that
moved — taken with cameras of their own, not the user's view).

Three more ways to use it:

- `--headless` runs the steps in node, with no window
  (`scripts/headless-cell.mjs`: the same `planner.js`, `mj-world.js` and
  `cell-host.js`, on the same scene objects, built without a picture —
  `three` is a dev dependency for this). Same result as the viewer, in
  about a second; no pictures. `test/loops.test.mjs` runs every
  application's loop this way in `./scripts/check.sh`, and pins one step
  to the numbers the viewer gives for it. `headless-cell.mjs` mirrors
  `main()` in `viewer/app.js` (arm chain, capsules, tool mounting): when
  one changes, change the other.
- `--last-failure` prints the record of the last run that failed in the
  viewer, whoever started it. The page posts it (`/__run/record`) and the
  server keeps it with the application:
  `applications/<app>/runs/last-failure.json` and two pictures beside it
  (the folder is git-ignored; one record, replaced by the next failure).
- A job belongs to the page that took it only while that page keeps
  saying so (`/__run/alive`, every 3 s): a job that went to a connection
  the browser had dropped, or whose page was reloaded, is given out again
  after 8 s, and a second tab never runs a job the first is working on.

How it travels: the script reads the server's port from `.server.json`
(written by `serve.py` at start) and posts to `/__run/request`;
`viewer/runs.py` holds the job until the page takes it
(`/__run/next`, a long poll from `viewer/agent-run.js`), the page runs it
(`runSteps` in `app.js`) and posts `/__run/result`. One job at a time per
application; no open page means an error, not a wait. The viewer must be
on screen (a hidden tab drops its polls). In the installed app the page
does not reload while the agent works, so a run after a change to the
layout or items says it used the old files (`stale`).

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
