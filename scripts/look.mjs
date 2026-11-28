#!/usr/bin/env node
// Draw geometry to a PNG so a design can be LOOKED AT — by the CAD designer
// (an agent opens the picture with its Read tool) or by a person:
//
//   node scripts/look.mjs <file.step> [more.step ...] <out.png>
//   node scripts/look.mjs applications/<app> <out.png>
//
// A STEP file (or several, each as placed in its own frame — a part in its
// nest) is drawn from its exact geometry. An application folder is drawn as
// its layout: every fixture and part where layout.json puts it, on the
// breadboard, without the robot. The sheet has four views at ONE scale —
// isometric, top, front, right — shaded, with outlines, and the frame's
// axes at the origin (x red, y green, z blue). What is where on the sheet,
// and the scale, is printed.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadStep, meshOf, meshesOfGlb, boxMesh, drawSheet } from './cad-kernel.mjs';

const args = process.argv.slice(2);
const out = args.pop();
if (!args.length || !out || !/\.png$/i.test(out)) {
  console.error('usage: look.mjs <file.step ...> <out.png>   or   look.mjs applications/<app> <out.png>');
  process.exit(1);
}
const ROOT = fileURLToPath(new URL('..', import.meta.url));
// a few distinct greys and tints, so bodies drawn together can be told apart
const TINTS = [[0.78, 0.8, 0.84], [0.55, 0.72, 0.9], [0.9, 0.72, 0.5], [0.6, 0.85, 0.65], [0.85, 0.6, 0.75], [0.7, 0.7, 0.55]];

const pieces = [];
if (args.length === 1 && existsSync(args[0]) && statSync(args[0]).isDirectory()) {
  // an application: its layout on the breadboard
  const app = relative(join(ROOT, 'applications'), resolve(args[0]));
  if (!app || app.includes(sep) || app.startsWith('..')) { console.error(`${args[0]}: give an application folder, applications/<name>`); process.exit(1); }
  const { loadApplication, robotDir } = await import('../viewer/cell-data.js');
  const readJson = async p => JSON.parse(readFileSync(join(ROOT, p)));
  const application = await loadApplication(readJson, app);
  const robot = await readJson(robotDir(application.robot) + 'robot.json');
  const t = robot.table;
  if (t?.min_table_m && t?.max_table_m) {
    pieces.push(boxMesh([t.min_table_m[0] * 1000, t.min_table_m[1] * 1000, -6], [t.max_table_m[0] * 1000, t.max_table_m[1] * 1000, 0], [0.86, 0.87, 0.9]));
  }
  for (const it of [...application.fixtures, ...application.parts]) {
    if (it.mesh) pieces.push(...meshesOfGlb(join(ROOT, 'applications', app, it.mesh), it.pose_table));
  }
  if (pieces.length < 2) { console.error(`${args[0]}: the layout places nothing with a mesh`); process.exit(1); }
} else {
  let n = 0;
  for (const p of args) {
    let shape;
    try { shape = await loadStep(p); } catch (e) { console.error(`could not read ${p}${e?.message ? `: ${e.message}` : ''}`); process.exit(1); }
    for (const body of shape.solids?.length ? shape.solids : [shape]) pieces.push(meshOf(body, TINTS[n++ % TINTS.length]));
  }
}
console.log(drawSheet(pieces, out));
