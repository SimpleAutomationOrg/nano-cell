// Gravity demo: pick the exposed case, hover 120 mm above the holder
// pocket, and just LET GO — no set-down, no touch descent. With the
// exact backend active the released case falls and settles into the
// pocket under MuJoCo gravity; on the sampled fallback it stays where
// the cup released it (which is the visible difference between the two).

import type { CellAPI, Ctx, Entry } from '../../../viewer/cell';

export const entry: Entry = { joints_deg: [-95.8, -109.03, -35.38, -125.69, 89.91, 61.48] };

const CASE_IDS = [1, 2, 3, 4, 5, 6].map(i => `front_case_${i}`);
const NEAR = ['stack_north', ...CASE_IDS];

export default async function (cell: CellAPI, ctx: Ctx): Promise<void> {
  // pick the exposed case (same selection as the pick-place recipe)
  const stackPos = ctx.h.matPos(ctx.fixture('stack_north').matrix);
  const onStack = CASE_IDS.map(id => ctx.part(id)).filter(p => {
    const d = ctx.h.add(ctx.h.matPos(p.matrix), ctx.h.neg(stackPos));
    return Math.hypot(d[0], d[1], d[2]) < 0.12;
  });
  if (!onStack.length) throw new Error('the north stack is empty');
  const outward = (p: typeof onStack[0]) => ctx.h.neg(ctx.h.matAxis(p.matrix, 2));
  const part = onStack.reduce((a, b) => {
    const n = outward(a);
    const da = ctx.h.matPos(a.matrix), db = ctx.h.matPos(b.matrix);
    return (da[0] * n[0] + da[1] * n[1]) > (db[0] * n[0] + db[1] * n[1]) ? a : b;
  });

  await cell.transitTip(ctx.h.suctionGrasp(part, 0.06), { spin: 'exact', ignore: NEAR });
  await cell.setIO('vacuum', true);
  await cell.moveTip(ctx.h.suctionGrasp(part, 0.002), { speed: 0.03, spin: 'exact', ignore: NEAR });
  await cell.grasp(part.id);
  await cell.moveTip(ctx.h.suctionGrasp(part, 0.06), { speed: 0.15, spin: 'exact', ignore: NEAR });

  // hover high above the pocket, aligned — and drop
  const holder = ctx.fixture('holder');
  const hp = holder.topCenter;
  const top: [number, number, number] = [hp[0], hp[1], hp[2] + 0.12];
  const caseAz = cell.heldFootprintAzimuth(ctx.h.poseZDown(top, 0));
  const yaw = caseAz === null ? holder.topLongAxis : caseAz - holder.topLongAxis;
  const pose = ctx.h.poseZDown(top, yaw);
  const fp = cell.heldFootprintCenter(pose);
  const goPose = [...pose];
  if (fp) { goPose[3] += hp[0] - fp.x; goPose[7] += hp[1] - fp.y; }
  await cell.transitTip(goPose, { spin: 'exact', ignore: NEAR });

  cell.log('letting go 120 mm up — gravity takes it from here');
  await cell.release();
  await cell.setIO('vacuum', false);
  await cell.moveTipBy([0, 0, 0.05], { speed: 0.3 });
}
