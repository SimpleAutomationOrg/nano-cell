#!/usr/bin/env node
// Build an item's meshes from the CAD file it is MADE from — the print /
// machining STEP is the source of truth, not a mesh someone exported
// earlier. Writes both the visual mesh and the collision mesh from the
// same triangles, so the two can never disagree:
//
//   node scripts/step-to-mesh.mjs <file.STEP> <body name> <out path, no extension>
//   node scripts/step-to-mesh.mjs cell/print/case.STEP --list
//
//   -> <out>.glb             (metres, one mesh, the CAD colour)
//   -> <out>.collision.stl   (binary, metres, the same triangles)
//
// <body name> is a solid's name inside the STEP (an assembly holds
// several; --list prints them). Coordinates are kept exactly as in the
// STEP (assembly placements applied), converted mm -> m.
// Needs the dev dependency `occt-import-js` (OpenCascade as WebAssembly).
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const [, , stepPath, body, out] = process.argv;
if (!stepPath || !body || (body !== '--list' && !out)) {
  console.error('usage: step-to-mesh.mjs <file.STEP> <body name | --list> <out path without extension>');
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
  for (const m of res.meshes) console.log(`${m.name}: ${size(m).text}, ${m.index.array.length / 3} triangles`);
  process.exit(0);
}
const mesh = res.meshes.find(m => m.name === body);
if (!mesh) { console.error(`no body '${body}' in ${stepPath}; it has: ${res.meshes.map(m => m.name).join(', ')}`); process.exit(1); }

const pos = Float32Array.from(mesh.attributes.position.array, v => v / 1000);   // mm -> m
const nrm = Float32Array.from(mesh.attributes.normal.array);
const idx = Uint32Array.from(mesh.index.array);
const nTri = idx.length / 3;

// ---- collision STL: the same triangles ----
const stl = Buffer.alloc(84 + nTri * 50);
stl.writeUInt32LE(nTri, 80);
for (let t = 0; t < nTri; t++) {
  const o = 84 + t * 50, a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
  const u = [pos[b] - pos[a], pos[b + 1] - pos[a + 1], pos[b + 2] - pos[a + 2]];
  const v = [pos[c] - pos[a], pos[c + 1] - pos[a + 1], pos[c + 2] - pos[a + 2]];
  const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const l = Math.hypot(...n) || 1;
  for (let k = 0; k < 3; k++) stl.writeFloatLE(n[k] / l, o + k * 4);
  [a, b, c].forEach((p, j) => { for (let k = 0; k < 3; k++) stl.writeFloatLE(pos[p + k], o + 12 + j * 12 + k * 4); });
}
writeFileSync(`${out}.collision.stl`, stl);

// ---- visual GLB: one mesh, indexed, with normals and the CAD colour ----
const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], pos[i + k]); hi[k] = Math.max(hi[k], pos[i + k]); }
const bin = Buffer.concat([Buffer.from(idx.buffer), Buffer.from(pos.buffer), Buffer.from(nrm.buffer)]);
const color = mesh.color ? [...mesh.color.slice(0, 3), 1] : [0.8, 0.8, 0.8, 1];
const json = {
  asset: { version: '2.0', generator: 'nano-cell step-to-mesh' },
  scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: body, mesh: 0 }],
  materials: [{ name: 'cad_0', doubleSided: false, pbrMetallicRoughness: { baseColorFactor: color, roughnessFactor: 0.6, metallicFactor: 0.1 } }],
  meshes: [{ primitives: [{ attributes: { POSITION: 1, NORMAL: 2 }, indices: 0, material: 0, mode: 4 }] }],
  buffers: [{ byteLength: bin.length }],
  bufferViews: [
    { buffer: 0, byteOffset: 0, byteLength: idx.byteLength, target: 34963 },
    { buffer: 0, byteOffset: idx.byteLength, byteLength: pos.byteLength, target: 34962 },
    { buffer: 0, byteOffset: idx.byteLength + pos.byteLength, byteLength: nrm.byteLength, target: 34962 }],
  accessors: [
    { bufferView: 0, componentType: 5125, count: idx.length, type: 'SCALAR' },
    { bufferView: 1, componentType: 5126, count: pos.length / 3, type: 'VEC3', min: lo, max: hi },
    { bufferView: 2, componentType: 5126, count: nrm.length / 3, type: 'VEC3' }],
};
const pad = (b, fill) => Buffer.concat([b, Buffer.alloc((4 - b.length % 4) % 4, fill)]);
const jb = pad(Buffer.from(JSON.stringify(json)), 0x20), bb = pad(bin, 0);
const head = Buffer.alloc(12), jh = Buffer.alloc(8), bh = Buffer.alloc(8);
head.writeUInt32LE(0x46546C67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + jb.length + 8 + bb.length, 8);
jh.writeUInt32LE(jb.length, 0); jh.writeUInt32LE(0x4E4F534A, 4);
bh.writeUInt32LE(bb.length, 0); bh.writeUInt32LE(0x004E4942, 4);
writeFileSync(`${out}.glb`, Buffer.concat([head, jh, jb, bh, bb]));

console.log(`${body}: ${size(mesh).text}, ${nTri} triangles -> ${out}.glb + ${out}.collision.stl`);
