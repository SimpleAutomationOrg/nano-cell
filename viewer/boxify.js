// Decompose a (closed) triangle mesh into axis-aligned boxes, in the
// mesh's own frame. Used to build MuJoCo collision geometry: MuJoCo
// takes the CONVEX HULL of a mesh asset, which fills cavities — a
// pocket becomes a solid block. Boxes collide exactly.
//
// Method: a grid of vertical columns over the xy bounding box; one ray
// per column collects triangle crossings; even-odd parity gives the
// solid z-intervals; adjacent columns with identical intervals merge
// into boxes (run-length, y then x). Upright prismatic shapes (pockets,
// trays, stands, slabs) come out exact to the cell size; slanted faces
// become a staircase at the cell size.

export function boxify(tris, { cell = 0.004 } = {}) {
  const nTri = tris.length / 9;
  if (!nTri) return [];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < tris.length; i += 3) {
    if (tris[i] < minX) minX = tris[i];
    if (tris[i] > maxX) maxX = tris[i];
    if (tris[i + 1] < minY) minY = tris[i + 1];
    if (tris[i + 1] > maxY) maxY = tris[i + 1];
  }
  const nx = Math.max(1, Math.ceil((maxX - minX) / cell));
  const ny = Math.max(1, Math.ceil((maxY - minY) / cell));

  // bin triangles by xy bbox so each column tests few of them
  const bins = Array.from({ length: nx * ny }, () => []);
  for (let t = 0; t < nTri; t++) {
    const xs = [tris[t * 9], tris[t * 9 + 3], tris[t * 9 + 6]];
    const ys = [tris[t * 9 + 1], tris[t * 9 + 4], tris[t * 9 + 7]];
    const ix0 = Math.max(0, Math.floor((Math.min(...xs) - minX) / cell));
    const ix1 = Math.min(nx - 1, Math.floor((Math.max(...xs) - minX) / cell));
    const iy0 = Math.max(0, Math.floor((Math.min(...ys) - minY) / cell));
    const iy1 = Math.min(ny - 1, Math.floor((Math.max(...ys) - minY) / cell));
    for (let ix = ix0; ix <= ix1; ix++)
      for (let iy = iy0; iy <= iy1; iy++) bins[ix * ny + iy].push(t);
  }

  // vertical ray through a column centre (jittered off edges/vertices):
  // z crossings by even-odd parity → solid intervals
  const jx = 0.137 * cell, jy = 0.219 * cell;
  function columnIntervals(ix, iy) {
    const px = minX + (ix + 0.5) * cell + jx;
    const py = minY + (iy + 0.5) * cell + jy;
    const zs = [];
    for (const t of bins[ix * ny + iy]) {
      const ax = tris[t * 9], ay = tris[t * 9 + 1], az = tris[t * 9 + 2];
      const bx = tris[t * 9 + 3], by = tris[t * 9 + 4], bz = tris[t * 9 + 5];
      const cx = tris[t * 9 + 6], cy = tris[t * 9 + 7], cz = tris[t * 9 + 8];
      const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
      if (Math.abs(d) < 1e-14) continue;              // vertical triangle
      const w0 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / d;
      const w1 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / d;
      const w2 = 1 - w0 - w1;
      if (w0 < 0 || w1 < 0 || w2 < 0) continue;
      zs.push(w0 * az + w1 * bz + w2 * cz);
    }
    zs.sort((a, b) => a - b);
    // dedupe near-identical crossings (coincident faces of adjacent pieces)
    const uniq = [];
    for (const z of zs) {
      if (!uniq.length || z - uniq[uniq.length - 1] > 1e-6) uniq.push(z);
      else uniq.pop();                                 // cancelled pair
    }
    const ivals = [];
    for (let i = 0; i + 1 < uniq.length; i += 2) ivals.push([uniq[i], uniq[i + 1]]);
    return ivals;
  }

  // signature per column, run-length merge along y, then along x
  const sig = ivals => ivals.map(([a, b]) => `${Math.round(a * 1e4)}:${Math.round(b * 1e4)}`).join('|');
  const strips = []; // {ix, iy0, iy1, ivals, s}
  for (let ix = 0; ix < nx; ix++) {
    let run = null;
    for (let iy = 0; iy <= ny; iy++) {
      const ivals = iy < ny ? columnIntervals(ix, iy) : [];
      const s = sig(ivals);
      if (run && run.s === s && s !== '') { run.iy1 = iy; continue; }
      if (run && run.s !== '') strips.push(run);
      run = s === '' ? null : { ix, iy0: iy, iy1: iy + 1, ivals, s };
      if (run) run.iy1 = iy + 1;
    }
    if (run && run.s !== '') strips.push(run);
  }
  const boxes = [];
  const used = new Set();
  for (let i = 0; i < strips.length; i++) {
    if (used.has(i)) continue;
    const a = strips[i];
    let ix1 = a.ix + 1;
    for (let j = i + 1; j < strips.length; j++) {
      const b = strips[j];
      if (used.has(j) || b.ix !== ix1 || b.iy0 !== a.iy0 || b.iy1 !== a.iy1 || b.s !== a.s) continue;
      used.add(j); ix1++;
    }
    for (const [z0, z1] of a.ivals) {
      if (z1 - z0 < 1e-5) continue;
      boxes.push({
        center: [
          minX + ((a.ix + ix1) / 2) * cell,
          minY + ((a.iy0 + a.iy1) / 2) * cell,
          (z0 + z1) / 2,
        ],
        size: [(ix1 - a.ix) * cell, (a.iy1 - a.iy0) * cell, z1 - z0],
      });
    }
  }
  return boxes;
}
