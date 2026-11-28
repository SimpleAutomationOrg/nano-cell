// The cell without a window: the same planner, physics and step host the
// viewer runs (viewer/planner.js, mj-world.js, cell-host.js), on the same
// scene objects, built here in node with no picture. Steps run to their
// end as fast as they compute.
//
//   const cell = await openCell('case-assembly');
//   const res = await cell.run(['pick-place-case']);   // or cell.run(cell.loop)
//
// `res` has the shape of a run in the viewer (scripts/run-step.mjs prints
// either): ok, error, step, ran, log, parts_moved, held, io, tool,
// joints_deg.
//
// What is built here mirrors main() in viewer/app.js — the arm chain and
// its capsules, the flange stack, the mounted tool with its TCP marker,
// the parts and fixtures as posed groups. When that changes, this does:
// the loops test (test/loops.test.mjs) fails if the two drift.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as IK from '../viewer/ik.js';
import { loadCell } from '../viewer/cell-data.js';
import { createHost } from '../viewer/cell-host.js';
import { createMjWorld } from '../viewer/mj-world.js';
import { capsuleFromObject } from '../viewer/capsules.js';
import { partReport } from '../viewer/agent-run.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// (node says that stripping types from the step files is experimental, every time)
const warn = process.emitWarning;
process.emitWarning = (w, ...rest) => { if (!String(w?.message ?? w).includes('stripTypeScriptTypes')) warn.call(process, w, ...rest); };
const FLANGE_IN_WRIST3 = [0, 0, 0.1];        // as in viewer/app.js

const loader = new GLTFLoader();
const glbCache = new Map();
function loadGlb(path) {
  if (!glbCache.has(path)) {
    const buf = readFileSync(ROOT + path);
    glbCache.set(path, new Promise((res, rej) =>
      loader.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '', g => res(g.scene), rej)));
  }
  return glbCache.get(path).then(scene => scene.clone());
}
function applyPose(obj, pose) {
  obj.position.fromArray(pose.xyz_m);
  obj.quaternion.setFromEuler(new THREE.Euler(pose.rpy[0], pose.rpy[1], pose.rpy[2], 'ZYX'));
}

let mujoco = null;
async function loadMujoco() {
  mujoco ??= (await import('@mujoco/mujoco')).default();
  return mujoco;
}

/** The steps of an application: [{ id, name, tool }], as the server lists them. */
export function listSteps(app) {
  const dir = `${ROOT}applications/${app}/steps`;
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => f.endsWith('.ts')).sort().map(f => {
    const src = readFileSync(`${dir}/${f}`, 'utf8');
    const get = key => new RegExp(`^export const ${key}\\s*=\\s*(['"])(.*?)\\1`, 'm').exec(src)?.[2];
    return { id: f.slice(0, -3), name: get('name'), tool: get('tool') };
  });
}

async function importStep(app, id) {
  const src = readFileSync(`${ROOT}applications/${app}/steps/${id}.ts`, 'utf8');
  const js = stripTypeScriptTypes(src, { mode: 'transform' });
  return import('data:text/javascript;base64,' + Buffer.from(js).toString('base64') + `#${id}-${Date.now()}`);
}

export async function openCell(app, { onLog = () => {} } = {}) {
  const cell = await loadCell(async p => JSON.parse(readFileSync(ROOT + p, 'utf8')), app);
  const mj = await loadMujoco();

  // ---- the scene, as the viewer builds it ----
  const world = new THREE.Group();
  world.rotation.x = -Math.PI / 2;
  const partNodes = new Map();
  const spins = [], armCapsules = [];
  const base = new THREE.Group();
  applyPose(base, cell.arm.mount_table);
  world.add(base);
  const meshDir = `${cell.robot_dir}arm/meshes/`;
  base.add(await loadGlb(`${meshDir}base_link.glb`));
  let parent = base;
  for (const j of IK.CHAIN) {
    const origin = new THREE.Group();
    applyPose(origin, { xyz_m: j.xyz, rpy: j.rpy });
    parent.add(origin);
    const spin = new THREE.Group();
    origin.add(spin);
    spins.push(spin);
    const mesh = await loadGlb(`${meshDir}${j.link}.glb`);
    spin.add(mesh);
    const cap = capsuleFromObject(mesh);
    if (cap) armCapsules.push({ jointIdx: spins.length - 1, ...cap });
    parent = spin;
  }
  const flangeGroup = new THREE.Group();
  flangeGroup.position.fromArray(FLANGE_IN_WRIST3);
  parent.add(flangeGroup);

  async function loadItems(list, parentGroup) {
    for (const it of list ?? []) {
      const holder = new THREE.Group();
      applyPose(holder, it.pose_table ?? it.pose_flange ?? { xyz_m: [0, 0, 0], rpy: [0, 0, 0] });
      if (it.mesh) holder.add(await loadGlb(it.mesh));
      else {
        const ph = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 0.01));
        ph.position.z = 0.005;
        holder.add(ph);
      }
      if (it.id) partNodes.set(it.id, holder);
      parentGroup.add(holder);
    }
  }
  const fixtures = new THREE.Group(); world.add(fixtures);
  const parts = new THREE.Group(); world.add(parts);
  await loadItems(cell.fixtures, fixtures);
  await loadItems(cell.parts, parts);
  const stack = new THREE.Group(); flangeGroup.add(stack);
  await loadItems(cell.flange_stack, stack);
  const toolHolder = new THREE.Group(); flangeGroup.add(toolHolder);

  let mountedId = null, toolCapsules = [];
  async function mountTool(id) {
    toolHolder.clear();
    mountedId = id;
    const t = cell.tools.find(x => x.id === id);
    if (t?.mesh) {
      toolHolder.add(await loadGlb(t.mesh));
      const tcpPoint = t.vacuum?.lip_centre_flange_m ?? t.tip_flange_m;
      if (tcpPoint) {                                   // the viewer's TCP marker: it counts among the tool's capsules
        const tip = new THREE.Mesh(new THREE.SphereGeometry(0.002, 12, 12));
        tip.position.fromArray(tcpPoint);
        toolHolder.add(tip);
      }
    }
    toolCapsules = [...stack.children, ...toolHolder.children].map(c => capsuleFromObject(c, { minR: 0.015 })).filter(Boolean);
  }
  await mountTool(cell.mounted_tool);

  const mjWorld = await createMjWorld({
    getToolId: () => mountedId, mj, cellData: cell, armCapsules, toolCapsules,
    loadStlBuffer: async p => { const b = readFileSync(ROOT + p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); },
  });
  const mountTracked = async id => {
    if (id === mountedId) return;
    if (!cell.tools.some(t => t.id === id)) throw new Error(`the step asks for the tool '${id}', which is not one of the application's grippers`);
    await mountTool(id);
    await mjWorld.rebuildTool(toolCapsules);
  };

  const log = [];
  const say = m => { log.push(String(m).trim()); onLog(m); };
  const e = cell.guard.envelope_mm;
  const ext = (cell.guard.wall_extensions_mm?.right_wall ?? 0) / 1000;
  const host = createHost({
    cellData: cell, spins, flangeGroup, worldGroup: world, partNodes,
    mountMat: IK.fromXyzRpy(cell.arm.mount_table.xyz_m, cell.arm.mount_table.rpy),
    getToolId: () => mountedId,
    onLog: say,
    guardBox: { x0: e.x_min_mm / 1000, x1: e.x_max_mm / 1000 + ext, y0: e.y_min_mm / 1000, y1: e.y_max_mm / 1000, z1: e.z_max_mm / 1000 },
    armCapsules,
    getToolCapsules: () => toolCapsules,
    getMjWorld: () => mjWorld,
  });
  host.setSpeed(1e6);                                   // no one is watching: every motion ends at once
  host.snapJointsDeg(cell.arm.start_deg ?? [-95.8, -109.03, -35.38, -125.69, 89.91, 61.48]);

  // a command is finished by the host's clock: turn it until the step's promise settles
  async function drive(promise) {
    let done = false, err = null;
    promise.then(() => { done = true; }, x => { err = x; done = true; });
    while (!done) { host.update(0.05); await new Promise(r => setImmediate(r)); }
    if (err) throw err;
  }
  const partNow = id => {
    const node = partNodes.get(id);
    world.updateMatrixWorld(true);
    const p = world.worldToLocal(node.getWorldPosition(new THREE.Vector3()));
    return [p.x, p.y, p.z];
  };

  const steps = listSteps(app);
  return {
    cell, steps, loop: cell.loop?.steps ?? [], host, mjWorld, partNow,
    /** Run these steps back to back, each from where the one before left the arm and the parts. */
    async run(ids) {
      const missing = ids.filter(id => !steps.some(s => s.id === id));
      if (missing.length) return { ok: false, error: `no such step: ${missing.join(', ')} — this application has: ${steps.map(s => s.id).join(', ') || 'none'}` };
      if (!ids.length) return { ok: false, error: 'nothing to run' };
      log.length = 0;
      host.reset();
      const t0 = performance.now();
      let out = { ok: true }, now = null;
      try {
        for (const [i, id] of ids.entries()) {
          now = id;
          say(`▶ ${id}`);
          const meta = steps.find(s => s.id === id);
          if (meta.tool) await mountTracked(meta.tool);
          const mod = await importStep(app, id);
          if (i === 0 && mod.entry?.joints_deg) host.snapJointsDeg(mod.entry.joints_deg);
          await drive(mod.default(host.api, host.ctx));
          say(`✓ ${id}`);
        }
      } catch (x) {
        say('✗ ' + x.message);
        out = { ok: false, step: now, error: x.message };
      }
      const moved = (cell.parts ?? []).map(it => partReport(it.id, it.pose_table.xyz_m, partNow(it.id))).filter(p => p.moved_mm >= 0.5);
      return { ...out, ran: ids, seconds: Math.round((performance.now() - t0) / 100) / 10, log: log.slice(-200), parts_moved: moved,
        held: host.state.held ?? null, io: { ...(host.state.io ?? {}) }, tool: mountedId,
        joints_deg: spins.map(sp => Math.round(THREE.MathUtils.radToDeg(sp.rotation.z) * 100) / 100), headless: true };
    },
  };
}
