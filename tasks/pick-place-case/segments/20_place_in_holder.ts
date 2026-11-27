// Carry the HELD case to the assembly holder (the wallet pocket) and set
// it down BY TOUCH: the descent runs until the case contacts the pocket
// floor or whatever already lies in it — no computed drop heights, so
// repeated runs stack correctly by construction.

import type { CellAPI, Ctx, Entry } from '../../../viewer/cell';

// standalone entry: tool down above the middle of the work area, so the
// transit starts without a big reorientation near the ceiling
export const entry: Entry = { joints_deg: [-95.8, -109.03, -35.38, -125.69, 89.91, 61.48] };

const CASE_IDS = [1, 2, 3, 4, 5, 6].map(i => `front_case_${i}`);

export default async function (cell: CellAPI, ctx: Ctx): Promise<void> {
  const holder = ctx.fixture('holder');
  // the pocket cavity centre from the fixture's top rim — the holder's
  // CAD origin is a datum OUTSIDE the pocket
  const hp = holder.topCenter;

  // placement yaw: align the HELD CASE's measured long footprint axis to
  // the POCKET's measured long axis. Frame labels (x vs y) are arbitrary
  // per CAD part. poseZDown's yaw spins about the DOWNWARD tip axis:
  // +yaw turns the held part NEGATIVE in world azimuth.
  const pocketYaw = holder.topLongAxis;
  const top: [number, number, number] = [hp[0], hp[1], hp[2] + 0.12];
  const caseAz = cell.heldFootprintAzimuth(ctx.h.poseZDown(top, 0));
  const alignYaw = caseAz === null ? pocketYaw : caseAz - pocketYaw;
  // both 180°-apart yaws fit the rectangle; take the one whose body lean
  // runs along the pocket's long axis, not into its walls
  const diff = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
  const topPose = [alignYaw, alignYaw + Math.PI]
    .map(y => ctx.h.poseZDown(top, y))
    .reduce((p, c) =>
      Math.min(diff(ctx.h.leanAzimuth(c), pocketYaw), diff(ctx.h.leanAzimuth(c), pocketYaw + Math.PI)) <
      Math.min(diff(ctx.h.leanAzimuth(p), pocketYaw), diff(ctx.h.leanAzimuth(p), pocketYaw + Math.PI)) ? c : p);

  // centre the HELD CASE's footprint over the pocket — the cup grips the
  // case wherever the grasp touched, not at its centre, so the tip target
  // must be shifted by the measured offset
  const fp = cell.heldFootprintCenter(topPose);
  const goPose = [...topPose];
  if (fp) { goPose[3] += hp[0] - fp.x; goPose[7] += hp[1] - fp.y; } // shift keeps the spin

  cell.log('carry to the holder');
  // departure happens right beside the stack; the button plate sits 88 mm
  // from the pocket, so the descent passes close by design
  const STACK = ['stack_north', ...CASE_IDS];
  await cell.transitTip(goPose, { spin: 'exact', ignore: STACK });

  // descend by touch: the detector probes only the case's interior
  // points, so the pocket rim under its edges never reads as support —
  // it stops on the floor, or on a case already inside
  const touch = await cell.moveUntilTouch([0, 0, -1], {
    maxDist: 0.15, speed: 0.04, ignore: ['button_plate'],
  });
  if (!touch.item) throw new Error('set-down found nothing to land on');
  await cell.release();
  await cell.setIO('vacuum', false);
  cell.log(`case set down on ${touch.item}`);
  // departure allowance covers the fresh contact below the cup
  await cell.moveTipBy([0, 0, 0.1], { speed: 0.2, ignore: ['button_plate'] });
}
