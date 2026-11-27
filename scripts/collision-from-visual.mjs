#!/usr/bin/env node
// Rebuild an item's collision STL from its visual GLB, triangle for
// triangle — no simplification. Use it when a collision mesh disagrees
// with what you see: a decimated collision mesh can skew a pocket wall by
// a millimetre, which turns a clearance fit into a fake interference fit.
//
//   node scripts/collision-from-visual.mjs cell/dvt01/meshes/holder
//
// reads <path>.glb, writes <path>.collision.stl (binary, metres).
import { readFileSync, writeFileSync } from 'node:fs';

export function glbTriangles(path) {
  const b = readFileSync(path);
  let o = 12, json, bin;
  while (o < b.length) {
    const len = b.readUInt32LE(o), type = b.readUInt32LE(o + 4);
    const d = b.subarray(o + 8, o + 8 + len);
    if (type === 0x4E4F534A) json = JSON.parse(d.toString()); else bin = d;
    o += 8 + len;
  }
  const SIZE = { 5126: 4, 5125: 4, 5123: 2, 5121: 1 };
  const READ = { 5126: 'readFloatLE', 5125: 'readUInt32LE', 5123: 'readUInt16LE', 5121: 'readUInt8' };
  const accessor = i => {
    const a = json.accessors[i], v = json.bufferViews[a.bufferView];
    const n = { SCALAR: 1, VEC3: 3 }[a.type], sz = SIZE[a.componentType];
    const off = (v.byteOffset || 0) + (a.byteOffset || 0), stride = v.byteStride || n * sz;
    const out = new Float64Array(a.count * n);
    for (let k = 0; k < a.count; k++)
      for (let c = 0; c < n; c++) out[k * n + c] = bin[READ[a.componentType]](off + k * stride + c * sz);
    return out;
  };
  // column-major 4x4, as glTF stores them
  const mul = (a, b) => {
    const r = new Array(16).fill(0);
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) for (let k = 0; k < 4; k++) r[j * 4 + i] += a[k * 4 + i] * b[j * 4 + k];
    return r;
  };
  const local = n => {
    if (n.matrix) return n.matrix;
    const t = n.translation || [0, 0, 0], [x, y, z, w] = n.rotation || [0, 0, 0, 1], s = n.scale || [1, 1, 1];
    return [
      (1 - 2 * (y * y + z * z)) * s[0], 2 * (x * y + z * w) * s[0], 2 * (x * z - y * w) * s[0], 0,
      2 * (x * y - z * w) * s[1], (1 - 2 * (x * x + z * z)) * s[1], 2 * (y * z + x * w) * s[1], 0,
      2 * (x * z + y * w) * s[2], 2 * (y * z - x * w) * s[2], (1 - 2 * (x * x + y * y)) * s[2], 0,
      t[0], t[1], t[2], 1];
  };
  const tris = [];
  const walk = (ni, M) => {
    const n = json.nodes[ni], W = mul(M, local(n));
    if (n.mesh !== undefined) for (const p of json.meshes[n.mesh].primitives) {
      const pos = accessor(p.attributes.POSITION);
      const idx = p.indices !== undefined ? accessor(p.indices) : Float64Array.from({ length: pos.length / 3 }, (_, i) => i);
      for (const i of idx) {
        const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
        tris.push(W[0] * x + W[4] * y + W[8] * z + W[12], W[1] * x + W[5] * y + W[9] * z + W[13], W[2] * x + W[6] * y + W[10] * z + W[14]);
      }
    }
    for (const c of n.children || []) walk(c, W);
  };
  for (const r of json.scenes[json.scene || 0].nodes) walk(r, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  return Float64Array.from(tris);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const base = process.argv[2];
  if (!base) { console.error('usage: collision-from-visual.mjs <path without extension>'); process.exit(1); }
  const t = glbTriangles(`${base}.glb`), n = t.length / 9;
  const out = Buffer.alloc(84 + n * 50);
  out.writeUInt32LE(n, 80);
  for (let i = 0; i < n; i++) {
    const p = 84 + i * 50, a = t.subarray(i * 9, i * 9 + 9);
    const u = [a[3] - a[0], a[4] - a[1], a[5] - a[2]], v = [a[6] - a[0], a[7] - a[1], a[8] - a[2]];
    const nn = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const l = Math.hypot(...nn) || 1;
    for (let k = 0; k < 3; k++) out.writeFloatLE(nn[k] / l, p + k * 4);
    for (let k = 0; k < 9; k++) out.writeFloatLE(a[k], p + 12 + k * 4);
  }
  writeFileSync(`${base}.collision.stl`, out);
  console.log(`${base}.collision.stl: ${n} triangles`);
}
