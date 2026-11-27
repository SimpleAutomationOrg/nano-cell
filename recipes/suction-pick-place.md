# Recipe: pick and place with the suction cup

How to write a step that picks a part with a vacuum cup and sets it
down somewhere flat. The working example is
the pick half of `applications/case-assembly/steps/pick-place-case.ts`.

## 1. Choose the target at run time

Part poses in `ctx` are **live** (read from the scene, not from
application.json), because parts move between runs. Never hardcode a part id
that an earlier run may have moved — select by current geometry:

```ts
const part = ctx.nextOnStack('stack_north', CASES);
```

`nextOnStack` returns the EXPOSED part: of the listed parts still near
the stack, the frontmost along its outward face — the one the cup can
reach. It throws when the stack is empty.

## 2. Build the grasp poses with `suctionGrasp`

```ts
const above = ctx.h.suctionGrasp(part, 0.06);   // 60 mm standoff
const touch = ctx.h.suctionGrasp(part, 0.002);  //  2 mm before contact
```

This is the only sanctioned way to build a grasp pose. It guarantees:

- the **cup lip face is parallel to the part face** (the controlled frame
  is the cup lip from the tool's `vacuum` data — the cup is bent off the
  flange axis, so never aim the flange yourself);
- approach and retreat run **along the face normal**;
- the spin is chosen so the **wrist camera sits level** with the
  breadboard (pass `lean: [x, y]` only when a layout forces a direction).

Honor the chosen spin with `spin: 'exact'` on every move that uses these
poses.

## 3. The pick sequence

```ts
await cell.transitTip(above, { spin: 'exact', ignore: NEAR });
await cell.setIO('vacuum', true);
await cell.moveTip(touch, { speed: 0.03, spin: 'exact', ignore: NEAR }); // 30 mm/s
await cell.waitMs(300);
await cell.grasp(part.id);      // the vacuum SEATS the part flush on the lip
await cell.moveTip(above, { speed: 0.15, spin: 'exact', ignore: NEAR });
```

- `transitTip` plans the transfer itself (direct when clear, lift when
  not) — don't hand-build transfer waypoints.
- `NEAR` is the deliberate-proximity list: the part, its neighbours, and
  the fixture they sit on. A rejected move names the id to add; never
  ignore more than the move actually touches.
- `speed` is tip speed in m/s (default 1.0 = full). Slow numbers are for
  deliberate approaches only.

## 4. Flat set-down

Transit above the target, then descend **by touch** — never by a
computed drop height:

```ts
await cell.transitTip(ctx.h.poseZDown([x, y, z + 0.12]), { spin: 'exact' });
const touch = await cell.moveUntilTouch([0, 0, -1], { maxDist: 0.15, speed: 0.04 });
if (!touch.item) throw new Error('nothing to land on');
await cell.release();
await cell.setIO('vacuum', false);
await cell.moveTipBy([0, 0, 0.1], { speed: 0.2 });   // departure allowance
                                                     // covers the fresh contact
```

For placement into a pocket (alignment, centring), use the
**holder-insertion** recipe instead of this step.

## Pitfalls this recipe exists to avoid

- Aiming the flange instead of the cup (bent stem → angled contact).
- Grasping a hardcoded part that moved on a previous run.
- Fixed drop heights (wrong the moment something is already there).
- Hand-set spins that leave the camera rolled or the body leaning into
  a wall — let `suctionGrasp` choose, override only with `lean`.
