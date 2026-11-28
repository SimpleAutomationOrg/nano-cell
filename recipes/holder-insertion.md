# Recipe: insert a held part into a holder (pocket)

How to place a part INTO a cavity — aligned, centred, resting on the
floor or on parts already inside. The working example is
the place half of `applications/case-assembly/steps/pick-place-case.ts`.

The one rule behind every step: **measure geometry, never assume it.**
CAD origins are datums (often outside the working geometry), frame-axis
labels are arbitrary per part, and centroids/PCA drift with interior
feature density. All helpers below measure outlines and surfaces.

## 1. Hang the part square over the pocket

```ts
const holder = ctx.fixture('holder');
await cell.transitTip(cell.heldPoseOver(holder, 0.12), { spin: 'exact', ignore: /* departure proximity */ });
```

`cell.heldPoseOver(target, height)` returns the cup pose that holds the
part square to, and centred over, the target's top opening. Use it for
every placement; it does three measured things you should not redo by
hand:

- **Finds the pocket** from its top-rim outline: `topCenter` (the cavity
  centre, NOT the origin) and `topLongAxis` (the long-EDGE azimuth, NOT
  a frame axis).
- **Aligns the HELD PART, not the cup.** The grasp spin served the
  camera, so the part hangs at an arbitrary rotation under the cup; the
  yaw is solved from the part's measured footprint. Of the two
  180°-apart yaws that fit a rectangle it takes the one the wrist
  reaches with less turning. (If a part must go in a particular way
  round, that is not decided here.)
- **Centres the part's footprint**, not the tip: the cup grips the part
  wherever the grasp touched, which is not its centre.

## 2. Descend by touch

```ts
const touch = await cell.moveUntilTouch([0, 0, -1], {
  maxDist: 0.15, speed: 0.04, ignore: [/* fixtures beside the pocket */],
});
if (!touch.item) throw new Error('set-down found nothing to land on');
```

Why this just works for tight pockets: the detector probes only the
part's **interior** points (6 mm inset from its outline), so the rim
under the part's edges never reads as support — the part passes the rim
and stops on the **floor** or on a **part already inside** (`touch.item`
tells you which). No drop heights, no pile counting, no blind zones.

## 3. Release and leave

```ts
await cell.release();
await cell.setIO('vacuum', false);
await cell.moveTipBy([0, 0, 0.1], { speed: 0.2 });
```

The retreat needs no ignore for the part just released: contacts present
at a move's start are allowed to persist while departing.

## Pitfalls this recipe exists to avoid

- Placing at the fixture ORIGIN (a datum outside the pocket).
- Aligning frame x to frame x (one part's x is its short edge, the
  other's its long edge → 90° across the pocket).
- Aligning or centring by PCA/centroid (drifts ~9° / several mm with
  interior features — use the outline-based helpers).
- The yaw sign: `poseZDown(+yaw)` turns the held part NEGATIVE in world
  azimuth (regression-tested in `test/motion.test.mjs`).
- Computed drop heights and rim blind zones — superseded by
  interior-probe `moveUntilTouch`.

Debugging: turn on **MuJoCo boxes** in the Show panel — the teal
boxes are exactly the geometry every check and measurement runs against.

## If the contact forces look huge after placing

Suspect the MESHES before the placement or the physics. A part hanging
on the pocket walls at hundreds of newtons, never reaching the floor,
means the collision geometry says the part does not fit. The pocket
here is a clearance fit (74.5 x 48.1 mm for a 74.1 x 47.8 mm case) —
but a simplified collision mesh once had its walls skewed up to 1 mm
inward, and that read exactly like an interference fit.

The print / machining STEP files in `applications/<application>/print/` are the source of
truth for geometry. Build an item's visual AND collision mesh from
them in one step, so the two cannot disagree:

    node scripts/step-to-mesh.mjs applications/<application>/print/<file>.STEP --list
    node scripts/step-to-mesh.mjs applications/<application>/print/<file>.STEP <body> applications/<application>/items/<item>/<item>

Record where a mesh came from as `mesh_source` in the item's
`item.json`. For an item with no STEP file,
`scripts/collision-from-visual.mjs` at least makes the collision mesh
match the visual one. The 'the case FITS the holder pocket' test in
`test/mujoco.test.mjs` guards this pair.

When measuring "how far off centre" a placed part is, compare poses in
the HOLDER's frame against the measured pocket rectangle — never
against remembered world coordinates of the pocket centre (those are
datums and have already been ~2 mm wrong once).
