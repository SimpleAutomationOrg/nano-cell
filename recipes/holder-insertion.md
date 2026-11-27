# Recipe: insert a held part into a holder (pocket)

How to place a part INTO a cavity — aligned, centred, resting on the
floor or on parts already inside. The working example is
`tasks/pick-place-case/segments/20_place_in_holder.ts`.

The one rule behind every step: **measure geometry, never assume it.**
CAD origins are datums (often outside the working geometry), frame-axis
labels are arbitrary per part, and centroids/PCA drift with interior
feature density. All helpers below measure outlines and surfaces.

## 1. Find the pocket: centre and long axis

```ts
const holder = ctx.fixture('holder');
const hp = holder.topCenter;          // cavity centre (top-rim outline), NOT the origin
const pocketYaw = holder.topLongAxis; // long-EDGE azimuth (min-area rectangle), NOT a frame axis
```

## 2. Align the HELD PART, not the cup

The grasp spin served the camera, so the part hangs at an arbitrary
rotation under the cup. Solve the cup yaw from the part's measured
footprint:

```ts
const top: [number, number, number] = [hp[0], hp[1], hp[2] + 0.12];
const caseAz = cell.heldFootprintAzimuth(ctx.h.poseZDown(top, 0));
// poseZDown's yaw spins about the DOWNWARD tip axis:
// +yaw turns the held part NEGATIVE in world azimuth → caseAz − pocketYaw
const alignYaw = caseAz === null ? pocketYaw : caseAz - pocketYaw;
```

Both `alignYaw` and `alignYaw + π` fit a rectangle; pick the one whose
body lean (`ctx.h.leanAzimuth`) runs along the pocket's long axis, so
the leaning tool body never points into the pocket walls.

## 3. Centre the held part's footprint over the pocket

The cup grips the part wherever the grasp touched — not at its centre:

```ts
const fp = cell.heldFootprintCenter(topPose);
const goPose = [...topPose];
if (fp) { goPose[3] += hp[0] - fp.x; goPose[7] += hp[1] - fp.y; }  // shift keeps the spin
await cell.transitTip(goPose, { spin: 'exact', ignore: /* departure proximity */ });
```

## 4. Descend by touch

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

## 5. Release and leave

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

The print / machining STEP files in `cell/print/` are the source of
truth for geometry. Build an item's visual AND collision mesh from
them in one step, so the two cannot disagree:

    node scripts/step-to-mesh.mjs cell/print/<file>.STEP --list
    node scripts/step-to-mesh.mjs cell/print/<file>.STEP <body> cell/<cell>/meshes/<item>

Record where a mesh came from in the item's `mesh_source` in
cell.json. For an item with no STEP file,
`scripts/collision-from-visual.mjs` at least makes the collision mesh
match the visual one. The 'the case FITS the holder pocket' test in
`test/mujoco.test.mjs` guards this pair.

When measuring "how far off centre" a placed part is, compare poses in
the HOLDER's frame against the measured pocket rectangle — never
against remembered world coordinates of the pocket centre (those are
datums and have already been ~2 mm wrong once).
