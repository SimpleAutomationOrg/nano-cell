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
  //         world?, armCapsules?, getToolCapsules?, guardBox?,
  //         mjWorld?: () => mjWorldOrNull   (exact backend, mj-world.js),
  //         collisionCheck?: () => boolean }
  //
  // Collision backends: when `mjWorld` returns a world, configuration
  // contacts are EXACT (MuJoCo: box-decomposed obstacles vs arm/tool
  // capsules, held part as a posed free body). Otherwise the sampled
  // point-cloud world is used. The guard ceiling is analytic in both.
  // Touch probing (planUntilTouch) stays on the sampled points — its
  // interior-probe semantics are part of the contract.
  const { cellData, mountMat } = opts;
  const invMount = IK.invRigid(mountMat);
  const world = opts.world ?? null;
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
    const found = [];
    const mats = linkMats(q);
    for (const c of opts.armCapsules ?? []) {
      const m = mats[c.jointIdx];
      const wa = applyMat(m, c.a), wb = applyMat(m, c.b);
      const hit = world ? world.hitCapsule(wa, wb, c.r + MARGIN, ignore) : null;
      if (hit) found.push({ ...hit, link: IK.CHAIN[c.jointIdx].link });
    }
    const fl = IK.mul(mountMat, IK.fkFlange(q));
    for (const tc of opts.getToolCapsules?.() ?? []) {
      const wa = applyMat(fl, tc.a), wb = applyMat(fl, tc.b);
      const hit = world ? world.hitCapsule(wa, wb, tc.r + MARGIN, ignore) : null;
      if (hit) found.push({ ...hit, link: 'tool' });
    }
    return found.concat(guardHits(q, ignore));
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
    if ((!world && !guardBox && !mjw) || !checkOn()) return null;
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
        if (!mjw && held?.pts && held.rel) {
          const pm = IK.mul(IK.mul(mountMat, IK.fkFlange(q)), held.rel);
          const n = Math.max(1, Math.floor(held.pts.length / 250));
          for (let i = 0; i < held.pts.length; i += n) {
            const w = applyMat(pm, held.pts[i]);
            const hit = (world ? world.hitCapsule(w, w, MARGIN + 0.002, ignore) : null)
              ?? (ignore.has('guard') ? null : guardHit(w, w, 0.002));
            if (hit) return { ...hit, link: `held ${held.id}`, q };
          }
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

  // Contact-seeking move: advance the tip along `dir` in small steps until
  // the HELD PART (or the tool) makes FIRM contact, then settle onto it.
  // Firm means >= firmContacts sample points whose contact vector points
  // ALONG the motion (a supporting surface ahead) — a single grazing point,
  // or pocket walls beside the part during a tight insertion, never stop
  // the move. After detection the remaining gap to the contact points is
  // measured and closed to ~1.5 mm, so parts rest on surfaces instead of
  // hovering a tolerance above them.
  // Returns { path, dist, item }; item is null when maxDist ran out.
  // minDist: contacts are ignored before this travel (rarely needed).
  // Probing uses only the held part's INTERIOR points (edgeShrink inset
  // from its outline): a pocket rim under the part's edges never counts
  // as contact, so tight insertions pass the rim with no blind zone,
  // while a pile or floor under the part's middle always registers.
  function planUntilTouch(q0, dir, { maxDist = 0.12, minDist = 0, step = 0.002, touchTol = 0.005,
                                     firmContacts = 3, rest = 0.0015, edgeShrink = 0.006,
                                     ignore, held } = {}) {
    const ig = new Set(ignore ?? []);
    if (held) ig.add(held.id);
    const n = Math.hypot(...dir) || 1;
    const u = dir.map(v => v / n);

    // interior probe subset of the held part's samples (local-frame inset)
    let probePts = held?.pts ?? null;
    if (probePts && edgeShrink > 0) {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const p of probePts) {
        if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
        if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
      }
      const inner = probePts.filter(p =>
        p[0] > minX + edgeShrink && p[0] < maxX - edgeShrink &&
        p[1] > minY + edgeShrink && p[1] < maxY - edgeShrink);
      if (inner.length >= 6) probePts = inner;
    }

    // all directional contacts at config q: { along, item } per touching point
    const contactsAt = q => {
      const fl = IK.mul(mountMat, IK.fkFlange(q));
      const found = [];
      if (probePts && held?.rel) {
        const pm = IK.mul(fl, held.rel);
        const sk = Math.max(1, Math.floor(probePts.length / 400));
        for (let i = 0; i < probePts.length; i += sk) {
          const w = applyMat(pm, probePts[i]);
          const hit = world?.hitCapsule(w, w, touchTol, ig);
          if (!hit) continue;
          const dv = [hit.point[0] - w[0], hit.point[1] - w[1], hit.point[2] - w[2]];
          const along = dv[0] * u[0] + dv[1] * u[1] + dv[2] * u[2];
          // supporting contact: the obstacle lies AHEAD along the motion
          if (along > 0.4 * Math.hypot(...dv)) found.push({ along, item: hit.item });
        }
      } else {
        for (const tc of opts.getToolCapsules?.() ?? []) {
          const wa = applyMat(fl, tc.a), wb = applyMat(fl, tc.b);
          const hit = world?.hitCapsule(wa, wb, tc.r + touchTol, ig);
          if (hit) found.push({ along: hit.dist - tc.r, item: hit.item }, { along: hit.dist - tc.r, item: hit.item }, { along: hit.dist - tc.r, item: hit.item });
        }
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
        // settle: close the measured gap to the supporting points
        const gap = Math.min(...cs.map(c => c.along));
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
    const hCorr = (world ? world.maxZInCorridor(p0, p1, 0.15, ignoreSet) : 0.25) + clearance;
    const hAll = (world ? world.maxZ : 0.35) + clearance;
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
    const wi = world?.items.get(item.id);
    if (wi?.local?.length) {
      const step = Math.max(1, Math.floor(wi.local.length / 400));
      let m = -Infinity;
      for (let i = 0; i < wi.local.length; i += step) {
        const w = applyMat(item.matrix, wi.local[i]);
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
