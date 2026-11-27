// MuJoCo-backed collision world: exact contact queries for the planner.
//
// Geometry: fixtures and parts are decomposed into axis-aligned boxes in
// their own frames (boxify.js — MuJoCo hulls mesh assets, which would
// fill cavities); the arm links and the tool keep their fitted capsules.
// Parts are free bodies whose poses are synced from the scene before
// each query, so a held part is just a part posed from the flange.
//
// Contact groups: arm/tool collide with fixtures and parts; fixtures
// never collide with each other; parts collide with everything but are
// queried selectively by the planner.
//
// Pure given a loaded module + STL loader: usable in browser and node.

import * as IK from './ik.js';
import { parseBinaryStl } from './stl.js';
import { boxify } from './boxify.js';

// fixed-precision attribute numbers: no scientific notation (the XML
// parser rejects it) and deterministic output
const num = v => {
  const r = Number(v.toFixed(7));
  return Object.is(r, -0) ? '0' : String(r.toFixed ? r : r);
};
const vec = a => a.map(v => Number(v.toFixed(7))).map(v => (Object.is(v, -0) ? 0 : v)).join(' ');
const quatAttr = rpy => vec(IK.quatFromMat(IK.fromXyzRpy([0, 0, 0], rpy)));
const quatOfMat = m => IK.quatFromMat(m);

// TWO models from the same geometry (runtime contype/conaffinity edits
// are not honored by the binding, so filtering must be baked at build):
//  - QUERY model: parts collide with the arm/held side only — path
//    checks never pay for the hundreds of resting world contacts
//  - PHYSICS model: everything collides — settling and contact forces
// Poses are synced to both; heavier computations run on PHYSICS.
const GROUPS_QUERY = { arm: 'contype="1" conaffinity="6"', fixture: 'contype="2" conaffinity="1"', part: 'contype="4" conaffinity="3"' };
const GROUPS_PHYS = { arm: 'contype="1" conaffinity="6"', fixture: 'contype="2" conaffinity="5"', part: 'contype="4" conaffinity="7"' };

export async function createMjWorld({ mj, cellData, armCapsules, toolCapsules, loadStlBuffer }) {
  // --- box decompositions, cached per mesh path (parts share meshes) ---
  const boxCache = new Map();
  async function boxesFor(meshPath, detail) {
    const key = `${meshPath}|${detail}`;
    if (!boxCache.has(key)) {
      const buf = await loadStlBuffer(meshPath);
      const opts = detail === 'coarse'
        ? { cell: 0.006, exactWalls: false }   // big ribbed fixtures: no tight fits
        : {};                                   // exact walls (default)
      boxCache.set(key, boxify(parseBinaryStl(buf), opts));
    }
    return boxCache.get(key);
  }

  const boxGeoms = (G, boxes, group) => boxes.map(b =>
    `<geom type="box" ${G[group]} pos="${vec(b.center)}" size="${vec(b.size.map(v => Math.max(v / 2, 1e-4)))}"/>`
  ).join('\n');
  const capGeom = (G, c, group) => {
    const len = Math.hypot(c.b[0] - c.a[0], c.b[1] - c.a[1], c.b[2] - c.a[2]);
    if (len < 1e-3) {                     // squat fit: MuJoCo rejects a≈b
      const mid = c.a.map((v, i) => (v + c.b[i]) / 2);
      return `<geom type="sphere" ${G[group]} pos="${vec(mid)}" size="${Number(c.r.toFixed(7))}"/>`;
    }
    return `<geom type="capsule" ${G[group]} fromto="${vec(c.a)} ${vec(c.b)}" size="${Number(c.r.toFixed(7))}"/>`;
  };

  const boxesByItem = new Map();  // id -> local-frame boxes
  const itemBoxes = async it => it.boxes ?? await boxesFor(it.collision_mesh, it.collision_detail);
  async function buildXml(G, toolCaps) {
    let wb = '';
    for (const it of cellData.fixtures ?? []) {
      if (!it.collision_mesh && !it.boxes) continue;
      const boxes = await itemBoxes(it);
      boxesByItem.set(it.id, boxes);
      wb += `<body name="${it.id}" pos="${vec(it.pose_table.xyz_m)}" quat="${quatAttr(it.pose_table.rpy)}">
        ${boxGeoms(G, boxes, 'fixture')}</body>\n`;
    }
    for (const it of cellData.parts ?? []) {
      if (!it.collision_mesh && !it.boxes) continue;
      const boxes = await itemBoxes(it);
      boxesByItem.set(it.id, boxes);
      wb += `<body name="${it.id}" pos="${vec(it.pose_table.xyz_m)}" quat="${quatAttr(it.pose_table.rpy)}">
        <freejoint name="fj:${it.id}"/>
        ${boxGeoms(G, boxes, 'part')}</body>\n`;
    }
    // arm chain: capsules per link, hinge about local z, built inside-out
    const mount = cellData.arm.mount_table;
    let inner = `<body name="arm:flange" pos="0 0 0.1">
      <geom type="sphere" size="0.001" density="100" contype="0" conaffinity="0"/>
      ${(toolCaps ?? []).map(c => capGeom(G, c, 'arm')).join('\n')}</body>`;
    for (let i = IK.CHAIN.length - 1; i >= 0; i--) {
      const j = IK.CHAIN[i];
      const caps = (armCapsules ?? []).filter(c => c.jointIdx === i).map(c => capGeom(G, c, 'arm')).join('\n');
      inner = `<body name="arm:${j.link}" pos="${vec(j.xyz)}" quat="${quatAttr(j.rpy)}">
        <joint name="q${i}" type="hinge" axis="0 0 1"/>
        <geom type="sphere" size="0.001" density="100" contype="0" conaffinity="0"/>
        ${caps}${inner}</body>`;
    }
    wb += `<body name="arm:base" pos="${vec(mount.xyz_m)}" quat="${quatAttr(mount.rpy)}">${inner}</body>\n`;
    return `
<mujoco>
  <compiler angle="radian"/>
  <default>
    <!-- plastic-on-plastic, not MuJoCo's rubber-like 1.0: wedged parts
         must be able to SLIDE into place under their own weight.
         SOFT contacts: sub-millimetre overlaps (the case↔holder snap
         fit is ~0.3 mm interference) push back gently, like the real
         plastic flexing, instead of hard-solver hundreds of newtons.
         solimp starts at low impedance and firms up fully by 0.8 mm of
         depth, so sub-snap overlaps are compliant.
         LOSSY contacts: solref is given directly as (-stiffness, -damping).
         The stiffness is MuJoCo's default (so resting forces are
         unchanged); the damping is 10x the default. The default contact
         is a slow critically-damped spring that takes ~10 mm to stop a
         1.5 m/s impact - more than the holder's 6 mm pocket floor, so a
         dropped case went straight through it. Plastic on plastic does
         not bounce or sink: this stops the same impact in about 1 mm.
         1000 is the stability limit for the 1 ms settle step.
         Queries are unaffected (distance, not force). -->
    <geom friction="0.3 0.002 0.0001" solimp="0.15 0.95 0.0008" solref="-2500 -1000"/>
  </default>
  <option gravity="0 0 0"/>
  <worldbody>
${wb}
  </worldbody>
</mujoco>`;
  }

  // --- state: two models (QUERY fast, PHYSICS full) ---
  const makeSlot = () => ({ model: null, data: null, jointAdr: [], partAdr: new Map(), partDof: new Map(), geomItem: [], geomsByName: new Map() });
  const Q = makeSlot(), P = makeSlot();
  const w = Q;   // default slot for queries

  function fillSlot(slot, model) {
    slot.model = model;
    slot.data = new mj.MjData(model);
    slot.jointAdr = [];
    for (let i = 0; i < 6; i++) {
      const jid = mj.mj_name2id(model, mj.mjtObj.mjOBJ_JOINT.value, `q${i}`);
      slot.jointAdr.push(model.jnt_qposadr[jid]);
    }
    slot.partAdr = new Map();
    slot.partDof = new Map();
    for (const it of cellData.parts ?? []) {
      const jid = mj.mj_name2id(model, mj.mjtObj.mjOBJ_JOINT.value, `fj:${it.id}`);
      if (jid < 0) continue;
      slot.partAdr.set(it.id, model.jnt_qposadr[jid]);
      slot.partDof.set(it.id, model.jnt_dofadr[jid]);
    }
    slot.geomItem = [];
    slot.geomsByName = new Map();
    for (let g = 0; g < model.ngeom; g++) {
      const name = mj.mj_id2name(model, mj.mjtObj.mjOBJ_BODY.value, model.geom_bodyid[g]) ?? '';
      slot.geomItem.push(name);
      if (!slot.geomsByName.has(name)) slot.geomsByName.set(name, []);
      slot.geomsByName.get(name).push(g);
    }
  }
  async function rebuild(toolCaps) {
    fillSlot(Q, mj.MjModel.from_xml_string(await buildXml(GROUPS_QUERY, toolCaps)));
    fillSlot(P, mj.MjModel.from_xml_string(await buildXml(GROUPS_PHYS, toolCaps)));
  }
  await rebuild(toolCapsules);

  function setArm(qRad) {
    for (const slot of [Q, P])
      for (let i = 0; i < 6; i++) slot.data.qpos[slot.jointAdr[i]] = qRad[i];
  }
  function setPartPose(id, mat) {
    const q = quatOfMat(mat);
    for (const slot of [Q, P]) {
      const adr = slot.partAdr.get(id);
      if (adr === undefined) continue;
      slot.data.qpos[adr] = mat[3]; slot.data.qpos[adr + 1] = mat[7]; slot.data.qpos[adr + 2] = mat[11];
      for (let k = 0; k < 4; k++) slot.data.qpos[adr + 3 + k] = q[k];
      // a posed part is a TELEPORT: it carries no velocity. Without this
      // the speed left over from an earlier settle launches the next one.
      const dof = slot.partDof.get(id);
      for (let k = dof; k < dof + 6; k++) { slot.data.qvel[k] = 0; slot.data.qfrc_applied[k] = 0; }
    }
  }
  // margin ONLY on the probing bodies (arm + optionally a held part):
  // a global margin makes every resting part erupt in contacts
  function setMargin(slot, m, extraIds = []) {
    const gm = slot.model.geom_margin;
    for (let g = 0; g < slot.model.ngeom; g++) gm[g] = 0;
    for (const [name, geoms] of slot.geomsByName) {
      if (!name.startsWith('arm:') && !extraIds.includes(name)) continue;
      for (const g of geoms) gm[g] = m;
    }
  }

  // contacts at the current state: [{a, b, dist, pos}], names are item
  // ids, 'arm:<link>', 'arm:flange' (tool), or 'arm:base'
  function contacts(margin, extraIds = []) {
    setMargin(Q, margin, extraIds);
    // kinematics + collision only: no constraint solver — queries never
    // need it (and the QUERY model has no part-part pairs at all).
    // Note: the held part collides with fixtures AND other parts here
    // (part conaffinity 3 ∋ fixtures; part contype 4 vs part affinity…
    // held-vs-part pairs come from contype4 & affinity… see GROUPS_QUERY)
    mj.mj_kinematics(w.model, w.data);
    mj.mj_collision(w.model, w.data);
    const out = [];
    const vec = w.data.contact;              // embind handles: delete after use
    for (let i = 0; i < w.data.ncon; i++) {
      const c = vec.get(i);
      out.push({
        a: w.geomItem[c.geom1], b: w.geomItem[c.geom2],
        dist: c.dist, pos: [c.pos[0], c.pos[1], c.pos[2]],
        normalAB: [c.frame[0], c.frame[1], c.frame[2]],  // from a toward b
      });
      c.delete?.();
    }
    vec.delete?.();
    return out;
  }

  // read a part's current pose back out as a table-frame row-major mat4
  function readPartPoseFrom(slot, id) {
    const adr = slot.partAdr.get(id);
    if (adr === undefined) return null;
    const q = [slot.data.qpos[adr + 3], slot.data.qpos[adr + 4], slot.data.qpos[adr + 5], slot.data.qpos[adr + 6]];
    return IK.matFromQuat(q, [slot.data.qpos[adr], slot.data.qpos[adr + 1], slot.data.qpos[adr + 2]]);
  }
  const readPartPose = id => readPartPoseFrom(Q, id);

  // PHYSICS: let one part settle under gravity while everything else is
  // frozen (arm joints and the other parts are restored every step, so
  // the 45° stack cannot slump and the arm cannot fall). Returns the
  // part's settled pose, or null if it never came to rest.
  function settlePart(id, { duration = 1.5 } = {}) {
    const w = P;              // physics model: the pile below is solid
    const adr = w.partAdr.get(id);
    if (adr === undefined) return null;
    setMargin(P, 0);
    // a settle may only RELAX the part. A press/snap-fit pocket (tighter
    // than the part — real holders grip) gives rigid-body physics no valid
    // rest pose: the solver wedges the part deeper and leaves it hanging
    // on the walls. Detect that and keep the as-placed pose instead.
    const scanFit = () => {
      let pen = 0, support = false;
      for (const c of contacts(0)) {
        if (c.a !== id && c.b !== id) continue;
        if (c.dist < pen) pen = c.dist;
        if (Math.abs(c.normalAB[2]) > 0.7) support = true;
      }
      return { pen, support };
    };
    const fit0 = scanFit();
    const mat0 = readPartPoseFrom(P, id);
    const frozenQpos = Float64Array.from({ length: w.model.nq }, (_, i) => w.data.qpos[i]);
    const g = w.model.opt.gravity;
    const g0 = [g[0], g[1], g[2]];
    g[0] = 0; g[1] = 0; g[2] = -9.81;
    // gentle relaxation, not a sim: a fine timestep plus velocity damping
    // — the frozen neighbours act as kinematic walls, and at coarse steps
    // the contact chatter ratchets a tight-fitting part sideways.
    // The step is also capped by TRAVEL: the part never moves more than
    // 0.2 mm between collision checks, however fast it falls (a fixed
    // 1 ms step lets a 1.5 m/s drop cover 1.5 mm — thin shells get
    // skipped). Capping the step, not the speed, keeps the momentum.
    const DT_MAX = 0.001, DT_MIN = 2e-5, TRAVEL = 2e-4, MAX_STEPS = 40000;
    // the lowest solid thing in the cell: a part that ends up below it
    // has left the world, and would otherwise fall for the whole duration
    let floorZ = -Infinity;
    try {
      mj.mj_kinematics(w.model, w.data);
      let lo = Infinity;
      for (let gi = 0; gi < w.model.ngeom; gi++) {
        if (w.geomItem[gi] === id || w.geomItem[gi].startsWith('arm:')) continue;
        lo = Math.min(lo, w.data.geom_xpos[3 * gi + 2] - w.model.geom_rbound[gi]);
      }
      if (Number.isFinite(lo)) floorZ = lo - 0.05;
    } catch { /* binding without these arrays: no guard */ }
    let fellOut = false;
    const dt0 = w.model.opt.timestep;
    const dof0 = w.partDof.get(id);
    const qv = w.data.qvel;
    const traj = [{ t: 0, mat: readPartPoseFrom(P, id) }];
    let t = 0, nextSample = 1 / 60;
    try {
      for (let i = 0; i < MAX_STEPS && t < duration; i++) {
        const speed = Math.hypot(qv[dof0], qv[dof0 + 1], qv[dof0 + 2]);
        const dt = Math.min(DT_MAX, Math.max(DT_MIN, TRAVEL / Math.max(speed, 1e-9)));
        w.model.opt.timestep = dt;
        mj.mj_step(w.model, w.data);
        t += dt;
        // freeze everything except the settling part
        for (let k = 0; k < w.model.nq; k++) {
          if (k >= adr && k < adr + 7) continue;
          w.data.qpos[k] = frozenQpos[k];
        }
        for (let k = 0; k < w.model.nv; k++) {
          if (k >= dof0 && k < dof0 + 6) continue;
          qv[k] = 0;
        }
        // damp the part's LATERAL and angular motion to bleed off contact
        // chatter (the sideways ratchet); vertical fall stays undamped.
        // 0.9 per millisecond, whatever the step
        const damp = Math.pow(0.9, dt / DT_MAX);
        qv[dof0] *= damp; qv[dof0 + 1] *= damp;
        for (let k = dof0 + 3; k < dof0 + 6; k++) qv[k] *= damp;
        if (t >= nextSample) {                                  // ~60 Hz samples
          traj.push({ t, mat: readPartPoseFrom(P, id) });
          nextSample += 1 / 60;
        }
        // early out when the part is at rest
        let v = 0;
        for (let k = dof0; k < dof0 + 6; k++) v = Math.max(v, Math.abs(qv[k]));
        if (t > 0.1 && v < 5e-4) break;
        if (w.data.qpos[adr + 2] < floorZ) { fellOut = true; break; }
      }
    } finally {
      g[0] = g0[0]; g[1] = g0[1]; g[2] = g0[2];
      w.model.opt.timestep = dt0;
      for (let k = dof0; k < dof0 + 6; k++) qv[k] = 0;
    }
    if (fellOut) {
      setPartPose(id, mat0);     // keep the as-placed pose
      throw new Error(`${id} fell out of the cell — nothing below it to land on`);
    }
    const pose = readPartPoseFrom(P, id);
    traj.push({ t: t + DT_MAX, mat: pose });
    setPartPose(id, pose);     // sync the settled pose into BOTH models
    const fit1 = scanFit();
    // drift of the part's geometric CENTRE (probe centroid), not of its
    // origin: the origin is a CAD datum — a settle that only yaws the
    // part still swings the body sideways
    let gc = [0, 0, 0];
    const pp = probePoints(id) ?? [[0, 0, 0]];
    for (const p of pp) { gc[0] += p[0]; gc[1] += p[1]; gc[2] += p[2]; }
    gc = gc.map(v => v / pp.length);
    const at = (M) => [
      M[0] * gc[0] + M[1] * gc[1] + M[2] * gc[2] + M[3],
      M[4] * gc[0] + M[5] * gc[1] + M[6] * gc[2] + M[7],
      M[8] * gc[0] + M[9] * gc[1] + M[10] * gc[2] + M[11]];
    const c0 = at(mat0), c1 = at(pose);
    const drop = Math.abs(c0[2] - c1[2]);
    const drift = Math.hypot(c1[0] - c0[0], c1[1] - c0[1]);
    if ((fit1.pen < fit0.pen - 2e-4 && !fit1.support) ||
        drift > Math.max(1e-3, 0.5 * drop)) {
      // wedged deeper and hanging, or walked sideways far beyond its
      // cone of descent — physics found no honest rest pose
      setPartPose(id, mat0);   // keep the as-placed pose
      return null;
    }
    return { pose, traj };
  }

  // PUSH a part with a capped force, like a fingertip: quasi-static
  // (strong damping, speed clamp), gravity on, everything else frozen.
  // The part slides, stops against hard obstacles, and can press past
  // soft shallow overlaps (the snap fit). dir is a unit vector in the
  // table frame; dist is how far to push. Returns { pose, moved } —
  // moved < dist means it was blocked.
  function pushPart(id, dir, dist, { force = 25, duration = 1.0 } = {}) {
    const w = P;
    const adr = w.partAdr.get(id);
    if (adr === undefined) return null;
    setMargin(P, 0);
    const n = Math.hypot(dir[0], dir[1], dir[2]) || 1;
    const d3 = [dir[0] / n, dir[1] / n, dir[2] / n];
    const frozenQpos = Float64Array.from({ length: w.model.nq }, (_, i) => w.data.qpos[i]);
    const g = w.model.opt.gravity;
    const g0 = [g[0], g[1], g[2]];
    g[0] = 0; g[1] = 0; g[2] = -9.81;
    const dt0 = w.model.opt.timestep;
    w.model.opt.timestep = 0.001;
    const dt = w.model.opt.timestep;
    const dof0 = w.model.jnt_dofadr[mj.mj_name2id(w.model, mj.mjtObj.mjOBJ_JOINT.value, `fj:${id}`)];
    const start = [w.data.qpos[adr], w.data.qpos[adr + 1], w.data.qpos[adr + 2]];
    const along = () =>
      (w.data.qpos[adr] - start[0]) * d3[0] +
      (w.data.qpos[adr + 1] - start[1]) * d3[1] +
      (w.data.qpos[adr + 2] - start[2]) * d3[2];
    let stale = 0, last = 0;
    try {
      for (let i = 0; i < Math.ceil(duration / dt); i++) {
        for (let k = 0; k < 3; k++) w.data.qfrc_applied[dof0 + k] = d3[k] * force;
        mj.mj_step(w.model, w.data);
        for (let k = 0; k < w.model.nq; k++) {
          if (k >= adr && k < adr + 7) continue;
          w.data.qpos[k] = frozenQpos[k];
        }
        for (let k = 0; k < w.model.nv; k++) {
          if (k >= dof0 && k < dof0 + 6) continue;
          w.data.qvel[k] = 0;
        }
        // quasi-static: damp hard and clamp speed, so one step never
        // outruns the soft-contact ramp (no tunnelling)
        for (let k = dof0; k < dof0 + 6; k++) w.data.qvel[k] *= 0.7;
        for (let k = dof0; k < dof0 + 3; k++) {
          if (w.data.qvel[k] > 0.08) w.data.qvel[k] = 0.08;
          if (w.data.qvel[k] < -0.08) w.data.qvel[k] = -0.08;
        }
        const a = along();
        if (a >= dist) break;
        if (a - last < 1e-6) { if (++stale > 120) break; }   // blocked
        else { stale = 0; last = a; }
      }
    } finally {
      for (let k = 0; k < 3; k++) w.data.qfrc_applied[dof0 + k] = 0;
      for (let k = dof0; k < dof0 + 6; k++) w.data.qvel[k] = 0;
      g[0] = g0[0]; g[1] = g0[1]; g[2] = g0[2];
      w.model.opt.timestep = dt0;
    }
    const pose = readPartPoseFrom(P, id);
    setPartPose(id, pose);     // sync into BOTH models
    return { pose, moved: along() };
  }

  // MEASUREMENT points derived from the SAME boxes MuJoCo collides:
  // corners + face centres of every box, in the item's local frame.
  // Deterministic (no random sampling) and consistent with collision.
  const probeCache = new Map();
  function probePoints(id) {
    if (probeCache.has(id)) return probeCache.get(id);
    const boxes = boxesByItem.get(id);
    if (!boxes) return null;
    const pts = [];
    for (const b of boxes) {
      const [cx, cy, cz] = b.center;
      const [hx, hy, hz] = b.size.map(v => v / 2);
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1])
        pts.push([cx + sx * hx, cy + sy * hy, cz + sz * hz]);
      pts.push([cx + hx, cy, cz], [cx - hx, cy, cz], [cx, cy + hy, cz],
               [cx, cy - hy, cz], [cx, cy, cz + hz], [cx, cy, cz - hz]);
    }
    probeCache.set(id, pts);
    return pts;
  }

  // highest box-corner z within halfWidth of the 2D segment a→b, using
  // CURRENT poses (fixtures static, parts from qpos)
  function corridorMaxZ(a, b, halfWidth, ignore) {
    const ab = [b[0] - a[0], b[1] - a[1]];
    const len2 = ab[0] * ab[0] + ab[1] * ab[1];
    let maxZ = 0;
    for (const [id, boxes] of boxesByItem) {
      if (ignore?.has(id)) continue;
      const isPart = w.partAdr.has(id);
      const fix = !isPart ? (cellData.fixtures ?? []).find(f => f.id === id) : null;
      const mat = isPart ? readPartPose(id)
        : IK.mul(IK.fromXyzRpy(fix.pose_table.xyz_m, [0, 0, 0]), IK.fromXyzRpy([0, 0, 0], fix.pose_table.rpy));
      for (const bx of boxes) {
        const [cx, cy, cz] = bx.center;
        const [hx, hy, hz] = bx.size.map(v => v / 2);
        for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
          const px = cx + sx * hx, py = cy + sy * hy, pz = cz + hz;
          const wx = mat[0] * px + mat[1] * py + mat[2] * pz + mat[3];
          const wy = mat[4] * px + mat[5] * py + mat[6] * pz + mat[7];
          const wz = mat[8] * px + mat[9] * py + mat[10] * pz + mat[11];
          let t = len2 > 1e-12 ? ((wx - a[0]) * ab[0] + (wy - a[1]) * ab[1]) / len2 : 0;
          t = Math.max(0, Math.min(1, t));
          const d = Math.hypot(wx - a[0] - ab[0] * t, wy - a[1] - ab[1] * t);
          if (d < halfWidth && wz > maxZ) maxZ = wz;
        }
      }
    }
    return maxZ;
  }

  let maxZAllCache = null;
  function maxZAll() {
    if (maxZAllCache !== null) return maxZAllCache;
    maxZAllCache = corridorMaxZ([0, 0], [1.3, 0.6], 10, null);
    return maxZAllCache;
  }

  // static contact FORCES at the current poses: gravity on, one full
  // forward pass (with the constraint solver), no integration — the
  // scene does not move. Returns [{a, b, pos, normal, fn, ft}] with
  // fn/ft the normal/tangential force magnitudes in newtons.
  function contactForces() {
    const w = P;              // physics model: full world-world contact
    setMargin(P, 0);
    for (let k = 0; k < w.model.nv; k++) w.data.qvel[k] = 0;
    const g = w.model.opt.gravity;
    const g0 = [g[0], g[1], g[2]];
    g[0] = 0; g[1] = 0; g[2] = -9.81;
    const out = [];
    try {
      mj.mj_forward(w.model, w.data);
      const vec = w.data.contact;
      // out-params MUST be the module's DoubleBuffer — a plain
      // Float64Array is silently ignored by the bindings
      const fbuf = new mj.DoubleBuffer(6);
      for (let i = 0; i < w.data.ncon; i++) {
        const c = vec.get(i);
        mj.mj_contactForce(w.model, w.data, i, fbuf);
        const f = fbuf.GetView();
        out.push({
          a: w.geomItem[c.geom1], b: w.geomItem[c.geom2],
          pos: [c.pos[0], c.pos[1], c.pos[2]],
          normal: [c.frame[0], c.frame[1], c.frame[2]],   // a → b
          fn: f[0], ft: Math.hypot(f[1], f[2]),
        });
        c.delete?.();
      }
      fbuf.delete?.();
      vec.delete?.();
    } finally {
      g[0] = g0[0]; g[1] = g0[1]; g[2] = g0[2];
    }
    return out;
  }

  return {
    setArm, setPartPose, contacts, readPartPose, settlePart, pushPart, contactForces,
    probePoints, corridorMaxZ, maxZAll,
    getBoxes: () => boxesByItem,
    rebuildTool: caps => rebuild(caps),
    get model() { return w.model; },
    get data() { return w.data; },
  };
}
