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

// contype/conaffinity: ARM 1/6, FIXTURE 2/5, PART 4/7 (see header)
const GROUPS = { arm: 'contype="1" conaffinity="6"', fixture: 'contype="2" conaffinity="5"', part: 'contype="4" conaffinity="7"' };

export async function createMjWorld({ mj, cellData, armCapsules, toolCapsules, loadStlBuffer }) {
  // --- box decompositions, cached per mesh path (parts share meshes) ---
  const boxCache = new Map();
  async function boxesFor(meshPath) {
    if (!boxCache.has(meshPath)) {
      const buf = await loadStlBuffer(meshPath);
      boxCache.set(meshPath, boxify(parseBinaryStl(buf)));
    }
    return boxCache.get(meshPath);
  }

  const boxGeoms = (boxes, group) => boxes.map(b =>
    `<geom type="box" ${GROUPS[group]} pos="${vec(b.center)}" size="${vec(b.size.map(v => Math.max(v / 2, 1e-4)))}"/>`
  ).join('\n');
  const capGeom = (c, group) => {
    const len = Math.hypot(c.b[0] - c.a[0], c.b[1] - c.a[1], c.b[2] - c.a[2]);
    if (len < 1e-3) {                     // squat fit: MuJoCo rejects a≈b
      const mid = c.a.map((v, i) => (v + c.b[i]) / 2);
      return `<geom type="sphere" ${GROUPS[group]} pos="${vec(mid)}" size="${Number(c.r.toFixed(7))}"/>`;
    }
    return `<geom type="capsule" ${GROUPS[group]} fromto="${vec(c.a)} ${vec(c.b)}" size="${Number(c.r.toFixed(7))}"/>`;
  };

  const boxesByItem = new Map();  // id -> local-frame boxes
  const itemBoxes = async it => it.boxes ?? await boxesFor(it.collision_mesh);
  async function buildXml(toolCaps) {
    let wb = '';
    for (const it of cellData.fixtures ?? []) {
      if (!it.collision_mesh && !it.boxes) continue;
      const boxes = await itemBoxes(it);
      boxesByItem.set(it.id, boxes);
      wb += `<body name="${it.id}" pos="${vec(it.pose_table.xyz_m)}" quat="${quatAttr(it.pose_table.rpy)}">
        ${boxGeoms(boxes, 'fixture')}</body>\n`;
    }
    for (const it of cellData.parts ?? []) {
      if (!it.collision_mesh && !it.boxes) continue;
      const boxes = await itemBoxes(it);
      boxesByItem.set(it.id, boxes);
      wb += `<body name="${it.id}" pos="${vec(it.pose_table.xyz_m)}" quat="${quatAttr(it.pose_table.rpy)}">
        <freejoint name="fj:${it.id}"/>
        ${boxGeoms(boxes, 'part')}</body>\n`;
    }
    // arm chain: capsules per link, hinge about local z, built inside-out
    const mount = cellData.arm.mount_table;
    let inner = `<body name="arm:flange" pos="0 0 0.1">
      <geom type="sphere" size="0.001" density="100" contype="0" conaffinity="0"/>
      ${(toolCaps ?? []).map(c => capGeom(c, 'arm')).join('\n')}</body>`;
    for (let i = IK.CHAIN.length - 1; i >= 0; i--) {
      const j = IK.CHAIN[i];
      const caps = (armCapsules ?? []).filter(c => c.jointIdx === i).map(c => capGeom(c, 'arm')).join('\n');
      inner = `<body name="arm:${j.link}" pos="${vec(j.xyz)}" quat="${quatAttr(j.rpy)}">
        <joint name="q${i}" type="hinge" axis="0 0 1"/>
        <geom type="sphere" size="0.001" density="100" contype="0" conaffinity="0"/>
        ${caps}${inner}</body>`;
    }
    wb += `<body name="arm:base" pos="${vec(mount.xyz_m)}" quat="${quatAttr(mount.rpy)}">${inner}</body>\n`;
    return `
<mujoco>
  <compiler angle="radian"/>
  <option gravity="0 0 0"/>
  <worldbody>
${wb}
  </worldbody>
</mujoco>`;
  }

  // --- state shared across rebuilds ---
  const w = {
    mj, model: null, data: null,
    jointAdr: [], partAdr: new Map(), geomItem: [],
  };

  async function rebuild(toolCaps) {
    const xml = await buildXml(toolCaps);
    const model = mj.MjModel.from_xml_string(xml);
    const data = new mj.MjData(model);
    w.model = model; w.data = data;
    w.jointAdr = [];
    for (let i = 0; i < 6; i++) {
      const jid = mj.mj_name2id(model, mj.mjtObj.mjOBJ_JOINT.value, `q${i}`);
      w.jointAdr.push(model.jnt_qposadr[jid]);
    }
    w.partAdr = new Map();
    for (const it of cellData.parts ?? []) {
      const jid = mj.mj_name2id(model, mj.mjtObj.mjOBJ_JOINT.value, `fj:${it.id}`);
      if (jid >= 0) w.partAdr.set(it.id, model.jnt_qposadr[jid]);
    }
    w.geomItem = [];
    w.geomsByName = new Map();
    for (let g = 0; g < model.ngeom; g++) {
      const name = mj.mj_id2name(model, mj.mjtObj.mjOBJ_BODY.value, model.geom_bodyid[g]) ?? '';
      w.geomItem.push(name);
      if (!w.geomsByName.has(name)) w.geomsByName.set(name, []);
      w.geomsByName.get(name).push(g);
    }
  }
  await rebuild(toolCapsules);

  function setArm(qRad) {
    for (let i = 0; i < 6; i++) w.data.qpos[w.jointAdr[i]] = qRad[i];
  }
  function setPartPose(id, mat) {
    const adr = w.partAdr.get(id);
    if (adr === undefined) return;
    w.data.qpos[adr] = mat[3]; w.data.qpos[adr + 1] = mat[7]; w.data.qpos[adr + 2] = mat[11];
    const q = quatOfMat(mat);
    for (let k = 0; k < 4; k++) w.data.qpos[adr + 3 + k] = q[k];
  }
  // margin ONLY on the probing bodies (arm + optionally a held part):
  // a global margin makes every resting part erupt in contacts
  function setMargin(m, extraIds = []) {
    const gm = w.model.geom_margin;
    for (let g = 0; g < w.model.ngeom; g++) gm[g] = 0;
    for (const [name, geoms] of w.geomsByName) {
      if (!name.startsWith('arm:') && !extraIds.includes(name)) continue;
      for (const g of geoms) gm[g] = m;
    }
  }

  // contacts at the current state: [{a, b, dist, pos}], names are item
  // ids, 'arm:<link>', 'arm:flange' (tool), or 'arm:base'
  function contacts(margin, extraIds = []) {
    setMargin(margin, extraIds);
    // kinematics + collision only: no constraint solver — queries never
    // need it, and resting parts would make it expensive
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
  function readPartPose(id) {
    const adr = w.partAdr.get(id);
    if (adr === undefined) return null;
    const q = [w.data.qpos[adr + 3], w.data.qpos[adr + 4], w.data.qpos[adr + 5], w.data.qpos[adr + 6]];
    return IK.matFromQuat(q, [w.data.qpos[adr], w.data.qpos[adr + 1], w.data.qpos[adr + 2]]);
  }

  // PHYSICS: let one part settle under gravity while everything else is
  // frozen (arm joints and the other parts are restored every step, so
  // the 45° stack cannot slump and the arm cannot fall). Returns the
  // part's settled pose, or null if it never came to rest.
  function settlePart(id, { duration = 0.8 } = {}) {
    const adr = w.partAdr.get(id);
    if (adr === undefined) return null;
    setMargin(0);
    const frozenQpos = Float64Array.from({ length: w.model.nq }, (_, i) => w.data.qpos[i]);
    const g = w.model.opt.gravity;
    const g0 = [g[0], g[1], g[2]];
    g[0] = 0; g[1] = 0; g[2] = -9.81;
    const dt = w.model.opt.timestep;
    const steps = Math.ceil(duration / dt);
    const every = Math.max(1, Math.round((1 / 60) / dt));   // ~60 Hz samples
    const traj = [{ t: 0, mat: readPartPose(id) }];
    try {
      for (let i = 0; i < steps; i++) {
        mj.mj_step(w.model, w.data);
        // freeze everything except the settling part
        for (let k = 0; k < w.model.nq; k++) {
          if (k >= adr && k < adr + 7) continue;
          w.data.qpos[k] = frozenQpos[k];
        }
        for (let k = 0; k < w.model.nv; k++) {
          // zero all velocities except the part's 6 dofs
          // (freejoint dof address = jnt_dofadr of its joint)
        }
        // crude but sufficient: zero every velocity not belonging to the part
        const dof0 = w.model.jnt_dofadr[mj.mj_name2id(w.model, mj.mjtObj.mjOBJ_JOINT.value, `fj:${id}`)];
        for (let k = 0; k < w.model.nv; k++) {
          if (k >= dof0 && k < dof0 + 6) continue;
          w.data.qvel[k] = 0;
        }
        // early out when the part is at rest
        if (i % every === 0) traj.push({ t: (i + 1) * dt, mat: readPartPose(id) });
        let v = 0;
        for (let k = dof0; k < dof0 + 6; k++) v = Math.max(v, Math.abs(w.data.qvel[k]));
        if (i > 10 && v < 1e-3) break;
      }
    } finally {
      g[0] = g0[0]; g[1] = g0[1]; g[2] = g0[2];
    }
    const pose = readPartPose(id);
    traj.push({ t: traj[traj.length - 1].t + dt, mat: pose });
    return { pose, traj };
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
    setMargin(0);
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
    setArm, setPartPose, contacts, readPartPose, settlePart, contactForces,
    probePoints, corridorMaxZ, maxZAll,
    getBoxes: () => boxesByItem,
    rebuildTool: caps => rebuild(caps),
    get model() { return w.model; },
    get data() { return w.data; },
  };
}
