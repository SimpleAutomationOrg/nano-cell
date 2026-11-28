# sa-demo-nano-cell

A simulated robot cell that runs on the user's computer: a ROBOT (arm,
mount, table, guard, IO) with an APPLICATION set up on it (grippers, tool
rack, fixtures, parts, steps), both as data; a three.js viewer in the
browser that executes steps with IK and collision checking; and a local
server behind it for the agents, files and tools. No build step.

## Goal

This project is delivered as an APPLICATION INSTALLED ON THE USER'S
COMPUTER, not as a hosted page. Installed, it can do what a page alone
cannot, and it is meant to:

- **run local tools through the terminal** — the agents' CLI, the node
  scripts of the geometry pipeline (STEP to mesh, modelling), git;
- **make requests** — to the network (looking up components, saving and
  sharing applications) and to its own local server.

So the local server (`viewer/serve.py`) is part of the product, not only
the way to develop it: the chat agents, saving and loading, import and
export, attachments and building meshes all live behind it. When choosing
how to build something, it is fine — and often right — to rely on local
tools, the file system and requests; do not hold a feature back to keep it
working as a static page. The page stays the interface, and the core that
has to feel immediate (scene, planning, physics, running steps) stays in
it, with no build step.

Run it: `python3 viewer/serve.py` (live reload; `/__steps` lists steps).
Install procedure and the add/edit-step workflow for agents: `AGENTS.md`.

## Layout

- `viewer/` — the page. `app.js` scene + UI; `planner.js` the PURE planning
  layer (commands → joint paths, collision checks, pose policies — node-
  testable, no three.js); `cell-host.js` animates planned paths and moves
  scene objects; `ik.js` FK/IK (5-DOF free-spin + TCP); `collision.js`
  `mj-world.js` + `boxify.js` + `stl.js` the geometry/physics backend
  (MuJoCo wasm, REQUIRED via npm; cavity-preserving box decomposition);
  `capsules.js` fits the arm/tool capsules; `cell.d.ts` the step API
  types. Collision, touch, corridor heights, measurements and gravity
  settling all derive from the one MuJoCo model.
- `cell_fr3/` — the design of the cell, i.e. the robot an application runs
  on: `robot.json` (arm + mount, table, guard, flange stack, cameras, IO),
  `meshes/` (flange stack) and `arm/` (FR3 link meshes; the kinematic
  chain constants live in `ik.js`). Knows nothing about the job.
- `applications/<name>/` — an application: one job and its environment, one
  folder that can be copied, saved and shared. `application.json` is the
  small manifest (format, name, description, robot, its `grippers` and
  `items`, `mounted_tool`, and the ONE `loop`: a name and ordered steps);
  `layout.json` is what stands where (fixtures, parts, tool rack — poses in
  the table frame, z up, metres); `grippers/<id>/` and `items/<id>/` hold a
  description (`gripper.json` / `item.json`) with its meshes beside it;
  `robots/<robot>.json` what was taught on one robot; `print/` the STEP
  sources (and, for parts designed here, the `<part>.model.mjs` that
  `scripts/model-step.mjs` builds the STEP from); `notes/` the agents' notes; `materials/` chat attachments.
  An item is described ONCE in `items/` and placed as often as needed in
  the layout — never repeat a mesh, mass or `mesh_source` in a placement.
  It names the robot it is set up on and can be moved to another: keep
  robot facts OUT of it (no arm, IO definitions; joint values only in
  `robots/`). `viewer/cell-data.js` puts the files together and composes
  robot + application into the one cell the planner and physics see
  ("cell.json" in older comments means this composed cell), checking the
  robot can run it. The viewer's steps dock shows the loop and saves its
  order when steps are dragged; each row runs its step alone, **Run loop**
  runs them back to back (later steps start where the previous one ended,
  not at their own `entry`). **Export** / **Import** pack and unpack the
  whole folder as one `<name>-<date>-<time>.microfactory` file, named by
  when it was saved (`viewer/appfiles.py`).
  Format details: AGENTS.md, "The application folder".
- `applications/<name>/steps/<step>.ts` — a step is ONE file: it exports
  `name`, `tool`, `entry` and the default async function, and imports the
  cell API as `from 'nano-cell'` (never by a relative path).
- `agents/<id>.md` — the chat's agents (Lead engineer, CAD designer, Programmer,
  Component buyer, Accountant): a short header plus the role description
  that becomes the agent's instructions. `viewer/chat.py` runs them, one
  conversation each.
- `recipes/` — step-by-step guides for writing steps (suction pick &
  place, holder insertion). Follow the matching recipe before writing a
  new step; when a new motion pattern stabilizes, add a recipe for it.

## Step-authoring rules

- **Suction grasps are always parallel to the surface**: cup face parallel
  to the part face, approach and retreat along the surface normal. Use
  `ctx.h.suctionGrasp(item, standoff)` — do not hand-build grasp poses.
  The controlled frame for a vacuum tool is the CUP LIP frame from
  the gripper's `gripper.json` (`vacuum.lip_centre_flange_m` / `lip_normal_flange`) — the
  rcup16's cup is bent ~25° off the flange axis, so the flange axis is
  never the cup axis.
- **The wrist camera stays parallel to the breadboard while picking** when
  possible: `suctionGrasp`'s default spin levels the oak camera (level
  horizon, image looking down), tie-broken toward the collision-safe lean.
  Pass `lean: [x, y]` only when a layout forces a specific lean direction.
- Steps state intent; the host plans. Use `transitTip` for transfers
  (it picks the fastest collision-free candidate); explicit `moveTip` /
  `moveTipBy` only near contact, with a slow `speed` (m/s, e.g. 0.03).
- Deliberate contact needs `ignore: [ids]`; the error message names the id
  to add. Never ignore more than the move actually touches.
- Place by aligning the HELD PART (`cell.heldInTip()`), never the cup: the
  grasp spin follows the camera policy, so the part hangs at an arbitrary
  rotation under the cup. Place onto `item.topCenter` (measured geometry),
  never onto a fixture origin — origins are CAD datums.
- **Measure geometry, never assume it.** Three bugs came from shortcuts
  that each passed a numeric check while physically wrong: CAD origins
  (datums outside the working geometry), frame-axis labels (x may be the
  short edge on one part, the long edge on another), and PCA (tilts with
  interior features — the case's PCA sits 9° off its true edge). Use the
  measured helpers: `topCenter`, `topLongAxis`, `heldFootprintAzimuth`,
  `suctionGrasp`; alignment means OUTLINE edges (`footprintAzimuth`,
  min-area rectangle, in planner.js — regression-tested).
- Every step declares `entry` (a safe standalone start pose, tool down,
  clear of the rack) and types itself against `viewer/cell.d.ts`.
- `speed` is TIP speed in m/s (default 1.0 = full); joint limits are
  enforced on top.

## What physics is for

Simulate only what is meaningful to SEE: a released part dropping and
coming to rest, a part pushed by hand, a touch descent stopping on
something. Do not simulate fine fits whose contacts add nothing to the
picture — a screw standing in its hole in the feeder disc, a pin in a
bore. Place those from measured geometry (hole axis, hole bottom) and
leave them there. The collision model is boxes, so a round shank in a
round hole has no honest rest pose anyway; do not tune the physics to
make such a fit settle.

## After any change to viewer/, a robot or an application

Run `./scripts/check.sh` (types + `test/motion.test.mjs`) and rerun the
pick-place step in the viewer before calling the change done. The motion
tests encode the rules above plus the regressions already caught once
(J6 reversals, yaw dumped into a final move, camera level, cup parallel) —
when a new motion bug is fixed, ADD AN ASSERTION for it there. New motion
behaviour belongs in `viewer/planner.js` (pure, testable), not in
`cell-host.js` (animation and scene only).
