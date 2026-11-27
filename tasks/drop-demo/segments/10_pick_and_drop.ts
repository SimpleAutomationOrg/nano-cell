// Gravity demo: pick the exposed front case, hold it square 120 mm above
// the holder pocket, and just LET GO. No set-down, no touch descent: the
// case falls under MuJoCo gravity into the pocket and seats on its floor.
// The fit has ~0.2 mm clearance per side and the release is a fraction
// of a degree off-square; the settle squares the case up as it goes in,
// the way the chamfers guide a real one.

import type { CellAPI, Ctx, Entry } from '../../../viewer/cell';

// standalone start: tool down above the middle of the work area
export const entry: Entry = { joints_deg: [-95.8, -109.03, -35.38, -125.69, 89.91, 61.48] };

const CASES = [1, 2, 3, 4, 5, 6].map(i => `front_case_${i}`);
// working at the stack means being close to all of it, on purpose
const NEAR = ['stack_north', ...CASES];

export default async function (cell: CellAPI, ctx: Ctx): Promise<void> {
  // pick, as in the pick-place task
  const part = ctx.nextOnStack('stack_north', CASES);
  const above = ctx.h.suctionGrasp(part, 0.06);
  await cell.transitTip(above, { spin: 'exact', ignore: NEAR });
  await cell.setIO('vacuum', true);
  await cell.moveTip(ctx.h.suctionGrasp(part, 0.002), { speed: 0.03, spin: 'exact', ignore: NEAR });
  await cell.grasp(part.id);
  await cell.moveTip(above, { speed: 0.15, spin: 'exact', ignore: NEAR });

  // hang it square over the pocket, 120 mm up, and drop
  await cell.transitTip(cell.heldPoseOver(ctx.fixture('holder'), 0.12), { spin: 'exact', ignore: NEAR });
  cell.log('letting go 120 mm up: gravity takes it from here');
  await cell.release();
  await cell.setIO('vacuum', false);
  await cell.moveTipBy([0, 0, 0.05], { speed: 0.3 });
}
