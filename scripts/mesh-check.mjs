// Account for every byte of a mesh file before it is given to anyone.
//
// A mesh that goes into the installable app must be geometry and nothing
// else: no pictures, no programs, no notes riding along. checkGlb and
// checkStl read a whole file and either throw, naming what they found, or
// return what the file is: its size in triangles, its bounds and every
// piece of text in it (names, generator) — for a person to read.

const GLB_TOP = new Set(['asset', 'scene', 'scenes', 'nodes', 'meshes', 'materials', 'accessors', 'bufferViews', 'buffers']);
const KEYS = {
  asset: new Set(['version', 'generator']),
  scenes: new Set(['nodes', 'name']),
  nodes: new Set(['name', 'mesh', 'children', 'translation', 'rotation', 'scale', 'matrix']),
  meshes: new Set(['name', 'primitives']),
  primitives: new Set(['attributes', 'indices', 'material', 'mode']),
  materials: new Set(['name', 'pbrMetallicRoughness', 'doubleSided', 'emissiveFactor', 'alphaMode', 'alphaCutoff']),
  pbr: new Set(['baseColorFactor', 'metallicFactor', 'roughnessFactor']),
  accessors: new Set(['bufferView', 'byteOffset', 'componentType', 'count', 'type', 'min', 'max', 'normalized', 'name']),
  bufferViews: new Set(['buffer', 'byteOffset', 'byteLength', 'byteStride', 'target', 'name']),
  buffers: new Set(['byteLength']),
};
const ATTRS = new Set(['POSITION', 'NORMAL', 'COLOR_0']);
const COMPONENT_BYTES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const TYPE_COUNT = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function only(obj, allowed, where) {
  for (const k of Object.keys(obj)) if (!allowed.has(k)) throw new Error(`${where}: "${k}" is not plain geometry`);
}

export function checkGlb(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 28 || dv.getUint32(0, true) !== 0x46546c67) throw new Error('not a GLB file');
  if (dv.getUint32(4, true) !== 2) throw new Error('not glTF version 2');
  if (dv.getUint32(8, true) !== bytes.length) throw new Error('the stated length is not the length of the file');
  const jsonLen = dv.getUint32(12, true);
  if (dv.getUint32(16, true) !== 0x4e4f534a) throw new Error('the first chunk is not JSON');
  const jsonText = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(20, 20 + jsonLen));
  const json = JSON.parse(jsonText);
  let at = 20 + jsonLen, bin = null;
  if (at < bytes.length) {
    const len = dv.getUint32(at, true);
    if (dv.getUint32(at + 4, true) !== 0x004e4942) throw new Error('the second chunk is not the geometry buffer');
    bin = bytes.subarray(at + 8, at + 8 + len);
    at += 8 + len;
  }
  if (at !== bytes.length) throw new Error('there is something after the geometry buffer');

  only(json, GLB_TOP, 'file');
  only(json.asset ?? {}, KEYS.asset, 'asset');
  for (const s of json.scenes ?? []) only(s, KEYS.scenes, 'scene');
  for (const n of json.nodes ?? []) only(n, KEYS.nodes, 'node');
  for (const m of json.materials ?? []) { only(m, KEYS.materials, 'material'); only(m.pbrMetallicRoughness ?? {}, KEYS.pbr, 'material colour'); }
  for (const a of json.accessors ?? []) only(a, KEYS.accessors, 'accessor');
  for (const v of json.bufferViews ?? []) only(v, KEYS.bufferViews, 'buffer view');
  if ((json.buffers ?? []).length !== 1) throw new Error('expected exactly one buffer');
  only(json.buffers[0], KEYS.buffers, 'buffer');
  if (!bin || json.buffers[0].byteLength > bin.length || bin.length - json.buffers[0].byteLength > 3) throw new Error('the buffer is not the size it states');

  // every accessor used is geometry; every byte of the buffer belongs to one
  const used = new Uint8Array(bin.length);
  let triangles = 0;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  const claim = idx => {
    const a = json.accessors[idx];
    if (!a || a.bufferView === undefined) throw new Error('an accessor without data');
    const v = json.bufferViews[a.bufferView];
    const size = COMPONENT_BYTES[a.componentType] * TYPE_COUNT[a.type];
    if (!size) throw new Error('an accessor of an unknown type');
    const stride = v.byteStride ?? size;
    const start = (v.byteOffset ?? 0) + (a.byteOffset ?? 0);
    const end = start + (a.count - 1) * stride + size;
    if (end > (v.byteOffset ?? 0) + v.byteLength || end > bin.length) throw new Error('an accessor runs past its data');
    for (let i = 0; i < a.count; i++) used.fill(1, start + i * stride, start + i * stride + size);
    return { a, start, stride };
  };
  const seen = new Set();
  for (const m of json.meshes ?? []) {
    only(m, KEYS.meshes, 'mesh');
    for (const p of m.primitives) {
      only(p, KEYS.primitives, 'primitive');
      if ((p.mode ?? 4) !== 4) throw new Error('a primitive that is not triangles');
      for (const [name, idx] of Object.entries(p.attributes)) {
        if (!ATTRS.has(name)) throw new Error(`attribute ${name} is not plain geometry`);
        const { a, start, stride } = claim(idx);
        if (name === 'POSITION') {
          if (a.componentType !== 5126 || a.type !== 'VEC3') throw new Error('positions are not float triples');
          if (!seen.has(idx)) {
            const d = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
            for (let i = 0; i < a.count; i++) for (let k = 0; k < 3; k++) {
              const x = d.getFloat32(start + i * stride + k * 4, true);
              if (!Number.isFinite(x)) throw new Error('a position that is not a number');
              if (x < lo[k]) lo[k] = x; if (x > hi[k]) hi[k] = x;
            }
          }
          if (p.indices === undefined) triangles += a.count / 3;
        }
        seen.add(idx);
      }
      if (p.indices !== undefined) { const { a } = claim(p.indices); triangles += a.count / 3; seen.add(p.indices); }
    }
  }
  if (seen.size !== (json.accessors ?? []).length) throw new Error('data that no mesh uses');
  let loose = 0;
  for (let i = 0; i < bin.length; i++) if (!used[i]) { if (bin[i] !== 0) throw new Error('bytes in the buffer that belong to no mesh'); loose++; }
  if (loose > 4 * ((json.bufferViews ?? []).length + 1)) throw new Error('unexplained empty space in the buffer');

  const text = [];
  if (json.asset?.generator) text.push(json.asset.generator);
  for (const list of [json.scenes, json.nodes, json.meshes, json.materials, json.accessors, json.bufferViews]) for (const x of list ?? []) if (x.name) text.push(x.name);
  return { kind: 'glb', triangles, bounds: [lo, hi], text: [...new Set(text)] };
}

export function checkStl(bytes) {
  if (bytes.length < 84) throw new Error('too short for an STL file');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = dv.getUint32(80, true);
  if (bytes.length !== 84 + n * 50) throw new Error('not a binary STL of the size it states');
  let end = 80;
  while (end > 0 && bytes[end - 1] === 0) end--;
  for (let i = 0; i < end; i++) if (bytes[i] < 32 || bytes[i] > 126) throw new Error('the header is not plain text');
  const header = new TextDecoder().decode(bytes.subarray(0, end)).trim();
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let t = 0; t < n; t++) {
    const o = 84 + t * 50;
    for (let f = 0; f < 12; f++) {
      const x = dv.getFloat32(o + f * 4, true);
      if (!Number.isFinite(x)) throw new Error('a coordinate that is not a number');
      if (f >= 3) { const k = (f - 3) % 3; if (x < lo[k]) lo[k] = x; if (x > hi[k]) hi[k] = x; }
    }
    if (dv.getUint16(o + 48, true) !== 0) throw new Error('extra bytes attached to a triangle');
  }
  return { kind: 'stl', triangles: n, bounds: [lo, hi], text: header ? [header] : [] };
}

export const checkMesh = (path, bytes) => path.endsWith('.glb') ? checkGlb(bytes) : checkStl(bytes);
