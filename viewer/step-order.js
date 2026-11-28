// The step list of the panel, as data: which steps are in the application's
// loop, in what order, and what a drag-and-drop does to that. Pure (no
// DOM), so the rules are tested under node; viewer/steps-panel.js draws it.
//
//   steps: [{ id, name, tool }]       every step file of the application
//   loop:  { name, steps: [id...] }   the manifest's loop — the ordered step ids

/**
 * The two parts of the list, top to bottom: the loop's steps in loop
 * order, then the steps that are not in it (kept for when they are needed
 * — a fallback, a demo), in the order the application lists them.
 */
export function sections(steps, loop) {
  const byId = new Map(steps.map(s => [s.id, s]));
  const mine = (loop?.steps ?? []).filter(id => byId.has(id));
  const used = new Set(mine);
  return {
    loop: mine.map(id => byId.get(id)),
    free: steps.filter(s => !used.has(s.id)),
  };
}

/**
 * Drop step `stepId` into the loop (`toLoop`) before position `index` of
 * the loop as it was shown, or out of it (`toLoop` false). Returns the new
 * step ids of the loop, and whether anything changed (only then is there
 * something to save).
 *  - into the loop: it is inserted there (moved, if it already was in it);
 *  - out of the loop: it leaves it but still exists. The order of the
 *    steps outside the loop is the application's, so nothing is saved for
 *    a drag that stays down there.
 */
export function moveStep(loopSteps, stepId, toLoop, index = 0) {
  const next = [...loopSteps];
  const i = next.indexOf(stepId);
  let at = index;
  if (i >= 0) { next.splice(i, 1); if (i < at) at--; }
  if (toLoop) next.splice(Math.max(0, Math.min(at, next.length)), 0, stepId);
  return { steps: next, changed: JSON.stringify(next) !== JSON.stringify(loopSteps) };
}
