# sa-demo-nano-cell

A browser-only robot cell: a ROBOT (arm, mount, table, guard, IO) with an
APPLICATION set up on it (grippers, tool rack, fixtures, parts, tasks),
both as data, plus a three.js viewer that executes task segments with IK
and collision checking. No build step.

Run it: `python3 viewer/serve.py` (live reload; `/__tasks` lists tasks).
Install procedure and the add/edit-task workflow for agents: `AGENTS.md`.

## Layout

- `viewer/` — the page. `app.js` scene + UI; `planner.js` the PURE planning
  layer (commands → joint paths, collision checks, pose policies — node-
  testable, no three.js); `cell-host.js` animates planned paths and moves
  scene objects; `ik.js` FK/IK (5-DOF free-spin + TCP); `collision.js`
  `mj-world.js` + `boxify.js` + `stl.js` the geometry/physics backend
  (MuJoCo wasm, REQUIRED via npm; cavity-preserving box decomposition);
  `capsules.js` fits the arm/tool capsules; `cell.d.ts` the segment API
  types. Collision, touch, corridor heights, measurements and gravity
  settling all derive from the one MuJoCo model.
- `cell_fr3/` — the design of the cell, i.e. the robot an application runs
  on: `robot.json` (arm + mount, table, guard, flange stack, cameras, IO),
  `meshes/` (flange stack) and `arm/` (FR3 link meshes; the kinematic
  chain constants live in `ik.js`). Knows nothing about the job.
- `applications/<name>/` — an application: one job and its environment.
  `application.json` (grippers, tool rack, fixtures, parts — poses in the
  table frame, z up, metres), `meshes/`, `print/` (STEP source files) and
  `tasks/`. It names the robot it is set up on and can be moved to
  another: keep robot facts OUT of it (no arm, IO definitions or joint
  values — joint-space values taught on one robot live under
  `taught_on.<robot>`). `viewer/cell-data.js` composes robot + application
  into the one cell the planner and physics see ("cell.json" in older
  comments means this composed cell) and checks the robot can run it.
- `applications/<name>/tasks/<task>/` — `task.json` (tool, segment order) +
  `segments/*.ts`.
- `recipes/` — step-by-step guides for writing segments (suction pick &
  place, holder insertion). Follow the matching recipe before writing a
  new segment; when a new motion pattern stabilizes, add a recipe for it.

## Task-authoring rules

- **Suction grasps are always parallel to the surface**: cup face parallel
  to the part face, approach and retreat along the surface normal. Use
  `ctx.h.suctionGrasp(item, standoff)` — do not hand-build grasp poses.
  The controlled frame for a vacuum tool is the CUP LIP frame from
  application.json (`vacuum.lip_centre_flange_m` / `lip_normal_flange`) — the
  rcup16's cup is bent ~25° off the flange axis, so the flange axis is
  never the cup axis.
- **The wrist camera stays parallel to the breadboard while picking** when
  possible: `suctionGrasp`'s default spin levels the oak camera (level
  horizon, image looking down), tie-broken toward the collision-safe lean.
  Pass `lean: [x, y]` only when a layout forces a specific lean direction.
- Segments state intent; the host plans. Use `transitTip` for transfers
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
- Every segment declares `entry` (a safe standalone start pose, tool down,
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
pick-place task in the viewer before calling the change done. The motion
tests encode the rules above plus the regressions already caught once
(J6 reversals, yaw dumped into a final move, camera level, cup parallel) —
when a new motion bug is fixed, ADD AN ASSERTION for it there. New motion
behaviour belongs in `viewer/planner.js` (pure, testable), not in
`cell-host.js` (animation and scene only).
