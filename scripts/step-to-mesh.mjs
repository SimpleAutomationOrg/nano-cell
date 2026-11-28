#!/usr/bin/env node
// Build an item's meshes from the CAD file it is MADE from — the print /
// machining STEP is the source of truth, not a mesh someone exported
// earlier. Writes both the visual mesh and the collision mesh from the
// same triangles, so the two can never disagree:
//
//   node scripts/step-to-mesh.mjs <file.STEP> <body | --all> <out path, no extension> [options]
//   node scripts/step-to-mesh.mjs applications/case-assembly/print/case.STEP --list
//   node scripts/step-to-mesh.mjs applications/case-assembly/print/case.STEP --all applications/case-assembly/items/case/case
//
//   -> <out>.glb             (metres, the CAD colours)
//   -> <out>.collision.stl   (binary, metres, the same triangles)
//
// <body> is a solid's name inside the STEP (an assembly holds several;
// --list prints them); --all merges every body into one item (a PCB with
// its components). By default coordinates are kept exactly as in the STEP
// (assembly placements applied), converted mm -> m. Options, for parts
// whose CAD frame is not how they sit in the cell:
//
//   --up <+z|-z|+x|-x|+y|-y>   which STEP direction points UP in the cell
//                              (a part modelled upside down: --up -z)
//   --origin bottom-centre     put the origin under the middle of the part:
//                              bounding-box centre in x and y, lowest point
//                              at z = 0 — so a pose's xyz is simply "where
//                              it stands"
//   --color r,g,b              override the CAD colour (0..1 each), for a
//                              part printed in a colour the CAD does not
//                              carry
//
// Record the options used as `mesh_source` in the item's item.json (the
// meshes go beside it: applications/<app>/items/<item>/<item>).
// Needs the dev dependency `occt-import-js` (OpenCascade as WebAssembly).
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(name); return i < 0 ? null : args.splice(i, 2)[1]; };
const up = opt('--up') ?? '+z', origin = opt('--origin'), colour = opt('--color');
const [stepPath, body, out] = args;
if (!stepPath || !body || (body !== '--list' && !out)) {
  console.error('usage: step-to-mesh.mjs <file.STEP> <body name | --all | --list> <out path without extension> [--up -z] [--origin bottom-centre]');
  process.exit(1);
}
const occt = await createRequire(import.meta.url)('occt-import-js')();
// 0.01 mm chord error: a curved wall is never more than 10 microns from
// the true surface — an order of magnitude inside the 0.1 mm fits here
const res = occt.ReadStepFile(new Uint8Array(readFileSync(stepPath)), {
  linearUnit: 'millimeter', linearDeflectionType: 'absolute_value', linearDeflection: 0.01, angularDeflection: 0.25,
});
if (!res.success) { console.error(`could not read ${stepPath}`); process.exit(1); }

const size = m => {
  const p = m.attributes.position.array, lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
  for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[i + k]); hi[k] = Math.max(hi[k], p[i + k]); }
  return { lo, hi, text: hi.map((v, k) => (v - lo[k]).toFixed(3)).join(' x ') + ' mm' };
};
if (body === '--list') {
  for (const m of res.meshes) console.log(`${m.name || '(unnamed)'}: ${size(m).text}, ${m.index.array.length / 3} triangles`);
  process.exit(0);
}
const bodies = body === '--all' ? res.meshes : res.meshes.filter(m => m.name === body);
if (!bodies.length) { console.error(`no body '${body}' in ${stepPath}; it has: ${res.meshes.map(m => m.name).join(', ')}`); process.exit(1); }

// rotation that brings the chosen STEP direction to +z (a proper rotation)
const R = {
  '+z': [1, 0, 0, 0, 1, 0, 0, 0, 1], '-z': [1, 0, 0, 0, -1, 0, 0, 0, -1],   // half turn about x
  '+x': [0, 0, -1, 0, 1, 0, 1, 0, 0], '-x': [0, 0, 1, 0, 1, 0, -1, 0, 0],
  '+y': [1, 0, 0, 0, 0, -1, 0, 1, 0], '-y': [1, 0, 0, 0, 0, 1, 0, -1, 0],
}[up];
if (!R) { console.error(`--up ${up}: use one of +z -z +x -x +y -y`); process.exit(1); }
const rot = (a, scale) => {
  const o = new Float32Array(a.length);
  for (let i = 0; i < a.length; i += 3) for (let r = 0; r < 3; r++)
    o[i + r] = (R[r * 3] * a[i] + R[r * 3 + 1] * a[i + 1] + R[r * 3 + 2] * a[i + 2]) * scale;
  return o;
};
const prims = bodies.map(m => ({
  pos: rot(m.attributes.position.array, 1 / 1000),                 // mm -> m
  nrm: rot(m.attributes.normal.array, 1),
  idx: Uint32Array.from(m.index.array),
  color: colour ? [...colour.split(',').map(Number), 1] : m.color ? [...m.color.slice(0, 3), 1] : [0.8, 0.8, 0.8, 1],
}));
const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
for (const p of prims) for (let i = 0; i < p.pos.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p.pos[i + k]); hi[k] = Math.max(hi[k], p.pos[i + k]); }
if (origin === 'bottom-centre') {
  const off = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, lo[2]];
  for (const p of prims) for (let i = 0; i < p.pos.length; i += 3) for (let k = 0; k < 3; k++) p.pos[i + k] -= off[k];
  for (let k = 0; k < 3; k++) { lo[k] -= off[k]; hi[k] -= off[k]; }
} else if (origin) { console.error(`--origin ${origin}: only bottom-centre is supported`); process.exit(1); }
const nTri = prims.reduce((t, p) => t + p.idx.length / 3, 0);

// ---- collision STL: the same triangles ----
const stl = Buffer.alloc(84 + nTri * 50);
stl.writeUInt32LE(nTri, 80);
let o = 84;
for (const { pos, idx } of prims) for (let t = 0; t < idx.length / 3; t++, o += 50) {
  const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
  const u = [pos[b] - pos[a], pos[b + 1] - pos[a + 1], pos[b + 2] - pos[a + 2]];
  const v = [pos[c] - pos[a], pos[c + 1] - pos[a + 1], pos[c + 2] - pos[a + 2]];
  const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const l = Math.hypot(...n) || 1;
  for (let k = 0; k < 3; k++) stl.writeFloatLE(n[k] / l, o + k * 4);
  [a, b, c].forEach((p, j) => { for (let k = 0; k < 3; k++) stl.writeFloatLE(pos[p + k], o + 12 + j * 12 + k * 4); });
}
writeFileSync(`${out}.collision.stl`, stl);

// ---- visual GLB: one mesh, one primitive per body (its CAD colour) ----
const chunks = [], views = [], accessors = [], materials = [], primitives = [];
let offset = 0;
const view = (arr, target) => {
  const b = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
  views.push({ buffer: 0, byteOffset: offset, byteLength: b.length, target });
  chunks.push(b); offset += b.length;
  return views.length - 1;
};
for (const p of prims) {
  const plo = [1e9, 1e9, 1e9], phi = [-1e9, -1e9, -1e9];
  for (let i = 0; i < p.pos.length; i += 3) for (let k = 0; k < 3; k++) { plo[k] = Math.min(plo[k], p.pos[i + k]); phi[k] = Math.max(phi[k], p.pos[i + k]); }
  const ai = accessors.push({ bufferView: view(p.idx, 34963), componentType: 5125, count: p.idx.length, type: 'SCALAR' }) - 1;
  const ap = accessors.push({ bufferView: view(p.pos, 34962), componentType: 5126, count: p.pos.length / 3, type: 'VEC3', min: plo, max: phi }) - 1;
  const an = accessors.push({ bufferView: view(p.nrm, 34962), componentType: 5126, count: p.nrm.length / 3, type: 'VEC3' }) - 1;
  let mi = materials.findIndex(m => m.pbrMetallicRoughness.baseColorFactor.every((v, k) => Math.abs(v - p.color[k]) < 1e-6));
  if (mi < 0) mi = materials.push({ name: `cad_${materials.length}`, doubleSided: false, pbrMetallicRoughness: { baseColorFactor: p.color, roughnessFactor: 0.6, metallicFactor: 0.1 } }) - 1;
  primitives.push({ attributes: { POSITION: ap, NORMAL: an }, indices: ai, material: mi, mode: 4 });
}
const bin = Buffer.concat(chunks);
const name = body === '--all' ? (res.root.children[0]?.name || 'part') : body;
const json = {
  asset: { version: '2.0', generator: 'nano-cell step-to-mesh' },
  scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name, mesh: 0 }],
  materials, meshes: [{ primitives }],
  buffers: [{ byteLength: bin.length }], bufferViews: views, accessors,
};
const pad = (b, fill) => Buffer.concat([b, Buffer.alloc((4 - b.length % 4) % 4, fill)]);
const jb = pad(Buffer.from(JSON.stringify(json)), 0x20), bb = pad(bin, 0);
const head = Buffer.alloc(12), jh = Buffer.alloc(8), bh = Buffer.alloc(8);
head.writeUInt32LE(0x46546C67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + jb.length + 8 + bb.length, 8);
jh.writeUInt32LE(jb.length, 0); jh.writeUInt32LE(0x4E4F534A, 4);
bh.writeUInt32LE(bb.length, 0); bh.writeUInt32LE(0x004E4942, 4);
writeFileSync(`${out}.glb`, Buffer.concat([head, jh, jb, bh, bb]));

const f = v => (v * 1000).toFixed(2);
console.log(`${name}: ${hi.map((v, k) => f(v - lo[k])).join(' x ')} mm, ${nTri} triangles, x ${f(lo[0])}..${f(hi[0])} y ${f(lo[1])}..${f(hi[1])} z ${f(lo[2])}..${f(hi[2])} -> ${out}.glb + ${out}.collision.stl`);
