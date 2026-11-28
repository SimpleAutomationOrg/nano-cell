// The CAD designer's kernel: Open CASCADE (WebAssembly, through replicad)
// plus what the designer's tools share — reading a STEP as exact geometry,
// measuring it (sizes, bores and bosses, flat faces), checking a fit
// between two shapes, and drawing shaded views to a PNG so a design can be
// LOOKED AT. Used by model-step.mjs, inspect-step.mjs and look.mjs.
// Lengths are millimetres throughout (STEP's unit); the cell's own files
// are metres and are converted where they are read.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { deflateSync } from 'node:zlib';

const require = createRequire(import.meta.url);
let R = null;
// the replicad API with the kernel loaded (once per process)
export const kernel = async () => {
  if (R) return R;
  const r = await import('replicad');
  const { default: opencascade } = await import('replicad-opencascadejs');
  // print: the kernel's own transfer statistics are noise here
  r.setOC(await opencascade({ locateFile: () => require.resolve('replicad-opencascadejs/wasm'), print: () => {} }));
  return (R = r);
};

// a STEP file as one exact shape (every body in it; .solids lists them)
export const loadStep = async path => (await kernel()).importSTEP(new Blob([readFileSync(path)]));

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b, s = 1) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = a => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const xyz = v => { const p = [v.x, v.y, v.z]; v.delete?.(); return p; };
export const fmt = (v, d = 3) => (Math.abs(v) < 0.5 * 10 ** -d ? 0 : v).toFixed(d);
export const fmt3 = (p, d = 3) => p.map(v => fmt(v, d)).join(', ');

// size, place and mass properties of a solid shape
export const describe = (r, shape) => {
  const [lo, hi] = shape.boundingBox.bounds;
  const props = r.measureShapeVolumeProperties(shape);
  return { lo, hi, size: hi.map((v, k) => v - lo[k]), volume: props.volume, centre: props.centerOfMass };
};

// The faces that matter when something has to mate with a part:
//  cylinders — bores and bosses: diameter, axis line, where along it, and
//              whether it is a full circle (a hole) or an arc (a fillet);
//  planes    — flat faces by outward normal and offset along it, with area.
// Measured from the exact surfaces, not from a mesh. Faces of one bore that
// the CAD split in halves are joined.
export const features = (r, shape) => {
  const cyl = new Map(), planes = new Map();
  const key = (...v) => v.map(x => fmt(x, 2)).join(' ');
  for (const f of shape.faces) {
    const type = f.geomType;
    if (type === 'CYLINDRE') {
      const { uMin, uMax, vMin, vMax } = f.UVBounds, du = uMax - uMin, step = Math.min(du, Math.PI / 2);
      const P = (u, v) => xyz(f.pointOnSurface(u, v));
      // UV bounds are normalised to 0..1 in replicad
      const pa = P(0, 0), pb = P(step / du, 0), pm = P(step / du / 2, 0), pc = P(0, 1);
      const chord = Math.hypot(...sub(pb, pa)), radius = chord / (2 * Math.sin(step / 2));
      const mid = add(pa, sub(pb, pa), 0.5), centre = add(mid, unit(sub(mid, pm)), radius * Math.cos(step / 2));
      let axis = unit(sub(pc, pa));
      if (!(radius > 1e-6) || !isFinite(radius) || Math.hypot(...sub(pc, pa)) < 1e-9) continue;
      // one sign for the axis, so both halves of a bore agree
      const lead = axis.find(c => Math.abs(c) > 1e-6);
      if (lead < 0) axis = axis.map(c => -c);
      const boss = dot(xyz(f.normalAt(pa)), sub(pa, centre)) > 0;
      const along = [dot(pa, axis), dot(pc, axis)].sort((a, b) => a - b);
      const foot = add(centre, axis, -dot(centre, axis));           // the axis line's point nearest the origin
      const k = key(radius, ...axis, ...foot, boss ? 1 : 0);
      const c = cyl.get(k) ?? cyl.set(k, { diameter: 2 * radius, axis, foot, boss, arc: 0, from: Infinity, to: -Infinity }).get(k);
      c.arc += du; c.from = Math.min(c.from, along[0]); c.to = Math.max(c.to, along[1]);
    } else if (type === 'PLANE') {
      const centre = xyz(f.center), n = unit(xyz(f.normalAt(centre))), area = r.measureArea(f);
      const k = key(...n, dot(n, centre));
      const p = planes.get(k) ?? planes.set(k, { normal: n, offset: dot(n, centre), area: 0, faces: 0 }).get(k);
      p.area += area; p.faces++;
    }
  }
  const cylinders = [...cyl.values()].map(c => ({
    ...c, full: c.arc > 2 * Math.PI - 1e-3, arc_deg: Math.min(360, c.arc * 180 / Math.PI),
    // where the axis meets the feature's two ends
    ends: [add(c.foot, c.axis, c.from), add(c.foot, c.axis, c.to)], length: c.to - c.from,
  })).sort((a, b) => b.full - a.full || a.boss - b.boss || a.diameter - b.diameter || a.from - b.from);
  return { cylinders, planes: [...planes.values()].sort((a, b) => b.area - a.area) };
};

// how two shapes sit together: the smallest gap between them, and how much
// material they share (0 when they do not interfere)
export const fit = (r, a, b) => {
  let overlap = 0;
  try { overlap = r.measureVolume(a.intersect(b)); } catch { overlap = 0; }
  if (!(overlap > 1e-6)) overlap = 0;
  return { overlap, gap: overlap ? 0 : r.measureDistanceBetween(a, b) };
};

// ---------------------------------------------------------------- drawing

// a shape as triangles (mm), fine enough to look at
export const meshOf = (shape, color = [0.8, 0.8, 0.8]) => {
  const m = shape.mesh({ tolerance: 0.05, angularTolerance: 0.2 });
  return { pos: Float32Array.from(m.vertices), idx: Uint32Array.from(m.triangles), color };
};

// a GLB written by step-to-mesh.mjs (metres) as drawable pieces in mm, one
// per body with its CAD colour; `pose` = { xyz_m, rpy } places it
export const meshesOfGlb = (path, pose) => {
  const buf = readFileSync(path), jsonLen = buf.readUInt32LE(12);
  const gltf = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8')), bin = buf.subarray(20 + jsonLen + 8);
  const arr = (i, T) => {
    const a = gltf.accessors[i], v = gltf.bufferViews[a.bufferView], n = a.count * (a.type === 'VEC3' ? 3 : 1);
    const start = bin.byteOffset + (v.byteOffset ?? 0) + (a.byteOffset ?? 0);
    return new T(bin.buffer.slice(start, start + n * T.BYTES_PER_ELEMENT));
  };
  const T = poseMatrix(pose);
  return gltf.meshes.flatMap(m => m.primitives).map(p => {
    const src = arr(p.attributes.POSITION, Float32Array), pos = new Float32Array(src.length);
    for (let i = 0; i < src.length; i += 3) for (let k = 0; k < 3; k++)
      pos[i + k] = (T[k][0] * src[i] + T[k][1] * src[i + 1] + T[k][2] * src[i + 2] + T[k][3]) * 1000;
    const kind = gltf.accessors[p.indices].componentType;
    return {
      pos, idx: Uint32Array.from(arr(p.indices, kind === 5125 ? Uint32Array : kind === 5123 ? Uint16Array : Uint8Array)),
      color: (gltf.materials?.[p.material]?.pbrMetallicRoughness?.baseColorFactor ?? [0.8, 0.8, 0.8]).slice(0, 3),
    };
  });
};

// the cell's pose convention: R = Rz(yaw) . Ry(pitch) . Rx(roll), metres
const poseMatrix = pose => {
  const [x, y, z] = pose?.xyz_m ?? [0, 0, 0], [ro, pi, ya] = pose?.rpy ?? [0, 0, 0];
  const cr = Math.cos(ro), sr = Math.sin(ro), cp = Math.cos(pi), sp = Math.sin(pi), cy = Math.cos(ya), sy = Math.sin(ya);
  return [
    [cy * cp, cy * sp * sr - sy * cr, cy * sp * cr + sy * sr, x],
    [sy * cp, sy * sp * sr + cy * cr, sy * sp * cr - cy * sr, y],
    [-sp, cp * sr, cp * cr, z],
  ];
};

// a box as a drawable piece (mm) — the breadboard under a layout
export const boxMesh = (lo, hi, color) => {
  const pos = [], idx = [];
  for (let i = 0; i < 8; i++) pos.push(i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]);
  for (const [a, b, c, d] of [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]]) idx.push(a, b, c, a, c, d);
  return { pos: Float32Array.from(pos), idx: Uint32Array.from(idx), color };
};

// The four views a drawing gives, as [name, direction TO the viewer, right, up]:
// an isometric from the front-right-top, then top, front and right.
const VIEWS = [
  ['isometric (from front, right, above)', unit([1, -1, 0.9])],
  ['top (x right, y up)', [0, 0, 1], [1, 0, 0], [0, 1, 0]],
  ['front (x right, z up)', [0, -1, 0]],
  ['right (y right, z up)', [1, 0, 0]],
].map(([name, d, right, up]) => {
  right ??= unit(cross([0, 0, 1], d));
  return { name, d, right, up: up ?? cross(d, right) };
});

// Draw pieces [{pos (mm), idx, color}] as a 2 x 2 sheet of shaded views
// with outlines, all at ONE scale, the frame's axes drawn at the origin
// (x red, y green, z blue). Returns what the caller should say about it.
export const drawSheet = (pieces, outPath, { tile = [760, 560] } = {}) => {
  const [tw, th] = tile, W = tw * 2, H = th * 2, img = new Uint8Array(W * H * 3).fill(255);
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const { pos } of pieces) for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], pos[i + k]); hi[k] = Math.max(hi[k], pos[i + k]); }
  const corners = Array.from({ length: 8 }, (_, i) => [i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]]);
  const spans = VIEWS.map(v => {
    const us = corners.map(c => dot(c, v.right)), vs = corners.map(c => dot(c, v.up));
    return { u0: Math.min(...us), u1: Math.max(...us), v0: Math.min(...vs), v1: Math.max(...vs) };
  });
  const margin = 28, scale = Math.min(...spans.map(s => Math.min((tw - 2 * margin) / (s.u1 - s.u0 || 1), (th - 2 * margin) / (s.v1 - s.v0 || 1))));
  const light = unit([0.35, -0.5, 0.8]), axisLen = 0.18 * Math.max(...hi.map((v, k) => v - lo[k]));

  VIEWS.forEach((view, vi) => {
    const ox = (vi % 2) * tw, oy = Math.floor(vi / 2) * th, s = spans[vi];
    const cx = ox + tw / 2 - scale * (s.u0 + s.u1) / 2, cy = oy + th / 2 + scale * (s.v0 + s.v1) / 2;
    const px = p => [cx + scale * dot(p, view.right), cy - scale * dot(p, view.up), dot(p, view.d)];
    const depth = new Float32Array(tw * th).fill(-Infinity), face = new Int32Array(tw * th).fill(-1);
    const shade = new Float32Array(tw * th * 3);
    pieces.forEach((piece, pi) => {
      const { pos, idx, color } = piece;
      for (let t = 0; t < idx.length; t += 3) {
        const A = [pos[idx[t] * 3], pos[idx[t] * 3 + 1], pos[idx[t] * 3 + 2]];
        const B = [pos[idx[t + 1] * 3], pos[idx[t + 1] * 3 + 1], pos[idx[t + 1] * 3 + 2]];
        const C = [pos[idx[t + 2] * 3], pos[idx[t + 2] * 3 + 1], pos[idx[t + 2] * 3 + 2]];
        let n = cross(sub(B, A), sub(C, A));
        const nl = Math.hypot(...n); if (!(nl > 0)) continue;
        n = n.map(c => c / nl);
        if (dot(n, view.d) < 0) n = n.map(c => -c);                 // light both sides: meshes are not always oriented
        const lum = 0.38 + 0.62 * Math.max(0, dot(n, light));
        // faces that turn (an edge) get a different id; a smooth wall keeps one
        const id = pi * 4096 + (Math.round(n[0] * 6) + 7) * 225 + (Math.round(n[1] * 6) + 7) * 15 + Math.round(n[2] * 6) + 7;
        const a = px(A), b = px(B), c = px(C);
        const x0 = Math.max(ox, Math.floor(Math.min(a[0], b[0], c[0]))), x1 = Math.min(ox + tw - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
        const y0 = Math.max(oy, Math.floor(Math.min(a[1], b[1], c[1]))), y1 = Math.min(oy + th - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
        const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
        if (Math.abs(area) < 1e-9) continue;
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
          const w0 = ((b[0] - x) * (c[1] - y) - (b[1] - y) * (c[0] - x)) / area;
          const w1 = ((c[0] - x) * (a[1] - y) - (c[1] - y) * (a[0] - x)) / area;
          const w2 = 1 - w0 - w1;
          if (w0 < -1e-4 || w1 < -1e-4 || w2 < -1e-4) continue;
          const z = w0 * a[2] + w1 * b[2] + w2 * c[2], q = (y - oy) * tw + (x - ox);
          if (z <= depth[q]) continue;
          depth[q] = z; face[q] = id;
          for (let k = 0; k < 3; k++) shade[q * 3 + k] = color[k] * lum;
        }
      }
    });
    // paint, with a dark line wherever the surface breaks: a silhouette, a
    // step in depth, or a change of face
    const step = 1.5 / scale + 0.4;
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
      const q = y * tw + x, o = ((oy + y) * W + ox + x) * 3;
      let edge = false;
      for (const [dx, dy] of [[1, 0], [0, 1]]) {
        if (x + dx >= tw || y + dy >= th) continue;
        const q2 = q + dy * tw + dx;
        if (face[q] !== face[q2] || Math.abs(depth[q] - depth[q2]) > step * 4) { edge = face[q] >= 0 || face[q2] >= 0; if (edge) break; }
      }
      if (face[q] < 0 && !edge) continue;
      for (let k = 0; k < 3; k++) img[o + k] = edge ? 40 : Math.round(255 * Math.min(1, shade[q * 3 + k]));
    }
    // the frame's axes at the origin, over everything
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]].forEach((ax, k) => {
      const a = px([0, 0, 0]), b = px(ax.map(c => c * axisLen)), n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]));
      for (let i = 0; i <= n; i++) for (const [dx, dy] of [[0, 0], [1, 0], [0, 1]]) {
        const x = Math.round(a[0] + (b[0] - a[0]) * i / (n || 1)) + dx, y = Math.round(a[1] + (b[1] - a[1]) * i / (n || 1)) + dy;
        if (x < ox || x >= ox + tw || y < oy || y >= oy + th) continue;
        const o = (y * W + x) * 3; img[o] = k === 0 ? 220 : 0; img[o + 1] = k === 1 ? 160 : 0; img[o + 2] = k === 2 ? 230 : 0;
      }
    });
    // a thin frame around the view
    for (let x = 0; x < tw; x++) for (const y of [0, th - 1]) img.fill(200, ((oy + y) * W + ox + x) * 3, ((oy + y) * W + ox + x) * 3 + 3);
    for (let y = 0; y < th; y++) for (const x of [0, tw - 1]) img.fill(200, ((oy + y) * W + ox + x) * 3, ((oy + y) * W + ox + x) * 3 + 3);
  });
  writePng(outPath, W, H, img);
  return `${outPath}: ${VIEWS.map((v, i) => `${['top-left', 'top-right', 'bottom-left', 'bottom-right'][i]} ${v.name}`).join('; ')}. ` +
    `One scale: ${fmt(scale, 2)} px per mm (100 px = ${fmt(100 / scale, 1)} mm). Axes at the frame origin: x red, y green, z blue, ${fmt(axisLen, 1)} mm long.`;
};

const crcTable = Array.from({ length: 256 }, (_, n) => { for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
const crc = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const writePng = (path, w, h, rgb) => {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]), out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc(body), body.length + 4);
    return out;
  };
  const head = Buffer.alloc(13); head.writeUInt32BE(w, 0); head.writeUInt32BE(h, 4); head[8] = 8; head[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) Buffer.from(rgb.buffer, y * w * 3, w * 3).copy(raw, y * (w * 3 + 1) + 1);
  writeFileSync(path, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
};
