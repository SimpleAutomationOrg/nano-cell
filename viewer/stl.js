// Binary STL utilities, dependency-free (browser and node).
//
// Collision meshes store every connected component as one convex piece.
// MuJoCo hulls each mesh ASSET as a whole, so a multi-piece mesh must be
// split into its components first — otherwise a pocket becomes a solid
// block (the hull has no cavity).

// parse binary STL → Float32Array of vertices, 9 floats per triangle
export function parseBinaryStl(buffer) {
  const dv = new DataView(buffer);
  const n = dv.getUint32(80, true);
  const tris = new Float32Array(n * 9);
  let off = 84;
  for (let t = 0; t < n; t++) {
    off += 12; // skip normal
    for (let k = 0; k < 9; k++) {
      tris[t * 9 + k] = dv.getFloat32(off, true);
      off += 4;
    }
    off += 2; // attribute byte count
  }
  return tris;
}

// split triangles into connected components (shared vertices, quantized
// to 1 µm). Returns an array of Float32Array triangle soups.
export function splitComponents(tris) {
  const nTri = tris.length / 9;
  const key = (x, y, z) =>
    `${Math.round(x * 1e6)},${Math.round(y * 1e6)},${Math.round(z * 1e6)}`;

  // union-find over triangles, joined through shared vertex keys
  const parent = new Int32Array(nTri);
  for (let i = 0; i < nTri; i++) parent[i] = i;
  const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };

  const seen = new Map(); // vertex key -> first triangle index
  for (let t = 0; t < nTri; t++) {
    for (let v = 0; v < 3; v++) {
      const k = key(tris[t * 9 + v * 3], tris[t * 9 + v * 3 + 1], tris[t * 9 + v * 3 + 2]);
      const first = seen.get(k);
      if (first === undefined) seen.set(k, t);
      else union(t, first);
    }
  }
  const groups = new Map();
  for (let t = 0; t < nTri; t++) {
    const r = find(t);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(t);
  }
  return [...groups.values()].map(idxs => {
    const out = new Float32Array(idxs.length * 9);
    idxs.forEach((t, i) => out.set(tris.subarray(t * 9, t * 9 + 9), i * 9));
    return out;
  });
}

// triangle soup → binary STL ArrayBuffer
export function writeBinaryStl(tris) {
  const nTri = tris.length / 9;
  const buf = new ArrayBuffer(84 + nTri * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, nTri, true);
  let off = 84;
  for (let t = 0; t < nTri; t++) {
    off += 12; // zero normal: MuJoCo recomputes
    for (let k = 0; k < 9; k++) {
      dv.setFloat32(off, tris[t * 9 + k], true);
      off += 4;
    }
    off += 2;
  }
  return buf;
}
