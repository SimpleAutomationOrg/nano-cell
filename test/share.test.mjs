// The shareable edition (an artifact page that asks for no access to a
// computer): what its build puts out, and that the page engine, over the
// pack AS BUILT, gives the viewer everything it asks of a server — up to
// running a step of the starter application to its end, with the physics
// the pack carries. No browser here: the viewer's requests are made
// through engineFetch as the page makes them, and the scene is built in
// node as scripts/headless-cell.mjs builds it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync, readdirSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import { engineFetch } from '../viewer/desktop-bridge.js';
import { createMemoryStore } from '../viewer/page-store.js';
import { ROUTES } from '../viewer/page-engine.js';
import { zipRead } from '../viewer/zip.js';
import { createShare, packLoader, memoryStorage, safeStorage, saveName, downloadWords, measureText, resetFiles, startPage, onePage, fileType, isAttachment } from '../viewer/share.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
// The build is made from the repository (git says what is tracked): in a
// workspace the installed app made there is nothing to build.
const CHECKOUT = existsSync(join(ROOT, '.git'));
let mj = true;
try { await import('@mujoco/mujoco'); } catch { mj = false; }
const BUILT = CHECKOUT && mj;          // the share build carries MuJoCo's physics from node_modules
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const HEAD = { 'X-Microfactory': 'chat', 'Content-Type': 'application/json' };
const PAGE = 'https://host.example/a/xyz/';

// (node says that stripping types from the step files is experimental, every time)
const warn = process.emitWarning;
process.emitWarning = (w, ...rest) => { if (!String(w?.message ?? w).includes('stripTypeScriptTypes')) warn.call(process, w, ...rest); };

// ---- the two builds, made once ----
let out = null, plain = null, pack = null, said = '';
before(() => {
  if (!BUILT) return;
  out = mkdtempSync(join(ROOT, 'dist-test-'));
  plain = mkdtempSync(join(ROOT, 'dist-test-'));
  // (--dirty: the tests are of the working tree, committed or not; a plain --share build insists on a clean one)
  said = execFileSync('node', ['scripts/build-artifact.mjs', '--share', '--dirty', '--out', out.slice(ROOT.length)], { cwd: ROOT, encoding: 'utf8' });
  execFileSync('node', ['scripts/build-artifact.mjs', '--dirty', '--out', plain.slice(ROOT.length)], { cwd: ROOT, encoding: 'utf8' });
  pack = JSON.parse(readFileSync(join(out, 'ws/files.json'), 'utf8'));
});
after(() => {
  for (const d of [out, plain]) if (d) { rmSync(d, { recursive: true, force: true }); rmSync(d + '-report.txt', { force: true }); }
});
const walk = d => readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));

// The page, as share.js puts it together, over the built pack: the carried
// files are read from the build's folder where the page would fetch them.
function share(more = {}) {
  const s = createShare({
    pack, store: createMemoryStore(),
    readText: async ref => readFileSync(join(out, ref), 'utf8'),
    engine: { hold: 300 }, chat: { hold: 300 },
    ...more,
  });
  let network = 0;
  const fetch2 = engineFetch(s.engine, async () => { network++; return new Response('from the network'); }, { pageUrl: PAGE });
  return { ...s, fetch2, network: () => network };
}

test('the share build is the page with another entry: no desktop manifest, no installed-app modules, its own capabilities', { skip: !BUILT }, () => {
  assert.match(said, /the page \+ \d+ files/);
  const page = readFileSync(join(out, 'index.html'), 'utf8');
  assert.ok(page.startsWith('<title>Microfactory</title>'), 'the title comes first');
  assert.ok(!/<!doctype|<html|<head|<body/i.test(page), 'the page must not carry its own document tags');
  assert.ok(!/claude-artifacts-manifest|full-access/.test(page), 'it asks for no access to the computer');
  assert.ok(page.indexOf('type="importmap"') < page.indexOf('type="module"'), 'the import map must come before the first module');
  assert.match(page, /<script type="module" src="\.\/viewer\/share\.js"><\/script>\s*$/, 'the shareable entry, and only it');
  assert.ok(!/src="\.\/app\.js"|src="\.\/chat\.js"/.test(page), 'app.js and chat.js are loaded by share.js, after the engine is up');
  assert.match(page, /window\.MICROFACTORY_BUILD = \{[^}]*"edition":"share"\}/);
  assert.match(page, /accept="\.microfactory,\.zip"/, 'an export saved as .zip must be offered by the file picker');

  const publish = JSON.parse(readFileSync(join(out, 'publish.json'), 'utf8'));
  assert.deepEqual(publish.capabilities, { sample: { images: true }, downloads: true });
  assert.equal(publish.title, 'Microfactory');
  assert.ok(!/desktop app/.test(publish.description), 'the description must not promise an installed app');
  assert.equal(publish.file_path, `${out.slice(ROOT.length)}/index.html`);
  const names = Object.keys(publish.files);
  for (const need of ['viewer/share.js', 'viewer/app.js', 'viewer/chat.js', 'viewer/page-engine.js', 'viewer/page-fs.js', 'viewer/page-store.js', 'viewer/page-agent.js', 'viewer/page-tools.js', 'viewer/page-brief.js', 'viewer/zip.js', 'viewer/desktop-bridge.js', 'ws/files.json', 'ws/mujoco.wasm.txt'])
    assert.ok(names.includes(need), `${need} is missing`);
  for (const not of ['viewer/desktop.js', 'viewer/workspace-install.js']) assert.ok(!names.includes(not), `${not} is the installed app's`);
  for (const [name, from] of Object.entries(publish.files)) {
    assert.match(name, /^(viewer\/[\w.-]+\.js|ws\/files\.json|ws\/b\/\d+\.txt|ws\/mujoco\.wasm\.txt)$/, `${name} is not something the page carries`);
    assert.ok(existsSync(join(ROOT, from)), `${name} was not built`);
  }
  // nothing shipped asks for the desktop, in code (comments may name the other edition)
  for (const f of names.filter(n => n.startsWith('viewer/'))) {
    const code = readFileSync(join(out, f), 'utf8').split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    assert.ok(!/use\(\s*['"]desktop['"]\s*\)|full-access/.test(code), `${f} asks for access to the computer`);
  }
});

test('the share pack carries only what the page reads — tracked files of the robot, the starter, the guides — meshes gzip\'d, and MuJoCo\'s physics', { skip: !BUILT }, () => {
  const tracked = new Set(execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n'));
  const starter = JSON.parse(readFileSync(join(ROOT, 'artifact.json'), 'utf8')).starter;
  for (const f of pack.files) {
    assert.ok(tracked.has(f.path), `${f.path} is not tracked`);
    assert.match(f.path, /^(cell_fr3\/|applications\/|guides\/|recipes\/|viewer\/cell\.d\.ts$)/, `${f.path} is not something the page reads`);
    assert.ok(!/(^|\/)(materials|chats|print|\.backups|\.claude|node_modules|scripts|test)\//.test(f.path) && !/\.(step|stp|wasm|py)$/i.test(f.path), `${f.path} must not be given away`);
    if (f.path.startsWith('applications/')) assert.ok(starter.includes(f.path.split('/')[1]), `${f.path}: not a starter application`);
    assert.ok(('text' in f) !== ('bin' in f), f.path);
    if (f.bin) assert.equal(f.enc, 'gzip', `${f.path}: a mesh travels gzip'd`);
    if (f.text) assert.ok(!f.text.includes(homedir()), `${f.path} names this computer's home folder`);
  }
  for (const need of ['cell_fr3/robot.json', 'cell_fr3/arm/meshes/base_link.glb', 'guides/agent.md', 'guides/steps.md', 'viewer/cell.d.ts', ...starter.map(id => `applications/${id}/application.json`)])
    assert.ok(pack.files.some(f => f.path === need), `${need} is missing from the pack`);
  assert.ok(pack.files.some(f => f.path.startsWith('recipes/')), 'the recipes are missing');
  // the physics: one exact version (the module comes from the CDN at it), and bytes that are the installed ones
  assert.match(pack.mujoco.version, /^\d+\.\d+\.\d+$/);
  assert.equal(pack.mujoco.version, JSON.parse(readFileSync(join(ROOT, 'node_modules/@mujoco/mujoco/package.json'), 'utf8')).version);
  assert.deepEqual({ wasm: pack.mujoco.wasm, enc: pack.mujoco.enc }, { wasm: 'ws/mujoco.wasm.txt', enc: 'gzip' });
  assert.equal(pack.mujoco.sha, sha(readFileSync(join(ROOT, 'node_modules/@mujoco/mujoco/mujoco.wasm'))));
  // the Artifact tool's limits: 16 MB a text file, 255 files and 64 MB a publish
  const all = walk(out);
  for (const f of all) assert.ok(statSync(f).size <= 16e6, `${f.slice(out.length + 1)} is over the limit for one file`);
  assert.ok(all.reduce((s, f) => s + statSync(f).size, 0) < 64e6 && all.length <= 255, 'over the publish limits');
  for (const f of all.filter(f => /\.(js|html|json)$/.test(f))) assert.ok(!readFileSync(f, 'utf8').includes(homedir()), `${f} names this computer's home folder`);
});

test('the default build is still the installed app: the desktop manifest and entry, the full workspace pack, no physics carried', { skip: !BUILT }, () => {
  const page = readFileSync(join(plain, 'index.html'), 'utf8');
  assert.match(page, /<script type="application\/json" id="claude-artifacts-manifest">\{"permissions": \["full-access"\]\}<\/script>/);
  assert.match(page, /<script type="module" src="\.\/viewer\/desktop\.js"><\/script>\s*$/);
  assert.ok(!/"edition"/.test(page), 'only the shareable page says which edition it is');
  const publish = JSON.parse(readFileSync(join(plain, 'publish.json'), 'utf8'));
  assert.deepEqual(publish.capabilities, { desktop: {} });
  assert.match(publish.description, /installs as a desktop app/);
  const names = Object.keys(publish.files);
  // every viewer module rides in both builds, so the new ones are here too — not loaded, since desktop.js never imports them
  for (const need of ['viewer/desktop.js', 'viewer/workspace-install.js', 'viewer/share.js', 'viewer/page-engine.js']) assert.ok(names.includes(need), `${need} is missing`);
  assert.ok(!names.some(n => /mujoco/.test(n)), 'the installed app gets MuJoCo from npm, in its workspace');
  const full = JSON.parse(readFileSync(join(plain, 'ws/files.json'), 'utf8'));
  assert.ok(!('mujoco' in full) && full.files.every(f => !('enc' in f)), 'the installer reads this pack as it is: no new fields');
  for (const need of ['viewer/serve.py', 'scripts/check.sh', 'package.json']) assert.ok(full.files.some(f => f.path === need), `${need} is missing from the pack`);
  // the two builds give away the same robot and application, byte for byte
  const bySha = new Map(full.files.map(f => [f.path, f.sha]));
  for (const f of pack.files) assert.equal(bySha.get(f.path), f.sha, f.path);
});

test('every request the viewer makes of its server is one the page engine answers', () => {
  const dir = join(ROOT, 'viewer');
  for (const f of readdirSync(dir).filter(f => f.endsWith('.js'))) {
    const code = readFileSync(join(dir, f), 'utf8').split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    for (const m of code.matchAll(/['"`](\/__[a-z]+(?:\/[a-z]+)*)/g))
      assert.ok(ROUTES.includes(m[1]) || ROUTES.some(r => r.startsWith(m[1] + '/')), `viewer/${f} requests ${m[1]}`);
  }
});

test('the page engine over the built pack answers as the server does: files, the API, meshes byte for byte, many at once, aborts', { skip: !BUILT }, async () => {
  const { fetch2, network } = share();
  const apps = await (await fetch2('/__applications')).json();
  assert.deepEqual(apps.map(a => a.id), JSON.parse(readFileSync(join(ROOT, 'artifact.json'), 'utf8')).starter, 'the starter application, and only it');
  const robot = await (await fetch2('../cell_fr3/robot.json')).json();
  assert.ok(robot.arm && robot.table, 'a file of the pack, as the viewer asks for it');

  // every mesh the pack names arrives byte for byte — inflated on the way — also as three's loader asks (a Request, an absolute address)
  for (const f of pack.files.filter(f => f.bin)) {
    const r = await fetch2(new Request(new URL('../' + f.path, PAGE + 'index.html').href));
    assert.equal(r.status, 200, f.path);
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), readFileSync(join(ROOT, f.path)), `${f.path} changed on the way`);
  }
  // and every text file
  for (const f of pack.files.filter(f => 'text' in f))
    assert.deepEqual(Buffer.from(await (await fetch2('/' + f.path + '?v=1')).arrayBuffer()), readFileSync(join(ROOT, f.path)), f.path);

  // the steps, as the server lists them, and a step's source
  const steps = await (await fetch2(`/__steps?app=${apps[0].id}`)).json();
  const manifest = JSON.parse(readFileSync(join(ROOT, `applications/${apps[0].id}/application.json`), 'utf8'));
  for (const id of manifest.loop.steps) assert.ok(steps.some(s => s.id === id && s.tool), `the loop's step ${id} is not listed`);
  assert.match(await (await fetch2(`/applications/${apps[0].id}/steps/${steps[0].id}.ts?v=${Date.now()}`)).text(), /export default async function/);

  // the chat's endpoints need its header, as in a browser
  assert.equal((await fetch2('/__chat/agent')).status, 403);
  const agent = await (await fetch2('/__chat/agent', { headers: HEAD })).json();
  assert.ok(agent.name && agent.hint && agent.models_ready === true);
  const bad = await fetch2('/__loop/save', { method: 'POST', headers: HEAD, body: JSON.stringify({ app: 'no-such-app', steps: [] }) });
  assert.equal(bad.status, 400);
  assert.equal((await fetch2('/no/such/file.json')).status, 404);
  assert.equal((await fetch2(`../applications/${apps[0].id}/robots/no-such-robot.json`)).status, 404, 'a robot the application was never taught on');

  const many = await Promise.all(Array.from({ length: 24 }, (_, i) =>
    fetch2(i % 2 ? '/__applications' : '../cell_fr3/robot.json').then(r => r.json())));
  many.forEach((m, i) => assert.equal(Array.isArray(m), i % 2 === 1, `answer ${i} went to the wrong request`));

  // a long poll is held, not answered at once with nothing; it can be dropped
  const gen = parseInt(await (await fetch2('/__reload?gen=-1')).text(), 10);
  const t0 = performance.now();
  assert.equal(parseInt(await (await fetch2(`/__reload?gen=${gen}`)).text(), 10), gen);
  assert.ok(performance.now() - t0 >= 250, 'a poll with nothing new must be held');
  const ctl = new AbortController();
  const waiting = fetch2('/__reload?gen=99999999999', { signal: ctl.signal });
  ctl.abort();
  await assert.rejects(waiting, { name: 'AbortError' });

  // the page's own files and the CDN are not the engine's
  await fetch2(PAGE + 'viewer/app.js');
  await fetch2('https://cdn.jsdelivr.net/npm/sucrase@3.35.0/+esm');
  assert.equal(network(), 2);
});

test('what the viewer changes is kept over the pack and found again by the next page; an export goes back in; reset puts the original back', { skip: !BUILT }, async () => {
  const store = createMemoryStore();
  const a = share({ store });
  const id = (await (await a.fetch2('/__applications')).json())[0].id;
  const manifestPath = `applications/${id}/application.json`;
  const original = readFileSync(join(ROOT, manifestPath));
  const loop = JSON.parse(original).loop.steps;
  assert.ok(loop.length > 1, 'the starter needs a loop of several steps for this');
  const turned = [...loop.slice(1), loop[0]];
  const gen0 = a.engine.generation();
  assert.deepEqual(await (await a.fetch2('/__loop/save', { method: 'POST', headers: HEAD, body: JSON.stringify({ app: id, steps: turned }) })).json(), { ok: true });
  assert.equal(a.engine.generation(), gen0, 'the page\'s own save must not reload it');
  assert.equal(a.fs.origin(manifestPath), 'changed');

  // "after a reload": another page over the same store
  const b = share({ store });
  await b.fs.ready;
  assert.deepEqual((await (await b.fetch2('../' + manifestPath)).json()).loop.steps, turned);

  // Export: one zip, named as the server names it; saved as .zip it is imported under the same id
  const r = await b.fetch2(`/__applications/export?app=${id}`, { headers: { 'X-Microfactory': 'chat' } });
  assert.equal(r.status, 200);
  const fileName = r.headers.get('X-Microfactory-File');
  assert.match(fileName, new RegExp(`^${id}-\\d{8}-\\d{6}\\.microfactory$`));
  const zip = new Uint8Array(await r.arrayBuffer());
  const entries = await zipRead(zip);
  const packed = pack.files.filter(f => f.path.startsWith(`applications/${id}/`)).map(f => f.path.slice(`applications/${id}/`.length)).sort();
  assert.deepEqual(entries.map(e => e.name).sort(), packed, 'the export holds the application\'s files');
  const send = (name, existing) => b.fetch2(`/__applications/import?name=${encodeURIComponent(name)}&existing=${existing}`,
    { method: 'POST', headers: { 'X-Microfactory': 'chat', 'Content-Type': 'application/octet-stream' }, body: zip }).then(x => x.json());
  const same = await send(saveName(fileName), 'ask');
  assert.deepEqual({ exists: same.exists, identical: same.identical, id: same.id }, { exists: true, identical: true, id }, JSON.stringify(same));
  const copy = await send(saveName(fileName), 'copy');
  assert.ok(copy.id && copy.id !== id && !copy.error, JSON.stringify(copy));
  assert.deepEqual((await (await b.fetch2('/__applications')).json()).map(x => x.id).sort(), [id, copy.id].sort());

  // Reset to original: the application's files as the pack has them; a conversation is not touched
  await b.fs.write(`applications/${id}/chats/assistant.json`, '{"events": []}\n');
  await b.fs.write(`applications/${id}/steps/mine.ts`, '// mine\n');
  await b.fs.remove(`applications/${id}/layout.json`);
  const back = await resetFiles(b.fs, store, id);
  assert.deepEqual(back, [manifestPath, `applications/${id}/layout.json`, `applications/${id}/steps/mine.ts`].sort());
  assert.deepEqual(Buffer.from(await b.fs.read(manifestPath)), original);
  assert.ok(b.fs.exists(`applications/${id}/layout.json`) && !b.fs.exists(`applications/${id}/steps/mine.ts`));
  assert.ok(b.fs.exists(`applications/${id}/chats/assistant.json`), 'the conversation stays');
  assert.ok(b.fs.exists(`applications/${copy.id}/application.json`), 'another application is not touched');
});

// ---- the cell, built from what the page engine answers ----
// As scripts/headless-cell.mjs builds it from the disk (which mirrors main()
// in viewer/app.js), but every file — the manifest, the meshes, the
// collision shapes, the step — and MuJoCo's physics itself come through
// the page's fetch.
async function openCellThrough(fetch2, app) {
  const THREE = await import('three');
  const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
  const IK = await import('../viewer/ik.js');
  const { loadCell } = await import('../viewer/cell-data.js');
  const { createHost } = await import('../viewer/cell-host.js');
  const { createMjWorld } = await import('../viewer/mj-world.js');
  const { capsuleFromObject } = await import('../viewer/capsules.js');
  const { partReport } = await import('../viewer/agent-run.js');

  // exactly app.js: readJson throws on a missing file, meshes are asked relative to the page
  const cell = await loadCell(async p => {
    const r = await fetch2('../' + p);
    if (!r.ok) throw new Error(`${p}: not found`);
    return r.json();
  }, app, null);
  const buffer = async p => {
    const r = await fetch2('../' + p);
    if (!r.ok) throw new Error(`${p}: ${r.status}`);
    return r.arrayBuffer();
  };
  const loader = new GLTFLoader(), glbs = new Map();
  const loadGlb = path => {
    if (!glbs.has(path)) glbs.set(path, buffer(path).then(buf => new Promise((res, rej) => loader.parse(buf, '', g => res(g.scene), rej))));
    return glbs.get(path).then(scene => scene.clone());
  };
  // the installed app's and the page's branch of app.js: the version asked of the "workspace", the physics handed over as bytes
  const MJ = '/node_modules/@mujoco/mujoco/';
  const pkg = await (await fetch2(MJ + 'package.json')).json();
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  const wasmBinary = await (await fetch2(MJ + 'mujoco.wasm')).arrayBuffer();
  const mjmod = await (await import('@mujoco/mujoco')).default({ wasmBinary });

  const applyPose = (obj, pose) => {
    obj.position.fromArray(pose.xyz_m);
    obj.quaternion.setFromEuler(new THREE.Euler(pose.rpy[0], pose.rpy[1], pose.rpy[2], 'ZYX'));
  };
  const world = new THREE.Group();
  world.rotation.x = -Math.PI / 2;
  const partNodes = new Map(), spins = [], armCapsules = [];
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
  flangeGroup.position.fromArray([0, 0, 0.1]);
  parent.add(flangeGroup);
  async function loadItems(list, group) {
    for (const it of list ?? []) {
      const holder = new THREE.Group();
      applyPose(holder, it.pose_table ?? it.pose_flange ?? { xyz_m: [0, 0, 0], rpy: [0, 0, 0] });
      if (it.mesh) holder.add(await loadGlb(it.mesh));
      else { const ph = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 0.01)); ph.position.z = 0.005; holder.add(ph); }
      if (it.id) partNodes.set(it.id, holder);
      group.add(holder);
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
      const tcp = t.vacuum?.lip_centre_flange_m ?? t.tip_flange_m;
      if (tcp) { const tip = new THREE.Mesh(new THREE.SphereGeometry(0.002, 12, 12)); tip.position.fromArray(tcp); toolHolder.add(tip); }
    }
    toolCapsules = [...stack.children, ...toolHolder.children].map(c => capsuleFromObject(c, { minR: 0.015 })).filter(Boolean);
  }
  await mountTool(cell.mounted_tool);
  const mjWorld = await createMjWorld({ getToolId: () => mountedId, mj: mjmod, cellData: cell, armCapsules, toolCapsules, loadStlBuffer: buffer });
  const log = [];
  const e = cell.guard.envelope_mm, ext = (cell.guard.wall_extensions_mm?.right_wall ?? 0) / 1000;
  const host = createHost({
    cellData: cell, spins, flangeGroup, worldGroup: world, partNodes,
    mountMat: IK.fromXyzRpy(cell.arm.mount_table.xyz_m, cell.arm.mount_table.rpy),
    getToolId: () => mountedId,
    onLog: m => log.push(String(m).trim()),
    guardBox: { x0: e.x_min_mm / 1000, x1: e.x_max_mm / 1000 + ext, y0: e.y_min_mm / 1000, y1: e.y_max_mm / 1000, z1: e.z_max_mm / 1000 },
    armCapsules, getToolCapsules: () => toolCapsules, getMjWorld: () => mjWorld,
  });
  host.setSpeed(1e6);
  host.snapJointsDeg(cell.arm.start_deg ?? [-95.8, -109.03, -35.38, -125.69, 89.91, 61.48]);
  const partNow = id => {
    world.updateMatrixWorld(true);
    const p = world.worldToLocal(partNodes.get(id).getWorldPosition(new THREE.Vector3()));
    return [p.x, p.y, p.z];
  };
  return {
    cell, host, mjWorld, tool: () => mountedId,
    /** Run steps as the viewer does: listed by the engine, their source fetched, types stripped, imported. */
    async run(ids) {
      const steps = await (await fetch2(`/__steps?app=${encodeURIComponent(app)}`)).json();
      const missing = ids.filter(id => !steps.some(s => s.id === id));
      if (missing.length) return { ok: false, error: `no such step: ${missing.join(', ')} — this application has: ${steps.map(s => s.id).join(', ') || 'none'}` };
      log.length = 0;
      host.reset();
      const t0 = performance.now();
      let res = { ok: true }, now = null;
      try {
        for (const [i, id] of ids.entries()) {
          now = id;
          log.push(`▶ ${id}`);
          const meta = steps.find(s => s.id === id);
          if (meta.tool && meta.tool !== mountedId) { await mountTool(meta.tool); await mjWorld.rebuildTool(toolCapsules); }
          const src = await (await fetch2(`/applications/${app}/steps/${id}.ts?v=${Date.now()}`)).text();
          const js = stripTypeScriptTypes(src, { mode: 'transform' });
          const mod = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64') + `#${id}-${Date.now()}`);
          if (i === 0 && mod.entry?.joints_deg) host.snapJointsDeg(mod.entry.joints_deg);
          let done = false, err = null;
          mod.default(host.api, host.ctx).then(() => { done = true; }, x => { err = x; done = true; });
          while (!done) { host.update(0.05); await new Promise(r => setImmediate(r)); }
          if (err) throw err;
          log.push(`✓ ${id}`);
        }
      } catch (x) {
        log.push('✗ ' + x.message);
        res = { ok: false, step: now, error: x.message };
      }
      const moved = (cell.parts ?? []).map(it => partReport(it.id, it.pose_table.xyz_m, partNow(it.id))).filter(p => p.moved_mm >= 0.5);
      return { ...res, ran: ids, seconds: Math.round((performance.now() - t0) / 100) / 10, log: log.slice(-200), parts_moved: moved,
        held: host.state.held ?? null, io: { ...(host.state.io ?? {}) }, tool: mountedId,
        joints_deg: spins.map(sp => Math.round(THREE.MathUtils.radToDeg(sp.rotation.z) * 100) / 100), stale: false };
    },
  };
}

test('the starter\'s first step runs to its end on nothing but the page engine — and ends where it ends from the repository; the assistant runs it and measures the scene', { skip: !BUILT }, async () => {
  const { openCell } = await import('../scripts/headless-cell.mjs');
  // the assistant, stood in for: one answer that uses the page's tools as Claude would
  let told = null, offered = null;
  const sample = async (input, options) => {
    offered = options.tools.map(t => t.name);
    const use = (name, args) => options.tools.find(t => t.name === name).execute(args, { signal: new AbortController().signal });
    told = { run: await use('run_steps', { steps: [first] }), measured: await use('measure', { ids: [target] }), all: await use('measure', {}) };
    return { text: 'It ran.\n[[DONE]]', truncated: false, modelTierApplied: 'default' };
  };
  sample.limits = async () => ({ maxPromptBytes: 262144, tools: { maxCount: 16 } });
  let scene = null;
  const { fetch2, engine } = share({
    getSample: () => sample,
    measure: async ids => measureText(scene.host, ids, { tool: scene.tool(), probe: id => scene.mjWorld.probePoints(id) }),
  });
  const id = (await (await fetch2('/__applications')).json())[0].id;
  scene = await openCellThrough(fetch2, id);
  const first = scene.cell.loop.steps[0];

  // ---- the step, to "step done" ----
  const res = await scene.run([first]);
  assert.ok(res.ok, `${first} FAILED through the page engine: ${res.error}\n  ${res.log.slice(-8).join('\n  ')}`);
  assert.equal(res.log.at(-1), `✓ ${first}`);
  assert.ok(res.parts_moved.length >= 1, 'the step moved nothing');
  // the same step on the repository's files with node's own MuJoCo: the same parts end in the same places
  const disk = await (await openCell(id)).run([first]);
  assert.ok(disk.ok, disk.error);
  assert.deepEqual(res.parts_moved.map(p => p.id), disk.parts_moved.map(p => p.id));
  res.parts_moved.forEach((p, i) => p.to_m.forEach((v, k) => assert.ok(Math.abs(v - disk.parts_moved[i].to_m[k]) < 0.0005, `${p.id} ${'xyz'[k]}: ${v} here, ${disk.parts_moved[i].to_m[k]} from the repository`)));
  assert.deepEqual(res.joints_deg.map(Math.round), disk.joints_deg.map(Math.round));

  // ---- the assistant asks the page to run it: chat -> run tool -> the engine's queue -> "the page" -> the result back ----
  const target = res.parts_moved[0].id;
  let serving = true;
  const page = (async () => {                    // what viewer/agent-run.js does in the page
    while (serving) {
      const { job } = await (await fetch2(`/__run/next?app=${id}&page=test`, { headers: HEAD })).json();
      if (!job) continue;
      await fetch2('/__run/alive', { method: 'POST', headers: HEAD, body: JSON.stringify({ id: job.id, page: 'test' }) });
      const result = await scene.run(job.steps);
      await fetch2('/__run/result', { method: 'POST', headers: HEAD, body: JSON.stringify({ id: job.id, result }) });
    }
  })();
  try {
    const sent = await fetch2('/__chat/send', { method: 'POST', headers: HEAD, body: JSON.stringify({ app: id, text: 'run the first step', context: `application: ${id}`, files: [], model: '' }) });
    assert.deepEqual(await sent.json(), { ok: true });
    let events = [], next = 0, epoch = -1, running = true;
    for (let n = 0; n < 400 && (running || !events.some(e => e.type === 'done')); n++) {
      const r = await (await fetch2(`/__chat/events?app=${id}&epoch=${epoch}&since=${next}`, { headers: HEAD })).json();
      assert.equal(r.available, true);
      if (r.epoch !== epoch) { epoch = r.epoch; events = []; }
      events.push(...r.events); next = r.next; running = r.running;
    }
    assert.deepEqual(events.map(e => e.type), ['user', 'tool', 'tool', 'tool', 'text', 'done'], JSON.stringify(events));
    assert.deepEqual(events.filter(e => e.type === 'tool').map(e => e.text), [`runs ${first}`, `measures ${target}`, 'measures the scene']);
    assert.equal(events.find(e => e.type === 'text').text, 'It ran.', 'the [[DONE]] line is not shown');
    assert.deepEqual(offered, ['read_file', 'list_files', 'write_file', 'edit_file', 'run_steps', 'measure', 'undo']);
    assert.match(told.run, new RegExp(`${first}`));
    assert.ok(!/NOT RUN|FAILED/.test(told.run), told.run);
    // the conversation is kept with the application, where the installed app keeps it
    const kept = JSON.parse(await (await fetch2(`../applications/${id}/chats/assistant.json`)).text());
    assert.deepEqual(kept.events.map(e => e.type), events.map(e => e.type));
  } finally {
    serving = false;
    await engine.request('POST', '/__chat/stop', { 'x-microfactory': 'chat' }, new TextEncoder().encode(JSON.stringify({ app: id })));
    await page;
  }

  // ---- what the measure tool says: measured values, mm and degrees, table frame ----
  const it = scene.host.ctx.part(target);
  const mm = v => (Math.round(v * 10000) / 10).toFixed(1);
  assert.ok(told.measured.includes(`part ${target}`), told.measured);
  assert.ok(told.measured.includes(`top centre (${mm(it.topCenter[0])}, ${mm(it.topCenter[1])}, ${mm(it.topCenter[2])}) mm`), told.measured);
  assert.match(told.measured, /long top edge at -?\d+\.\d°/);
  assert.match(told.measured, /fills x -?\d+\.\d\.\.-?\d+\.\d, y .* mm along the table's axes/);
  assert.match(told.measured, /arm: joints \[(-?\d+\.\d\d(, )?){6}\] deg; tool on the flange: \w+; holding: nothing/);
  for (const f of scene.cell.fixtures) assert.ok(told.all.includes(`fixture ${f.id}: top centre (`), `${f.id} is missing from the whole-scene listing`);
  assert.match(measureText(scene.host, ['no-such-thing'], {}), /no-such-thing: no fixture or part has this id — this application has: /);
  assert.match(measureText(scene.host, [], {}), /the physics is not loaded/, 'without collision samples it must not pass origins off as measured');
});

test('MuJoCo\'s physics comes out of the pack as the bytes that were installed', { skip: !BUILT }, async () => {
  const { fetch2 } = share();
  assert.deepEqual(await (await fetch2('/node_modules/@mujoco/mujoco/package.json')).json(), { name: '@mujoco/mujoco', version: pack.mujoco.version });
  const r = await fetch2('/node_modules/@mujoco/mujoco/mujoco.wasm');
  assert.equal(r.status, 200);
  const bytes = new Uint8Array(await r.arrayBuffer());
  assert.equal(bytes.length, pack.mujoco.size);
  assert.equal(sha(bytes), pack.mujoco.sha);
  assert.ok(WebAssembly.validate(bytes), 'not a WebAssembly module');
});

test('a carried file that arrives short is refused, and asked for again the next time', async () => {
  const whole = Buffer.from('twelve bytes').toString('base64');
  let reads = 0, text = whole.slice(0, 8);
  const loader = packLoader(async () => { reads++; return text; });
  const entry = { path: 'a/b.glb', bin: 'ws/b/0.txt', size: 12 };
  await assert.rejects(loader.bin(entry), /a\/b\.glb did not arrive whole/);
  text = whole + '\n';
  assert.equal(Buffer.from(await loader.bin(entry)).toString(), 'twelve bytes');
  await loader.bin(entry);
  assert.equal(reads, 2, 'a mesh is fetched once and kept');
});

test('where there is no assistant the chat says so before anything is typed, and a message is answered with the reason', { skip: !BUILT }, async () => {
  // outside Claude: no sample at all
  const none = share();
  const id = (await (await none.fetch2('/__applications')).json())[0].id;
  const agent = await (await none.fetch2('/__chat/agent', { headers: HEAD })).json();
  assert.match(agent.hint, /The assistant is not available in this view/);
  assert.match(agent.hint, /New and Import\./);
  // on a public link saving a file is not offered either: the hint must not promise Export
  assert.doesNotMatch(agent.hint, /Export/);
  assert.match(agent.hint, /install https:\/\/github\.com\//);
  assert.deepEqual(await (await none.fetch2('/__chat/send', { method: 'POST', headers: HEAD, body: JSON.stringify({ app: id, text: 'hello', context: '', files: [], model: '' }) })).json(), { ok: true });
  await none.chat.whenIdle();
  const { events, running } = await (await none.fetch2(`/__chat/events?app=${id}&epoch=-1&since=0`, { headers: HEAD })).json();
  assert.deepEqual(events.map(e => e.type), ['user', 'error', 'done']);
  assert.match(events[1].text, /the assistant is not available in this view/);
  assert.equal(running, false);
  // inside Claude the hint is the guide's own
  const sample = async () => ({ text: 'hi', truncated: false });
  const some = share({ getSample: async () => sample });
  const guide = /^hint:\s*(.+)$/m.exec(readFileSync(join(ROOT, 'guides/agent.md'), 'utf8'))?.[1].trim();
  assert.equal((await (await some.fetch2('/__chat/agent', { headers: HEAD })).json()).hint, guide);
});

test('an export is saved under a name the artifact may save, and a save that did not happen is said in plain words', () => {
  assert.equal(saveName('case-assembly-20261127-101500.microfactory'), 'case-assembly-20261127-101500.microfactory.zip');
  assert.equal(saveName('x.microfactory.zip'), 'x.microfactory.zip');
  assert.equal(saveName('picture.PNG'), 'picture.PNG');
  assert.match(downloadWords({ code: 'declined' }), /declined/);
  assert.match(downloadWords({ code: 'rate_limited' }), /another save is still waiting/);
  assert.match(downloadWords({ code: 'too_large' }), /too large/);
  assert.match(downloadWords({ code: 'host_unavailable' }), /open Microfactory in a browser or on a computer/);
  for (const code of ['unavailable', 'not_granted', 'capability_disabled', 'something-new', undefined]) assert.equal(downloadWords(code && { code }), 'saving files is not available in this view');
});

test('storage that throws when touched is replaced by one in memory with the same methods', () => {
  const win = {};
  Object.defineProperty(win, 'localStorage', { get() { throw new Error('The operation is insecure.'); }, configurable: true });
  win.sessionStorage = memoryStorage();
  assert.equal(safeStorage(win, 'localStorage'), false);
  assert.equal(safeStorage(win, 'sessionStorage'), true);
  win.localStorage.setItem('app.last', 'case-assembly');
  win.localStorage.setItem('n', 1);
  assert.equal(win.localStorage.getItem('app.last'), 'case-assembly');
  assert.equal(win.localStorage.getItem('n'), '1');
  assert.equal(win.localStorage.getItem('nothing'), null);
  assert.equal(win.localStorage.length, 2);
  win.localStorage.removeItem('n');
  assert.equal(win.localStorage.key(0), 'app.last');
  win.localStorage.clear();
  assert.equal(win.localStorage.length, 0);
  // one that can be read but not written (no room at all) is replaced too
  const full = { localStorage: { getItem: () => null, setItem() { throw new Error('QuotaExceededError'); }, removeItem() {} } };
  assert.equal(safeStorage(full, 'localStorage'), false);
  full.localStorage.setItem('a', 'b');
  assert.equal(full.localStorage.getItem('a'), 'b');
});

// ---- the page's own start, with no window.claude, no storage and no IndexedDB ----
// As it is opened from a plain web server. The DOM is the least that
// share.js touches; the viewer itself (app.js needs WebGL) is stood in for.
test('the page starts outside Claude without throwing: the engine behind fetch, saving by the browser\'s own download, a note that nothing is kept', { skip: !BUILT }, async () => {
  const made = [];
  const element = tag => {
    const kids = new Map();
    const el = { tag, children: [], hidden: false, textContent: '', title: '', style: {}, clicked: 0,
      appendChild(c) { el.children.push(c); return c; }, append(...c) { el.children.push(...c); }, remove() { el.removed = true; },
      querySelector(sel) { if (!kids.has(sel)) kids.set(sel, element(sel)); return kids.get(sel); },
      click() { el.clicked++; } };
    made.push(el);
    return el;
  };
  const body = element('body'), known = new Map([['#panel .sub', Object.assign(element('div'), { textContent: 'Fairino FR3 · drag to orbit · WASD to fly · live reload' })]]);
  for (const sel of ['#appSel', '#appExport', '#appImport']) known.set(sel, element(sel));
  const fetched = [];
  const win = {
    fetch: async url => {
      const u = new URL(url);
      fetched.push(u.pathname);
      const file = join(out, u.pathname.replace(/^\/a\/xyz\//, ''));
      return existsSync(file) ? new Response(readFileSync(file)) : new Response('no', { status: 404 });
    },
  };
  win.top = win;
  for (const name of ['localStorage', 'sessionStorage']) Object.defineProperty(win, name, { get() { throw new Error('SecurityError'); }, configurable: true });
  const globals = { window: win, document: { baseURI: PAGE + 'index.html', body, createElement: element, querySelector: sel => known.get(sel) ?? null, getElementById: () => null } };
  const before0 = Object.fromEntries(Object.keys(globals).map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  Object.assign(globalThis, globals);
  let viewerLoaded = 0;
  try {
    await startPage({ viewer: async () => { viewerLoaded++; } });
    const screen = body.children.find(c => c.id === 'setup');
    assert.equal(viewerLoaded, 1, `the page did not get as far as the viewer: ${screen.querySelector('pre').textContent}`);
    assert.equal(screen.hidden, true, 'the loading card must be gone');
    assert.deepEqual(fetched, ['/a/xyz/ws/files.json'], 'only the list is read at the start; meshes come when asked for');

    // storage that throws was made safe before the viewer loads
    win.localStorage.setItem('app.last', 'x');
    assert.equal(win.localStorage.getItem('app.last'), 'x');
    win.sessionStorage.setItem('chat.draft.x', 'hello');

    // the viewer's requests are the engine's now; a mesh is fetched from the carried files on the way
    const apps = await (await win.fetch('/__applications')).json();
    assert.equal(apps.length, 1);
    const glb = pack.files.find(f => f.bin);
    assert.equal(sha(new Uint8Array(await (await win.fetch('../' + glb.path)).arrayBuffer())), glb.sha);
    assert.ok(fetched.includes('/a/xyz/' + glb.bin));

    // what app.js and chat.js read of their host
    const host = win.microfactoryDesktop;
    assert.equal(host.kind, 'page');
    assert.deepEqual([host.workspace, host.keptFiles], ['', []]);
    assert.equal(host.original(apps[0].id), true);
    assert.equal(host.original('something-of-mine'), false);
    // no window.claude: the browser's own download, under the file's own name
    // (the link's address is let go of ten seconds later: that timer is taken aside, not waited for)
    const timeout = globalThis.setTimeout, later = [];
    globalThis.setTimeout = (f, ms) => { later.push(ms); return 0; };
    let where;
    try { where = await host.saveFile('x-20261127-101500.microfactory', new Blob(['zip'])); } finally { globalThis.setTimeout = timeout; }
    assert.deepEqual(later, [10000]);
    const link = made.find(el => el.tag === 'a');
    assert.deepEqual([link.download, link.clicked], ['x-20261127-101500.microfactory', 1]);
    assert.match(link.href, /^blob:/);
    assert.match(where, /^x-20261127-101500\.microfactory — /);
    // an attachment is shown from the virtual file system
    const up = await (await win.fetch(`/__chat/upload?app=${apps[0].id}&name=${encodeURIComponent('shot 1.png')}`, { method: 'POST', headers: { 'X-Microfactory': 'chat', 'Content-Type': 'application/octet-stream' }, body: new Uint8Array([1, 2, 3]) })).json();
    assert.ok(up.path, JSON.stringify(up));
    const url = await host.fileUrl(up.path);
    assert.match(url, /^blob:/);
    assert.equal(await host.fileUrl(up.path), url, 'one address per file');
    assert.deepEqual([...new Uint8Array(await (await fetch(url)).arrayBuffer())], [1, 2, 3]);
    await assert.rejects(host.fileUrl('applications/nope/materials/x.png'), /not found/);

    // the words of the page that spoke of a folder and a server
    assert.equal(known.get('#panel .sub').textContent, 'Fairino FR3 · drag to orbit · WASD to fly');
    assert.match(known.get('#appImport').title, /\.microfactory\.zip/);
    // node has no IndexedDB: changes are kept in memory, and the page says so
    const note = body.children.find(c => c.id === 'pageNote');
    assert.ok(note, 'nothing said about changes not being kept');
    assert.match(note.children[0].textContent, /Use Export to keep your work/);
  } finally {
    for (const [k, d] of Object.entries(before0)) { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; }
  }
});

test('inside Claude a save goes through the artifact\'s own function, as a .zip, and a refusal is not tried again', { skip: !BUILT }, async () => {
  const body = { children: [], appendChild(c) { this.children.push(c); return c; } };
  const stub = () => { const kids = new Map(); return { style: {}, querySelector(s) { if (!kids.has(s)) kids.set(s, stub()); return kids.get(s); }, append() {}, appendChild() {}, remove() {} }; };
  const saves = [];
  let answer = async () => ({ status: 'saved' });
  const caps = { downloads: { save: req => { saves.push(req); return answer(); } } };
  const win = {
    fetch: async url => new Response(readFileSync(join(out, new URL(url).pathname.replace(/^\/a\/xyz\//, '')))),
    localStorage: memoryStorage(), sessionStorage: memoryStorage(),
    claude: { use: async name => caps[name] ?? null },
    top: {},                                   // framed: the page is not the top window
  };
  const globals = { window: win, document: { baseURI: PAGE, body, createElement: stub, querySelector: () => null, getElementById: () => null } };
  const before0 = Object.fromEntries(Object.keys(globals).map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  Object.assign(globalThis, globals);
  try {
    await startPage({ viewer: async () => {} });
    const host = win.microfactoryDesktop, blob = new Blob(['zip']);
    assert.equal(await host.saveFile('x.microfactory', blob), 'x.microfactory.zip — with your downloads');
    assert.deepEqual(saves, [{ filename: 'x.microfactory.zip', data: blob }]);
    answer = async () => { throw { code: 'declined', message: 'no' }; };
    await assert.rejects(host.saveFile('x.microfactory', blob), /the save was declined/);
    assert.equal(saves.length, 2, 'a declined save must not be tried again');
    // the function is not there in this view: inside the frame there is no other way, and it is said
    delete caps.downloads;
    await assert.rejects(host.saveFile('x.microfactory', blob), /saving files is not available in this view/);
    // the assistant's hint is the guide's: this view has one
    caps.sample = async () => ({ text: 'hi' });
    const agent = await (await win.fetch('/__chat/agent', { headers: HEAD })).json();
    assert.ok(!/not available/.test(agent.hint), agent.hint);
  } finally {
    for (const [k, d] of Object.entries(before0)) { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; }
  }
});

// ---- what the review of the first version found ----
test('one page at a time keeps the store: a second tab waits for the first to close, and a browser without locks is not held up', async () => {
  // navigator.locks, as far as the page uses it: one holder per name, the rest wait in line
  const held = new Map();
  const locks = {
    request(name, options, fn) {
      return new Promise(resolve => {
        const grant = () => {
          held.set(name, []);
          Promise.resolve(fn({ name })).then(resolve).finally(() => { const next = held.get(name).shift(); held.delete(name); next?.(); });
        };
        if (!held.has(name)) return grant();
        if (options.ifAvailable) return resolve(fn(null));
        held.get(name).push(grant);
      });
    },
  };
  assert.equal(await onePage(locks), 'held');
  let said = 0, second = null;
  const waiting = onePage(locks, () => { said++; }).then(r => { second = r; });
  await new Promise(res => setTimeout(res, 20));
  assert.deepEqual([said, second], [1, null], 'the second page says it is waiting, and does not start');
  // the first tab closes: its lock goes with it
  const next = held.get('microfactory').shift(); held.delete('microfactory'); next();
  await waiting;
  assert.equal(second, 'held', 'then it starts by itself');
  // where there are no locks, they throw, or they never answer: the page starts all the same
  assert.equal(await onePage(undefined), 'none');
  assert.equal(await onePage({ request: () => { throw new Error('SecurityError'); } }), 'none');
  assert.equal(await onePage({ request: () => Promise.reject(new Error('no')) }), 'none');
  assert.equal(await onePage({ request: () => new Promise(() => {}) }, () => {}, { patience: 30 }), 'none');
  // and the page asks before it opens the store
  const src = readFileSync(join(ROOT, 'viewer/share.js'), 'utf8');
  assert.ok(src.indexOf('await onePage(') > 0 && src.indexOf('await onePage(') < src.indexOf("openIdbStore('microfactory')"));
});

test('an attached file is handed out as a picture only when it cannot carry a script, and only attachments are handed out at all', () => {
  for (const [name, type] of [['a.png', 'image/png'], ['a.JPG', 'image/jpeg'], ['a.webp', 'image/webp'], ['a.gif', 'image/gif'], ['a.bmp', 'image/bmp']]) assert.equal(fileType(`applications/x/materials/${name}`), type);
  for (const name of ['a.svg', 'a.SVG', 'a.pdf', 'a.html', 'a.xhtml', 'a.json', 'a.txt', 'noext']) assert.equal(fileType(`applications/x/materials/${name}`), 'application/octet-stream', name);
  assert.equal(isAttachment('applications/x/materials/a.png'), true);
  for (const path of ['applications/x/layout.json', 'applications/x/chats/assistant.json', 'applications/x/materials/deep/a.png', 'viewer/app.js', 'applications/x/materials/..', '/applications/x/materials/a.png',
    'applications/x/materials/a%2Fb.png', 'applications/x/materials/a.png?x', 'applications/x\\materials\\a.png', null, 5])
    assert.equal(isAttachment(path), false, String(path));
  // the chat, in this edition, shows and links pictures only — an SVG is named, never opened as a page of this origin
  const chat = readFileSync(join(ROOT, 'viewer/chat.js'), 'utf8');
  assert.match(chat, /const RASTER = \/\\\.\(png\|jpe\?g\|gif\|webp\|bmp\)\$\/i;/);
  assert.match(chat, /\(onPage \? RASTER : IMAGE\)\.test\(path\)/);
  assert.match(chat, /if \(onPage && !img\) a\.removeAttribute\('target'\);\s*else if \(host\?\.fileUrl\)/);
});

test('an application that does not load still opens the chat in the page edition, so the assistant can be asked to mend it', () => {
  const app = readFileSync(join(ROOT, 'viewer/app.js'), 'utf8');
  const at = app.indexOf("status('cannot load the cell: ' + e.message);");
  assert.ok(at > 0);
  const handler = app.slice(at, app.indexOf('throw e;', at));
  assert.match(handler, /if \(pageOnly\) document\.documentElement\.dataset\.application = appId;/);
});

test('the build carries only viewer modules git knows, and the shareable edition is refused when it is not its commit', { skip: !BUILT }, () => {
  // git, with one module made a stranger to it: viewer/share.js is on disk and "untracked" — whatever
  // the checkout's real state is. (Nothing is put into viewer/ for this: other tests read that folder meanwhile.)
  const bin = mkdtempSync(join(tmpdir(), 'mf-git-'));
  const real = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  writeFileSync(join(bin, 'git'), `#!/bin/sh
case "$*" in
  "ls-files -- viewer") "${real}" "$@" | grep -v '^viewer/share\\.js$'; exit 0 ;;
  "ls-files --others --exclude-standard -- viewer") "${real}" "$@" | grep -v '^viewer/share\\.js$'; echo viewer/share.js; exit 0 ;;
  *) exec "${real}" "$@" ;;
esac
`, { mode: 0o755 });
  const tmp = mkdtempSync(join(ROOT, 'dist-test-'));
  const run = (...flags) => {
    try { return { ok: true, said: execFileSync('node', ['scripts/build-artifact.mjs', ...flags, '--out', tmp.slice(ROOT.length)], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } }) }; }
    catch (e) { return { ok: false, said: String(e.stderr) }; }
  };
  try {
    // a link meant for anyone: a module git does not know stops the build, by name
    const refused = run('--share');
    assert.equal(refused.ok, false);
    assert.match(refused.said, /viewer\/share\.js is not tracked by git: commit it, or build with --dirty/);
    // the installed app's build goes on without it, and says what it left out
    const plainBuild = run();
    assert.equal(plainBuild.ok, true, plainBuild.said);
    assert.ok(existsSync(join(tmp, 'viewer/app.js')) && !existsSync(join(tmp, 'viewer/share.js')), 'a module git does not know was shipped');
    assert.match(plainBuild.said, /left out, not tracked by git: .*viewer\/share\.js/);
    // asked for in so many words, it is built from the working tree — and stamped as not being the commit
    const dirty = run('--share', '--dirty');
    assert.equal(dirty.ok, true, dirty.said);
    assert.ok(existsSync(join(tmp, 'viewer/share.js')));
    assert.match(JSON.parse(readFileSync(join(tmp, 'publish.json'), 'utf8')).build.commit, /^[0-9a-f]+\+dirty$/);
    assert.match(readFileSync(join(tmp, 'index.html'), 'utf8'), /"commit":"[0-9a-f]+\+dirty"/);
    assert.match(dirty.said, /NOT the commit it is stamped with .*viewer\/share\.js \(untracked\)/);
  } finally {
    rmSync(bin, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true }); rmSync(tmp + '-report.txt', { force: true });
  }
});
