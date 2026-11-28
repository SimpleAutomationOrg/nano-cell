# Agent guide

You are a coding agent working in (or asked to install) **nano-cell**, a
browser-only simulated robot cell. This file is your contract: how to
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
meshes in `arm/` — the whole design of the cell): arm and mount, table, enclosure, flange
stack, cameras, IO. An **application**
(`applications/<name>/application.json`): one job and its environment —
grippers, tool rack, fixtures and parts with meshes + collision meshes —
together with its `print/` files and `steps/`. `viewer/cell-data.js`
composes the two into the cell everything else works on, and refuses a
robot that lacks what the application needs (an IO line a gripper
switches, a tool changer). The **planner**
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

## Robots and applications

An application must stay movable to another robot. So:

- Everything an application places is in the **table frame**; it holds
  no arm data, no IO definitions and no joint values. Grippers name the
  IO lines they need (`vacuum.output`); the robot defines them.
- Joint-space values taught on one robot (tool-stand joint poses, the
  changer's unlock interlock) sit under `taught_on.<robot>` in
  application.json and do not follow the application to another robot.
- `"robot"` in application.json is the robot it is set up on now. To
  look at it on another one: `?robot=<name>` in the viewer URL.
- The viewer's right panel lists the applications; picking one opens it
  (`?app=<name>`; without it, the one opened last). **New** makes an
  empty application on the same robot — `application.json` with no
  grippers, fixtures or parts, an empty `loop.ts`, empty `steps/` and
  `meshes/` — and opens it; fill it from there.
- A robot is a folder in the repository root named after it (`cell_fr3/`);
  a new robot is a new such folder with its `robot.json`; a new application a
  new `applications/<name>/` — copy the existing one as the template.
  `test/cell-data.test.mjs` holds these rules.

## Geometry comes from the print files

The STEP files in `applications/<name>/print/` (what the parts are actually printed or
machined from) are the source of truth for geometry. Meshes in
`applications/<name>/meshes/` are generated from them with
`scripts/step-to-mesh.mjs`, which writes the visual and the collision
mesh from the same triangles; `mesh_source` in application.json says which
file and body (path relative to the application). Never hand-edit or simplify a mesh, and when physics
says a part does not fit, compare the mesh with its STEP before
believing it.

**A new suction-cup gripper** is built with `scripts/cup-tool.mjs
<cup.step> <reference tool> <out>`: the cup comes from its print file,
the body (changer half, arm, nozzle) from an existing cup tool, and the
cup's mount face is seated on the nozzle's end, on its axis. The script
prints the tool's lip frame (`vacuum.lip_centre_flange_m`,
`lip_normal_flange`, radii) for application.json. Give such a tool
`"collision_detail": "coarse"` — its collision mesh is the full print
geometry, and boxed exactly it is tens of thousands of boxes. Then put
its id in a stand of `tool_rack` (`tool_id`).

## What physics is for

Physics is there for what is meaningful to see: a released part
dropping and settling, a hand push, a touch descent. Fine fits that add
nothing to the picture — a screw in its hole in the feeder disc — are
NOT simulated: place them from measured geometry and leave them. Do not
spend effort making such contacts settle.

## The loop

An application has ONE loop: `applications/<application>/loop.ts` names
it and lists, in order, the steps that make up one cycle of work (front
case, then back case). When you add a step that belongs to the cycle,
add it there in its place. Steps not in the loop still exist and run on
their own (a fallback, a demo).

The page is three columns: the chat on the left, the 3D view with the
steps dock under it in the middle, the cell panel on the right. The
viewer shows the loop as the **steps dock** under the 3D view, in one
column: the loop's steps in order, and below them the steps not in the
loop. Dragging a step reorders the loop or moves the step in or out of
it, and the server writes the new order into `loop.ts` (only the
`steps: [...]` list is rewritten — keep comments outside it). Each
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
| `lead-engineer.md` | Lead engineer | turns a goal into tasks and says who does each | `plan.md` |
| `cad-designer.md` | CAD designer | print files, meshes, fixtures, parts, placement | `design.md`, `application.json` |
| `programmer.md` | Programmer | steps, the loop, the viewer's code | `steps/`, `loop.ts` |
| `component-buyer.md` | Component buyer | finds components to buy (web search) | `purchasing.md` |
| `accountant.md` | Accountant | what the application costs | `budget.md` |

(the "keeps" files live in the application's folder). A file starts with
a header — `name`, `role` (one line under the name), `initials`, `color`,
`order`, `hint` (shown in an empty conversation) and optionally `tools`
— and the text below it is the agent's description, used as its
instructions. To add an agent, add a file; to change how one behaves,
edit its description (it is re-read with every message).

How it runs (`viewer/chat.js`, `viewer/chat.py`, served by `serve.py`
under `/__chat/*`): every message runs the Claude Code CLI (`claude`,
installed and signed in) headless in the repository root, continuing
that agent's own conversation. The conversations are kept in the server,
so they survive page reloads; **New** forgets the one shown. Every agent
may read, search and edit files and run `./scripts/check.sh`; `tools:`
in its header can add only what `EXTRA_TOOLS` in `chat.py` lists (web
search for the buyer, `step-to-mesh` for the CAD designer). Agents
cannot see or drive the viewer, and cannot message each other — the
Lead engineer writes a task so that the user can paste it to the right one.
The endpoints answer only to the page's own origin.

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
