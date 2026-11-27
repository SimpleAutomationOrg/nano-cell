// Collision world for the nano cell: static geometry (fixtures, parts) is
// sampled from the repo's *.collision.stl files into a point cloud in a
// spatial hash; the arm is capsules fitted to the link meshes. A query is
// capsule-vs-points, which is robust as long as the capsule radius is well
// above the ~1 cm sampling pitch (arm links are 4-6 cm).

import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';

const PITCH = 0.01;          // target sample spacing, m
const DENSITY = 1 / (PITCH * PITCH);
const MAX_SAMPLES = 3000;    // per mesh
const CELL = 0.05;           // hash cell, m

const stl = new STLLoader();
const loadStl = url => new Promise((res, rej) => stl.load(url, res, undefined, rej));

// area-weighted surface samples of a (non-indexed) BufferGeometry, local frame
function sampleGeometry(geo) {
  const p = geo.attributes.position.array;
  const tris = p.length / 9;
  const pts = [];
  const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3();
  let totalArea = 0;
  const areas = new Array(tris);
  for (let t = 0; t < tris; t++) {
    A.fromArray(p, t * 9); B.fromArray(p, t * 9 + 3); C.fromArray(p, t * 9 + 6);
    areas[t] = B.clone().sub(A).cross(C.clone().sub(A)).length() / 2;
    totalArea += areas[t];
  }
  const budget = Math.min(MAX_SAMPLES, Math.max(50, Math.round(totalArea * DENSITY)));
  for (let t = 0; t < tris; t++) {
    A.fromArray(p, t * 9); B.fromArray(p, t * 9 + 3); C.fromArray(p, t * 9 + 6);
    const n = Math.max(1, Math.round(budget * areas[t] / (totalArea || 1)));
    for (let i = 0; i < n; i++) {
      let u = Math.random(), v = Math.random();
      if (u + v > 1) { u = 1 - u; v = 1 - v; }
      pts.push([
        A.x + (B.x - A.x) * u + (C.x - A.x) * v,
        A.y + (B.y - A.y) * u + (C.y - A.y) * v,
        A.z + (B.z - A.z) * u + (C.z - A.z) * v,
      ]);
    }
  }
  return pts;
}

const applyMat = (m, p) => [
  m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
  m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
  m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
];

export class CollisionWorld {
  constructor() {
    this.items = new Map();   // id -> { local: pts, mat, world: pts, active }
    this.hash = new Map();    // "i,j,k" -> [[x,y,z,id], ...]
    this.maxZ = 0;
  }

  async addStl(id, url, mat) {
    try {
      const geo = await loadStl(url);
      this.items.set(id, { local: sampleGeometry(geo), mat, active: false });
      this.place(id, mat);
    } catch { console.warn('collision mesh failed:', url); }
  }

  addBox(id, size, mat) { // fallback for items with no collision mesh
    const pts = [];
    const [sx, sy, sz] = size;
    for (let i = 0; i < 200; i++)
      pts.push([(Math.random() - .5) * sx, (Math.random() - .5) * sy, Math.random() * sz]);
    this.items.set(id, { local: pts, mat, active: false });
    this.place(id, mat);
  }

  key(x, y, z) {
    return `${Math.floor(x / CELL)},${Math.floor(y / CELL)},${Math.floor(z / CELL)}`;
  }

  place(id, mat) {   // (re)insert an item's points at a pose
    this.remove(id);
    const it = this.items.get(id);
    if (!it) return;
    it.mat = mat;
    it.active = true;
    for (const p of it.local) {
      const w = applyMat(mat, p);
      const k = this.key(w[0], w[1], w[2]);
      let cell = this.hash.get(k);
      if (!cell) this.hash.set(k, cell = []);
      cell.push([w[0], w[1], w[2], id]);
      if (w[2] > this.maxZ) this.maxZ = w[2];
    }
  }

  remove(id) {
    const it = this.items.get(id);
    if (!it || !it.active) return;
    for (const [k, cell] of this.hash) {
      const kept = cell.filter(p => p[3] !== id);
      if (kept.length) this.hash.set(k, kept); else this.hash.delete(k);
    }
    it.active = false;
  }

  // highest obstacle point within `halfWidth` of the 2D segment a→b
  // (table frame), skipping ignored item ids — the corridor a transfer sweeps
  maxZInCorridor(a, b, halfWidth, ignore) {
    let maxZ = 0;
    const ab = [b[0] - a[0], b[1] - a[1]];
    const len2 = ab[0] * ab[0] + ab[1] * ab[1];
    for (const cell of this.hash.values())
      for (const p of cell) {
        if (ignore?.has(p[3])) continue;
        let t = len2 > 1e-12 ? ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / len2 : 0;
        t = Math.max(0, Math.min(1, t));
        const d = Math.hypot(p[0] - a[0] - ab[0] * t, p[1] - a[1] - ab[1] * t);
        if (d < halfWidth && p[2] > maxZ) maxZ = p[2];
      }
    return maxZ;
  }

  // nearest offending point to the capsule [a, b] with radius r, or null.
  // `ignore` is a Set of item ids to skip (e.g. the part being grasped).
  hitCapsule(a, b, r, ignore) {
    const lo = [Math.min(a[0], b[0]) - r, Math.min(a[1], b[1]) - r, Math.min(a[2], b[2]) - r];
    const hi = [Math.max(a[0], b[0]) + r, Math.max(a[1], b[1]) + r, Math.max(a[2], b[2]) + r];
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const len2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2;
    let best = null, bestD = r;
    for (let i = Math.floor(lo[0] / CELL); i <= Math.floor(hi[0] / CELL); i++)
      for (let j = Math.floor(lo[1] / CELL); j <= Math.floor(hi[1] / CELL); j++)
        for (let k = Math.floor(lo[2] / CELL); k <= Math.floor(hi[2] / CELL); k++) {
          const cell = this.hash.get(`${i},${j},${k}`);
          if (!cell) continue;
          for (const p of cell) {
            if (ignore && ignore.has(p[3])) continue;
            let t = 0;
            if (len2 > 1e-12) {
              t = ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1] + (p[2] - a[2]) * ab[2]) / len2;
              t = Math.max(0, Math.min(1, t));
            }
            const d = Math.hypot(p[0] - a[0] - ab[0] * t, p[1] - a[1] - ab[1] * t, p[2] - a[2] - ab[2] * t);
            if (d < bestD) { bestD = d; best = { point: [p[0], p[1], p[2]], item: p[3], dist: d }; }
          }
        }
    return best;
  }
}

// Bounding box of a subtree in the frame of `root` itself (not world space).
function localBox(root) {
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  root.traverse(o => {
    if (!o.isMesh || !o.geometry) return;
    o.geometry.computeBoundingBox();
    const bb = o.geometry.boundingBox;
    // compose o's transform relative to root
    const rel = new THREE.Matrix4();
    let n = o;
    while (n && n !== root) { n.updateMatrix(); rel.premultiply(n.matrix); n = n.parent; }
    for (let c = 0; c < 8; c++) {
      v.set(c & 1 ? bb.max.x : bb.min.x, c & 2 ? bb.max.y : bb.min.y, c & 4 ? bb.max.z : bb.min.z);
      box.expandByPoint(v.applyMatrix4(rel));
    }
  });
  return box;
}

// Fit a capsule (in the object's own frame) to a loaded mesh subtree.
export function capsuleFromObject(obj, { minR = 0.03, shrink = 0.9 } = {}) {
  const box = localBox(obj);
  if (box.isEmpty()) return null;
  const size = box.getSize(new THREE.Vector3()).toArray();
  const center = box.getCenter(new THREE.Vector3()).toArray();
  const axis = size.indexOf(Math.max(...size));
  const others = [0, 1, 2].filter(i => i !== axis);
  const r = Math.max(minR, Math.max(size[others[0]], size[others[1]]) / 2 * shrink);
  const half = Math.max(0, size[axis] / 2 - r);
  const a = [...center], b = [...center];
  a[axis] -= half; b[axis] += half;
  return { a, b, r };
}
