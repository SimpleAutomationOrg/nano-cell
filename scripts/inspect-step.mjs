#!/usr/bin/env node
// Measure a STEP file from its exact geometry — what the CAD designer needs
// to know about a part before designing something that mates with it:
//
//   node scripts/inspect-step.mjs <file.step>
//   node scripts/inspect-step.mjs <file.step> --fit <other.step>
//
// For every body: its size and place, volume and centre of mass; its bores
// and bosses (diameter, axis, where it starts and ends, a full circle or an
// arc); its largest flat faces (normal and position). Millimetres, in the
// STEP's own frame. Measured from the true surfaces, not from a mesh — a
// 6.6 mm bore reads 6.600, not the facets of one.
//
// With --fit: how the two files sit together AS THEY ARE PLACED in their
// frames — the smallest gap between them, or the volume they share if they
// interfere. Model both in the frame they will stand in, then ask.
import { kernel, loadStep, describe, features, fit, fmt, fmt3 } from './cad-kernel.mjs';

const args = process.argv.slice(2);
const fi = args.indexOf('--fit');
const other = fi >= 0 ? args.splice(fi, 2)[1] : null;
const [path] = args;
if (!path || (fi >= 0 && !other)) {
  console.error('usage: inspect-step.mjs <file.step> [--fit <other.step>]');
  process.exit(1);
}
const r = await kernel();
const load = async p => {
  try { return await loadStep(p); } catch (e) { console.error(`could not read ${p}${e?.message ? `: ${e.message}` : ''}`); process.exit(1); }
};
const shape = await load(path);
const bodies = shape.solids?.length ? shape.solids : [shape];

console.log(`${path}: ${bodies.length} bod${bodies.length === 1 ? 'y' : 'ies'}  (mm, the file's own frame)`);
bodies.forEach((b, i) => {
  const d = describe(r, b), f = features(r, b);
  console.log(`\nbody ${i + 1}: ${fmt3(d.size)} mm   x ${fmt(d.lo[0])}..${fmt(d.hi[0])}  y ${fmt(d.lo[1])}..${fmt(d.hi[1])}  z ${fmt(d.lo[2])}..${fmt(d.hi[2])}`);
  console.log(`  volume ${fmt(d.volume, 1)} mm3, centre of mass (${fmt3(d.centre)})`);
  const round = f.cylinders.filter(c => c.full), arcs = f.cylinders.length - round.length;
  for (const c of round.slice(0, 40)) {
    console.log(`  ${c.boss ? 'boss' : 'bore'} dia ${fmt(c.diameter)}  axis (${fmt3(c.axis, 2)})  from (${fmt3(c.ends[0])}) to (${fmt3(c.ends[1])})  length ${fmt(c.length)}`);
  }
  if (round.length > 40) console.log(`  ... and ${round.length - 40} more bores/bosses`);
  if (arcs) console.log(`  ${arcs} cylindrical arc${arcs > 1 ? 's' : ''} (fillets, rounded corners) not listed`);
  for (const p of f.planes.slice(0, 8)) {
    console.log(`  flat face  normal (${fmt3(p.normal, 2)})  at ${fmt(p.offset)} along it  area ${fmt(p.area, 1)} mm2`);
  }
  if (f.planes.length > 8) console.log(`  ... and ${f.planes.length - 8} smaller flat faces`);
});

if (other) {
  const b = await load(other);
  const { overlap, gap } = fit(r, shape, b);
  console.log(`\nfit with ${other}, both as placed in their frames:`);
  console.log(overlap
    ? `  THEY INTERFERE: ${fmt(overlap, 2)} mm3 of shared material`
    : gap < 1e-6 ? '  they touch (gap 0.000 mm) and share no material'
      : `  clear: the smallest gap between them is ${fmt(gap)} mm`);
}
