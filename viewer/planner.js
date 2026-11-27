// The pure planning layer: commands → joint paths. No three.js, no DOM,
// no animation — importable under node for tests. The host (cell-host.js)
// animates what this module plans.
//
// Frames: table (z up, metres). A "pose" is a 4x4 row-major matrix or
// {xyz_m, rpy}. Joint paths are arrays of 6-vectors (radians).

import * as IK from './ik.js';

const d2r = d => d * Math.PI / 180;
const r2d = r => r * 180 / Math.PI;

export const JVMAX = [3.15, 3.15, 3.15, 3.2, 3.2, 3.2]; // FR3 URDF, rad/s
export const FULL_TIP_MPS = 1.0;
const MARGIN = 0.004;

const applyMat = (m, p) => [
  m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
  m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
  m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
];
const rotOnly = (m, v) => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[4] * v[0] + m[5] * v[1] + m[6] * v[2],
  m[8] * v[0] + m[9] * v[1] + m[10] * v[2],
];


// Min-area bounding rectangle of a point cloud's xy footprint: the LONG
// edge azimuth and the OUTLINE centre (rad / metres, table frame).
// Deliberately not statistics: centroids and principal components drift
// with interior feature density; the rectangle follows the outline, which
// is what physical centring and alignment mean.
export function footprintRect(pts, matrix) {
  const step = Math.max(1, Math.floor(pts.length / 600));
  const w = [];
  for (let i = 0; i < pts.length; i += step) w.push(applyMat(matrix, pts[i]));
  let best = null;
  for (let deg = 0; deg < 90; deg += 0.5) {
    const r = deg * Math.PI / 180, c = Math.cos(r), sn = Math.sin(r);
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const p of w) {
      const u = p[0] * c + p[1] * sn, v = -p[0] * sn + p[1] * c;
      if (u < minU) minU = u; if (u > maxU) maxU = u;
      if (v < minV) minV = v; if (v > maxV) maxV = v;
    }
    const du = maxU - minU, dv = maxV - minV;
    const area = du * dv;
    if (!best || area < best.area) best = { area, r, c, sn, minU, maxU, minV, maxV, du, dv };
  }
  const u0 = (best.minU + best.maxU) / 2, v0 = (best.minV + best.maxV) / 2;
  let a = best.du >= best.dv ? best.r : best.r + Math.PI / 2;
  if (a > Math.PI / 2) a -= Math.PI;
  return {
    azimuth: a,
    cx: u0 * best.c - v0 * best.sn,
    cy: u0 * best.sn + v0 * best.c,
  };
}

export function footprintAzimuth(pts, matrix) {
  return footprintRect(pts, matrix).azimuth;
}

export class CollisionError extends Error {
  constructor(msg, hit) { super(msg); this.hit = hit; }
}

export function createPlanner(opts) {
  // opts: { cellData, mountMat, getToolId,
  //         armCapsules?, getToolCapsules?, guardBox?,
  //         mjWorld?: () => mjWorldOrNull   (exact backend, mj-world.js),
  //         collisionCheck?: () => boolean }
  //
  // Geometry authority: MuJoCo (`mjWorld`). Collision contacts, touch
  // probing, corridor heights and measurement points all derive from the
  // same box-decomposed model. The guard ceiling is analytic. Without a
  // backend (startup, or node tests that exercise pure kinematics) the
  // collision checks are inactive and only the guard applies.
  const { cellData, mountMat } = opts;
  const invMount = IK.invRigid(mountMat);
  const guardBox = opts.guardBox ?? null;
  const checkOn = opts.collisionCheck ?? (() => true);

  // ---------- tool frame ----------
  // For a vacuum cup the TCP is the LIP frame from cell.json (origin lip
  // centre, z along lip normal — the rcup16 is bent ~25° off the flange
  // axis); other tools control their tip point.
  const toolTcp = () => {
    const t = cellData.tools.find(x => x.id === opts.getToolId());
    if (t?.vacuum?.lip_centre_flange_m && t.vacuum.lip_normal_flange)
      return IK.poseFacing(t.vacuum.lip_centre_flange_m, t.vacuum.lip_normal_flange);
    return IK.translate(t?.tip_flange_m ?? [0, 0, 0]);
  };

  const asMat = p => Array.isArray(p) ? p : IK.fromXyzRpy(p.xyz_m, p.rpy);
  const tipToFlangeBase = tipMat =>
    IK.mul(invMount, IK.mul(asMat(tipMat), IK.invRigid(toolTcp())));
  const flangeToBase = m => IK.mul(invMount, asMat(m));
  const tipMatAt = q => IK.mul(mountMat, IK.mul(IK.fkFlange(q), toolTcp()));

  // ---------- collision ----------
  // ceiling only: nothing may leave the envelope through the top (walls are
  // skipped: fitted capsules are a few mm fat for this cell's tight walls)
  function guardHit(a, b, r) {
    if (!guardBox) return null;
    const over = Math.max(a[2], b[2]) + r - guardBox.z1;
    if (over <= 0) return null;
    const p = a[2] > b[2] ? a : b;
    return { point: [p[0], p[1], Math.min(p[2] + r, guardBox.z1)], item: 'guard ceiling', dist: 0 };
  }

  function linkMats(q) {
    const mats = [];
    let m = mountMat;
    for (let i = 0; i < 6; i++) {
      m = IK.mul(m, IK.fromXyzRpy(IK.CHAIN[i].xyz, IK.CHAIN[i].rpy));
      m = IK.mul(m, IK.rotZ(q[i]));
      mats.push(m);
    }
    return mats;
  }

  // guard-ceiling check over the capsules (analytic, both backends)
  function guardHits(q, ignore) {
    if (ignore.has('guard')) return [];
    const found = [];
    const mats = linkMats(q);
    for (const c of opts.armCapsules ?? []) {
      const m = mats[c.jointIdx];
      const hit = guardHit(applyMat(m, c.a), applyMat(m, c.b), c.r);
      if (hit) found.push({ ...hit, link: IK.CHAIN[c.jointIdx].link });
    }
    const fl = IK.mul(mountMat, IK.fkFlange(q));
    for (const tc of opts.getToolCapsules?.() ?? []) {
      const hit = guardHit(applyMat(fl, tc.a), applyMat(fl, tc.b), tc.r);
      if (hit) found.push({ ...hit, link: 'tool' });
    }
    return found;
  }

  function configHits(q, ignore, held = null) {
    const mjw = opts.mjWorld?.();
    if (mjw) return configHitsMj(mjw, q, ignore, held);
    return guardHits(q, ignore);
  }

  // exact contacts via MuJoCo: arm + tool capsules and the held part
  // (posed from the flange) against box-decomposed obstacles
  function configHitsMj(mjw, q, ignore, held) {
    mjw.setArm(q);
    if (held?.rel) mjw.setPartPose(held.id, IK.mul(IK.mul(mountMat, IK.fkFlange(q)), held.rel));
    const found = [];
    for (const c of mjw.contacts(MARGIN, held ? [held.id] : [])) {
      const aProbe = c.a.startsWith('arm:') || (held && c.a === held.id);
      const bProbe = c.b.startsWith('arm:') || (held && c.b === held.id);
      if (!aProbe && !bProbe) continue;             // world resting contact
      if (aProbe && bProbe) continue;               // arm/held internal
      const self = aProbe ? c.a : c.b;
      const other = aProbe ? c.b : c.a;
      if (ignore.has(other)) continue;
      if (c.dist >= MARGIN) continue;
      const link = self === 'arm:flange' ? 'tool'
        : self.startsWith('arm:') ? self.slice(4) : `held ${self}`;
      found.push({ point: c.pos, item: other, dist: c.dist, link });
    }
    return found.concat(guardHits(q, ignore));
  }

  // first predicted contact along a joint path, or null.
  // held: { id, rel (flange→part Mat4), pts (part-local sample points) } | null
  function pathHit(path, ignoreIds, held = null, scene = null) {
    const mjw = opts.mjWorld?.();
    if ((!guardBox && !mjw) || !checkOn()) return null;
    const ignore = new Set(ignoreIds ?? []);
    if (held) ignore.add(held.id);
    if (mjw && scene) for (const sp of scene) mjw.setPartPose(sp.id, sp.mat);

    // contacts already present at the start may persist while departing —
    // only NEW contacts reject the move
    const preexisting = new Set(configHits(path[0], ignore, held).map(h => `${h.link}|${h.item}`));

    for (let leg = 0; leg + 1 < path.length; leg++) {
      const a = path[leg], b = path[leg + 1];
      const maxDelta = Math.max(...a.map((v, j) => Math.abs(b[j] - v)));
      const steps = Math.max(1, Math.ceil(r2d(maxDelta) / 3));
      for (let s = 0; s <= steps; s++) {
        const q = a.map((v, j) => v + (b[j] - v) * s / steps);
        for (const h of configHits(q, ignore, held)) {
          if (!preexisting.has(`${h.link}|${h.item}`)) return { ...h, q };
        }
      }
    }
    return null;
  }

  function assertClear(path, cmd, ignore, held, scene) {
    const hit = pathHit(path, ignore, held, scene);
    if (hit) {
      const p = hit.point.map(v => (v * 1000).toFixed(0)).join(', ');
      const hint = hit.item.startsWith('guard')
        ? 'keep the motion inside the envelope (or pass ignore:[\'guard\'])'
        : `route around it (transitTip) or pass ignore:['${hit.item}']`;
      throw new CollisionError(
        `${cmd}: collision predicted — ${hit.link} would hit ${hit.item} near (${p}) mm; ${hint}`, hit);
    }
  }

  // ---------- timing ----------
  // leg durations: tip distance at tipMps, never faster than the joints allow
  function legDurations(path, tipMps, jointDps = null) {
    const tips = path.map(q => IK.pos(tipMatAt(q)));
    const dur = [];
    for (let i = 1; i < path.length; i++) {
      let t = 0;
      for (let j = 0; j < 6; j++)
        t = Math.max(t, Math.abs(path[i][j] - path[i - 1][j]) / JVMAX[j]);
      const dTip = Math.hypot(...tips[i].map((v, k) => v - tips[i - 1][k]));
      t = Math.max(t, dTip / tipMps);
      if (jointDps)
        t = Math.max(t, r2d(Math.max(...path[i].map((v, j) => Math.abs(v - path[i - 1][j])))) / jointDps);
      dur.push(Math.max(0.03, t));
    }
    return dur;
  }

  // ---------- plans (pure: q0 in, path out; throw CollisionError) ----------
  function planJointMove(q0, targetDeg, { ignore, held, scene } = {}) {
    const path = [q0, targetDeg.map(d2r)];
    assertClear(path, 'moveJointsDeg', ignore, held, scene);
    return path;
  }

  function planFlange(q0, pose, { ignore, held, scene } = {}) {
    const path = [q0, IK.ikNear(flangeToBase(pose), q0)];
    assertClear(path, 'moveFlange', ignore, held, scene);
    return path;
  }

  function planTip(q0, pose, { spin = 'free', ignore, held, scene } = {}) {
    const q = IK.ikNear(IK.mul(invMount, asMat(pose)), q0,
      { freeSpin: spin !== 'exact', tcp: toolTcp() });
    const path = [q0, q];
    assertClear(path, 'moveTip', ignore, held, scene);
    return path;
  }

  function linearPath(from, dxyz, waypoints) {
    const tip0 = tipMatAt(from);
    const path = [from];
    for (let i = 1; i <= waypoints; i++) {
      const f = i / waypoints;
      const t = [...tip0];
      t[3] += dxyz[0] * f; t[7] += dxyz[1] * f; t[11] += dxyz[2] * f;
      path.push(IK.ikNear(tipToFlangeBase(t), path[path.length - 1]));
    }
    return path;
  }

  function planTipBy(q0, dxyz, { waypoints = 6, ignore, held, scene } = {}) {
    const path = linearPath(q0, dxyz, waypoints);
    assertClear(path, 'moveTipBy', ignore, held, scene);
    return path;
  }

  // Contact-seeking move on MuJoCo contacts: advance the tip along `dir`
  // in small steps until the HELD PART (or the tool) makes FIRM contact,
  // then settle onto it. The semantics are unchanged from the sampled
  // era, now computed exactly:
  //  - directional: a contact counts only when its surface normal pushes
  //    against the motion (a supporting surface ahead, not a side wall)
  //  - interior: for a held part, contacts under its outline edges are
  //    ignored (a pocket rim never stops an insertion)
  //  - firm: >= firmContacts such contacts at once
  //  - settle: the measured remaining gap is closed to `rest` (1.5 mm)
  // Returns { path, dist, item }; item is null when maxDist ran out.
  function planUntilTouch(q0, dir, { maxDist = 0.12, minDist = 0, step = 0.002, touchTol = 0.005,
                                     firmContacts = 3, rest = 0.0015, edgeShrink = 0.006,
                                     ignore, held, scene } = {}) {
    const mjw = opts.mjWorld?.();
    const ig = new Set(ignore ?? []);
    if (held) ig.add(held.id);
    const n0 = Math.hypot(...dir) || 1;
    const u = dir.map(v => v / n0);
    if (mjw && scene) for (const sp of scene) mjw.setPartPose(sp.id, sp.mat);

    // interior-support test: a contact only counts as support when the
    // touched BOX's footprint overlaps the held part's interior footprint
    // (shrunk by edgeShrink). A pocket-rim wall is millimetres wide — its
    // overlap with the interior is ~zero — while a floor, a pile or a
    // case below overlaps broadly. Positions of box-box contact points
    // cannot be used for this: manifolds put them at overlap corners,
    // i.e. at the part's own edges. World-AABB approximation.
    const worldAABB = (mat, b) => {
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z1 = -Infinity;
      const [cx, cy, cz] = b.center, [hx, hy, hz] = b.size.map(v => v / 2);
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
        const px = cx + sx * hx, py = cy + sy * hy, pz = cz + sz * hz;
        const wx = mat[0] * px + mat[1] * py + mat[2] * pz + mat[3];
        const wy = mat[4] * px + mat[5] * py + mat[6] * pz + mat[7];
        const wz = mat[8] * px + mat[9] * py + mat[10] * pz + mat[11];
        x0 = Math.min(x0, wx); x1 = Math.max(x1, wx);
        y0 = Math.min(y0, wy); y1 = Math.max(y1, wy); z1 = Math.max(z1, wz);
      }
      return { x0, x1, y0, y1, z1 };
    };
    const itemMat = id => {
      if (mjw.readPartPose && (cellData.parts ?? []).some(x => x.id === id))
        return mjw.readPartPose(id);
      const f = (cellData.fixtures ?? []).find(x => x.id === id);
      return f ? IK.fromXyzRpy(f.pose_table.xyz_m, f.pose_table.rpy) : null;
    };
    const supportsInterior = (other, pos, heldPose) => {
      if (!held || !heldPose) return true;             // tool touch: no filter
      const hb = mjw.getBoxes().get(held.id);
      const ob = mjw.getBoxes().get(other);
      const om = itemMat(other);
      if (!hb?.length || !ob?.length || !om) return true;
      // held interior rect (world AABB of all held boxes, shrunk)
      let H = null;
      for (const b of hb) {
        const a = worldAABB(heldPose, b);
        H = H ? { x0: Math.min(H.x0, a.x0), x1: Math.max(H.x1, a.x1), y0: Math.min(H.y0, a.y0), y1: Math.max(H.y1, a.y1) } : a;
      }
      H = { x0: H.x0 + edgeShrink, x1: H.x1 - edgeShrink, y0: H.y0 + edgeShrink, y1: H.y1 - edgeShrink };
      // the touched box: the one whose AABB contains the contact point
      for (const b of ob) {
        const a = worldAABB(om, b);
        if (pos[0] < a.x0 - 3e-3 || pos[0] > a.x1 + 3e-3 ||
            pos[1] < a.y0 - 3e-3 || pos[1] > a.y1 + 3e-3 ||
            pos[2] > a.z1 + 6e-3) continue;
        const ox = Math.min(H.x1, a.x1) - Math.max(H.x0, a.x0);
        const oy = Math.min(H.y1, a.y1) - Math.max(H.y0, a.y0);
        if (ox > 0 && oy > 0 && ox * oy > 1e-4) return true;   // ≥ 100 mm²
      }
      return false;
    };

    const probeName = held ? held.id : 'arm:flange';
    const contactsAt = q => {
      if (!mjw) return [];
      mjw.setArm(q);
      let heldPose = null;
      if (held?.rel) {
        heldPose = IK.mul(IK.mul(mountMat, IK.fkFlange(q)), held.rel);
        mjw.setPartPose(held.id, heldPose);
      }
      const found = [];
      // a held part must see the OTHER PARTS below it too (a case already
      // in the pocket), not just fixtures — the default query model has
      // no part-against-part pairs
      for (const c of mjw.contacts(touchTol, held ? [held.id] : [], { partPairs: !!held })) {
        const aIs = c.a === probeName, bIs = c.b === probeName;
        if (!aIs && !bIs) continue;
        const other = aIs ? c.b : c.a;
        if (ig.has(other) || other.startsWith('arm:')) continue;
        // surface normal pushing AGAINST the motion = support ahead
        const nTo = aIs ? c.normalAB.map(v => -v) : c.normalAB; // toward the probe
        const along = -(nTo[0] * u[0] + nTo[1] * u[1] + nTo[2] * u[2]);
        if (along < 0.4) continue;
        // interior-support filter (see above)
        if (!supportsInterior(other, c.pos, heldPose)) continue;
        found.push({ gap: Math.max(0, c.dist), item: other });
      }
      return found;
    };

    const tip0 = tipMatAt(q0);
    const tipAt = d => {
      const t = [...tip0];
      t[3] += u[0] * d; t[7] += u[1] * d; t[11] += u[2] * d;
      return t;
    };
    const path = [q0];
    let dist = 0, touched = null;
    const steps = Math.max(1, Math.ceil(maxDist / step));
    for (let i = 1; i <= steps; i++) {
      const d = Math.min(i * step, maxDist);
      let q;
      try { q = IK.ikNear(tipToFlangeBase(tipAt(d)), path[path.length - 1]); }
      catch { break; }                    // reach limit — stop where we are
      const cs = d >= minDist ? contactsAt(q) : [];
      if (cs.length >= firmContacts) {
        // settle: close the measured gap to the supporting contacts
        const gap = Math.min(...cs.map(c => c.gap));
        const dSettle = d + Math.max(0, gap - rest);
        try { path.push(IK.ikNear(tipToFlangeBase(tipAt(dSettle)), q)); dist = dSettle; }
        catch { path.push(q); dist = d; }
        const byItem = {};
        for (const c of cs) byItem[c.item] = (byItem[c.item] ?? 0) + 1;
        touched = Object.entries(byItem).sort((a, b) => b[1] - a[1])[0][0];
        break;
      }
      path.push(q);
      dist = d;
    }
    return { path, dist, item: touched };
  }

  // Candidate-based transfer: direct line / corridor lift / safe lift —
  // each built, collision-checked, the fastest clean one returned.
  // Orientation slerps across lift+transfer and settles before descent.
  // spin 'free': waypoints are 5-DOF, the wrist moves minimally.
  // spin 'exact': every waypoint follows the slerp (which carries the
  // target yaw), so the re-spin blends into the travel, never playing as
  // a second move at the destination.
  function planTransit(q0, pose, { speed = FULL_TIP_MPS, clearance = 0.10, ignore, spin = 'free', held, scene } = {}) {
    const target = asMat(pose);
    const tip0 = tipMatAt(q0);
    const qa = IK.quatFromMat(tip0), qb = IK.quatFromMat(target);
    const p0 = [tip0[3], tip0[7], tip0[11]], p1 = [target[3], target[7], target[11]];

    const lerp3 = (a, b, n, z) => {
      const out = [];
      for (let i = 1; i <= n; i++) out.push([
        a[0] + (b[0] - a[0]) * i / n,
        a[1] + (b[1] - a[1]) * i / n,
        z ?? a[2] + (b[2] - a[2]) * i / n,
      ]);
      return out;
    };

    const buildVia = (pts, settle = pts.length) => {
      const path = [q0];
      pts.forEach((p, i) => {
        const m = IK.matFromQuat(IK.slerp(qa, qb, Math.min(1, (i + 1) / settle)), p);
        const free = spin !== 'exact';
        try { path.push(IK.ikNear(IK.mul(invMount, m), path[path.length - 1], { freeSpin: free, tcp: toolTcp() })); }
        catch (e) { if (i === pts.length - 1) throw e; } // only the last point is mandatory
      });
      return path;
    };

    const viaPts = h => {
      const hz = Math.max(h, p0[2], p1[2]);
      const pts = [];
      if (p0[2] < hz - 1e-6) pts.push(...lerp3(p0, [p0[0], p0[1], hz], 3));
      const liftN = pts.length;
      pts.push(...lerp3([p0[0], p0[1], hz], [p1[0], p1[1], hz], 8, hz));
      const settle = pts.length;              // orientation final before descent
      if (p1[2] < hz - 1e-6) pts.push(...lerp3([p1[0], p1[1], hz], p1, 3));
      return { pts, settle: settle || liftN || 1 };
    };

    const ignoreSet = new Set([...(ignore ?? []), ...(held ? [held.id] : [])]);
    const mjw = opts.mjWorld?.();
    const hCorr = (mjw ? mjw.corridorMaxZ(p0, p1, 0.15, ignoreSet) : 0.25) + clearance;
    const hAll = (mjw ? mjw.maxZAll() : 0.35) + clearance;
    const candidates = [
      { name: 'direct', make: () => buildVia(lerp3(p0, p1, 8)) },
      { name: `corridor z=${Math.round(hCorr * 1000)}`, make: () => { const v = viaPts(hCorr); return buildVia(v.pts, v.settle); } },
    ];
    if (hAll > hCorr + 0.01)
      candidates.push({ name: `safe z=${Math.round(hAll * 1000)}`, make: () => { const v = viaPts(hAll); return buildVia(v.pts, v.settle); } });

    const durOf = path => legDurations(path, speed).reduce((a, b) => a + b, 0);
    const built = [];
    for (const c of candidates) {
      try { const path = c.make(); built.push({ name: c.name, path, est: durOf(path) }); }
      catch { /* shape unreachable (IK) — drop it */ }
    }
    if (!built.length) throw new Error('transitTip: no reachable path shape (IK failed for every candidate)');
    built.sort((x, y) => x.est - y.est);

    const rejected = [];
    let lastHit = null;
    for (const b of built) {
      lastHit = pathHit(b.path, ignore, held, scene);
      if (!lastHit) return { ...b, candidates: built.length, rejected };
      rejected.push({ name: b.name, item: lastHit.item });
    }
    const pp = lastHit.point.map(v => (v * 1000).toFixed(0)).join(', ');
    throw new CollisionError(
      `transitTip: all ${built.length} candidates collide — last: ${lastHit.link} would hit ${lastHit.item} near (${pp}) mm`,
      lastHit);
  }

  // ---------- pose policies ----------
  const leanAzimuth = pose => {
    const fl = IK.mul(asMat(pose), IK.invRigid(toolTcp()));
    const zf = IK.axis(fl, 2);
    return Math.atan2(-zf[1], -zf[0]);   // where the TOP of the tool tips toward
  };

  const withLean = (pose, dir) => {
    const want = Math.atan2(dir[1], dir[0]);
    let best = 0, bestD = Infinity;
    for (let i = 0; i < 180; i++) {
      const phi = -Math.PI + i * Math.PI / 90;
      const az = leanAzimuth(IK.mul(asMat(pose), IK.rotZ(phi)));
      const d = Math.abs(Math.atan2(Math.sin(az - want), Math.cos(az - want)));
      if (d < bestD) { bestD = d; best = phi; }
    }
    return IK.mul(asMat(pose), IK.rotZ(best));
  };

  const camAxes = (() => {
    const cam = (cellData.cameras ?? []).find(c => c.parent === 'flange');
    if (!cam) return null;
    const R = IK.fromXyzRpy([0, 0, 0], cam.pose.rpy);
    return { x: IK.axis(R, 0), y: IK.axis(R, 1) }; // image-right, image-down
  })();

  // re-spin a pose so the wrist CAMERA sits parallel to the breadboard:
  // image-right horizontal (level horizon), image looking down. preferLean
  // breaks the 180° tie toward the collision-safe lean side.
  const withCameraLevel = (pose, preferLean = null) => {
    if (!camAxes) return asMat(pose);
    let best = null;
    for (let i = 0; i < 180; i++) {
      const phi = -Math.PI + i * Math.PI / 90;
      const cand = IK.mul(asMat(pose), IK.rotZ(phi));
      const fl = IK.mul(cand, IK.invRigid(toolTcp()));
      const xw = rotOnly(fl, camAxes.x), yw = rotOnly(fl, camAxes.y);
      let score = Math.abs(xw[2]);
      if (yw[2] > 0) score += 0.5;
      if (preferLean) {
        const az = leanAzimuth(cand);
        const want = Math.atan2(preferLean[1], preferLean[0]);
        score += 0.1 * Math.abs(Math.atan2(Math.sin(az - want), Math.cos(az - want))) / Math.PI;
      }
      if (!best || score < best.score) best = { score, cand };
    }
    return best.cand;
  };

  // Suction-grasp pose: cup face PARALLEL to the part surface, lip at
  // `standoff` along the face's outward normal. Default spin levels the
  // wrist camera; an explicit `lean` direction overrides that policy.
  const suctionGrasp = (item, standoff, face = '-z', lean = null) => {
    const sign = face[0] === '-' ? -1 : 1;
    const idx = { x: 0, y: 1, z: 2 }[face[1]];
    const n = IK.axis(item.matrix, idx).map(v => v * sign);
    const p = IK.pos(item.matrix);
    // stand off from the MEASURED face plane, not from the origin: CAD
    // origins sit behind the surface (the case's by ~5 mm), which once
    // made a "2 mm" approach a 7 mm air gap that the vacuum seat then
    // closed as a visible jump
    let faceOff = 0;
    const pts = opts.mjWorld?.()?.probePoints?.(item.id);
    if (pts?.length) {
      let m = -Infinity;
      for (const lp of pts) {
        const w = applyMat(item.matrix, lp);
        const d = (w[0] - p[0]) * n[0] + (w[1] - p[1]) * n[1] + (w[2] - p[2]) * n[2];
        if (d > m) m = d;
      }
      if (Number.isFinite(m)) faceOff = m;  // the origin may sit on EITHER side of the face
    }
    const pose = IK.poseFacing(p.map((v, i) => v + n[i] * (faceOff + standoff)), n.map(v => -v));
    if (lean) return withLean(pose, lean);
    const safeSide = Math.hypot(n[0], n[1]) > 0.1 ? [-n[0], -n[1]] : null;
    return withCameraLevel(pose, safeSide);
  };

  return {
    toolTcp, tipMatAt, asMat,
    pathHit, assertClear,
    legDurations,
    planJointMove, planFlange, planTip, planTipBy, planTransit, planUntilTouch,
    suctionGrasp, withLean, withCameraLevel, leanAzimuth,
  };
}
