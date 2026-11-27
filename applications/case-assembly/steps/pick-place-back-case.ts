// Pick the exposed back case from the 45-degree south stack and place it
// in the assembly holder (the wallet pocket).
//  - pick: approach along the case's face normal, touch, grasp, retreat the
//    same way;
//  - place: set it down BY TOUCH — the descent runs until the case meets
//    the pocket floor or whatever already lies in it. No computed drop
//    heights, so repeated runs stack correctly by construction.

import type { CellAPI, Ctx, Entry } from '../../../viewer/cell';

// what the viewer's step list shows, and the gripper the step works with
export const name = 'Pick a back case into the holder';
export const tool = 'rcup16_p0';

// standalone start: tool down above the middle of the work area
export const entry: Entry = { joints_deg: [-95.8, -109.03, -35.38, -125.69, 89.91, 61.48] };

const CASES = [1, 2, 3, 4, 5, 6].map(i => `back_case_${i}`);
// working at the stack means being close to all of it, on purpose; the
// carry to the holder starts right beside it too
const NEAR = ['stack_south', ...CASES];
// the button plate sits 88 mm from the pocket: the descent passes close
const BESIDE_POCKET = ['button_plate'];

export default async function (cell: CellAPI, ctx: Ctx): Promise<void> {
  // ---- pick ----
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

  // ---- place ----
  const holder = ctx.fixture('holder');

  // hang the case square over the pocket, 120 mm up
  cell.log('carry to the holder');
  await cell.transitTip(cell.heldPoseOver(holder, 0.12), { spin: 'exact', ignore: NEAR });

  // lower straight down until it touches (the pocket rim under its
  // edges does not count)
  const touch = await cell.moveUntilTouch([0, 0, -1], { maxDist: 0.15, speed: 0.04, ignore: BESIDE_POCKET });
  if (!touch.item) throw new Error('set-down found nothing to land on');

  await cell.release();
  await cell.setIO('vacuum', false);
  cell.log(`case set down on ${touch.item}`);
  await cell.moveTipBy([0, 0, 0.1], { speed: 0.2, ignore: BESIDE_POCKET });
}
