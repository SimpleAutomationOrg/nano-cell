// Pick the exposed back case from the 45-degree south stack:
// approach along its face normal, touch, grasp, retreat the same way.

import type { CellAPI, Ctx, Entry } from '../../../viewer/cell';

// standalone start: tool down above the middle of the work area
export const entry: Entry = { joints_deg: [-95.8, -109.03, -35.38, -125.69, 89.91, 61.48] };

const CASES = [1, 2, 3, 4, 5, 6].map(i => `back_case_${i}`);
// working at the stack means being close to all of it, on purpose
const NEAR = ['stack_south', ...CASES];

export default async function (cell: CellAPI, ctx: Ctx): Promise<void> {
  const part = ctx.nextOnStack('stack_south', CASES);
  cell.log(`picking ${part.id}`);

  // cup face parallel to the case face, 60 mm off and then touching.
  // spin:'exact' is what makes the moves keep the wrist camera level.
  const above = ctx.h.suctionGrasp(part, 0.06);
  const touching = ctx.h.suctionGrasp(part, 0.002);

  await cell.transitTip(above, { spin: 'exact', ignore: NEAR });
  await cell.setIO('vacuum', true);
  await cell.moveTip(touching, { speed: 0.03, spin: 'exact', ignore: NEAR });   // slow into contact
  await cell.waitMs(300);
  await cell.grasp(part.id);
  await cell.moveTip(above, { speed: 0.15, spin: 'exact', ignore: NEAR });      // gentle retreat
}
