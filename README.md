# nano-cell

A simulated robot work cell that runs entirely in the browser: a 6-axis
arm inside a guarded enclosure, collision-checked motion planning, and
steps written as small TypeScript files. No build step, no physics
engine, no dependencies to install — one Python server, one page.

![viewer](docs/viewer.jpg)

## Quickstart

```sh
python3 viewer/serve.py
# opens http://127.0.0.1:8742/viewer/ with live reload
```

Pick a step in the dock under the 3D view and press its **▶**. Edit any file —
viewer code, a step, robot or application data — and the page reloads itself.

**Agent install**: paste this repository's URL into your coding agent
with the word `install`. The agent-facing guide is [AGENTS.md](AGENTS.md)
(Claude Code also reads [CLAUDE.md](CLAUDE.md) automatically); it covers
setup, verification, and how to add or edit steps.

Prerequisites: Python 3.8+, Node 18+ (for `npm install` and the checks),
a modern browser.

**Required — `npm install`**: the geometry and physics engine is MuJoCo
(WebAssembly, `@mujoco/mujoco`, loaded in the page). Collision checks,
contact-seeking moves, gravity settling and geometric measurements all
run on one model: obstacles box-decomposed from their collision meshes
(cavities preserved — `viewer/boxify.js`), arm and tool capsules, parts
as free bodies. Without it the scene renders but steps are disabled.

## What's inside

- **`viewer/`** — the page and the engine.
  - `planner.js` — pure planning: commands → joint paths. FK/IK with a
    tool-frame TCP and 5-DOF free-spin solves (`ik.js`), candidate-based
    transfers (direct / corridor-lift / safe-lift, fastest clean one
    wins), collision checking against sampled geometry, contact-seeking
    moves, and measured-geometry pose helpers. Runs under `node --test`.
  - `cell-host.js` — animates planned paths in the scene, owns run
    state (grasp/release with vacuum seating, IO, pause/step/stop).
  - `collision.js` — obstacles as surface-sampled point clouds in a
    spatial hash; the moving side (arm links, tool) as fitted capsules.
    Both are visualizable live (Show → collision points / capsules).
  - `cell.d.ts` — the typed step API, fully documented for IDE hover.
- **`cell_fr3/`** — the design of the cell, as data: `robot.json` (the
  arm and its mount, the table, the enclosure, the flange stack,
  cameras, IO), the flange-stack meshes and the arm's link meshes
  (`arm/`). It is the robot an application runs on.
- **`applications/<name>/`** — an application is one job and its
  environment, in one folder that can be copied, saved and shared:
  `application.json` (a small manifest: name, description, robot, its
  grippers and items, the loop), `layout.json` (what stands where),
  `grippers/` and `items/` (one self-contained folder each: a
  description and its meshes), `steps/`, and `print/` (the CAD). Every
  pose is in the table frame, so an application can be moved to another
  robot; the viewer shows it on the robot it names (`?app=<name>` picks
  the application, `?robot=<name>` tries it on another robot).
  - `steps/<name>.ts` — one file per step: its name, its tool and an
    async function against the typed
    cell API; it states intent (`transitTip`, `suctionGrasp`,
    `moveUntilTouch`) and the planner does the geometry.
- **`recipes/`** — step-by-step guides for writing steps
  (suction pick & place, holder insertion), including the pitfalls
  each step avoids.
- **`test/`** — motion regression tests: IK invariants, path quality
  (no wrist reversals, no yaw dumped into a final move), grasp/camera
  policies, footprint measurement, contact-seeking behavior.

## Design choices

- **Steps state intent; the planner plans.** Steps survive cell
  layout changes because routes, heights, and alignments are computed
  from the live cell, not hand-taught.
- **Measure geometry, never assume it.** Placement and alignment use
  measured outlines and surfaces (`topCenter`, `topLongAxis`,
  `heldFootprintCenter`, `suctionGrasp`) — never CAD origins, frame-axis
  labels, or statistical centroids. The recipes explain why.
- **Every motion is collision-checked before it runs**, with actionable
  rejections (which link, which item, where). Deliberate contact is
  explicit (`ignore`), and set-downs seek contact instead of computing
  drop heights.
- **Speeds are tip speeds** (m/s) with per-joint velocity limits always
  enforced; the simulation answers "is this motion feasible and clean",
  not yet "exactly how fast is the cycle".

## Checks

```sh
./scripts/check.sh   # tsc --noEmit + node --test (needs Node 18+)
```

Every motion rule above is encoded as an assertion in
`test/motion.test.mjs`. If you fix a motion bug, add a test for it.

## License

MIT. Arm link meshes are converted from the arm vendor's public CAD;
see `cell_fr3/arm/arm.json` for details.
