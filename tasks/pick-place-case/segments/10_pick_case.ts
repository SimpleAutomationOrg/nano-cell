// Pick the EXPOSED front case off the 45° stack with the 16 mm suction
// cup. The target is chosen at run time — the case still on the stack
// that sits frontmost along the stack's outward normal — so repeated runs
// take case 1, then case 2, and so on. Never hardcode a part id that may
// have moved on a previous run: ctx poses are live.

import type { CellAPI, Ctx, Entry } from '../../../viewer/cell';

// home: tool down, tip 300 mm above the middle of the work area (clear of the rack)
export const entry: Entry = { joints_deg: [-95.8, -109.03, -35.38, -125.69, 89.91, 61.48] };

const CASE_IDS = [1, 2, 3, 4, 5, 6].map(i => `front_case_${i}`);
// working at the stack: the whole north stack is deliberate proximity
const NEAR = ['stack_north', ...CASE_IDS];

export default async function (cell: CellAPI, ctx: Ctx): Promise<void> {
  // the exposed case: still near the stack, frontmost along the face normal
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
  cell.log(`picking ${part.id} (${onStack.length} cases on the stack)`);

  // cup face parallel to the case face; default spin keeps the wrist
  // camera level — spin:'exact' is what makes the moves honor it
  const above = ctx.h.suctionGrasp(part, 0.06);
  const touch = ctx.h.suctionGrasp(part, 0.002);

  await cell.transitTip(above, { spin: 'exact', ignore: NEAR });
  await cell.setIO('vacuum', true);
  await cell.moveTip(touch, { speed: 0.03, spin: 'exact', ignore: NEAR });  // 30 mm/s contact approach
  await cell.waitMs(300);
  await cell.grasp(part.id);
  cell.log('case held, retreating');
  await cell.moveTip(above, { speed: 0.15, spin: 'exact', ignore: NEAR });  // gentle retreat with the part
}
