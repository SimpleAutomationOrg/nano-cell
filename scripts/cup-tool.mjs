#!/usr/bin/env node
// Build a suction-cup TOOL (an interchangeable gripper) from a cup's print
// file and the body of an existing cup tool:
//
//   node scripts/cup-tool.mjs <cup.step> <reference tool, no extension> <out, no extension>
//   node scripts/cup-tool.mjs applications/case-assembly/print/DP40_suction_cup.step \
//        applications/case-assembly/meshes/rcup16_p0 applications/case-assembly/meshes/bigcup_p0
//
//   -> <out>.glb, <out>.collision.stl   and, printed, the tool's lip frame
//
// A cup tool's mesh has two parts: the BODY (the changer's tool half and the
// bent arm with its nozzle) and the CUP on the nozzle. The body is taken
// unchanged from the reference tool; the cup comes from the STEP, through
// scripts/step-to-mesh.mjs, so it is the printed geometry.
//
// How the cup sits is measured, not assumed:
//  - the cup's axis is the STEP's z; its LIP is the wide open end and its
//    mount the other end (both found from the profile);
//  - the nozzle axis is the reference tool's lip normal, through its lip
//    centre (`vacuum.lip_*` of the reference, read from application.json);
//  - the cup's mount face is seated on the nozzle's end face — the body's
//    furthest point along that axis — coaxial with it.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const [stepPath, refBase, out] = process.argv.slice(2);
if (!stepPath || !refBase || !out) {
  console.error('usage: cup-tool.mjs <cup.step> <reference tool path without extension> <out path without extension>');
  process.exit(1);
}

// ---- GLB in and out (positions, normals, indices, base colour) ----
function readGlb(path) {
  const b = readFileSync(path), jl = b.readUInt32LE(12);
  const json = JSON.parse(b.subarray(20, 20 + jl).toString()), bin = b.subarray(20 + jl + 8);
  const acc = i => {
    const a = json.accessors[i], v = json.bufferViews[a.bufferView];
    const off = bin.byteOffset + (v.byteOffset ?? 0) + (a.byteOffset ?? 0);
    const n = a.count * (a.type === 'VEC3' ? 3 : 1);
    const T = a.componentType === 5126 ? Float32Array : a.componentType === 5125 ? Uint32Array : Uint16Array;
    return new T(bin.buffer.slice(off, off + n * T.BYTES_PER_ELEMENT));
  };
  return json.meshes.flatMap(m => m.primitives).map(p => ({
    pos: Float32Array.from(acc(p.attributes.POSITION)),
    nrm: Float32Array.from(acc(p.attributes.NORMAL)),
    idx: Uint32Array.from(acc(p.indices)),
    color: json.materials[p.material].pbrMetallicRoughness.baseColorFactor,
  }));
}
function writeGlb(path, prims, name) {
  const chunks = [], views = [], accessors = [], materials = [], primitives = [];
  let offset = 0;
  const view = (arr, target) => {
    const b = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
    views.push({ buffer: 0, byteOffset: offset, byteLength: b.length, target });
    chunks.push(b); offset += b.length;
    return views.length - 1;
  };
  for (const p of prims) {
    const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
    for (let i = 0; i < p.pos.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p.pos[i + k]); hi[k] = Math.max(hi[k], p.pos[i + k]); }
    const ai = accessors.push({ bufferView: view(p.idx, 34963), componentType: 5125, count: p.idx.length, type: 'SCALAR' }) - 1;
    const ap = accessors.push({ bufferView: view(p.pos, 34962), componentType: 5126, count: p.pos.length / 3, type: 'VEC3', min: lo, max: hi }) - 1;
    const an = accessors.push({ bufferView: view(p.nrm, 34962), componentType: 5126, count: p.nrm.length / 3, type: 'VEC3' }) - 1;
    const mi = materials.push({ name: `cad_${materials.length}`, doubleSided: false, pbrMetallicRoughness: { baseColorFactor: p.color, roughnessFactor: 0.6, metallicFactor: 0.1 } }) - 1;
    primitives.push({ attributes: { POSITION: ap, NORMAL: an }, indices: ai, material: mi, mode: 4 });
  }
  const bin = Buffer.concat(chunks);
  const json = { asset: { version: '2.0', generator: 'nano-cell cup-tool' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ name, mesh: 0 }], materials, meshes: [{ primitives }], buffers: [{ byteLength: bin.length }], bufferViews: views, accessors };
  const pad = (b, fill) => Buffer.concat([b, Buffer.alloc((4 - b.length % 4) % 4, fill)]);
  const jb = pad(Buffer.from(JSON.stringify(json)), 0x20), bb = pad(bin, 0);
  const head = Buffer.alloc(12), jh = Buffer.alloc(8), bh = Buffer.alloc(8);
  head.writeUInt32LE(0x46546C67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + jb.length + 8 + bb.length, 8);
  jh.writeUInt32LE(jb.length, 0); jh.writeUInt32LE(0x4E4F534A, 4);
  bh.writeUInt32LE(bb.length, 0); bh.writeUInt32LE(0x004E4942, 4);
  writeFileSync(path, Buffer.concat([head, jh, jb, bh, bb]));
}
function writeStl(path, prims) {
  const nTri = prims.reduce((t, p) => t + p.idx.length / 3, 0);
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
  writeFileSync(path, stl);
}

// ---- the reference tool: its body, and the nozzle axis it carries ----
const refId = basename(refBase);
const app = JSON.parse(readFileSync(join(dirname(refBase), '..', 'application.json')));
const ref = app.tools.find(t => t.id === refId);
if (!ref?.vacuum?.lip_centre_flange_m) { console.error(`${refId} is not a cup tool of ${app.name} (no vacuum.lip_centre_flange_m)`); process.exit(1); }
const refPrims = readGlb(`${refBase}.glb`);
if (refPrims.length !== 2) { console.error(`${refBase}.glb: expected two parts (body, cup), found ${refPrims.length}`); process.exit(1); }
const body = refPrims[0];
const c0 = ref.vacuum.lip_centre_flange_m;
const nl = Math.hypot(...ref.vacuum.lip_normal_flange), n = ref.vacuum.lip_normal_flange.map(v => v / nl);
// the nozzle's end face: the body's furthest reach along the axis, within the nozzle's own radius
let tEnd = -1e9;
for (let i = 0; i < body.pos.length; i += 3) {
  const d = [body.pos[i] - c0[0], body.pos[i + 1] - c0[1], body.pos[i + 2] - c0[2]];
  const t = d[0] * n[0] + d[1] * n[1] + d[2] * n[2];
  const r = Math.hypot(d[0] - t * n[0], d[1] - t * n[1], d[2] - t * n[2]);
  if (r < 0.008 && t > tEnd) tEnd = t;
}
const E = c0.map((v, k) => v + tEnd * n[k]);     // centre of the nozzle's end face

// ---- the cup, from its print file ----
const tmp = mkdtempSync(join(tmpdir(), 'cup-'));
execFileSync('node', [join(dirname(fileURLToPath(import.meta.url)), 'step-to-mesh.mjs'), stepPath, '--all', join(tmp, 'cup'), '--color', '0.92,0.92,0.9'], { stdio: ['ignore', 'ignore', 'inherit'] });
const cupPrims = readGlb(join(tmp, 'cup.glb'));
rmSync(tmp, { recursive: true });
// profile along z: the lip is the end with the larger radius
let z0 = 1e9, z1 = -1e9;
for (const p of cupPrims) for (let i = 2; i < p.pos.length; i += 3) { z0 = Math.min(z0, p.pos[i]); z1 = Math.max(z1, p.pos[i]); }
const ring = z => { let lo = 1e9, hi = 0; for (const p of cupPrims) for (let i = 0; i < p.pos.length; i += 3) if (Math.abs(p.pos[i + 2] - z) < 2e-4) { const r = Math.hypot(p.pos[i], p.pos[i + 1]); lo = Math.min(lo, r); hi = Math.max(hi, r); } return { lo, hi }; };
const lipAtLow = ring(z0).hi > ring(z1).hi;
const zLip = lipAtLow ? z0 : z1, zMount = lipAtLow ? z1 : z0, height = z1 - z0;
const lip = ring(zLip);
// off-axis check: the cup must be modelled on its own axis
let cx = 0, cy = 0, cn = 0;
for (const p of cupPrims) for (let i = 0; i < p.pos.length; i += 3) if (Math.abs(p.pos[i + 2] - zLip) < 2e-4) { cx += p.pos[i]; cy += p.pos[i + 1]; cn++; }
if (Math.hypot(cx / cn, cy / cn) > 2e-4) { console.error(`the cup's lip is ${(Math.hypot(cx / cn, cy / cn) * 1000).toFixed(2)} mm off the STEP's z axis — model it on its axis`); process.exit(1); }

// cup frame -> flange frame: mount face on E, axis along n, lip outward.
// (u, v, n) right-handed; when the lip is at low z the cup is turned over,
// which a half turn about u does (y and z both change sign)
const a = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
let u = [a[1] * n[2] - a[2] * n[1], a[2] * n[0] - a[0] * n[2], a[0] * n[1] - a[1] * n[0]];
const ul = Math.hypot(...u); u = u.map(x => x / ul);
const v = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
const sgn = lipAtLow ? -1 : 1;
const place = (p, isPoint) => {
  const o = new Float32Array(p.length);
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], y = sgn * p[i + 1], z = sgn * (p[i + 2] - (isPoint ? zMount : 0));
    for (let k = 0; k < 3; k++) o[i + k] = (isPoint ? E[k] : 0) + x * u[k] + y * v[k] + z * n[k];
  }
  return o;
};
const cup = cupPrims.map(p => ({ pos: place(p.pos, true), nrm: place(p.nrm, false), idx: p.idx, color: p.color }));

writeGlb(`${out}.glb`, [body, ...cup], basename(out));
writeStl(`${out}.collision.stl`, [body, ...cup]);
const r6 = x => +x.toFixed(6);
const lipCentre = E.map((x, k) => r6(x + height * n[k]));
console.log(JSON.stringify({
  cup: `${(lip.hi * 2000).toFixed(1)} mm lip, ${(height * 1000).toFixed(1)} mm tall`,
  seated_on: `${refId} nozzle end, ${(-tEnd * 1000).toFixed(2)} mm behind that tool's lip plane`,
  vacuum: { cup_radius_m: r6(lip.hi), lip_centre_flange_m: lipCentre, lip_normal_flange: n.map(r6), lip_inner_radius_m: r6(lip.lo) },
}, null, 1));
