// Carry the HELD front case to the assembly holder (the wallet pocket) and
// set it down BY TOUCH: the descent runs until the case meets the pocket
// floor or whatever already lies in it. No computed drop heights, so
// repeated runs stack correctly by construction.

import type { CellAPI, Ctx, Entry } from '../../../viewer/cell';

// standalone start: tool down above the middle of the work area
export const entry: Entry = { joints_deg: [-95.8, -109.03, -35.38, -125.69, 89.91, 61.48] };

// the carry starts right beside the stack the case came from
const LEAVING = ['stack_north', ...[1, 2, 3, 4, 5, 6].map(i => `front_case_${i}`)];
// the button plate sits 88 mm from the pocket: the descent passes close
const BESIDE_POCKET = ['button_plate'];

export default async function (cell: CellAPI, ctx: Ctx): Promise<void> {
  const holder = ctx.fixture('holder');

  // hang the case square over the pocket, 120 mm up
  cell.log('carry to the holder');
  await cell.transitTip(cell.heldPoseOver(holder, 0.12), { spin: 'exact', ignore: LEAVING });

  // lower straight down until it touches (the pocket rim under its
  // edges does not count)
  const touch = await cell.moveUntilTouch([0, 0, -1], { maxDist: 0.15, speed: 0.04, ignore: BESIDE_POCKET });
  if (!touch.item) throw new Error('set-down found nothing to land on');

  await cell.release();
  await cell.setIO('vacuum', false);
  cell.log(`case set down on ${touch.item}`);
  await cell.moveTipBy([0, 0, 0.1], { speed: 0.2, ignore: BESIDE_POCKET });
}
