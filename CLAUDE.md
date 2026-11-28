# microfactory

A simulated robot cell that runs on the user's computer: a ROBOT (arm,
mount, table, guard, IO) with an APPLICATION set up on it (grippers, tool
rack, fixtures, parts, steps), both as data; a three.js viewer in the
browser that executes steps with IK and collision checking; and a local
server behind it for the agent, files and tools. No build step.

## Who it is for

An average robotics engineer, and the one measure of a decision is whether
it makes their work more CONVENIENT: less to set up, less to learn, fewer
steps to a running cell.

There is NO requirement to work offline, to be self-contained, or to do
without accounts. Online services, sign-ins, cloud storage, hosted APIs
and downloads are all fine — and are the right choice whenever they make
the thing easier to use. Never argue against a feature, or steer the user
away from one, on the grounds that it needs the network, an account or a
service; weigh only what it costs the engineer in effort against what it
gives them. That the installed app happens to carry its own files is a way
of making installation easy, not a principle to defend.

## Goal

This project is delivered as an APPLICATION INSTALLED ON THE USER'S
COMPUTER, not as a hosted page. Installed, it can do what a page alone
cannot, and it is meant to:

- **run local tools through the terminal** — the agent's CLI, the node
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

The installable form is a Claude artifact with the `desktop` capability
("Install as app" in the Claude desktop app). Making it is one defined
step, the project skill **`/publish-app`**
(`.claude/skills/publish-app/SKILL.md`): check, `node
scripts/build-artifact.mjs`, publish — a new version of the artifact named
in `artifact.json` (on a computer that installed from the repository:
its own artifact, named in the untracked `artifact.local.json`). To make installing easy, besides the page the app carries a
PACK of the files a workspace is made of (the local programs, the guides,
the robot, the starter application named in `artifact.json`), and makes
the workspace folder from it on first start, so installing takes no
access to the repository. Only tracked files go in, meshes only when every byte is
accounted for as geometry (`scripts/mesh-check.mjs`), never attachments,
conversations or uncommitted CAD. A checkout of this repository works as
a workspace too. The page reaches the folder through `viewer/desktop.js`
and `python3 viewer/serve.py --stdio`. Details:
AGENTS.md, "The installable app".

The installed app works only for the organization that published it. So
there is a second, SHAREABLE edition for everyone else: the same page as
an artifact that asks for no access to a computer (`node
scripts/build-artifact.mjs --share`, published by the same skill as a
separate artifact). There the page is its own server: `viewer/share.js`
puts a page engine behind the viewer's requests (`viewer/page-engine.js`),
answering from the pack the artifact carries plus the person's changes
kept in their browser (`viewer/page-fs.js`), and the chat's assistant is
asked through the artifact's `sample` function with the page's own
functions as tools (`viewer/page-agent.js`). It simulates, runs and
edits steps and layouts, imports and exports; it has no CAD pipeline, no
web lookups and no git. The page therefore runs THREE ways — served by
`serve.py`, installed, shared — and a change to the viewer must keep all
three working. Details: AGENTS.md, "The shareable edition".

Run it: `python3 viewer/serve.py` (live reload; `/__steps` lists steps).
Run a step without clicking: `node scripts/run-step.mjs <application> <step>`
(runs in the open viewer, prints the outcome and where the parts ended up;
`--shot` saves pictures; `--headless` runs with no window; `--last-failure`
prints the record of the last run that failed in the viewer). The chat's
agent debugs steps with it.
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
  The page's hosts: `desktop.js` + `desktop-bridge.js` +
  `workspace-install.js` (the installed app: workspace, engine through
  pipes); `share.js` (the shareable edition's entry) with `page-store.js`
  + `page-fs.js` (the pack and the person's changes over it), `zip.js`
  (`.microfactory` files in the page), `page-engine.js` (what `serve.py`
  answers, answered in the page — keep the two alike:
  `test/page-engine.test.mjs`) and `page-agent.js` + `page-tools.js` +
  `page-brief.js` (the assistant there, its tools, its instructions).
- `cell_fr3/` — the design of the cell, i.e. the robot an application runs
  on: `robot.json` (arm + mount, table, guard, flange stack, cameras, IO),
  `meshes/` (flange stack), `arm/` (FR3 link meshes; the kinematic
  chain constants live in `ik.js`) and `kit/` — the robot's standard
  equipment, COPIED into every new application made on it: the basic
  grippers and the tool rack they stand in (`kit.json` lists them and
  where the stands are). To change what new applications start with,
  change `kit/`; an existing application is not affected. Knows nothing
  about the job.
- `applications/<name>/` — an application: one job and its environment, one
  folder that can be copied, saved and shared. `application.json` is the
  small manifest (format, name, description, robot, its `grippers` and
  `items`, `mounted_tool`, and the ONE `loop`: a name and ordered steps);
  `layout.json` is what stands where (fixtures, parts, tool rack — poses in
  the table frame, z up, metres); `grippers/<id>/` and `items/<id>/` hold a
  description (`gripper.json` / `item.json`) with its meshes beside it;
  `robots/<robot>.json` what was taught on one robot; `print/` the STEP
  sources (and, for parts designed here, the `<part>.model.mjs` that
  `scripts/model-step.mjs` builds the STEP from); `notes/` the agent's notes; `materials/` chat attachments.
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
  cell API as `from 'microfactory'` (never by a relative path).
- `guides/` — the chat has ONE agent (`guides/agent.md`: who it is, how it
  works) and a guide for each kind of work it does (`planning.md`,
  `geometry.md`, `steps.md`, `buying.md`, `costing.md`), which it reads
  before starting work of that kind. `viewer/chat.py` runs it, one
  conversation per application. To change how a kind of work is done, edit
  its guide.
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

Run `./scripts/check.sh` (types, the motion tests, and every
application's loop run without the viewer — `test/loops.test.mjs`) and
rerun the pick-place step in the viewer before calling the change done
(`node scripts/run-step.mjs <application> <step> --shot` does that and
shows the result). The motion
tests encode the rules above plus the regressions already caught once
(J6 reversals, yaw dumped into a final move, camera level, cup parallel) —
when a new motion bug is fixed, ADD AN ASSERTION for it there. New motion
behaviour belongs in `viewer/planner.js` (pure, testable), not in
`cell-host.js` (animation and scene only).
