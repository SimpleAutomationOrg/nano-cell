#!/usr/bin/env node
// Model new solid geometry and write it as a print STEP file — for the
// fixtures and parts that are DESIGNED here (a nest, a tray, a jaw, a
// stand) rather than bought or handed over as CAD. The kernel is Open
// CASCADE as WebAssembly, driven through replicad: true cylinders, bores,
// fillets, chamfers, booleans — the same kind of file a desktop CAD
// exports. The STEP it writes is the source of truth; make the meshes from
// it with scripts/step-to-mesh.mjs, like any other print file.
//
//   node scripts/model-step.mjs applications/<app>/print/<part>.model.mjs
//   -> applications/<app>/print/<part>.step   (beside the model, AP214, mm)
//
// A model is a small module, kept in print/ next to the STEP it makes so
// the part can be changed and rebuilt:
//
//   // nest.model.mjs — everything in MILLIMETRES, z up
//   export default r => {
//     const plate = r.drawRoundedRectangle(100, 75, 4).sketchOnPlane('XY').extrude(8);
//     const pocket = r.makeBaseBox(60.4, 40.4, 5).translate([0, 0, 3]);
//     const bore = r.makeCylinder(3.3, 8, [37.5, 25, 0], [0, 0, 1]);    // M6 clearance
//     return [{ name: 'nest', color: [0.2, 0.6, 0.3], shape: plate.cut(pocket).cut(bore) }];
//   };
//
// `r` is the whole replicad API (https://replicad.xyz/docs/api): draw*
// (2D outlines) -> sketchOnPlane -> extrude / revolve / loftWith; make*
// (makeBaseBox centred in x,y with its base on z = 0, makeCylinder,
// makeSphere); shape.fuse / cut / intersect, fillet, chamfer, shell,
// translate, rotate, mirror. Return one body, or a list of bodies
// { name, shape, color: [r,g,b] 0..1 } — the names are what
// step-to-mesh.mjs --list shows and what it takes as <body>.
//
// Model the part in the frame it will stand in (origin where the layout
// pose puts it), and CHECK the sizes and volumes printed below against
// what you meant — a boolean that missed leaves the size unchanged.
// Check a part with scripts/inspect-step.mjs (exact sizes, bores, the fit
// against a mating part) and LOOK at it with scripts/look.mjs.
// Needs the dev dependencies `replicad` and `replicad-opencascadejs`.
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { kernel as loadKernel } from './cad-kernel.mjs';

const [modelPath] = process.argv.slice(2);
if (!modelPath || !/\.model\.mjs$/.test(modelPath)) {
  console.error('usage: model-step.mjs <path/to/part.model.mjs>   (writes path/to/part.step)');
  process.exit(1);
}
const r = await loadKernel();

const model = (await import(pathToFileURL(resolve(modelPath)).href)).default;
if (typeof model !== 'function') { console.error(`${modelPath}: export default a function (r) => bodies`); process.exit(1); }
// the kernel throws bare WebAssembly exceptions; say which step failed
const kernel = (what, fn) => {
  try { return fn(); } catch (e) {
    console.error(`${modelPath}: ${what} failed in the CAD kernel${e?.message ? ` (${e.message})` : ''} — an empty or invalid shape: check that booleans leave material, fillets fit their edges, sketches are closed`);
    process.exit(1);
  }
};
let bodies;
try { bodies = await model(r); } catch (e) {
  console.error(`${modelPath}: the model threw while building: ${e?.stack ?? e?.message ?? 'a CAD kernel exception (an invalid operation: a fillet larger than its edge, an open sketch, a boolean on nothing)'}`);
  process.exit(1);
}
if (!Array.isArray(bodies)) bodies = [bodies];
bodies = bodies.map((b, i) => (b && b.shape ? b : { shape: b })).map((b, i) => ({ name: `body${i + 1}`, color: [0.8, 0.8, 0.8], ...b }));

const hex = c => '#' + c.slice(0, 3).map(v => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('');
const seen = new Set();
for (const b of bodies) {
  if (!b.shape || typeof b.shape.blobSTEP !== 'function') { console.error(`${modelPath}: body '${b.name}' has no 3D shape (did a sketch miss its extrude?)`); process.exit(1); }
  if (seen.has(b.name)) { console.error(`${modelPath}: two bodies are named '${b.name}' — names must differ, step-to-mesh picks bodies by name`); process.exit(1); }
  seen.add(b.name);
  const [[lo, hi], volume] = kernel(`measuring body '${b.name}'`, () => [b.shape.boundingBox.bounds, r.measureVolume(b.shape)]);
  if (!(volume > 1e-9)) { console.error(`${modelPath}: body '${b.name}' is empty (volume ${volume}) — a cut removed everything, or the shape is not a solid`); process.exit(1); }
  const f = v => v.toFixed(3);
  console.log(`${b.name}: ${hi.map((v, k) => f(v - lo[k])).join(' x ')} mm, x ${f(lo[0])}..${f(hi[0])}  y ${f(lo[1])}..${f(hi[1])}  z ${f(lo[2])}..${f(hi[2])}, volume ${volume.toFixed(1)} mm3`);
}
const out = modelPath.replace(/\.model\.mjs$/, '.step');
const blob = kernel('writing the STEP', () => r.exportSTEP(bodies.map(b => ({ shape: b.shape, name: b.name, color: hex(b.color) })), { unit: 'MM', modelUnit: 'MM' }));
writeFileSync(out, Buffer.from(await blob.arrayBuffer()));
console.log(`wrote ${out}`);
