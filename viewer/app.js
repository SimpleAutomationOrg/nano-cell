import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CHAIN } from './ik.js';
import * as IK from './ik.js';
import { createHost } from './cell-host.js';
import { CollisionWorld, capsuleFromObject } from './collision.js';
import { createMjWorld } from './mj-world.js';

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
  async function mountTool(id) {
    toolHolder.clear();
    sel.value = id;
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
  sel.addEventListener('change', e => mountTool(e.target.value));
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
    await mountTool(id);
    refreshToolCapsule();
    mjWorldRef?.rebuildTool(toolCapsules).catch(e => console.warn('[mj] tool rebuild failed', e));
  };
  sel.addEventListener('change', refreshToolCapsule);

  // collision world from the repo's *.collision.stl files
  const colWorld = new CollisionWorld();
  status('loading collision meshes…');
  const colItems = [...(cell.fixtures ?? []), ...(cell.parts ?? [])];
  await Promise.all(colItems.map(it => {
    const mat = IK.fromXyzRpy(it.pose_table.xyz_m, it.pose_table.rpy);
    return it.collision_mesh
      ? colWorld.addStl(it.id, '../cell/dvt01/' + it.collision_mesh, mat)
      : Promise.resolve(colWorld.addBox(it.id, [0.04, 0.04, 0.015], mat));
  }));

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

  // exact collision backend (optional): MuJoCo loads from node_modules
  // when installed; without it the sampled fallback runs — the viewer
  // itself stays zero-dependency
  let mjWorldRef = null;
  window.mjWorld = () => mjWorldRef;   // console/debug access
  const backendBadge = document.createElement('div');
  backendBadge.style.cssText = 'margin-top:6px;color:#7d8a99;font-size:11px';
  backendBadge.textContent = 'collision: sampled (fallback)';
  document.getElementById('toggles').appendChild(backendBadge);
  (async () => {
    try {
      const loadMujoco = (await import('/node_modules/@mujoco/mujoco/mujoco.js')).default;
      const mjmod = await loadMujoco();
      mjWorldRef = await createMjWorld({
        mj: mjmod, cellData: cell, armCapsules, toolCapsules,
        loadStlBuffer: p => fetch('../cell/dvt01/' + p).then(r => {
          if (!r.ok) throw new Error(`${p}: ${r.status}`);
          return r.arrayBuffer();
        }),
      });
      taskLog('exact collision backend active (MuJoCo)');
      backendBadge.textContent = 'collision: exact (MuJoCo) · gravity settle on release';
      backendBadge.style.color = '#7fd0a0';
      console.log('[mj] exact collision backend active');
    } catch (e) {
      console.warn('[mj] backend unavailable, using sampled collision:', e);
      taskLog('mj backend failed: ' + (e && e.message ? e.message : e));
    }
  })();

  // the task host
  host = createHost({
    cellData: cell,
    spins, flangeGroup, worldGroup: world, partNodes,
    mountMat: IK.fromXyzRpy(cell.arm.mount_table.xyz_m, cell.arm.mount_table.rpy),
    getToolId: () => sel.value,
    onLog: taskLog,
    onJoints: reflectJointsDeg,
    collisionWorld: colWorld,
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

  // debug view: the collision sample points of every item, at their
  // CURRENT poses (rebuilt on each toggle-on, so it reflects moved parts)
  let colPoints = null;
  const ptsToggle = document.createElement('label');
  ptsToggle.innerHTML = `<input type="checkbox"> collision points`;
  ptsToggle.querySelector('input').addEventListener('change', e => {
    if (colPoints) { world.remove(colPoints); colPoints = null; }
    if (!e.target.checked) return;
    colPoints = new THREE.Group();
    const mat = new THREE.PointsMaterial({ color: 0xffa500, size: 0.004 });
    for (const [id, it] of colWorld.items) {
      if (!it.active || !it.local?.length) continue;
      const arr = new Float32Array(it.local.length * 3);
      it.local.forEach((p, i) => {
        const m = it.mat;
        arr[i * 3] = m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3];
        arr[i * 3 + 1] = m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7];
        arr[i * 3 + 2] = m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11];
      });
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
      const pts = new THREE.Points(geo, mat);
      pts.userData.itemName = `collision samples: ${id}`;
      colPoints.add(pts);
    }
    world.add(colPoints);
  });
  document.getElementById('toggles').appendChild(ptsToggle);

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
      colWorld.place(it.id, IK.fromXyzRpy(it.pose_table.xyz_m, it.pose_table.rpy));
    }
    setJoints(POSE_DOCK);
    taskLog('scene reset');
    status('scene reset');
  };

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
