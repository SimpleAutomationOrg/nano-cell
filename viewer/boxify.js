// Decompose a (closed) triangle mesh into axis-aligned boxes, in the
// mesh's own frame. Used to build MuJoCo collision geometry: MuJoCo
// takes the CONVEX HULL of a mesh asset, which fills cavities — a
// pocket becomes a solid block. Boxes collide exactly.
//
// Method: a NON-UNIFORM grid of vertical columns whose lines come from
// the mesh's own axis-perpendicular faces (with `cell` as the maximum
// spacing for curved/diagonal regions); one ray per column collects
// triangle crossings; even-odd parity gives the solid z-intervals;
// adjacent columns with identical intervals merge into boxes. Vertical
// extents are exact (analytic crossings); axis-aligned walls are exact
// because the grid lines sit ON them; only slanted faces staircase.

export function boxify(tris, { cell = 0.004, exactWalls = true } = {}) {
  const nTri = tris.length / 9;
  if (!nTri) return [];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < tris.length; i += 3) {
    if (tris[i] < minX) minX = tris[i];
    if (tris[i] > maxX) maxX = tris[i];
    if (tris[i + 1] < minY) minY = tris[i + 1];
    if (tris[i + 1] > maxY) maxY = tris[i + 1];
  }

  // Grid lines FROM THE GEOMETRY: every axis-perpendicular face plants a
  // line at its exact coordinate, so axis-aligned walls (pockets, case
  // sides — where tight fits live) are reproduced exactly; `cell` is only
  // the MAXIMUM spacing, subdividing curved and diagonal regions.
  const xsSet = new Set([q(minX), q(maxX)]), ysSet = new Set([q(minY), q(maxY)]);
  function q(v) { return Math.round(v * 1e5) / 1e5; }   // 0.01 mm
  for (let t = 0; t < nTri; t++) {
    const ax = tris[t * 9], ay = tris[t * 9 + 1], az = tris[t * 9 + 2];
    const bx = tris[t * 9 + 3], by = tris[t * 9 + 4], bz = tris[t * 9 + 5];
    const cx = tris[t * 9 + 6], cy = tris[t * 9 + 7], cz = tris[t * 9 + 8];
    const nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    const nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const nl = Math.hypot(nx, ny, nz);
    if (nl < 1e-12) continue;
    if (exactWalls && Math.abs(nx / nl) > 0.999) xsSet.add(q(ax));
    if (exactWalls && Math.abs(ny / nl) > 0.999) ysSet.add(q(ay));
  }
  const densify = set => {
    const lines = [...set].sort((a, b) => a - b);
    const out = [lines[0]];
    for (let i = 1; i < lines.length; i++) {
      const gap = lines[i] - out[out.length - 1];
      const n = Math.ceil(gap / cell);
      if (n > 1) for (let k = 1; k < n; k++) out.push(lines[i - 1] + (gap * k) / n);
      out.push(lines[i]);
    }
    return [...new Set(out.map(q))].sort((a, b) => a - b);
  };
  const xs = densify(xsSet), ys = densify(ysSet);
  const nx2 = xs.length - 1, ny2 = ys.length - 1;
  if (nx2 < 1 || ny2 < 1) return [];

  // bin triangles by covered columns (binary search over the lines)
  const lower = (lines, v) => {
    let lo = 0, hi = lines.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lines[mid] <= v) lo = mid; else hi = mid - 1; }
    return lo;
  };
  const bins = Array.from({ length: nx2 * ny2 }, () => []);
  for (let t = 0; t < nTri; t++) {
    const x0 = Math.min(tris[t * 9], tris[t * 9 + 3], tris[t * 9 + 6]);
    const x1 = Math.max(tris[t * 9], tris[t * 9 + 3], tris[t * 9 + 6]);
    const y0 = Math.min(tris[t * 9 + 1], tris[t * 9 + 4], tris[t * 9 + 7]);
    const y1 = Math.max(tris[t * 9 + 1], tris[t * 9 + 4], tris[t * 9 + 7]);
    const ix0 = Math.max(0, Math.min(nx2 - 1, lower(xs, x0)));
    const ix1 = Math.max(0, Math.min(nx2 - 1, lower(xs, x1 - 1e-9)));
    const iy0 = Math.max(0, Math.min(ny2 - 1, lower(ys, y0)));
    const iy1 = Math.max(0, Math.min(ny2 - 1, lower(ys, y1 - 1e-9)));
    for (let ix = ix0; ix <= ix1; ix++)
      for (let iy = iy0; iy <= iy1; iy++) bins[ix * ny2 + iy].push(t);
  }

  // one vertical ray per column (at the cell centre — safely interior
  // between exact wall lines); even-odd parity → solid z-intervals
  function columnIntervals(ix, iy) {
    const px = (xs[ix] + xs[ix + 1]) / 2;
    const py = (ys[iy] + ys[iy + 1]) / 2;
    const zs = [];
    for (const t of bins[ix * ny2 + iy]) {
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
  const sig = ivals => ivals.map(([a, b]) => `${Math.round(a * 1e5)}:${Math.round(b * 1e5)}`).join('|');
  const strips = []; // {ix, iy0, iy1, ivals, s}
  for (let ix = 0; ix < nx2; ix++) {
    let run = null;
    for (let iy = 0; iy <= ny2; iy++) {
      const ivals = iy < ny2 ? columnIntervals(ix, iy) : [];
      const s2 = sig(ivals);
      if (run && run.s === s2 && s2 !== '') { run.iy1 = iy + 1; continue; }
      if (run && run.s !== '') strips.push(run);
      run = s2 === '' ? null : { ix, iy0: iy, iy1: iy + 1, ivals, s: s2 };
    }
    if (run && run.s !== '') strips.push(run);
  }
  const boxes = [];
  const used = new Set();
  for (let i = 0; i < strips.length; i++) {
    if (used.has(i)) continue;
    const a = strips[i];
    let ixEnd = a.ix + 1;
    for (let j = i + 1; j < strips.length; j++) {
      const b = strips[j];
      if (used.has(j) || b.ix !== ixEnd || b.iy0 !== a.iy0 || b.iy1 !== a.iy1 || b.s !== a.s) continue;
      used.add(j); ixEnd++;
    }
    for (const [z0, z1] of a.ivals) {
      if (z1 - z0 < 1e-5) continue;
      boxes.push({
        center: [(xs[a.ix] + xs[ixEnd]) / 2, (ys[a.iy0] + ys[a.iy1]) / 2, (z0 + z1) / 2],
        size: [xs[ixEnd] - xs[a.ix], ys[a.iy1] - ys[a.iy0], z1 - z0],
      });
    }
  }
  return boxes;
}
