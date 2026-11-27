// The step list of the panel, as data: which steps stand in which loop, in
// what order, and what a drag-and-drop does to that. Pure (no DOM), so the
// rules are tested under node; viewer/steps-panel.js draws it.
//
//   steps: [{ id, name, tool }]            every step file of the application
//   loops: [{ id, name, steps: [id...] }]  loops.ts — ordered step ids

/**
 * The sections of the list, top to bottom: one per loop, with its steps in
 * loop order, then the steps that are in no loop (kept for when they are
 * needed — a fallback, a demo), in the order the application lists them.
 */
export function sections(steps, loops) {
  const byId = new Map(steps.map(s => [s.id, s]));
  const used = new Set();
  const out = loops.map(l => {
    const mine = l.steps.filter(id => byId.has(id));
    mine.forEach(id => used.add(id));
    return { loop: l.id, name: l.name, steps: mine.map(id => byId.get(id)) };
  });
  out.push({ loop: null, name: 'Not in a loop', steps: steps.filter(s => !used.has(s.id)) });
  return out;
}

/**
 * Drop step `stepId`, dragged out of section `from` (a loop id, or null for
 * the steps in no loop), into section `to` before position `index` of that
 * section as it was shown. Returns the new loops and the ids of the loops
 * that changed (those have to be saved).
 *  - into a loop: it is inserted there (moved, if it already was in it);
 *  - out of a loop into another: it leaves the first;
 *  - into "not in a loop": it leaves the loop it was dragged from. The
 *    order down there is the application's, so `index` means nothing.
 */
export function moveStep(loops, stepId, from, to, index) {
  const next = loops.map(l => ({ ...l, steps: [...l.steps] }));
  const loop = id => next.find(l => l.id === id);
  const changed = new Set();
  let at = index;
  if (from !== null && loop(from)) {
    const src = loop(from), i = src.steps.indexOf(stepId);
    if (i >= 0) {
      src.steps.splice(i, 1);
      changed.add(from);
      if (from === to && i < at) at--;      // the row above the gap moved up
    }
  }
  if (to !== null && loop(to)) {
    const dst = loop(to), j = dst.steps.indexOf(stepId);
    if (j >= 0) { dst.steps.splice(j, 1); if (j < at) at--; }
    dst.steps.splice(Math.max(0, Math.min(at, dst.steps.length)), 0, stepId);
    changed.add(to);
  }
  // nothing really moved: say so, so nothing is saved
  const same = id => JSON.stringify(loop(id).steps) === JSON.stringify(loops.find(l => l.id === id).steps);
  return { loops: next, changed: [...changed].filter(id => !same(id)) };
}
