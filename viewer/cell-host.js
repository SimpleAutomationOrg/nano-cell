// The in-page cell host: executes step segments against the three.js scene.
// Planning (commands → joint paths, collision checking, pose policies)
// lives in planner.js, which is pure and tested under node; this file only
// animates planned paths, keeps run state, and moves scene objects.

import * as IK from './ik.js';
import { createPlanner, FULL_TIP_MPS, CollisionError, footprintAzimuth, footprintRect } from './planner.js';

const d2r = d => d * Math.PI / 180;
const r2d = r => r * 180 / Math.PI;

export function createHost(opts) {
  // opts: { cellData, spins, flangeGroup, worldGroup, partNodes, mountMat,
  //         getToolId, onLog, onJoints, collisionWorld, guardBox,
  //         armCapsules, getToolCapsules, onCollision }
  const { cellData, spins, flangeGroup, worldGroup, partNodes, mountMat } = opts;

  const st = {
    speed: 1,
    paused: false,
    stepping: false,
    aborted: false,
    motion: null,
    timer: null,
    held: null,
    partAnim: null,      // { node, traj, t, resolve } — settle playback
    io: {},
    events: [],
    busy: false,
    collisionCheck: true,
    current: null,       // label of the command being animated
    currentSince: 0,
  };

  const planner = createPlanner({
    cellData, mountMat,
    getToolId: opts.getToolId,
    guardBox: opts.guardBox ?? null,
    armCapsules: opts.armCapsules ?? [],
    getToolCapsules: opts.getToolCapsules,
    mjWorld: () => opts.getMjWorld?.() ?? null,
    collisionCheck: () => st.collisionCheck,
  });

  const log = m => opts.onLog?.(m);
  const logCmd = m => { st.current = m; st.currentSince = performance.now(); log(m); };
  const emit = (cmd, args) => st.events.push({ t: Date.now(), cmd, args });

  const jointsRad = () => spins.map(s => s.rotation.z);
  const setJointsRad = q => {
    q.forEach((v, i) => spins[i].rotation.z = v);
    opts.onJoints?.(q.map(r2d));
  };

  // held part info for the planner's collision check
  function heldInfo() {
    if (!st.held) return null;
    const n = partNodes.get(st.held);
    n.updateMatrix();
    const e = n.matrix.elements; // column-major → row-major
    return {
      id: st.held,
      rel: [e[0], e[4], e[8], e[12], e[1], e[5], e[9], e[13], e[2], e[6], e[10], e[14], 0, 0, 0, 1],
    };
  }

  // current part poses for the exact backend (parts move between runs)
  function sceneInfo() {
    const out = [];
    for (const it of cellData.parts ?? []) {
      const node = partNodes.get(it.id);
      if (node) out.push({ id: it.id, mat: liveMatrix(node) });
    }
    return out;
  }

  // report a CollisionError's hit into the scene, then rethrow
  function reportCollision(e) {
    if (e instanceof CollisionError && e.hit)
      opts.onCollision?.(e.hit.point, e.hit.item, e.hit.link);
    throw e;
  }

  // ---------- animation ----------
  function checkRun(cmd) {
    if (st.aborted) throw new Error('aborted');
    if (st.busy) throw new Error(`${cmd}: another command is still running`);
  }

  function animate(path, tipMps, jointDps = null) {
    return new Promise((resolve, reject) => {
      st.motion = { path, legDur: planner.legDurations(path, tipMps, jointDps), leg: 0, t: 0, resolve, reject };
      st.busy = true;
    });
  }

  const smooth = x => x * x * (3 - 2 * x);

  function finishCommand() {
    st.busy = false;
    if (st.current) {
      const dur = (performance.now() - st.currentSince) / 1000;
      log(`  ⏱ ${st.current.split(' ')[0]} took ${dur.toFixed(1)} s`);
      st.current = null;
    }
    if (st.stepping) { st.stepping = false; st.paused = true; }
  }

  function update(dt) {
    if (st.paused) return;
    const step = dt * st.speed;
    if (st.motion) {
      const m = st.motion;
      m.t += step;
      while (m.leg < m.legDur.length && m.t >= m.legDur[m.leg]) {
        m.t -= m.legDur[m.leg];
        m.leg++;
      }
      if (m.leg >= m.legDur.length) {
        setJointsRad(m.path[m.path.length - 1]);
        st.motion = null;
        finishCommand();
        m.resolve();
      } else {
        const a = m.path[m.leg], b = m.path[m.leg + 1];
        const f = smooth(Math.min(1, m.t / m.legDur[m.leg]));
        setJointsRad(a.map((v, i) => v + (b[i] - v) * f));
      }
    } else if (st.partAnim) {
      const a = st.partAnim;
      a.t += step;
      let i = a.traj.findIndex(k => k.t > a.t);
      if (i === -1) {
        const m = a.traj[a.traj.length - 1].mat;
        applyMatToNode(a.node, m);
        st.partAnim = null;
        finishCommand();
        a.resolve();
      } else {
        i = Math.max(1, i);
        const k0 = a.traj[i - 1], k1 = a.traj[i];
        const f = (a.t - k0.t) / Math.max(1e-9, k1.t - k0.t);
        // positions lerp; orientation snaps per sample (60 Hz: invisible)
        const m = f < 0.5 ? k0.mat : k1.mat;
        a.node.position.set(
          k0.mat[3] + (k1.mat[3] - k0.mat[3]) * f,
          k0.mat[7] + (k1.mat[7] - k0.mat[7]) * f,
          k0.mat[11] + (k1.mat[11] - k0.mat[11]) * f);
        const q = IK.quatFromMat(m);
        a.node.quaternion.set(q[1], q[2], q[3], q[0]);
      }
    } else if (st.timer) {
      st.timer.left_s -= step;
      if (st.timer.left_s <= 0) {
        const t = st.timer;
        st.timer = null;
        finishCommand();
        t.resolve();
      }
    }
  }

  function abort() {
    st.aborted = true;
    st.current = null;
    st.paused = false;
    const err = new Error('aborted');
    if (st.motion) { const m = st.motion; st.motion = null; st.busy = false; m.reject(err); }
    if (st.timer) { const t = st.timer; st.timer = null; st.busy = false; t.reject(err); }
    if (st.partAnim) { const a = st.partAnim; st.partAnim = null; st.busy = false; a.reject?.(err) ?? a.resolve(); }
  }

  function applyMatToNode(node, m) {
    node.position.set(m[3], m[7], m[11]);
    const q = IK.quatFromMat(m);
    node.quaternion.set(q[1], q[2], q[3], q[0]);
    node.updateMatrix();
  }

  // ---------- the API segments see ----------
  /** @type {import('./cell').CellAPI} */
  const api = {
    joints: () => jointsRad().map(r2d),
    held: () => st.held,

    // the held part's frame in the TIP (cup) frame — what placement needs
    // to align the PART, not the cup, with a pocket. Null when empty.
    heldInTip: () => {
      if (!st.held) return null;
      const node = partNodes.get(st.held);
      node.updateMatrix();
      const e = node.matrix.elements; // flange frame, column-major
      const inFlange = [e[0], e[4], e[8], e[12], e[1], e[5], e[9], e[13], e[2], e[6], e[10], e[14], 0, 0, 0, 1];
      return IK.mul(IK.invRigid(planner.toolTcp()), inFlange);
    },

    // the held part's footprint centre (xy centroid) and lowest point,
    // in the table frame, were the cup at `cupPose`. Centre PLACEMENTS on
    // this, not on the tip: the cup grips the part wherever the grasp
    // touched, which is not the part's centre.
    heldFootprintCenter: (cupPose) => {
      if (!st.held) return null;
      const pts = probePts(st.held);
      if (!pts?.length) return null;
      const pm = IK.mul(cupPose, api.heldInTip());
      let zMin = Infinity;
      for (const pt of pts) {
        const z = pm[8] * pt[0] + pm[9] * pt[1] + pm[10] * pt[2] + pm[11];
        if (z < zMin) zMin = z;
      }
      // outline centre, not centroid — interior features bias density
      const rect = footprintRect(pts, pm);
      return { x: rect.cx, y: rect.cy, z_min: zMin };
    },

    // azimuth of the held part's LONG footprint axis in the table frame,
    // were the cup at `cupPose` — measured from the part's collision
    // samples, not from its frame labels. Null when empty.
    heldFootprintAzimuth: (cupPose) => {
      if (!st.held) return null;
      const pts = probePts(st.held);
      if (!pts?.length) return null;
      const rel = api.heldInTip();
      return footprintAzimuth(pts, IK.mul(cupPose, rel));
    },

    // The cup pose that hangs the HELD PART square to, and centred over,
    // a target's top opening, `height` above its rim. Everything the
    // placement rules ask for, in one place:
    //  - yaw: the part's measured long footprint axis onto the target's
    //    measured long axis (frame labels are arbitrary per CAD part)
    //  - which of the two 180-degree yaws (a rectangle fits both ways): the
    //    one the wrist reaches with less turning from where the arm is now
    //  - xy: the part's footprint centre over the target's top centre (the
    //    cup grips the part wherever the grasp touched, not at its centre)
    heldPoseOver: (target, height) => {
      if (!st.held) throw new Error('heldPoseOver: nothing is held');
      const c = target.topCenter, axis = target.topLongAxis;
      const top = [c[0], c[1], c[2] + height];
      // poseZDown's yaw spins about the DOWNWARD axis: +yaw turns the held
      // part NEGATIVE in table azimuth
      const partAz = api.heldFootprintAzimuth(IK.poseZDown(top, 0));
      const yaw = partAz === null ? axis : partAz - axis;
      const a = IK.poseZDown(top, yaw), b = IK.poseZDown(top, yaw + Math.PI);
      const q = jointsRad();
      const pose = [...(planner.wristTurn(q, b) < planner.wristTurn(q, a) ? b : a)];
      const fp = api.heldFootprintCenter(pose);
      if (fp) { pose[3] += c[0] - fp.x; pose[7] += c[1] - fp.y; }   // a shift keeps the spin
      return pose;
    },

    async moveJointsDeg(targetDeg, { speedDps = 180, ignore } = {}) {
      checkRun('moveJointsDeg');
      emit('move_joints_deg', { target: targetDeg });
      logCmd(`moveJointsDeg [${targetDeg.map(v => v.toFixed(1)).join(', ')}]`);
      try {
        const path = planner.planJointMove(jointsRad(), targetDeg, { ignore, held: heldInfo(), scene: sceneInfo() });
        await animate(path, FULL_TIP_MPS, speedDps);
      } catch (e) { reportCollision(e); }
    },

    async moveFlange(pose, { speed = FULL_TIP_MPS, ignore } = {}) {
      checkRun('moveFlange');
      emit('move_flange', { pose });
      try {
        const path = planner.planFlange(jointsRad(), pose, { ignore, held: heldInfo(), scene: sceneInfo() });
        logCmd(`moveFlange → [${path[1].map(v => r2d(v).toFixed(1)).join(', ')}]`);
        await animate(path, speed);
      } catch (e) { reportCollision(e); }
    },

    async moveTip(pose, { speed = FULL_TIP_MPS, ignore, spin = 'free' } = {}) {
      checkRun('moveTip');
      emit('move_tip', { pose });
      try {
        const path = planner.planTip(jointsRad(), pose, { spin, ignore, held: heldInfo(), scene: sceneInfo() });
        logCmd(`moveTip → [${path[1].map(v => r2d(v).toFixed(1)).join(', ')}]`);
        await animate(path, speed);
      } catch (e) { reportCollision(e); }
    },

    async moveTipBy(d, { speed = FULL_TIP_MPS, waypoints = 6, ignore } = {}) {
      checkRun('moveTipBy');
      emit('move_tip_by', { d });
      logCmd(`moveTipBy [${d.map(v => (v * 1000).toFixed(0)).join(', ')}] mm`);
      try {
        const path = planner.planTipBy(jointsRad(), d, { waypoints, ignore, held: heldInfo(), scene: sceneInfo() });
        await animate(path, speed);
      } catch (e) { reportCollision(e); }
    },

    async transitTip(pose, { speed = FULL_TIP_MPS, clearance = 0.10, ignore, spin = 'free' } = {}) {
      checkRun('transitTip');
      emit('transit_tip', { pose });
      try {
        const plan = planner.planTransit(jointsRad(), pose,
          { speed, clearance, ignore, spin, held: heldInfo(), scene: sceneInfo() });
        for (const r of plan.rejected) log(`  ✗ candidate ${r.name}: would hit ${r.item}`);
        logCmd(`transitTip ${plan.name} · ${plan.est.toFixed(1)} s est (${plan.candidates} candidates)`);
        await animate(plan.path, speed);
      } catch (e) { reportCollision(e); }
    },

    // descend (or advance) until the held part or tool touches something;
    // resolves with what was touched and after how many metres
    async moveUntilTouch(dir, { speed = 0.02, maxDist = 0.12, minDist = 0, ignore } = {}) {
      checkRun('moveUntilTouch');
      emit('move_until_touch', { dir, maxDist, minDist });
      logCmd(`moveUntilTouch [${dir.join(', ')}] up to ${(maxDist * 1000).toFixed(0)} mm`);
      const plan = planner.planUntilTouch(jointsRad(), dir,
        { maxDist, minDist, ignore, held: heldInfo(), scene: sceneInfo() });
      if (plan.path.length > 1) await animate(plan.path, speed);
      log(plan.item
        ? `  touched ${plan.item} after ${(plan.dist * 1000).toFixed(0)} mm`
        : `  no contact within ${(maxDist * 1000).toFixed(0)} mm`);
      return { dist_m: plan.dist, item: plan.item };
    },

    async setIO(name, value) {
      checkRun('setIO');
      st.io[name] = value;
      emit('set_io', { name, value });
      log(`setIO ${name} = ${value}`);
    },

    async grasp(partId) {
      checkRun('grasp');
      const node = partNodes.get(partId);
      if (!node) throw new Error(`grasp: unknown part '${partId}'`);
      flangeGroup.attach(node);
      st.held = partId;

      // seat the part: the vacuum pulls it flush onto the cup lip, closing
      // the approach standoff and any origin-vs-surface offset. Gap = the
      // smallest distance from the lip plane to the part's surface points
      // along the cup axis.
      const pts = probePts(partId);
      if (pts?.length) {
        const applyM = (m, p) => [
          m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
          m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
          m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11]];
        const lip = IK.mul(mountMat, IK.mul(IK.fkFlange(jointsRad()), planner.toolTcp()));
        const lp = IK.pos(lip), zl = IK.axis(lip, 2);
        const pm = liveMatrix(node);
        let gap = Infinity;
        for (const lp of pts) {
          const w = applyM(pm, lp);
          const d = (w[0] - lp[0]) * zl[0] + (w[1] - lp[1]) * zl[1] + (w[2] - lp[2]) * zl[2];
          if (d > -0.003 && d < gap) gap = d;  // in front of the lip only
        }
        if (Number.isFinite(gap) && gap > 1e-4 && gap < 0.02) {
          // pull the part `gap` toward the lip, in the flange frame
          const af = IK.axis(planner.toolTcp(), 2); // cup axis, flange frame
          node.position.x -= af[0] * gap;
          node.position.y -= af[1] * gap;
          node.position.z -= af[2] * gap;
          log(`  vacuum seats ${partId}: ${(gap * 1000).toFixed(1)} mm`);
        }
      }
      emit('grasp', { part: partId });
      log(`grasp ${partId}`);
    },

    async release() {
      checkRun('release');
      if (!st.held) return;
      const id = st.held;
      const node = partNodes.get(id);
      worldGroup.attach(node);
      node.updateMatrix();
      const e = node.matrix.elements;
      let mat = [e[0], e[4], e[8], e[12], e[1], e[5], e[9], e[13], e[2], e[6], e[10], e[14], 0, 0, 0, 1];

      // PHYSICS (exact backend): the released part settles under gravity —
      // it drops the last millimetres and lies flat on whatever is below,
      // instead of hanging where the cup let go
      const mjw = opts.getMjWorld?.();
      if (mjw) {
        try {
          for (const sp of sceneInfo()) mjw.setPartPose(sp.id, sp.mat);
          mjw.setArm(jointsRad());
          // a few milliseconds of the settle per frame: the page keeps
          // drawing and answering the mouse while it is worked out
          const run = mjw.settleSteps(id);
          let settled, step;
          try {
            for (;;) {
              const until = performance.now() + 6;
              do step = run.next(); while (!step.done && performance.now() < until);
              if (step.done) { settled = step.value; break; }
              // (a hidden tab is given a timer tick only once a second — do
              // not hand it the thread at all)
              if (typeof document !== 'undefined' && !document.hidden) await new Promise(r => setTimeout(r, 0));
              if (st.aborted) throw new Error('aborted');
            }
          } finally { run.return(); }          // frees its model if cut short
          if (settled?.pose) {
            const drop = mat[11] - settled.pose[11];
            mat = settled.pose;
            if (settled.traj.length > 2 && Math.abs(drop) > 1e-3) {
              // PLAY the fall in real time (speed-scaled, pausable)
              await new Promise((resolve, reject) => {
                st.partAnim = { node, traj: settled.traj, t: 0, resolve, reject };
                st.busy = true;
              });
            } else {
              applyMatToNode(node, mat);
            }
            if (Math.abs(drop) > 1e-4) log(`  settles ${(drop * 1000).toFixed(1)} mm under gravity`);
          }
        } catch (err) {
          if (st.aborted) throw err;
          log(`  settle failed: ${err.message ?? err}`);
        }
      }
      emit('release', { part: id });
      log(`release ${id}`);
      st.held = null;
    },

    async waitMs(ms) {
      checkRun('waitMs');
      emit('wait_ms', { ms });
      logCmd(`waitMs ${ms}`);
      await new Promise((resolve, reject) => {
        st.timer = { left_s: ms / 1000, resolve, reject };
        st.busy = true;
      });
    },

    log(msg) { emit('log', { msg }); log(`step: ${msg}`); },
  };

  // ---------- ctx ----------
  const findIn = (list, id) => list?.find(x => x.id === id);

  // an item's CURRENT pose in the table frame — parts move between runs,
  // so ctx matrices must come from the scene, not from application.json
  function liveMatrix(node) {
    node.updateWorldMatrix(true, false);
    worldGroup.updateWorldMatrix(true, false);
    const m = worldGroup.matrixWorld.clone().invert().multiply(node.matrixWorld);
    const e = m.elements; // column-major → row-major
    return [e[0], e[4], e[8], e[12], e[1], e[5], e[9], e[13], e[2], e[6], e[10], e[14], 0, 0, 0, 1];
  }

  // the centroid of an item's TOP RIM (highest 12 mm band of its collision
  // samples), in the table frame. For an open pocket or tray this is the
  // cavity centre — fixture ORIGINS are CAD datums and often sit outside
  // the working geometry, so place onto topCenter, never onto the origin.
  const applyM = (m, p) => [
    m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
    m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
    m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11]];

  const probePts = id => opts.getMjWorld?.()?.probePoints?.(id) ?? null;

  function topCenterOf(id, matrix) {
    const pts = probePts(id);
    if (!pts?.length) return { center: [matrix[3], matrix[7], matrix[11]], longAxis: 0 };
    let zMax = -Infinity;
    for (const p of pts) if (p[2] > zMax) zMax = p[2];
    const band = pts.filter(p => p[2] >= zMax - 0.012);
    let nB = 0, zSum = 0;
    for (const p of band) { zSum += p[2]; nB++; }
    if (nB <= 10) return { center: [matrix[3], matrix[7], matrix[11]], longAxis: 0 };
    // xy centre from the band's OUTLINE (min-area rectangle), not its
    // centroid: point density drifts toward feature-heavy sides
    const rect = footprintRect(band, matrix);
    const zLocal = zSum / nB;
    const zWorld = matrix[8] * 0 + matrix[9] * 0 + matrix[10] * zLocal + matrix[11];
    return { center: [rect.cx, rect.cy, zWorld], longAxis: rect.azimuth };
  }

  const itemCtx = it => {
    const node = partNodes.get(it.id) ?? null;
    const matrix = node ? liveMatrix(node) : IK.fromXyzRpy(it.pose_table.xyz_m, it.pose_table.rpy);
    const top = topCenterOf(it.id, matrix);
    return {
      id: it.id, name: it.name,
      pose: it.pose_table,
      matrix,
      topCenter: top.center,
      topLongAxis: top.longAxis,
      node,
    };
  };

  /** @type {import('./cell').Ctx} */
  const ctx = {
    cell: cellData,
    part: id => { const it = findIn(cellData.parts, id); if (!it) throw new Error(`no part '${id}'`); return itemCtx(it); },
    fixture: id => { const it = findIn(cellData.fixtures, id); if (!it) throw new Error(`no fixture '${id}'`); return itemCtx(it); },
    // the part to pick next from a stack: the exposed one (see planner)
    nextOnStack: (stackId, partIds) => {
      const onStack = planner.exposedOnStack(partIds.map(id => ctx.part(id)), ctx.fixture(stackId).matrix);
      if (!onStack) throw new Error(`'${stackId}' is empty`);
      return onStack;
    },
    h: {
      suctionGrasp: planner.suctionGrasp,
      withLean: planner.withLean,
      withCameraLevel: planner.withCameraLevel,
      leanAzimuth: planner.leanAzimuth,
      poseFacing: IK.poseFacing,
      poseZDown: IK.poseZDown,
      matPos: IK.pos,
      matAxis: IK.axis,
      matMul: IK.mul,
      add: (a, b) => a.map((v, i) => v + b[i]),
      scale: (a, k) => a.map(v => v * k),
      neg: a => a.map(v => -v),
      deg: d2r,
    },
  };

  return {
    api, ctx, update, abort, state: st, planner,
    snapJointsDeg: deg => setJointsRad(deg.map(d2r)),
    pause: () => { st.paused = true; },
    resume: () => { st.paused = false; },
    step: () => { st.stepping = true; st.paused = false; },
    setSpeed: v => { st.speed = v; },
    setCollisionCheck: v => { st.collisionCheck = v; },
    reset: () => { st.aborted = false; st.paused = false; st.stepping = false; },
  };
}
