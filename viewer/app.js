import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CHAIN } from './ik.js';
import * as IK from './ik.js';
import { createHost } from './cell-host.js';
import { capsuleFromObject } from './capsules.js';
import { createMjWorld } from './mj-world.js';
import { dockedTools } from './planner.js';

const status = m => document.getElementById('status').textContent = m;

// ---------- renderer / scene ----------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.getElementById('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x11161c);

const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.02, 60);
camera.position.set(0.0, 1.05, 1.75);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0.68, 0.28, -0.30);
controls.enableDamping = true;
window.view = { camera, controls, scene };   // console/debug access

// ---------- fly camera: WASD ----------
// W/S rise and sink, A/D strafe, E/Q fly forward and back along the
// view direction, Shift for fast. The orbit pivot travels with the camera while you fly, and
// the next mouse drag re-anchors it on the surface at the centre of the
// view — so after flying, dragging always orbits around what you are
// looking at (not around an invisible point somewhere behind it). Speed
// scales with distance to the pivot: close to a part you creep, far out
// you cross the cell quickly.
const flyKeys = new Set();
let flyFast = false;
let flyFocus = null;              // the selected part's node, for F
let flyMoved = false;             // flown since the pivot was last anchored
const FLY = new Set(['w', 'a', 's', 'd', 'q', 'e']);
const HOME_EYE = new THREE.Vector3(0, 1.05, 1.75);
const HOME_AT = new THREE.Vector3(0.68, 0.28, -0.30);
export function setFlyFocus(node) { flyFocus = node; }

// F: frame the selected part, or fly home when nothing is selected —
// the way back after flying off into the void
function frameView() {
  if (flyFocus) {
    const box = new THREE.Box3().setFromObject(flyFocus);
    if (!box.isEmpty()) {
      const c = box.getCenter(new THREE.Vector3());
      const r = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 0.02);
      const dir = camera.getWorldDirection(new THREE.Vector3());
      controls.target.copy(c);
      camera.position.copy(c).addScaledVector(dir, -(r * 3 + 0.12));
      return;
    }
  }
  camera.position.copy(HOME_EYE);
  controls.target.copy(HOME_AT);
}

addEventListener('keydown', ev => {
  flyFast = ev.shiftKey;
  if (/INPUT|SELECT|TEXTAREA/.test(ev.target?.tagName ?? '')) return;
  const k = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
  if (k === 'f') { ev.preventDefault(); frameView(); flyMoved = false; return; }
  if (!FLY.has(k)) return;
  ev.preventDefault();
  flyKeys.add(k);
});
addEventListener('keyup', ev => {
  flyFast = ev.shiftKey;
  flyKeys.delete(ev.key.length === 1 ? ev.key.toLowerCase() : ev.key);
});
addEventListener('blur', () => { flyKeys.clear(); flyFast = false; });

// Re-anchor the orbit pivot on whatever is at the centre of the view.
// The pivot only slides ALONG the view direction, so the picture does
// not move — only what the next drag turns around.
const anchorRay = new THREE.Raycaster();
// centre first, then rings further out: the centre of the view is often
// a gap (between two arm links, past a part's edge)
const ANCHOR_RAYS = [[0, 0]];
for (const r of [0.12, 0.25, 0.4])
  for (let k = 0; k < 8; k++) ANCHOR_RAYS.push([r * Math.cos(k * Math.PI / 4), r * Math.sin(k * Math.PI / 4)]);
function anchorPivot() {
  flyMoved = false;
  camera.updateMatrixWorld();
  camera.getWorldDirection(flyFwd);
  // a mesh is only "there" if every group above it is shown too (the
  // debug overlays are hidden by their parent) and it is not see-through
  const shown = o => { for (; o; o = o.parent) if (!o.visible) return false; return true; };
  for (const [nx, ny] of ANCHOR_RAYS) {
    anchorRay.setFromCamera(new THREE.Vector2(nx, ny), camera);
    const hit = anchorRay.intersectObjects(scene.children, true).find(h =>
      h.object.isMesh && shown(h.object) && !h.object.material?.transparent);
    if (!hit) continue;
    // depth of that surface ALONG the view direction
    const depth = hit.point.sub(camera.position).dot(flyFwd);
    controls.target.copy(camera.position).addScaledVector(flyFwd, Math.min(Math.max(depth, 0.05), 4));
    return;
  }
  // nothing in view at all: leave the pivot where it travelled to
}
// capture phase: anchored before OrbitControls starts its drag or zoom
for (const type of ['pointerdown', 'wheel'])
  renderer.domElement.addEventListener(type, () => { if (flyMoved) anchorPivot(); }, { capture: true, passive: true });

const flyFwd = new THREE.Vector3(), flyRight = new THREE.Vector3(), flyStep = new THREE.Vector3();
function updateFly(dt) {
  if (!flyKeys.size) return;
  camera.getWorldDirection(flyFwd);
  flyRight.crossVectors(flyFwd, camera.up).normalize();
  flyStep.set(0, 0, 0);
  if (flyKeys.has('w')) flyStep.add(camera.up);
  if (flyKeys.has('s')) flyStep.sub(camera.up);
  if (flyKeys.has('d')) flyStep.add(flyRight);
  if (flyKeys.has('a')) flyStep.sub(flyRight);
  if (flyKeys.has('e')) flyStep.add(flyFwd);
  if (flyKeys.has('q')) flyStep.sub(flyFwd);
  if (flyStep.lengthSq() < 1e-9) return;
  // 0.4 x the orbit distance per second: ~2 s to cross the cell from
  // the default view, and a crawl once you are nose-up to a part
  const near = Math.min(Math.max(camera.position.distanceTo(controls.target), 0.15), 2.5);
  flyStep.normalize().multiplyScalar(near * 0.4 * (flyFast ? 3 : 1) * dt);
  camera.position.add(flyStep);
  controls.target.add(flyStep);       // the pivot travels with the camera
  flyMoved = true;
}

scene.add(new THREE.HemisphereLight(0xbcd0e8, 0x20262e, 1.0));
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(1.5, 3.0, 1.2);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -1.2; sun.shadow.camera.right = 1.2;
sun.shadow.camera.top = 1.2; sun.shadow.camera.bottom = -1.2;
sun.shadow.bias = -0.0003;
scene.add(sun);
const fill = new THREE.DirectionalLight(0x8fb4ff, 0.5);
fill.position.set(-1.5, 1.2, -1.5);
scene.add(fill);

// Everything in the repo is z-up (table frame); three.js is y-up.
const world = new THREE.Group();
world.rotation.x = -Math.PI / 2;
scene.add(world);

// ---------- helpers ----------
function applyPose(obj, pose) {
  obj.position.fromArray(pose.xyz_m);
  obj.quaternion.setFromEuler(new THREE.Euler(pose.rpy[0], pose.rpy[1], pose.rpy[2], 'ZYX'));
}

const loader = new GLTFLoader();
const loadGlb = url => new Promise((res, rej) => loader.load(url, g => res(g.scene), undefined, rej));

function tagShadows(obj, name) {
  obj.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  if (name) obj.userData.itemName = name;
}

// ---------- static cell dressing ----------
function buildTable(table) {
  const [sx, sy] = table.size_m;
  const [x0, y0] = table.min_table_m;
  const t = 0.0128;
  const plate = new THREE.Mesh(
    new THREE.BoxGeometry(sx, sy, t),
    new THREE.MeshStandardMaterial({ color: 0x343c46, roughness: 0.85, metalness: 0.25 })
  );
  plate.position.set(x0 + sx / 2, y0 + sy / 2, -t / 2);
  plate.receiveShadow = true;
  plate.userData.itemName = 'MB6090 breadboard plate';
  world.add(plate);

  const dot = new THREE.CircleGeometry(0.003, 10);
  const mat = new THREE.MeshBasicMaterial({ color: 0x1c2229 });
  const nx = Math.floor(sx / table.hole_pitch_m), ny = Math.floor(sy / table.hole_pitch_m);
  const holes = new THREE.InstancedMesh(dot, mat, nx * ny);
  const m = new THREE.Matrix4();
  let i = 0;
  for (let ix = 0; ix < nx; ix++)
    for (let iy = 0; iy < ny; iy++)
      holes.setMatrixAt(i++, m.makeTranslation(
        x0 + table.first_hole_m + ix * table.hole_pitch_m,
        y0 + table.first_hole_m + iy * table.hole_pitch_m, 0.0004));
  world.add(holes);
}

function buildGuard(guard) {
  const g = new THREE.Group();
  const e = guard.envelope_mm;
  const ext = (guard.wall_extensions_mm?.right_wall ?? 0) / 1000;
  const x0 = e.x_min_mm / 1000, x1 = e.x_max_mm / 1000 + ext;
  const y0 = e.y_min_mm / 1000, y1 = e.y_max_mm / 1000;
  const z1 = e.z_max_mm / 1000;
  const box = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1);
  const glass = new THREE.Mesh(box, new THREE.MeshPhysicalMaterial({
    color: 0x6fb7ff, transparent: true, opacity: 0.07, roughness: 0.15,
    side: THREE.DoubleSide, depthWrite: false
  }));
  glass.position.set((x0 + x1) / 2, (y0 + y1) / 2, z1 / 2);
  glass.userData.itemName = `guard envelope ${Math.round((x1 - x0) * 1000)} × ${Math.round((y1 - y0) * 1000)} × ${Math.round(z1 * 1000)} mm`;
  g.add(glass);
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(box),
    new THREE.LineBasicMaterial({ color: 0x5f9fe0, transparent: true, opacity: 0.8 })
  );
  edges.position.copy(glass.position);
  g.add(edges);

  if (guard.operator_barrier) {
    const off = guard.operator_barrier.offset_m;
    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(x1 - x0, z1),
      new THREE.MeshBasicMaterial({ color: 0xff9f43, transparent: true, opacity: 0.06, side: THREE.DoubleSide, depthWrite: false })
    );
    plane.rotation.x = Math.PI / 2;
    plane.position.set((x0 + x1) / 2, off, z1 / 2);
    plane.userData.itemName = `operator barrier, y = ${off} m`;
    g.add(plane);
  }
  world.add(g);
  return g;
}

// ---------- FR3 ----------
const FLANGE_IN_WRIST3 = [0, 0, 0.1];
const POSE_DOCK = [-27.55, -93.04, -110.382, -66.561, 90.068, -140.229];
const POSE_UP = [0, -90, 0, -90, 0, 0];

const spins = [];
let flangeGroup = null;
const armCapsules = [];   // {jointIdx, a, b, r} in each link's frame

async function buildArm(armCfg) {
  const base = new THREE.Group();
  applyPose(base, armCfg.mount_table);
  world.add(base);

  const baseMesh = await loadGlb('../arm/fr3/meshes/base_link.glb');
  tagShadows(baseMesh, 'FR3 base_link');
  base.add(baseMesh);

  let parent = base;
  for (const j of CHAIN) {
    const origin = new THREE.Group();
    applyPose(origin, { xyz_m: j.xyz, rpy: j.rpy });
    parent.add(origin);
    const spin = new THREE.Group();
    origin.add(spin);
    spins.push(spin);
    const mesh = await loadGlb(`../arm/fr3/meshes/${j.link}.glb`);
    tagShadows(mesh, `FR3 ${j.link}`);
    spin.add(mesh);
    const cap = capsuleFromObject(mesh);
    if (cap) armCapsules.push({ jointIdx: spins.length - 1, ...cap });
    parent = spin;
  }
  flangeGroup = new THREE.Group();
  flangeGroup.position.fromArray(FLANGE_IN_WRIST3);
  parent.add(flangeGroup);
  flangeGroup.add(new THREE.AxesHelper(0.05));
  return base;
}

function reflectJointsDeg(deg) {
  deg.forEach((d, i) => {
    const s = document.getElementById('j' + i);
    if (s) { s.value = d; document.getElementById('jo' + i).value = d.toFixed(1) + '°'; }
  });
}

function setJoints(deg) {
  deg.forEach((d, i) => spins[i].rotation.z = THREE.MathUtils.degToRad(d));
  reflectJointsDeg(deg);
}

function buildJointUI() {
  const host = document.getElementById('joints');
  CHAIN.forEach((j, i) => {
    const row = document.createElement('div');
    row.className = 'joint';
    const lo = THREE.MathUtils.radToDeg(j.lim[0]).toFixed(0);
    const hi = THREE.MathUtils.radToDeg(j.lim[1]).toFixed(0);
    row.innerHTML = `<label>J${i + 1}</label>
      <input type="range" id="j${i}" min="${lo}" max="${hi}" step="0.1" value="0">
      <output id="jo${i}">0.0°</output>`;
    host.appendChild(row);
    row.querySelector('input').addEventListener('input', e => {
      const v = parseFloat(e.target.value);
      spins[i].rotation.z = THREE.MathUtils.degToRad(v);
      document.getElementById('jo' + i).value = v.toFixed(1) + '°';
    });
  });
  document.getElementById('poseDemo').onclick = () => setJoints(POSE_DOCK);
  document.getElementById('poseUp').onclick = () => setJoints(POSE_UP);
}

function addToggle(label, group, on = true) {
  group.visible = on;
  const l = document.createElement('label');
  l.innerHTML = `<input type="checkbox" ${on ? 'checked' : ''}> ${label}`;
  l.querySelector('input').addEventListener('change', e => group.visible = e.target.checked);
  document.getElementById('toggles').appendChild(l);
}

// ---------- cell items ----------
const partNodes = new Map();   // id -> THREE.Group (parts and fixtures)

async function loadItems(list, base, parentGroup) {
  for (const it of list ?? []) {
    const holder = new THREE.Group();
    applyPose(holder, it.pose_table ?? it.pose_flange ?? { xyz_m: [0, 0, 0], rpy: [0, 0, 0] });
    holder.userData.itemName = it.name || it.id;
    if (it.mesh) {
      try {
        const m = await loadGlb(base + it.mesh);
        tagShadows(m, it.name || it.id);
        holder.add(m);
      } catch { console.warn('mesh failed:', it.mesh); }
    } else {
      const ph = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 0.01),
        new THREE.MeshStandardMaterial({ color: 0x3fa34d, roughness: 0.6 }));
      ph.position.z = 0.005;
      holder.add(ph);
    }
    if (it.id) partNodes.set(it.id, holder);
    parentGroup.add(holder);
  }
}

// ---------- task runner ----------
let host = null;
let running = false;

// one line in the panel; full history in the browser console
function taskLog(msg) {
  console.log('[task]', msg);
  const el = document.getElementById('taskline');
  el.textContent = msg.trim();
  el.title = msg.trim();
}

// .ts segments are transpiled in the page (types stripped by sucrase, loaded
// once from CDN) and imported as a blob module; .js segments import directly.
let sucrase = null;
async function importSegment(url) {
  if (!url.includes('.ts')) return import(url);
  const src = await (await fetch(url)).text();
  sucrase ??= await import('https://cdn.jsdelivr.net/npm/sucrase@3.35.0/+esm');
  const js = sucrase.transform(src, { transforms: ['typescript'] }).code;
  const blobUrl = URL.createObjectURL(new Blob([js], { type: 'text/javascript' }));
  try { return await import(blobUrl); }
  finally { URL.revokeObjectURL(blobUrl); }
}

async function runSegments(taskId, files, { snapEntry }) {
  if (running) { taskLog('already running'); return; }
  running = true;
  host.reset();
  try {
    for (const [i, f] of files.entries()) {
      status(`running ${f}…`);
      taskLog(`▶ ${f}`);
      const mod = await importSegment(`/tasks/${taskId}/segments/${f}?v=${Date.now()}`);
      if (i === 0 && snapEntry && mod.entry?.joints_deg) {
        host.snapJointsDeg(mod.entry.joints_deg);
      }
      await mod.default(host.api, host.ctx);
      taskLog(`✓ ${f}`);
    }
    status('task done');
  } catch (e) {
    if (e.message === 'aborted') { status('task stopped'); taskLog('■ stopped'); }
    else { status('task failed: ' + e.message); taskLog('✗ ' + e.message); console.error(e); }
  } finally {
    running = false;
  }
}

async function buildTaskUI(cell, mountToolFn) {
  let tasks = [];
  try { tasks = await (await fetch('/__tasks')).json(); } catch { /* not serve.py */ }
  if (!tasks.length) return;

  const sel = document.getElementById('taskSel');
  sel.innerHTML = '<option value="">— pick a task —</option>' +
    tasks.map(t => `<option value="${t.id}">${t.name ?? t.id}</option>`).join('');

  const segHost = document.getElementById('segments');
  sel.addEventListener('change', async () => {
    segHost.innerHTML = '';
    const t = tasks.find(x => x.id === sel.value);
    if (!t) return;
    if (t.tool) await mountToolFn(t.tool);
    for (const f of t.segments) {
      const row = document.createElement('div');
      row.className = 'segrow';
      row.innerHTML = `<button title="run this segment alone">▶</button><span>${f.replace(/\.[jt]s$/, '')}</span>`;
      row.querySelector('button').onclick = () => runSegments(t.id, [f], { snapEntry: true });
      segHost.appendChild(row);
    }
    const all = document.createElement('button');
    all.textContent = 'Run all segments';
    all.style.marginTop = '6px';
    all.onclick = () => runSegments(t.id, t.segments, { snapEntry: true });
    segHost.appendChild(all);
  });

  document.getElementById('btnPause').onclick = () => {
    if (host.state.paused) { host.resume(); document.getElementById('btnPause').textContent = 'Pause'; }
    else { host.pause(); document.getElementById('btnPause').textContent = 'Resume'; }
  };
  document.getElementById('btnStep').onclick = () => { host.step(); document.getElementById('btnPause').textContent = 'Pause'; };
  document.getElementById('btnStop').onclick = () => host.abort();
  document.getElementById('speedSel').addEventListener('change', e => host.setSpeed(parseFloat(e.target.value)));
}

// ---------- load the cell ----------
async function main() {
  const cell = await (await fetch('../cell/dvt01/cell.json')).json();
  document.getElementById('cellName').textContent = cell.name;
  document.title = cell.name;

  buildTable(cell.table);
  const guard = buildGuard(cell.guard);
  await buildArm(cell.arm);
  buildJointUI();
  setJoints(POSE_DOCK);

  const fixtures = new THREE.Group(); world.add(fixtures);
  const parts = new THREE.Group(); world.add(parts);
  status('loading fixtures…');
  await loadItems(cell.fixtures, '../cell/dvt01/', fixtures);
  status('loading parts…');
  await loadItems(cell.parts, '../cell/dvt01/', parts);

  const stack = new THREE.Group(); flangeGroup.add(stack);
  status('loading flange stack…');
  await loadItems(cell.flange_stack, '../cell/dvt01/', stack);

  const toolHolder = new THREE.Group(); flangeGroup.add(toolHolder);
  const sel = document.getElementById('toolSel');
  const toolCache = {};
  for (const t of cell.tools) {
    const o = document.createElement('option');
    o.value = t.id; o.textContent = t.name;
    sel.appendChild(o);
  }
  // the tools resting in the rack: every stand's tool except the one on
  // the arm, at the stand's measured docked pose
  const rack = new THREE.Group(); world.add(rack);
  async function showRack(mountedId) {
    rack.clear();
    await loadItems(dockedTools(cell, mountedId).map(({ id, ...rest }) => rest), '../cell/dvt01/', rack);
  }
  let mountedId = null;
  async function mountTool(id) {
    toolHolder.clear();
    sel.value = id;
    mountedId = id;
    await showRack(id);
    const t = cell.tools.find(x => x.id === id);
    if (!t || !t.mesh) return;
    if (!toolCache[id]) toolCache[id] = await loadGlb('../cell/dvt01/' + t.mesh);
    const m = toolCache[id].clone();
    tagShadows(m, t.name);
    toolHolder.add(m);
    // mark the CONTROLLED frame (the TCP): for a vacuum cup that is the
    // lip centre, not the catalog tip point — the cup is bent off the
    // flange axis, so the tip point floats beside the lip and misleads
    const tcpPoint = t.vacuum?.lip_centre_flange_m ?? t.tip_flange_m;
    if (tcpPoint) {
      const tip = new THREE.Mesh(new THREE.SphereGeometry(0.002, 12, 12),
        new THREE.MeshBasicMaterial({ color: 0xff5f5f }));
      tip.position.fromArray(tcpPoint);
      tip.userData.itemName = t.vacuum ? 'TCP (cup lip centre)' : (t.tip_name || 'tip');
      toolHolder.add(tip);
    }
  }
  status('loading tool…');
  await mountTool(cell.mounted_tool);

  // one capsule per flange-stack item and per tool mesh (flange frame),
  // refreshed on tool change — a single fat capsule is too conservative
  let toolCapsules = [];
  function refreshToolCapsule() {
    toolCapsules = [...stack.children, ...toolHolder.children]
      .map(c => capsuleFromObject(c, { minR: 0.015 }))
      .filter(Boolean);
  }
  refreshToolCapsule();
  const mountToolTracked = async id => {
    // already on the arm: nothing to rebuild (rebuilding the physics for
    // an unchanged tool froze the page every time a task was selected)
    if (id === mountedId) return;
    await mountTool(id);
    refreshToolCapsule();
    mjWorldRef?.rebuildTool(toolCapsules).catch(e => console.warn('[mj] tool rebuild failed', e));
  };
  // picking a tool by hand goes the same way, so the physics always has
  // the tool that is drawn
  sel.addEventListener('change', e => mountToolTracked(e.target.value));


  // red marker where a predicted collision was reported
  const hitMarker = new THREE.Mesh(
    new THREE.SphereGeometry(0.012, 16, 16),
    new THREE.MeshBasicMaterial({ color: 0xff3030 }));
  hitMarker.visible = false;
  world.add(hitMarker);

  addToggle('guard box', guard);
  addToggle('fixtures', fixtures);
  addToggle('parts', parts);
  addToggle('flange stack', stack);
  addToggle('tools in the rack', rack);

  // MuJoCo is THE geometry backend (collision, touch, physics,
  // measurements). It is required: without `npm install` tasks cannot
  // run, though the scene itself still renders for inspection.
  let mjWorldRef = null;
  window.mjWorld = () => mjWorldRef;   // console/debug access
  const backendBadge = document.createElement('div');
  backendBadge.style.cssText = 'margin-top:6px;color:#7d8a99;font-size:11px';
  backendBadge.textContent = 'physics: loading MuJoCo…';
  document.getElementById('toggles').appendChild(backendBadge);
  try {
    status('loading physics…');
    const loadMujoco = (await import('/node_modules/@mujoco/mujoco/mujoco.js')).default;
    const mjmod = await loadMujoco();
    mjWorldRef = await createMjWorld({
      getToolId: () => sel.value,
      mj: mjmod, cellData: cell, armCapsules, toolCapsules,
      loadStlBuffer: p => fetch('../cell/dvt01/' + p).then(r => {
        if (!r.ok) throw new Error(`${p}: ${r.status}`);
        return r.arrayBuffer();
      }),
    });
    backendBadge.textContent = 'physics: MuJoCo';
    backendBadge.style.color = '#7fd0a0';
  } catch (e) {
    console.warn('[mj] backend failed to load:', e);
    backendBadge.textContent = 'physics: UNAVAILABLE — run `npm install`, then reload';
    backendBadge.style.color = '#ff7f7f';
    taskLog('MuJoCo failed to load — tasks disabled (run `npm install`)');
    document.getElementById('taskSel').disabled = true;
  }

  // the task host
  host = createHost({
    cellData: cell,
    spins, flangeGroup, worldGroup: world, partNodes,
    mountMat: IK.fromXyzRpy(cell.arm.mount_table.xyz_m, cell.arm.mount_table.rpy),
    getToolId: () => sel.value,
    onLog: taskLog,
    onJoints: reflectJointsDeg,
    guardBox: (() => {
      const e = cell.guard.envelope_mm;
      const ext = (cell.guard.wall_extensions_mm?.right_wall ?? 0) / 1000;
      return {
        x0: e.x_min_mm / 1000, x1: e.x_max_mm / 1000 + ext,
        y0: e.y_min_mm / 1000, y1: e.y_max_mm / 1000, z1: e.z_max_mm / 1000,
      };
    })(),
    armCapsules,
    getToolCapsules: () => toolCapsules,
    getMjWorld: () => mjWorldRef,
    onCollision: (point) => { hitMarker.position.fromArray(point); hitMarker.visible = true; },
  });
  window.host = host;  // console access for debugging segments

  const colToggle = document.createElement('label');
  colToggle.innerHTML = `<input type="checkbox" checked> collision check`;
  colToggle.querySelector('input').addEventListener('change', e => host.setCollisionCheck(e.target.checked));
  document.getElementById('toggles').appendChild(colToggle);


  // debug view: the MOVING side of every collision decision — the
  // capsules fitted to each arm link and to the flange stack + tool.
  // They attach to the joint frames, so they ride along with the arm.
  const capMeshes = [];
  const capToggle = document.createElement('label');
  capToggle.innerHTML = `<input type="checkbox"> collision capsules`;
  capToggle.querySelector('input').addEventListener('change', e => {
    while (capMeshes.length) { const m = capMeshes.pop(); m.parent?.remove(m); }
    if (!e.target.checked) return;
    const mat = new THREE.MeshBasicMaterial({
      color: 0x4da3ff, transparent: true, opacity: 0.25, depthWrite: false,
    });
    const addCap = (parentObj, cap, name) => {
      const a = new THREE.Vector3(...cap.a), b = new THREE.Vector3(...cap.b);
      const len = a.distanceTo(b);
      const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(cap.r, len, 6, 14), mat);
      mesh.position.copy(a).add(b).multiplyScalar(0.5);
      // CapsuleGeometry runs along +Y: rotate it onto the a→b axis
      mesh.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        b.clone().sub(a).normalize());
      mesh.userData.itemName = `collision capsule: ${name}`;
      parentObj.add(mesh);
      capMeshes.push(mesh);
    };
    armCapsules.forEach(c => addCap(spins[c.jointIdx], c, `link J${c.jointIdx + 1}`));
    toolCapsules.forEach((c, i) => addCap(flangeGroup, c, `tool/stack ${i}`));
  });
  document.getElementById('toggles').appendChild(capToggle);

  // debug view: the EXACT backend's obstacle geometry — the box
  // decomposition each item collides as in MuJoCo. Boxes are children of
  // the item nodes, so they follow moved and held parts live.
  const mjBoxGroups = [];
  const mjBoxToggle = document.createElement('label');
  mjBoxToggle.innerHTML = `<input type="checkbox"> MuJoCo boxes`;
  mjBoxToggle.querySelector('input').addEventListener('change', e => {
    while (mjBoxGroups.length) { const g = mjBoxGroups.pop(); g.parent?.remove(g); }
    if (!e.target.checked) return;
    const w = mjWorldRef;
    if (!w) { taskLog('MuJoCo backend not active'); e.target.checked = false; return; }
    const mat = new THREE.MeshBasicMaterial({
      color: 0x51e8c8, transparent: true, opacity: 0.22, depthWrite: false,
    });
    for (const [id, boxes] of w.getBoxes()) {
      const node = partNodes.get(id);
      if (!node) continue;
      const g = new THREE.Group();
      g.userData.itemName = `MuJoCo boxes: ${id}`;
      const edgeMat = new THREE.LineBasicMaterial({ color: 0x19c9a6 });
      for (const b of boxes) {
        const geo = new THREE.BoxGeometry(...b.size);
        const m = new THREE.Mesh(geo, mat);
        m.position.set(...b.center);
        g.add(m);
        const e = new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgeMat);
        e.position.copy(m.position);
        g.add(e);
      }
      node.add(g);
      mjBoxGroups.push(g);
    }
  });
  document.getElementById('toggles').appendChild(mjBoxToggle);

  // CONTACT FORCES: static equilibrium under gravity at the current
  // poses — an arrow per contact (direction = push on the second body,
  // length/colour = magnitude). Refreshes twice a second while enabled.
  let forceGroup = null, forceTimer = null;
  const d2rApp = d => d * Math.PI / 180;
  function liveMat(node) {
    node.updateWorldMatrix(true, false);
    world.updateWorldMatrix(true, false);
    const m = world.matrixWorld.clone().invert().multiply(node.matrixWorld);
    const e = m.elements;
    return [e[0], e[4], e[8], e[12], e[1], e[5], e[9], e[13], e[2], e[6], e[10], e[14], 0, 0, 0, 1];
  }
  function refreshForces() {
    const w2 = mjWorldRef;
    if (!w2) return;
    if (forceGroup) { world.remove(forceGroup); forceGroup = null; }
    try {
      w2.setArm(host.api.joints().map(d2rApp));
      for (const it of cell.parts ?? []) {
        const node = partNodes.get(it.id);
        if (node) w2.setPartPose(it.id, liveMat(node));
      }
      const fs = w2.contactForces().filter(f => f.fn > 0.01);
      forceGroup = new THREE.Group();
      for (const f of fs) {
        const mag = Math.sqrt(f.fn);                      // visual scale
        const len = Math.min(0.12, 0.02 + 0.04 * mag);
        const color = f.fn < 0.3 ? 0x7fd0a0 : f.fn < 1.5 ? 0xffc94d : 0xff5f5f;
        const dir = new THREE.Vector3(...f.normal).normalize();
        const arrow = new THREE.ArrowHelper(dir, new THREE.Vector3(...f.pos), len, color, len * 0.35, len * 0.2);
        arrow.traverse(o => { o.userData.itemName = `${f.fn.toFixed(2)} N · ${f.a} ↔ ${f.b}`; });
        forceGroup.add(arrow);
      }
      world.add(forceGroup);
    } catch (e) { console.warn('[forces]', e); }
  }
  const forceToggle = document.createElement('label');
  forceToggle.innerHTML = `<input type="checkbox"> contact forces`;
  forceToggle.querySelector('input').addEventListener('change', e => {
    if (forceTimer) { clearInterval(forceTimer); forceTimer = null; }
    if (forceGroup) { world.remove(forceGroup); forceGroup = null; }
    if (!e.target.checked) return;
    if (!mjWorldRef) { taskLog('physics backend not active'); e.target.checked = false; return; }
    refreshForces();
    forceTimer = setInterval(refreshForces, 500);
  });
  document.getElementById('toggles').appendChild(forceToggle);

  // reset the SCENE in place (camera stays): parts back to their loaded
  // poses — including one riding the flange — collision world restored,
  // run state cleared, arm to the dock pose
  document.getElementById('btnReset').onclick = () => {
    host.abort();
    host.reset();
    host.state.held = null;
    host.state.io = {};
    for (const it of cell.parts ?? []) {
      const node = partNodes.get(it.id);
      if (!node) continue;
      world.attach(node);
      applyPose(node, it.pose_table);
      node.updateMatrix();
    }
    setJoints(POSE_DOCK);
    taskLog('scene reset');
    status('scene reset');
  };

  // ---------- interactive part pushing ----------
  // click a part to select it, then push it with the keyboard. Each
  // press is a REAL physics push (a capped force through MuJoCo): the
  // part slides and stops against walls — it can never teleport or
  // tunnel.
  //   arrows      push horizontally, relative to the camera (8 N)
  //   Z (or PgDn) press down firmly (30 N — seats a jammed part)
  //   X (or PgUp) lift gently (8 N)
  //   Shift       fine steps (0.1 mm instead of 1 mm)
  //   Esc         deselect
  // (letters chosen to leave WASD free for future bindings)
  {
    const nodeToPart = new Map();
    for (const it of cell.parts ?? []) {
      const n = partNodes.get(it.id);
      if (n) nodeToPart.set(n, it.id);
    }
    let selected = null, outline = null;
    const select = id => {
      if (outline) { scene.remove(outline); outline = null; }
      selected = id;
      setFlyFocus(id ? partNodes.get(id) : null);   // F frames it
      if (id) {
        // BoxHelper builds scene-space geometry, so it must live on the
        // scene root, not inside the rotated table-frame group
        outline = new THREE.BoxHelper(partNodes.get(id), 0xffc94d);
        scene.add(outline);
        taskLog(`${id} selected — arrows push · Z press in · X lift · F frame · Esc done`);
      }
    };
    window.selectPart = select;              // console/debug access
    const pickRay = new THREE.Raycaster();
    let downAt = null;
    renderer.domElement.addEventListener('pointerdown', ev => { downAt = [ev.clientX, ev.clientY]; });
    renderer.domElement.addEventListener('pointerup', ev => {
      if (!downAt || Math.hypot(ev.clientX - downAt[0], ev.clientY - downAt[1]) > 5) return;  // orbit drag
      pickRay.setFromCamera(new THREE.Vector2(ev.clientX / innerWidth * 2 - 1, -(ev.clientY / innerHeight) * 2 + 1), camera);
      const hits = pickRay.intersectObjects(world.children, true).filter(h =>
        h.object.visible && h.object.isMesh &&
        !(h.object.material?.transparent && h.object.material.opacity < 0.5));
      for (const h of hits) {
        let o = h.object;
        while (o && !nodeToPart.has(o)) o = o.parent;
        if (o) { select(nodeToPart.get(o)); return; }
      }
      if (selected) { select(null); taskLog('push mode off'); }
    });
    addEventListener('keydown', ev => {
      if (!selected) return;
      if (/INPUT|SELECT|TEXTAREA/.test(ev.target.tagName ?? '')) return;
      if (ev.key === 'Escape') { select(null); taskLog('push mode off'); return; }
      if (running || host?.state.busy) return;
      if (host?.state.held === selected) { taskLog(`${selected} is held by the arm`); return; }
      let dir = null, force = 8;
      const key = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
      if (key === 'z' || key === 'PageDown') { dir = [0, 0, -1]; force = 30; }
      else if (key === 'x' || key === 'PageUp') dir = [0, 0, 1];
      else if (ev.key.startsWith('Arrow')) {
        // camera-relative horizontal directions, in the table frame
        const fwd = new THREE.Vector3();
        camera.getWorldDirection(fwd);
        const inv = new THREE.Matrix4().extractRotation(world.matrixWorld).invert();
        fwd.applyMatrix4(inv); fwd.z = 0;
        if (fwd.lengthSq() < 1e-6) return;
        fwd.normalize();
        const right = new THREE.Vector3(fwd.y, -fwd.x, 0);
        const d = { ArrowUp: fwd, ArrowDown: fwd.clone().negate(),
                    ArrowRight: right, ArrowLeft: right.clone().negate() }[ev.key];
        if (!d) return;
        dir = [d.x, d.y, d.z];
      } else return;
      ev.preventDefault();
      const w2 = mjWorldRef;
      if (!w2) { taskLog('physics backend not active'); return; }
      const step = ev.shiftKey ? 0.0001 : 0.001;
      // push in the CURRENT world: live scene poses and arm
      w2.setArm(host.api.joints().map(v => v * Math.PI / 180));
      for (const it of cell.parts ?? []) {
        const n = partNodes.get(it.id);
        if (n) w2.setPartPose(it.id, liveMat(n));
      }
      const res = w2.pushPart(selected, dir, step, { force });
      if (!res) return;
      const m = res.pose;
      const m4 = new THREE.Matrix4().set(
        m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8], m[9], m[10], m[11], 0, 0, 0, 1);
      const node = partNodes.get(selected);
      node.position.setFromMatrixPosition(m4);
      node.quaternion.setFromRotationMatrix(m4);
      node.updateMatrix();
      outline?.update();
      const blocked = res.moved < step - 1e-6;
      taskLog(`${selected}: pushed ${(res.moved * 1000).toFixed(2)} mm${blocked ? ' — blocked' : ''}`);
    });
  }

  await buildTaskUI(cell, mountToolTracked);

  status(`${cell.name} — ready`);
}
main().catch(e => { status('load failed: ' + e.message); console.error(e); });

// ---------- hover tooltip ----------
const ray = new THREE.Raycaster();
const tipEl = document.getElementById('tip');
addEventListener('pointermove', ev => {
  ray.setFromCamera(new THREE.Vector2(ev.clientX / innerWidth * 2 - 1, -(ev.clientY / innerHeight) * 2 + 1), camera);
  const hits = ray.intersectObjects(world.children, true).filter(h => h.object.visible && !(h.object.material?.transparent && h.object.material.opacity < 0.2));
  let name = null;
  for (const h of hits) {
    let o = h.object;
    while (o && !o.userData.itemName) o = o.parent;
    if (o) { name = o.userData.itemName; break; }
  }
  if (name) {
    tipEl.textContent = name;
    tipEl.style.display = 'block';
    tipEl.style.left = (ev.clientX + 14) + 'px';
    tipEl.style.top = (ev.clientY + 10) + 'px';
  } else tipEl.style.display = 'none';
});

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

const clock = new THREE.Clock();
const taskLineEl = document.getElementById('taskline');
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1);
  host?.update(dt);
  if (host?.state.busy && host.state.current) {
    const el = ((performance.now() - host.state.currentSince) / 1000).toFixed(1);
    taskLineEl.textContent = `▶ ${host.state.current} · ${el} s`;
  }
  updateFly(dt);
  controls.update();
  renderer.render(scene, camera);
});

// ---------- live reload (serve.py) ----------
(async () => {
  let gen = -1;
  for (;;) {
    try {
      const r = await fetch(`/__reload?gen=${gen}`);
      if (!r.ok) return;
      const g = parseInt(await r.text(), 10);
      if (gen !== -1 && g > gen) location.reload();
      gen = g;
    } catch { await new Promise(res => setTimeout(res, 2000)); }
  }
})();
