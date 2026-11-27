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
   the viewer select the `pick-place-case` step and run all segments —
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
in `applications/<application>/steps/<name>/`: a `step.json` naming the tool and segment order,
and `segments/*.ts` — typed async functions against the cell API
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
  look at it on another one: `?robot=<name>` in the viewer URL
  (`?app=<name>` picks the application; default is the first).
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

## What physics is for

Physics is there for what is meaningful to see: a released part
dropping and settling, a hand push, a touch descent. Fine fits that add
nothing to the picture — a screw in its hole in the feeder disc — are
NOT simulated: place them from measured geometry and leave them. Do not
spend effort making such contacts settle.

## Adding a new step

1. Create `applications/<application>/steps/<name>/step.json`:
   ```json
   { "name": "Human-readable name",
     "tool": "rcup16_p0", "segments": ["10_first.ts", "20_second.ts"] }
   ```
2. Write segments by **copying the matching recipe**, not from scratch:
   - `recipes/suction-pick-place.md` — vacuum-cup picking and flat
     set-down.
   - `recipes/holder-insertion.md` — placing a held part INTO a pocket
     (alignment, centring, touch descent).
   Segments import types from `viewer/cell.d.ts`; hover any API call
   for its contract. Each segment exports `entry` (a safe standalone
   start pose, tool pointing down, mid-cell) and a default async
   function `(cell, ctx) => Promise<void>`.
3. The step appears in the viewer's dropdown automatically (the server
   scans the application's `steps/`). Run each segment alone with its ▶ button while
   iterating; `entry` is what makes that possible.

## Editing existing steps or the engine

- Follow the rules in `CLAUDE.md` (measured geometry only; segments
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

## The chat panel

The viewer has a **Step agent** panel (top right): the user types a
request and a coding agent edits the steps, the page reloading on each
save. It is `viewer/chat.js` (the panel) and `viewer/chat.py` (served by
`serve.py` under `/__chat/*`): every message runs the Claude Code CLI
(`claude`, installed and signed in) headless in the repository root,
continuing one conversation. The conversation is kept in the server, so
it survives page reloads; **New** forgets it. The agent may read, search
and edit files and run `./scripts/check.sh`; it cannot see or drive the
viewer, so it asks the user to run the step. The endpoints answer only
to the page's own origin.

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
