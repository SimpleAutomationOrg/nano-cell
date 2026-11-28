// The engine of the shareable edition (viewer/page-engine.js) answers the
// page's requests in the page, from the virtual file system. It has to say
// what viewer/serve.py says — the same statuses, the same JSON, the same
// words. So the first test puts the two side by side: the real server over
// a workspace made from a pack, the page engine over the same pack, the same
// requests to both. The tests after it are about what only the page engine
// can be asked: how long a poll is held, what moves the reload generation,
// the hand-over of runs.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, mkdtempSync, rmSync, readdirSync, statSync } from 'node:fs';
import * as nodeFs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installWorkspace } from '../viewer/workspace-install.js';
import { startEngine, engineFetch, fromBase64, toBase64 } from '../viewer/desktop-bridge.js';
import { createPageFs } from '../viewer/page-fs.js';
import { createMemoryStore } from '../viewer/page-store.js';
import { zipRead, zipWrite } from '../viewer/zip.js';
import { createPageEngine, ROUTES, pyDumps, parseKeeping, idFromFileName } from '../viewer/page-engine.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CHECKOUT = existsSync(join(ROOT, '.git'));
// the server started here must not take over the port file of one the developer is running
process.env.MICROFACTORY_NO_PORT_FILE = '1';

const enc = new TextEncoder(), dec = new TextDecoder();
const CHAT = { 'X-Microfactory': 'chat' };
const JSON_HEAD = { ...CHAT, 'Content-Type': 'application/json' };
const sleep = ms => new Promise(res => setTimeout(res, ms));
const APP = 'case-assembly';

// ---- the pack: what the shareable edition carries, plus the server's own programs ----
// Made here from the tracked files, in the format scripts/build-artifact.mjs
// writes (text inline, a mesh by reference). Not by running the build:
// other work is under way in that script, and this test needs only the
// pack's shape. A mesh's reference is its path in the repository.
function makePack() {
  const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n')
    .filter(p => /^(cell_fr3\/|guides\/|recipes\/|applications\/case-assembly\/|viewer\/[\w.-]+\.py$|viewer\/cell\.d\.ts$)/.test(p))
    .filter(p => existsSync(join(ROOT, p)));
  const files = tracked.map(path => {
    const bytes = readFileSync(join(ROOT, path));
    const entry = { path, sha: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
    if (/\.(js|mjs|ts|py|json|md|sh|html|txt)$/.test(path)) entry.text = bytes.toString('utf8'); else entry.bin = path;
    return entry;
  });
  return { version: 'test', files };
}
const loadBin = async e => new Uint8Array(readFileSync(join(ROOT, e.bin)));

// the assistant, as far as the engine needs one
function fakeChat(hold = 40) {
  const calls = [], events = new Map();
  const of = app => { if (!events.has(app)) events.set(app, []); return events.get(app); };
  return {
    calls,
    agent: () => ({ name: 'Assistant', hint: 'ask me', guides: [], models: [{ id: '', label: 'Default', model: '', note: '' }], models_ready: true }),
    async events(app, epoch, since) {
      calls.push(['events', app, epoch, since]);
      if (epoch === 0 && since >= of(app).length) await sleep(hold);
      if (epoch !== 0) since = 0;
      return { epoch: 0, events: of(app).slice(since), next: of(app).length, running: false, available: true };
    },
    send(o) {
      calls.push(['send', o]);
      if (!o.text.trim()) return { error: 'empty message', status: 409 };
      of(o.app).push({ type: 'user', text: o.text, files: o.files });
      return { ok: true };
    },
    stop(app) { calls.push(['stop', app]); return { ok: true }; },
    reset(app) { calls.push(['reset', app]); events.set(app, []); return { ok: true }; },
    forget(app) { calls.push(['forget', app]); },
    running: () => false,
  };
}

function pageEngine(pack, options = {}) {
  const fs = createPageFs({ pack, loadBin, store: createMemoryStore() });
  const chat = options.chat ?? fakeChat();
  const engine = createPageEngine({ fs, chat, hold: 60, ...options });
  return { fs, chat, engine };
}

// one request, read back
async function ask(engine, method, path, { headers = {}, body = null } = {}) {
  const bytes = body == null ? null : typeof body === 'string' ? enc.encode(body) : body;
  const r = await engine.request(method, path, headers, bytes);
  const h = {};
  for (const [k, v] of Object.entries(r.headers ?? {})) h[k.toLowerCase()] = v;
  const data = r.body ? fromBase64(r.body) : new Uint8Array(0);
  return { status: r.status, headers: h, bytes: data, text: () => dec.decode(data), json: () => JSON.parse(dec.decode(data)) };
}
const post = (engine, path, obj, headers = JSON_HEAD) => ask(engine, 'POST', path, { headers, body: JSON.stringify(obj) });

// The page's side of a run (viewer/agent-run.js): ask for work, say the job
// is in hand, answer it. `result(job)` makes the answer.
function fakePage(engine, app, result, { page = 'page-' + Math.random().toString(36).slice(2), vouch = true } = {}) {
  const state = { stop: false, taken: [], page };
  state.done = (async () => {
    while (!state.stop) {
      const r = await ask(engine, 'GET', `/__run/next?app=${app}&page=${page}`, { headers: CHAT });
      if (state.stop) break;
      const { job } = r.json();
      if (!job) continue;
      state.taken.push(job);
      if (vouch) await post(engine, '/__run/alive', { id: job.id, page });
      await post(engine, '/__run/result', { id: job.id, result: await result(job) });
    }
  })();
  return state;
}

const kids = [];
const desktopSpawn = (command, args, options) => {
  const p = spawn(command, args, { cwd: options.cwd });
  kids.push(p);
  p.stdout.setEncoding('utf8'); p.stderr.setEncoding('utf8');
  return {
    stdout: { on: (_, f) => p.stdout.on('data', f) },
    stderr: { on: (_, f) => p.stderr.on('data', f) },
    on: (ev, f) => p.on(ev, f),
    stdin: { write: data => new Promise((res, rej) => p.stdin.write(data, e => (e ? rej(e) : res()))), end: async () => p.stdin.end() },
    kill: async () => p.kill(),
  };
};
const desktopFs = {
  exists: async p => existsSync(p),
  readFile: async (p, e) => (e ? nodeFs.readFile(p, e) : new Uint8Array(await nodeFs.readFile(p))),
  writeFile: (p, data) => nodeFs.writeFile(p, data),
  mkdir: (p, o) => nodeFs.mkdir(p, o),
};
const temps = [];
after(() => { for (const k of kids) k.kill(); for (const t of temps) rmSync(t, { recursive: true, force: true }); });

const PACK = CHECKOUT ? makePack() : null;
const PNG = 'data:image/png;base64,' + toBase64(Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]));
const walk = (dir, base = dir, out = []) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) e.isDirectory() ? walk(join(dir, e.name), base, out) : out.push(join(dir, e.name).slice(base.length + 1));
  return out.sort();
};

// ============================================================ the parity test

test('the page engine answers as the real server does, request by request: reads, the loop, a new application, attachments, runs, export and import', { skip: !CHECKOUT, timeout: 120_000 }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'mf-parity-'));
  temps.push(tmp);
  const dir = join(tmp, 'workspace');
  await installWorkspace({ fs: desktopFs, load: loadBin, dir, pack: PACK });
  const real = startEngine(desktopSpawn, dir, process.platform);
  await real.ready;
  const { fs, engine: page, chat } = pageEngine(PACK, { mujoco: null });

  const both = async (method, path, opt) => Promise.all([ask(real, method, path, opt), ask(page, method, path, opt)]);
  const isJson = r => (r.headers['content-type'] ?? '').startsWith('application/json');
  // the same status and, when the server answers in JSON, the same object; returns that object (or the two answers)
  const same = async (method, path, opt, tidy = x => x) => {
    const [a, b] = await both(method, path, opt);
    const what = `${method} ${path}`;
    assert.equal(b.status, a.status, `${what}: status (the server said ${a.text().slice(0, 200)}, the page ${b.text().slice(0, 200)})`);
    if (!isJson(a)) return [a, b];
    assert.ok(isJson(b), `${what}: the page did not answer in JSON`);
    assert.deepEqual(tidy(b.json()), tidy(a.json()), what);
    return b.json();
  };
  const samePost = (path, obj, tidy) => same('POST', path, { headers: JSON_HEAD, body: JSON.stringify(obj) }, tidy);
  // a file of the workspace, the same bytes from both
  const sameFile = async (path, tidy = x => x) => {
    const [a, b] = await both('GET', path);
    assert.equal(a.status, 200, `${path}: the server has no such file`);
    assert.equal(b.status, 200, `${path}: the page has no such file`);
    assert.equal(b.headers['content-type'], a.headers['content-type'], `${path}: content type`);
    assert.equal(b.headers['content-length'], String(b.bytes.length), `${path}: the page's Content-Length`);
    assert.equal(b.headers['cache-control'], 'no-store');
    assert.ok(Buffer.from(tidy(b.bytes)).equals(Buffer.from(tidy(a.bytes))), `${path}: the bytes differ\n--- server\n${a.text().slice(0, 600)}\n--- page\n${b.text().slice(0, 600)}`);
    return b;
  };

  // ---- reads ----
  assert.deepEqual(await same('GET', '/__applications'), [{ id: APP, name: 'case assembly', robot: 'cell_fr3' }]);
  await same('GET', '/__applications/whatever');                            // a prefix: still the list
  const steps = await same('GET', `/__steps?app=${APP}`);
  assert.ok(steps.length >= 3 && steps.every(s => s.id && s.name && s.tool));
  for (const q of ['', '?app=nope', '?app=', '?app=..', '?app=a/b', `?x=1&app=${APP}`, `?app=${APP}&app=nope`, '?app=case%2Dassembly', '?app=case+assembly'])
    await same('GET', '/__steps' + q);
  await sameFile('/cell_fr3/robot.json');
  await sameFile(`/applications/${APP}/steps/${steps[0].id}.ts?v=1764280000000`);
  await sameFile(`/applications/${APP}/layout.json#top`);
  await sameFile('/guides/agent.md');
  await sameFile('/cell_fr3/../cell_fr3//./robot.json');                    // worked out as the server works it out
  await sameFile('/../../cell_fr3/robot.json');                             // never above the workspace
  await sameFile('/cell_fr3/robot%2Ejson');
  // a mesh, byte for byte — also against the repository
  for (const rel of [`applications/${APP}/items/holder/holder.glb`, 'cell_fr3/meshes/adapter.collision.stl', 'cell_fr3/arm/meshes/base_link.glb']) {
    const got = await sameFile('/' + rel);
    assert.ok(Buffer.from(got.bytes).equals(readFileSync(join(ROOT, rel))), `${rel} changed on the way`);
  }
  for (const missing of ['/no/such/file.json', `/applications/${APP}/robots/none.json`, '/cell_fr3/robot.json/', '/__nothing', '/node_modules/@mujoco/mujoco/package.json']) {
    const [a, b] = await same('GET', missing);
    assert.equal(a.status, 404, missing);
    assert.equal(b.headers['content-type'], a.headers['content-type'], 'the type of the 404 page');
  }
  {
    const [a, b] = await both('GET', '/__reload?gen=-1');
    assert.deepEqual([a.status, b.status], [200, 200]);
    assert.match(a.text(), /^\d+$/); assert.match(b.text(), /^\d+$/);
    assert.equal(b.headers['content-type'], a.headers['content-type']);
    // the two were started in the same minute: the generation is the clock in seconds on both
    assert.ok(Math.abs(Number(a.text()) - Number(b.text())) < 120, 'the generation does not start at the clock');
  }

  // ---- the header that says "this is our own page" ----
  for (const path of ['/__chat/agent', `/__chat/events?app=${APP}`, `/__run/next?app=${APP}&page=p`, `/__applications/export?app=${APP}`])
    assert.deepEqual(await same('GET', path), { error: 'forbidden' });
  for (const path of ['/__loop/save', '/__applications/new', '/__applications/import?name=x', '/__chat/send', '/__chat/upload?app=x', '/__run/request', '/__run/result', '/__run/record', '/__run/alive'])
    assert.deepEqual(await same('POST', path, { headers: { 'Content-Type': 'application/json' }, body: '{}' }), { error: 'forbidden' });
  for (const path of ['/__steps', '/__applications', '/__reload', '/cell_fr3/robot.json', '/__chatter'])
    assert.deepEqual(await same('POST', path, { headers: JSON_HEAD, body: '{}' }), { error: 'not found' });
  assert.deepEqual(await same('GET', '/__run/next?app=nope&page=p', { headers: CHAT }), { error: 'no such application' });
  assert.deepEqual(await same('GET', '/__chat/events?app=nope', { headers: CHAT }), { error: 'no such application' });
  assert.deepEqual(await same('GET', `/__chat/events?app=${APP}&epoch=x`, { headers: CHAT }), { error: 'bad request' });
  assert.deepEqual(await same('GET', `/__chat/events?app=${APP}&since=1.5`, { headers: CHAT }), { error: 'bad request' });
  // the first poll of a page gets everything at once. (`available` says whether this computer has the
  // agent's command; the page's assistant is its own, so it is left out of the comparison.)
  await same('GET', `/__chat/events?app=${APP}&epoch=-1&since=0`, { headers: CHAT }, r => ({ ...r, available: null }));

  // ---- bodies that are not what they should be ----
  for (const body of ['[]', '"x"', '{', '{"app": ', 'null', '\xff'])
    assert.deepEqual(await same('POST', '/__loop/save', { headers: JSON_HEAD, body: body === '\xff' ? Uint8Array.from([0xff, 0xfe]) : body }), { error: 'bad request' });
  assert.deepEqual(await same('POST', '/__run/alive', { headers: JSON_HEAD, body: '' }), { ok: false });       // no body is an empty object
  // Where a name is missing altogether the server does not answer at all (it trips over the missing
  // value and drops the connection, which the bridge reports as 502). The page engine says "bad request".
  for (const [path, body] of [['/__loop/save', {}], ['/__loop/save', { steps: [] }], ['/__applications/new', { name: 'x' }], ['/__loop/save', { app: 7, steps: [] }]]) {
    assert.equal((await post(real, path, body)).status, 502, `${path} ${JSON.stringify(body)}: the server answers this now — compare it`);
    assert.deepEqual((await post(page, path, body)).json(), { error: 'bad request' });
  }
  assert.deepEqual(await same('POST', '/__run/alive', { headers: JSON_HEAD, body: '{}' + ' '.repeat(199_997) }), { ok: false });
  assert.deepEqual(await same('POST', '/__run/alive', { headers: JSON_HEAD, body: '{}' + ' '.repeat(199_998) }), { error: 'bad request' });

  // ---- the loop's order ----
  const manifestPath = `/applications/${APP}/application.json`;
  const before = (await sameFile(manifestPath)).text();
  const order = JSON.parse(before).loop.steps;
  assert.deepEqual(await samePost('/__loop/save', { app: 'no-such-app', steps: [] }), { error: 'bad request' });
  assert.deepEqual(await samePost('/__loop/save', { app: APP, steps: 'x' }), { error: 'bad request' });
  assert.deepEqual(await samePost('/__loop/save', { app: APP }), { error: 'bad request' });
  assert.deepEqual(await samePost('/__loop/save', { app: APP, steps: Array(201).fill(order[0]) }), { error: 'bad request' });
  assert.deepEqual(await samePost('/__loop/save', { app: APP, steps: [order[0], 'nope'] }), { error: 'no such step: nope' });
  assert.deepEqual(await samePost('/__loop/save', { app: APP, steps: [order[0], '../x'] }), { error: 'no such step: ../x' });
  for (const odd of [7, null, true, 1.5]) await samePost('/__loop/save', { app: APP, steps: [odd] });
  assert.equal((await sameFile(manifestPath)).text(), before, 'a refused order changed the file');
  assert.deepEqual(await samePost('/__loop/save', { app: APP, steps: order }), { ok: true });
  assert.equal((await sameFile(manifestPath)).text(), before, 'saving the order it already has rewrote the file');
  const turned = [...order].reverse();
  assert.deepEqual(await samePost('/__loop/save', { app: APP, steps: turned }), { ok: true });
  const saved = (await sameFile(manifestPath)).text();
  assert.deepEqual(JSON.parse(saved).loop.steps, turned);
  assert.deepEqual(await samePost('/__loop/save', { app: APP, steps: [turned[0], turned[0]] }), { ok: true });       // the server does not mind
  await sameFile(manifestPath);
  assert.deepEqual(await samePost('/__loop/save', { app: APP, steps: [] }), { ok: true });
  await sameFile(manifestPath);
  assert.deepEqual(await samePost('/__loop/save', { app: APP, steps: order }), { ok: true });
  assert.equal((await sameFile(manifestPath)).text(), before, 'the order put back is not the file it was');

  // ---- a new application ----
  assert.deepEqual(await samePost('/__applications/new', { name: '!!!', like: APP }), { error: 'give the application a name (letters or digits)' });
  assert.deepEqual(await samePost('/__applications/new', { like: APP }), { error: 'give the application a name (letters or digits)' });
  assert.deepEqual(await samePost('/__applications/new', { name: ' Case   Assembly ', like: APP }), { error: `applications/${APP} already exists` });
  assert.deepEqual(await samePost('/__applications/new', { name: 'x', like: 'nope' }), { error: 'bad request' });
  assert.deepEqual(await samePost('/__applications/new', { name: '  My  New   Cell — №2 ', like: APP }), { ok: true, id: 'my-new-cell-2' });
  assert.deepEqual((await same('GET', '/__applications')).map(a => a.id), [APP, 'my-new-cell-2']);
  assert.deepEqual((await same('GET', '/__applications'))[1].name, 'My New Cell — №2');
  // its files: the manifest but for the id it was given at birth, the layout with the kit's poses spelled as the server spells numbers
  const noUid = bytes => enc.encode(dec.decode(bytes).replace(/"uid": "[0-9a-f-]{36}"/, '"uid": "…"'));
  const born = JSON.parse((await sameFile('/applications/my-new-cell-2/application.json', noUid)).text());
  assert.match(born.uid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual([born.format, born.robot, born.mounted_tool, born.loop], [1, 'cell_fr3', null, { name: 'My New Cell — №2', steps: [] }]);
  const layout = (await sameFile('/applications/my-new-cell-2/layout.json')).text();
  assert.match(layout, /"xyz_m": \[1\.1375, 0\.5625, 0\.0\]/, 'the kit\'s poses lost their spelling');
  for (const g of born.grippers) {
    await sameFile(`/applications/my-new-cell-2/grippers/${g}/gripper.json`);
    await sameFile(`/applications/my-new-cell-2/grippers/${g}/${g}.glb`);
    await sameFile(`/applications/my-new-cell-2/grippers/${g}/${g}.collision.stl`);
  }
  await sameFile('/applications/my-new-cell-2/items/rack_stand/item.json');
  assert.deepEqual(walk(join(dir, 'applications/my-new-cell-2')), fs.list('applications/my-new-cell-2').map(p => p.slice('applications/my-new-cell-2/'.length)), 'the new application does not hold the same files');
  assert.deepEqual(await same('GET', '/__steps?app=my-new-cell-2'), []);
  assert.deepEqual(await samePost('/__applications/new', { name: 'my new cell 2', like: APP }), { error: 'applications/my-new-cell-2 already exists' });

  // ---- attachments ----
  const up = (query, body) => same('POST', '/__chat/upload' + query, { headers: { ...CHAT, 'Content-Type': 'application/octet-stream' }, body });
  const photo = Uint8Array.from([1, 2, 3, 0, 255, 254]);
  assert.deepEqual(await up(`?app=${APP}&name=${encodeURIComponent('my photo (1).PNG')}`, photo),
    { ok: true, path: `applications/${APP}/materials/my-photo-1-.PNG`, name: 'my-photo-1-.PNG' });
  assert.deepEqual((await up(`?app=${APP}&name=${encodeURIComponent('my photo (1).PNG')}`, enc.encode('another'))).name, 'my-photo-1--2.PNG');
  assert.deepEqual((await up(`?app=${APP}&name=${encodeURIComponent('my photo (1).PNG')}`, enc.encode('a third'))).name, 'my-photo-1--3.PNG');
  assert.deepEqual((await up(`?app=${APP}&name=${encodeURIComponent('C:\\Users\\me\\..\\чертёж детали.step')}`, enc.encode('step'))).name, 'чертёж-детали.step');
  assert.deepEqual((await up(`?app=${APP}&name=${encodeURIComponent('../../etc/passwd')}`, enc.encode('x'))).name, 'passwd');
  assert.deepEqual((await up(`?app=${APP}&name=.hidden`, enc.encode('x'))).name, 'hidden');
  assert.deepEqual((await up(`?app=${APP}&name=...`, enc.encode('x'))).name, 'file');
  assert.deepEqual((await up(`?app=${APP}`, enc.encode('x'))).name, 'file-2');
  assert.deepEqual((await up(`?app=${APP}&name=a+b.tar.gz`, enc.encode('x'))).name, 'a-b.tar.gz');
  assert.deepEqual((await up(`?app=${APP}&name=${'n'.repeat(120)}.${'e'.repeat(30)}`, enc.encode('x'))).name, 'n'.repeat(80) + '.' + 'e'.repeat(11));
  assert.deepEqual((await up(`?app=${APP}&name=empty.txt`, null)).name, 'empty.txt');           // nothing in it: still a file
  assert.deepEqual(await up('?app=nope&name=a.txt', photo), { error: 'bad request' });
  assert.deepEqual(await up('?name=a.txt', photo), { error: 'bad request' });
  assert.ok(Buffer.from((await sameFile(`/applications/${APP}/materials/my-photo-1-.PNG`)).bytes).equals(Buffer.from(photo)), 'the first file was written over');
  await sameFile(`/applications/${APP}/materials/my-photo-1--2.PNG`);
  await sameFile(`/applications/${APP}/materials/${encodeURIComponent('чертёж-детали.step')}`);
  await sameFile(`/applications/${APP}/materials/empty.txt`);

  // ---- the chat's other doors (nothing is sent to the real agent here) ----
  assert.deepEqual(await samePost('/__chat/send', { app: 'nope', text: 'hi' }), { error: 'no such application' });
  assert.deepEqual(await samePost('/__chat/send', { text: 'hi' }), { error: 'no such application' });
  assert.deepEqual(await samePost('/__chat/stop', { app: APP }), { ok: true });
  assert.deepEqual(await samePost('/__chat/dance', { app: APP }), { error: 'not found' });
  assert.deepEqual(await samePost('/__chat/dance', { app: 'nope' }), { error: 'no such application' });
  assert.deepEqual(await samePost('/__run/dance', { app: APP }), { error: 'not found' });

  // ---- runs ----
  assert.deepEqual(await samePost('/__run/alive', { id: 'x', page: 'p' }), { ok: false });
  assert.deepEqual(await samePost('/__run/result', { id: 'x', result: { ok: true } }), { ok: false });
  assert.deepEqual(await samePost('/__run/request', { app: 'nope', steps: ['a'] }), { ok: false, error: "no application 'nope'" });
  assert.deepEqual(await samePost('/__run/request', { steps: ['a'] }), { ok: false, error: "no application ''" });
  // a whole run, with a page on each side that takes the job and answers it
  {
    const answer = job => { const { id, ...rest } = job; return { ok: true, ran: job.steps, job: rest, seconds: 1.5, shot: PNG, shot_close: PNG }; };
    const pages = [fakePage(real, APP, answer), fakePage(page, APP, answer)];
    const res = await samePost('/__run/request', { app: APP, steps: ['one', 7, 'x'.repeat(100)], shot: 1, timeout: 30 });
    assert.deepEqual(res, { ok: true, ran: ['one', '7', 'x'.repeat(80)], job: { steps: ['one', '7', 'x'.repeat(80)], loop: false, reset: true, shot: true, fast: true },
      seconds: 1.5, picture: `.runs/${APP}.png`, picture_close: `.runs/${APP}-close.png` });
    const loop = await samePost('/__run/request', { app: APP, loop: true, reset: false, fast: 0, timeout: 'soon' });
    assert.deepEqual(loop.job, { steps: [], loop: true, reset: false, shot: false, fast: false });
    for (const p of pages) p.stop = true;
    for (const p of pages) assert.equal(p.taken.length, 2);
    assert.match(pages[0].taken[0].id, /^[0-9a-f]{32}$/); assert.match(pages[1].taken[0].id, /^[0-9a-f]{32}$/);
    await sameFile(`/.runs/${APP}.png`); await sameFile(`/.runs/${APP}-close.png`);
  }
  // the record of a failed run, kept with the application
  assert.deepEqual(await samePost('/__run/record', { app: 'nope', record: {} }), { error: 'bad request' });
  assert.deepEqual(await samePost('/__run/record', { app: APP, record: [1] }), { error: 'bad request' });
  assert.deepEqual(await samePost('/__run/record', { app: APP }), { error: 'bad request' });
  const record = { ok: false, step: 'pick', error: 'collision: tool × holder — “too close”', ran: ['pick'], when: '2026-11-27T10:00:00.000Z',
    log: ['a', 'b'], parts_moved: [{ id: 'case', moved_mm: 12.0, from_m: [0.1, 0.2, 0.0], to_m: [1e-7, -0.25, 3] }], held: null, io: {}, tool: 'rcup16_p0',
    joints_deg: [0, -45.5, 90.0], stale: false, shot: PNG, shot_close: 'not a picture' };
  // sent as the page would not spell it (1.0, 1e-07): the file must still be the server's
  const recordBody = JSON.stringify({ app: APP, record }).replace('"moved_mm":12', '"moved_mm":12.0').replace('"joints_deg":[0,-45.5,90]', '"joints_deg":[0,-45.5,90.0]');
  assert.deepEqual(await same('POST', '/__run/record', { headers: JSON_HEAD, body: recordBody }), { ok: true });
  const kept = (await sameFile(`/applications/${APP}/runs/last-failure.json`)).text();
  assert.equal(JSON.parse(kept).picture, `applications/${APP}/runs/last-failure.png`);
  assert.ok(!('shot' in JSON.parse(kept)) && !('shot_close' in JSON.parse(kept)) && !('picture_close' in JSON.parse(kept)));
  assert.ok(/\\u00d7/.test(kept) && /"moved_mm": 12\.0/.test(kept) && !kept.endsWith('\n'), 'the record is not written as the server writes it');
  await sameFile(`/applications/${APP}/runs/last-failure.png`);
  // the next record replaces it, pictures and all
  assert.deepEqual(await samePost('/__run/record', { app: APP, record: { ok: false, error: 'again', shot_close: PNG } }), { ok: true });
  await sameFile(`/applications/${APP}/runs/last-failure.json`);
  await sameFile(`/applications/${APP}/runs/last-failure-close.png`);
  assert.equal((await same('GET', `/applications/${APP}/runs/last-failure.png`))[0].status, 404, 'the picture of the record before was left behind');

  // ---- export ----
  assert.deepEqual(await same('GET', '/__applications/export?app=nope', { headers: CHAT }), { error: 'no such application' });
  assert.deepEqual(await same('GET', '/__applications/export', { headers: CHAT }), { error: 'no such application' });
  const [exA, exB] = await both('GET', `/__applications/export?app=${APP}`, { headers: CHAT });
  assert.deepEqual([exA.status, exB.status], [200, 200]);
  // the name carries the second it was made, which need not be the same second on both sides
  for (const r of [exA, exB]) {
    assert.match(r.headers['x-microfactory-file'], /^case-assembly-\d{8}-\d{6}\.microfactory$/);
    assert.equal(r.headers['content-disposition'], `attachment; filename="${r.headers['x-microfactory-file']}"`);
    assert.equal(r.headers['content-type'], 'application/zip');
  }
  const stampOf = r => r.headers['x-microfactory-file'].slice(APP.length + 1, -'.microfactory'.length);
  const at = s => new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(9, 11), +s.slice(11, 13), +s.slice(13, 15)).getTime();
  assert.ok(Math.abs(at(stampOf(exA)) - at(stampOf(exB))) <= 2000 && Math.abs(at(stampOf(exB)) - Date.now()) < 5000, 'the export is not named by the local time');
  const inA = await zipRead(exA.bytes), inB = await zipRead(exB.bytes);
  assert.deepEqual(inB.map(e => e.name), inA.map(e => e.name), 'the export does not hold the same files in the same order');
  assert.equal(inB[0].name, 'application.json');
  assert.ok(inB.some(e => e.name.startsWith('materials/')) && inB.some(e => e.name === 'runs/last-failure.json'), 'attachments and the last failure travel with the application');
  inA.forEach((e, i) => assert.ok(Buffer.from(inB[i].bytes).equals(Buffer.from(e.bytes)), `${e.name} is not the same in the two exports`));
  // the page's own file is one Python opens and finds whole
  const pageFile = join(tmp, 'page-export.microfactory');
  await nodeFs.writeFile(pageFile, exB.bytes);
  assert.equal(execFileSync('python3', ['-c', 'import sys, zipfile; z = zipfile.ZipFile(sys.argv[1]); print(z.testzip(), len(z.namelist()))', pageFile], { encoding: 'utf8' }).trim(), `None ${inB.length}`);

  // ---- import ----
  const send = (name, existing, body, tidy) => same('POST', `/__applications/import?name=${encodeURIComponent(name)}${existing ? '&existing=' + existing : ''}`,
    { headers: { ...CHAT, 'Content-Type': 'application/octet-stream' }, body }, tidy);
  const exportName = exA.headers['x-microfactory-file'];
  // what was just exported is exactly what is here (the version is a hash of every file: equal on both sides, bit for bit)
  const asked = await send(exportName, 'ask', exA.bytes);
  assert.deepEqual({ ...asked, version: '' }, { ok: true, exists: true, id: APP, name: 'case assembly', version: '', same: true, identical: true });
  assert.match(asked.version, /^[0-9a-f]{8}$/);
  assert.deepEqual(await send(exportName, '', exB.bytes), asked, 'the page\'s own export is not the same application to the server');
  assert.deepEqual(await send(exportName.replace('.microfactory', ' (2).microfactory'), 'ask', exA.bytes), asked);
  assert.deepEqual(await send(`C:\\Downloads\\${exportName}`, 'ask', exA.bytes), asked);
  assert.deepEqual((await send('', 'ask', exA.bytes)).id, APP, 'without a file name the manifest names it');
  // refusals
  // (a small body: the server refuses this without reading what was sent, and megabytes still on their way would break the pipe)
  assert.deepEqual(await send(exportName, 'maybe', enc.encode('x')), { error: 'bad request' });
  assert.deepEqual(await send(exportName, 'ask', null), { error: 'bad request' });
  assert.deepEqual(await send(exportName, 'ask', enc.encode('this is no archive')), { error: 'not a .microfactory file' });
  assert.deepEqual(await send(exportName, 'replace', exA.bytes.slice(0, 2000)), { error: 'not a .microfactory file' });
  const text = s => enc.encode(s);
  const manifestBytes = inA[0].bytes;
  assert.deepEqual(await send('x.microfactory', 'ask', await zipWrite([{ name: 'layout.json', bytes: text('{}') }])),
    { error: 'not an application: there is no application.json in the file' });
  assert.deepEqual(await send('x.microfactory', 'ask', await zipWrite([{ name: 'application.json', bytes: text('{ nope') }])),
    { error: 'not an application: its application.json cannot be read' });
  assert.deepEqual(await send('x.microfactory', 'ask', await zipWrite([{ name: 'application.json', bytes: text('{"format": 2}') }])),
    { error: 'the application is in format 2; this viewer reads format 1' });
  assert.deepEqual(await send('x.microfactory', 'ask', await zipWrite([{ name: 'application.json', bytes: text('{"name": "x"}') }])),
    { error: 'the application is in format None; this viewer reads format 1' });
  assert.deepEqual(await send('x.microfactory', 'ask', await zipWrite([{ name: 'application.json', bytes: text('[1]') }])),
    { error: 'the application is in format ?; this viewer reads format 1' });
  for (const unsafe of ['../outside.txt', 'steps/../../x.ts', '/etc/passwd', 'a\\b.txt', 'C:/x.txt'])
    assert.deepEqual(await send('x.microfactory', 'replace', await zipWrite([{ name: 'application.json', bytes: manifestBytes }, { name: unsafe, bytes: text('x') }])),
      { error: `the file contains an unsafe path: ${unsafe}` });
  assert.deepEqual((await same('GET', '/__applications')).map(a => a.id), [APP, 'my-new-cell-2'], 'a refused file left something behind');

  // a changed application under the same name: it is asked about, then replaces the one here, which is put aside
  const changed = inA.map(e => (e.name === 'application.json' ? { name: e.name, bytes: text(dec.decode(e.bytes).replace('"name": "case assembly"', '"name": "case assembly, mine"')) } : e));
  changed.push({ name: 'notes/план работ.md', bytes: text('# план\n') }, { name: 'steps/extra.ts', bytes: text("export const name = 'Extra';\nexport const tool = \"rcup16_p0\";\n") });
  const changedZip = await zipWrite(changed);
  const again = await send(exportName, 'ask', changedZip);
  assert.deepEqual({ ...again, version: '' }, { ok: true, exists: true, id: APP, name: 'case assembly', version: '', same: true, identical: false });
  assert.notEqual(again.version, asked.version);
  const filesBefore = fs.list(`applications/${APP}`).map(p => p.slice(`applications/${APP}/`.length));
  assert.deepEqual(await send(exportName, 'replace', changedZip), { ok: true, id: APP, version: again.version });
  assert.equal((await same('GET', '/__applications'))[0].name, 'case assembly, mine');
  await sameFile(manifestPath);
  await sameFile(`/applications/${APP}/notes/${encodeURIComponent('план работ.md')}`);
  await sameFile(`/applications/${APP}/materials/my-photo-1-.PNG`);
  assert.ok((await same('GET', `/__steps?app=${APP}`)).some(s => s.id === 'extra' && s.name === 'Extra' && s.tool === 'rcup16_p0'));
  assert.deepEqual(fs.list(`applications/${APP}`).map(p => p.slice(`applications/${APP}/`.length)), walk(join(dir, 'applications', APP)));
  // the one that was here: whole, under .backups, on both sides (the folder's name carries the second)
  const backups = readdirSync(join(dir, '.backups/applications'));
  assert.equal(backups.length, 1); assert.match(backups[0], /^case-assembly-\d{8}-\d{6}$/);
  assert.deepEqual(fs.dirs('.backups/applications').map(d => d.replace(/\d{8}-\d{6}$/, '')), ['case-assembly-']);
  const put = fs.dirs('.backups/applications')[0];
  assert.deepEqual(fs.list(`.backups/applications/${put}`).map(p => p.slice(`.backups/applications/${put}/`.length)), walk(join(dir, '.backups/applications', backups[0])));
  assert.deepEqual(fs.list(`.backups/applications/${put}`).map(p => p.slice(`.backups/applications/${put}/`.length)).sort(), [...filesBefore].sort(), 'something of the replaced application was lost');
  assert.equal(await fs.readText(`.backups/applications/${put}/application.json`), before);
  // twice for a replace: before the folder is put aside (nothing the assistant still had to save may land on the
  // imported conversation), and again when the new files are in place (it may have read them half written)
  assert.deepEqual(chat.calls.filter(c => c[0] === 'forget'), [['forget', APP], ['forget', APP]], 'the assistant was not told that the conversation under this id is another one now');
  // now the file holds exactly what is here
  assert.deepEqual({ ...(await send(exportName, 'ask', changedZip)), version: '' }, { ok: true, exists: true, id: APP, name: 'case assembly, mine', version: '', same: true, identical: true });

  // beside it, as a copy: a free id, and an identity of its own
  assert.deepEqual(await send(exportName, 'copy', exA.bytes), { ok: true, id: `${APP}-2`, version: asked.version });
  assert.deepEqual(await send(exportName, 'copy', exA.bytes), { ok: true, id: `${APP}-3`, version: asked.version });
  assert.deepEqual((await same('GET', '/__applications')).map(a => a.id), [APP, `${APP}-2`, `${APP}-3`, 'my-new-cell-2']);
  const copy = JSON.parse((await sameFile(`/applications/${APP}-2/application.json`, noUid)).text());
  assert.notEqual(copy.uid, JSON.parse(before).uid);
  assert.equal((await sameFile(`/applications/${APP}-2/application.json`, noUid)).text().replace(/"uid": "[^"]+"/, `"uid": "${JSON.parse(before).uid}"`), before, 'a copy\'s manifest is the original but for its uid');
  await sameFile(`/applications/${APP}-2/layout.json`);
  await sameFile(`/applications/${APP}-2/items/holder/holder.glb`);
  // the copy is "another application by that name" to the file it came from
  assert.deepEqual({ ...(await send(`${APP}-2.microfactory`, 'ask', exA.bytes)), version: '' }, { ok: true, exists: true, id: `${APP}-2`, name: 'case assembly', version: '', same: false, identical: false });
  // under a name that is free: just imported
  assert.deepEqual(await send('Other Thing-20260101-101010 (1).microfactory', 'ask', exA.bytes), { ok: true, id: 'other-thing', version: asked.version });
  assert.deepEqual(await send('other-thing.MICROFACTORY', 'copy', exA.bytes), { ok: true, id: 'other-thing-2', version: asked.version });
  assert.deepEqual(await same('GET', '/__applications'), await same('GET', '/__applications'));
  assert.deepEqual(await same('GET', '/__steps?app=other-thing'), steps);
  // an archive whose names are written oddly lands where the server puts it
  const odd = await zipWrite([{ name: 'application.json', bytes: manifestBytes }, { name: './steps//a.ts', bytes: text("export const name = 'A';\n") }, { name: 'notes/50% done #1?.md', bytes: text('x') }]);
  assert.equal((await send('odd.microfactory', 'ask', odd)).id, 'odd');
  assert.deepEqual(await same('GET', '/__steps?app=odd'), [{ id: 'a', name: 'A' }]);
  await sameFile(`/applications/odd/notes/${encodeURIComponent('50% done #1?.md')}`);
  // and what all of it left: the same applications, the same files in each
  for (const a of await same('GET', '/__applications'))
    assert.deepEqual(fs.list(`applications/${a.id}`).map(p => p.slice(`applications/${a.id}/`.length)), walk(join(dir, 'applications', a.id)).filter(f => !f.includes('__pycache__')), `applications/${a.id}`);

  // The export of this edition is saved as <name>.microfactory.zip (a page may only save known kinds of file);
  // the server would make an application called "…-microfactory-zip" of it. The page engine knows the ending.
  const zipName = exportName + '.zip';
  assert.equal((await ask(page, 'POST', `/__applications/import?name=${encodeURIComponent(zipName)}&existing=ask`, { headers: CHAT, body: changedZip })).json().id, APP);
  assert.equal((await ask(real, 'POST', `/__applications/import?name=${encodeURIComponent(zipName)}&existing=ask`, { headers: CHAT, body: changedZip })).json().id, `${exportName.replace('.', '-')}-zip`.slice(0, 60).replace(/-$/, ''));
});

// ============================================================ the page engine alone

const pngBytes = fromBase64(PNG.split(',')[1]);

test('JSON is written as the server writes it: one key per line, plain lists on one line, numbers as Python spells them', { skip: !CHECKOUT }, () => {
  const source = JSON.stringify({ a: [1, 2, 3], b: { c: [], d: {} }, e: [{ x: 1 }, [1, 2]], s: 'é “q” [ 1,\n 2 ] {x}', n: null, t: true })
    .replace('"n":null', '"n":null,"f":[1.0,0.0,-0.0,1e-05,1E5,3.141593,0.00001,123456789.123456789,1e16,1e15,1.5e300,0.1,100,-7,12345678901234567890,2.50,5e-324,0.0001,1e22,123456789012345678.0]');
  const nums = [];
  const mine = pyDumps(parseKeeping(source, nums), nums);
  const theirs = execFileSync('python3', ['-c', 'import sys, json; sys.path.insert(0, "viewer"); import appfiles; sys.stdout.write(appfiles.dumps(json.loads(sys.stdin.read())))'],
    { cwd: ROOT, input: source, encoding: 'utf8' });
  assert.equal(mine, theirs);
  // the files of the repository come back as they are
  for (const f of ['applications/case-assembly/application.json', 'applications/case-assembly/layout.json', 'cell_fr3/kit/kit.json']) {
    const src = readFileSync(join(ROOT, f), 'utf8'), n = [];
    const out = pyDumps(parseKeeping(src, n), n);
    const py = execFileSync('python3', ['-c', 'import sys, json; sys.path.insert(0, "viewer"); import appfiles; sys.stdout.write(appfiles.dumps(json.loads(sys.stdin.read())))'], { cwd: ROOT, input: src, encoding: 'utf8' });
    assert.equal(out, py, f);
  }
});

test('the id a file\'s name gives: without the extension, the browser\'s " (1)", the date — and without the .zip this edition\'s downloads end in', () => {
  const ids = {
    'case-assembly-20261127-101500.microfactory': 'case-assembly',
    'case-assembly-20261127-101500.microfactory.zip': 'case-assembly',
    'case-assembly-20261127-101500.microfactory (1).zip': 'case-assembly',
    'case-assembly-20261127-101500 (3).microfactory.zip': 'case-assembly',
    'case-assembly-20261127-101500.zip': 'case-assembly',
    'Case Assembly.MICROFACTORY.ZIP': 'case-assembly',
    'My Cell (2).microfactory': 'my-cell',
    'plain': 'plain',
    '.microfactory': '',
    '': '',
  };
  for (const [name, id] of Object.entries(ids)) assert.equal(idFromFileName(name), id, name);
});

test('a long poll with nothing to say is held, never answered at once; news ends the wait', { skip: !CHECKOUT }, async () => {
  const hold = 120;
  const { fs, engine } = pageEngine(PACK, { hold, chat: fakeChat(hold) });
  await fs.ready;
  const timed = async p => { const t = performance.now(); const r = await p; return [r, performance.now() - t]; };
  const gen = engine.generation();

  // /__reload: a page that has not seen this generation is told at once; one that has, waits
  let [r, ms] = await timed(ask(engine, 'GET', '/__reload?gen=-1'));
  assert.deepEqual([r.status, r.text()], [200, String(gen)]); assert.ok(ms < hold / 2, `answered after ${ms} ms`);
  [r, ms] = await timed(ask(engine, 'GET', `/__reload?gen=${gen}`));
  assert.deepEqual([r.status, r.text(), r.headers['content-type']], [200, String(gen), 'text/plain']); assert.ok(ms >= hold - 10, `nothing new was answered after only ${ms} ms`);
  [r, ms] = await timed(ask(engine, 'GET', `/__reload?gen=${gen + 1000}`));
  assert.equal(r.text(), String(gen)); assert.ok(ms >= hold - 10);
  // a change by somebody else than the page ends the wait with the new generation
  const waiting = timed(ask(engine, 'GET', `/__reload?gen=${gen}`));
  await sleep(20);
  await fs.write(`applications/${APP}/layout.json`, '{"changed": true}');
  [r, ms] = await waiting;
  assert.equal(r.text(), String(gen + 1)); assert.ok(ms < hold - 20, `the news waited ${ms} ms`);
  // whatever is asked, the answer is 200: the page gives its reload loop up for good on anything else
  for (const odd of ['/__reload', '/__reload?gen=', '/__reload?gen=abc', '/__reload?gen=1.5', '/__reload?gen=5&x=1', '/__reload?x=gen=']) {
    const a = await ask(engine, 'GET', odd);
    assert.deepEqual([a.status, a.text()], [200, String(gen + 1)], odd);
  }

  // /__run/next: no job, so {"job": null} — after the hold
  [r, ms] = await timed(ask(engine, 'GET', `/__run/next?app=${APP}&page=p1`, { headers: CHAT }));
  assert.deepEqual([r.status, r.json()], [200, { job: null }]); assert.ok(ms >= hold - 10, `no job was answered after only ${ms} ms`);

  // /__chat/events: the chat holds its own poll; the engine passes the question on as asked
  [r, ms] = await timed(ask(engine, 'GET', `/__chat/events?app=${APP}&epoch=-1&since=0`, { headers: CHAT }));
  assert.deepEqual(r.json(), { epoch: 0, events: [], next: 0, running: false, available: true }); assert.ok(ms < hold / 2);
  [r, ms] = await timed(ask(engine, 'GET', `/__chat/events?app=${APP}&epoch=0&since=0`, { headers: CHAT }));
  assert.deepEqual(r.json().events, []); assert.ok(ms >= hold - 10, `no events were answered after only ${ms} ms`);

  // held polls hold nobody else up
  const held = ask(engine, 'GET', `/__reload?gen=${gen + 1}`);
  [r, ms] = await timed(ask(engine, 'GET', '/__applications'));
  assert.equal(r.status, 200); assert.ok(ms < hold / 2);
  await held;
});

test('the reload generation moves for a change the server\'s scan would see and the page did not make itself — and for nothing else', { skip: !CHECKOUT }, async () => {
  let clock = 1_764_280_000_000;
  const { fs, engine } = pageEngine(PACK, { now: () => clock });
  await fs.ready;
  let gen = engine.generation();
  assert.equal(gen, 1_764_280_000, 'it starts at the clock, in seconds');
  const moved = async (what, by, work) => { await work(); assert.equal(engine.generation() - gen, by, what); gen = engine.generation(); };
  const app = `applications/${APP}`;

  // somebody else's changes (the assistant writes straight to the file system)
  await moved('a layout', 1, () => fs.write(`${app}/layout.json`, '{}'));
  await moved('the same bytes again (a rewritten file is a changed file to the scan)', 1, () => fs.write(`${app}/layout.json`, '{}'));
  await moved('a step', 1, () => fs.write(`${app}/steps/new-step.ts`, 'export const name = "x";'));
  await moved('a step removed', 1, () => fs.remove(`${app}/steps/new-step.ts`));
  await moved('a mesh', 1, () => fs.write(`${app}/items/holder/holder.glb`, Uint8Array.from([1])));
  await moved('the robot', 1, () => fs.write('cell_fr3/robot.json', '{}'));
  await moved('a file put back as the pack has it', 1, () => fs.reset('cell_fr3/robot.json'));
  await moved('a json file among the attachments, not sent by the page', 1, () => fs.write(`${app}/materials/data.json`, '{}'));
  // what the scan does not look at
  await moved('notes', 0, () => fs.write(`${app}/notes/plan.md`, '# plan'));
  await moved('a CAD file', 0, () => fs.write(`${app}/print/part.step`, 'ISO'));
  await moved('a picture', 0, () => fs.write(`${app}/materials/photo.png`, pngBytes));
  await moved('a module script', 0, () => fs.write(`${app}/print/part.model.mjs`, 'export {}'));
  await moved('the conversation', 0, () => fs.write(`${app}/chats/assistant.json`, '{"events": []}'));
  await moved('the conversation removed', 0, () => fs.remove(`${app}/chats/assistant.json`));
  await moved('a run\'s record', 0, () => fs.write(`${app}/runs/last-failure.json`, '{}'));
  await moved('a run\'s picture folder', 0, () => fs.write(`.runs/${APP}.json`, '{}'));
  await moved('a backup', 0, () => fs.write(`.backups/applications/x-1/application.json`, '{}'));
  await moved('a folder of that name deeper down', 0, () => fs.write(`${app}/items/holder/runs/x.json`, '{}'));
  await moved('the files written while an agent works', 0, () => fs.write('.chat-sessions.json', '{}'));
  await moved('an upper-case extension', 0, () => fs.write(`${app}/notes/DATA.JSON`, '{}'));

  // what the page does itself is already on its screen
  await fs.reset(app); gen = engine.generation();
  const order = JSON.parse(await fs.readText(`${app}/application.json`)).loop.steps;
  await moved('the loop\'s order saved by the page', 0, async () => assert.equal((await post(engine, '/__loop/save', { app: APP, steps: [...order].reverse() })).status, 200));
  assert.equal(fs.origin(`${app}/application.json`), 'changed');
  await moved('the same order again', 0, async () => assert.equal((await post(engine, '/__loop/save', { app: APP, steps: [...order].reverse() })).status, 200));
  await moved('the order put back', 0, () => post(engine, '/__loop/save', { app: APP, steps: order }));
  assert.equal(fs.origin(`${app}/application.json`), 'base', 'the manifest with its first order is the pack\'s file again, byte for byte');
  await moved('an attachment, even a .json one', 0, async () =>
    assert.equal((await ask(engine, 'POST', `/__chat/upload?app=${APP}&name=table.json`, { headers: CHAT, body: enc.encode('{}') })).json().name, 'table.json'));
  await moved('a failed run recorded', 0, () => post(engine, '/__run/record', { app: APP, record: { ok: false, shot: PNG } }));
  await moved('reads', 0, async () => { await ask(engine, 'GET', '/__applications'); await ask(engine, 'GET', `/__steps?app=${APP}`); await ask(engine, 'GET', '/cell_fr3/robot.json'); });
  await moved('an export', 0, () => ask(engine, 'GET', `/__applications/export?app=${APP}`, { headers: CHAT }));
  await moved('a refused request', 0, () => post(engine, '/__applications/new', { name: 'case assembly', like: APP }));

  // a new application and an import move it — once, when all of it is in place, not file by file:
  // a reload in the middle would end the page, and with it the engine that was still writing
  const seen = [];
  const off = fs.onChange(() => seen.push(engine.generation()));
  await moved('a new application', 1, async () => assert.equal((await post(engine, '/__applications/new', { name: 'second', like: APP })).status, 200));
  assert.ok(seen.length > 10 && seen.every(g => g === gen - 1), 'the generation moved while the new application was still being written');
  const zip = (await ask(engine, 'GET', `/__applications/export?app=${APP}`, { headers: CHAT })).bytes;
  await moved('an import asked about', 0, () => ask(engine, 'POST', '/__applications/import?name=case-assembly.microfactory&existing=ask', { headers: CHAT, body: zip }));
  seen.length = 0;
  await moved('an import that replaces', 1, async () => assert.equal((await ask(engine, 'POST', '/__applications/import?name=case-assembly.microfactory&existing=replace', { headers: CHAT, body: zip })).status, 200));
  assert.ok(seen.length > 10 && seen.every(g => g === gen - 1));
  await moved('an import as a copy', 1, () => ask(engine, 'POST', '/__applications/import?name=case-assembly.microfactory&existing=copy', { headers: CHAT, body: zip }));
  await moved('a refused import', 0, () => ask(engine, 'POST', '/__applications/import?name=x.microfactory&existing=replace', { headers: CHAT, body: enc.encode('junk') }));
  // what the entry module does as one change (an application put back as it came): once, at the end —
  // and not at all when nothing the page shows was changed
  seen.length = 0;
  await moved('changes made as one', 1, () => engine.asOne(async () => { await fs.write(`${app}/layout.json`, '{"a": 1}'); await fs.write(`${app}/steps/x.ts`, '//'); }));
  assert.ok(seen.length === 2 && seen.every(g => g === gen - 1), 'the generation moved before all of it was done');
  await moved('made as one, nothing the page shows', 0, () => engine.asOne(() => fs.write(`${app}/notes/n.md`, 'x')));
  off();

  // the clock is the calendar only: a file's name says when it was exported by it
  clock = new Date(2031, 0, 2, 3, 4, 5).getTime();
  assert.equal((await ask(engine, 'GET', `/__applications/export?app=${APP}`, { headers: CHAT })).headers['x-microfactory-file'], 'case-assembly-20310102-030405.microfactory');
});

test('a file system that fails: /__reload still answers 200, everything else says why with a 500', async () => {
  const broken = createPageFs({ pack: { version: 'x', files: [] }, loadBin, store: { kind: 'memory', keys: async () => { throw new Error('site data is blocked'); }, get: async () => undefined, set: async () => {}, delete: async () => {}, clear: async () => {} } });
  const engine = createPageEngine({ fs: broken, chat: fakeChat(), hold: 30 });
  const r = await ask(engine, 'GET', '/__reload?gen=-1');
  assert.deepEqual([r.status, r.text()], [200, String(engine.generation())]);
  const a = await ask(engine, 'GET', '/__applications');
  assert.deepEqual([a.status, a.json()], [500, { error: 'site data is blocked' }]);
  assert.equal((await post(engine, '/__loop/save', { app: 'x', steps: [] })).status, 500);
  assert.deepEqual(await engine.runs.request({ app: 'x', steps: ['a'] }).catch(e => e.message), 'site data is blocked');
});

test('a run asked for by the assistant is taken by the page through /__run/next and answered through /__run/result', { skip: !CHECKOUT }, async () => {
  const { fs, engine } = pageEngine(PACK, { hold: 80, vouch: 60, listen: 150 });
  await fs.ready;

  // nobody has the application open: the request says so (after the time a page is given to show up)
  let t = performance.now();
  assert.deepEqual(await engine.runs.request({ app: APP, steps: ['a'] }),
    { ok: false, error: `the application '${APP}' is not open in the viewer (or its window is hidden): ask the user to open it and keep it on screen` });
  assert.ok(performance.now() - t >= 55, 'gave up before a page had the time to ask for work');
  assert.deepEqual(await engine.runs.request({ app: 'nope', steps: ['a'] }), { ok: false, error: "no application 'nope'" });

  // a page is there: it gets the job as the server would hand it out, runs it, answers
  const page = fakePage(engine, APP, async job => { await sleep(30); return { ok: true, ran: job.steps, seconds: 0.5, shot: PNG, shot_close: PNG, log: ['step done'] }; });
  await sleep(10);
  const res = await engine.runs.request({ app: APP, steps: ['pick-place-case', 'drop-demo'], shot: true });
  assert.deepEqual(res, { ok: true, ran: ['pick-place-case', 'drop-demo'], seconds: 0.5, log: ['step done'], picture: `.runs/${APP}.png`, picture_close: `.runs/${APP}-close.png` });
  const { id, ...job } = page.taken[0];
  assert.match(id, /^[0-9a-f]{32}$/);
  assert.deepEqual(job, { steps: ['pick-place-case', 'drop-demo'], loop: false, reset: true, shot: true, fast: true });
  // the pictures became files of the workspace (and no reason to reload)
  assert.deepEqual(await fs.read(`.runs/${APP}.png`), pngBytes);
  assert.deepEqual(await fs.read(`.runs/${APP}-close.png`), pngBytes);

  // the loop, without a reset first (`keep` is run-step.mjs's word for it), at the viewer's speed
  await engine.runs.request({ app: APP, loop: true, keep: true, fast: false });
  assert.deepEqual((({ id, ...j }) => j)(page.taken[1]), { steps: [], loop: true, reset: false, shot: false, fast: false });

  // one run at a time per application: a second request while one is going is refused, and the first still ends well
  const first = engine.runs.request({ app: APP, steps: ['a'] });
  assert.deepEqual(await engine.runs.request({ app: APP, steps: ['b'] }), { ok: false, error: 'another run was asked for and has not finished' });
  assert.equal((await first).ok, true);
  // …and when it has ended the next one is taken
  assert.equal((await engine.runs.request({ app: APP, steps: ['c'] })).ok, true);
  assert.deepEqual(page.taken.map(j => j.steps.join()), ['pick-place-case,drop-demo', '', 'a', 'c']);

  // an answer for a job that is not (or no longer) there is turned away
  assert.deepEqual((await post(engine, '/__run/result', { id, result: { ok: true } })).json(), { ok: false });
  assert.deepEqual((await post(engine, '/__run/alive', { id, page: page.page })).json(), { ok: false });
  // a page that answers nonsense: the request still gets a result it can show
  page.stop = true; await page.done;
  const silly = fakePage(engine, APP, async () => 'done!');
  assert.deepEqual(await engine.runs.request({ app: APP, steps: ['a'] }), { ok: false, error: 'the viewer sent no result' });
  silly.stop = true; await silly.done;

  // a run that takes longer than the request waits: the request says so, and the page's late answer is turned away
  let late;
  const slow = fakePage(engine, APP, async () => { await sleep(250); return { ok: true, ran: ['a'] }; });
  t = performance.now();
  assert.deepEqual(await engine.runs.request({ app: APP, steps: ['a'], timeout: 0.12 }), { ok: false, error: 'no result within 0.12 s — the run may still be going in the viewer' });
  assert.ok(performance.now() - t >= 110);
  slow.stop = true; await slow.done;
  late = await post(engine, '/__run/result', { id: slow.taken[0].id, result: { ok: true } });
  assert.deepEqual(late.json(), { ok: false });
});

test('a job handed to a poll the page had already dropped is given out again, to the next poll; a job in hand is not', { skip: !CHECKOUT }, async () => {
  const vouch = 100;
  const { fs, engine } = pageEngine(PACK, { hold: 400, vouch, listen: 2000 });
  await fs.ready;
  const next = page => ask(engine, 'GET', `/__run/next?app=${APP}&page=${page}`, { headers: CHAT }).then(r => r.json().job);

  // The page's poll is held. The tab is hidden: the page drops the poll (engineFetch rejects it with an
  // AbortError) but the engine cannot know, and when a job comes, it is this dead poll that gets it.
  const dropped = next('gone');
  await sleep(20);
  const asked = engine.runs.request({ app: APP, steps: ['pick'], timeout: 5 });
  const lost = await dropped;
  assert.deepEqual(lost.steps, ['pick']);
  // the tab is shown again and asks for work: while the first taker could still be vouching, nothing…
  const t = performance.now();
  const again = await next('back');
  // …then, nobody having said the job is in hand, the same job once more
  assert.ok(again, 'the job was lost with the dropped poll');
  assert.equal(again.id, lost.id);
  assert.ok(performance.now() - t >= vouch - 30, `given out again after only ${performance.now() - t} ms`);
  // the page that has it now says so, and keeps saying so: no third poll gets it
  assert.deepEqual((await post(engine, '/__run/alive', { id: again.id, page: 'gone' })).json(), { ok: false }, 'the page that lost it cannot vouch for it');
  const other = next('other');
  for (let i = 0; i < 6; i++) { assert.deepEqual((await post(engine, '/__run/alive', { id: again.id, page: 'back' })).json(), { ok: true }); await sleep(40); }
  assert.deepEqual((await post(engine, '/__run/result', { id: again.id, result: { ok: true, ran: ['pick'] } })).json(), { ok: true });
  assert.deepEqual(await asked, { ok: true, ran: ['pick'] });
  assert.equal(await other, null, 'a job in hand was given to a second page');
  // answered once: a second answer is turned away
  assert.deepEqual((await post(engine, '/__run/result', { id: again.id, result: { ok: false } })).json(), { ok: false });

  // a page that took a job and was then reloaded under it: its next load gets the job again
  const asked2 = engine.runs.request({ app: APP, steps: ['place'], timeout: 5 });
  const firstLoad = await next('load-1');
  await post(engine, '/__run/alive', { id: firstLoad.id, page: 'load-1' });
  const secondLoad = await next('load-2');
  assert.equal(secondLoad.id, firstLoad.id);
  await post(engine, '/__run/result', { id: secondLoad.id, result: { ok: true, ran: ['place'] } });
  assert.deepEqual(await asked2, { ok: true, ran: ['place'] });
});

test('/__run/record keeps the last failed run with the application: last-failure.json and its pictures, replacing the one before', { skip: !CHECKOUT }, async () => {
  const { fs, engine } = pageEngine(PACK);
  await fs.ready;
  const folder = `applications/${APP}/runs`;
  assert.equal(await engine.runs.last(APP), null);
  const record = { ok: false, step: 'pick-place-case', error: 'collision: tool × holder', ran: ['pick-place-case'], when: '2026-11-27T10:00:00.000Z', log: ['a'], held: null, io: {}, tool: 'rcup16_p0', joints_deg: [0, 1.5], stale: false, shot: PNG, shot_close: PNG };
  assert.deepEqual((await post(engine, '/__run/record', { app: APP, record })).json(), { ok: true });
  const { shot, shot_close, ...rest } = record;
  const kept = { ...rest, picture: `${folder}/last-failure.png`, picture_close: `${folder}/last-failure-close.png` };
  assert.deepEqual(JSON.parse(await fs.readText(`${folder}/last-failure.json`)), kept);
  assert.deepEqual(await engine.runs.last(APP), kept);
  assert.deepEqual(await fs.read(`${folder}/last-failure.png`), pngBytes);
  assert.deepEqual(await fs.read(`${folder}/last-failure-close.png`), pngBytes);
  assert.deepEqual(fs.list(folder), [`${folder}/last-failure-close.png`, `${folder}/last-failure.json`, `${folder}/last-failure.png`]);
  // a failure without pictures: the old pictures do not stay beside the new record
  assert.deepEqual((await post(engine, '/__run/record', { app: APP, record: { ok: false, error: 'second' } })).json(), { ok: true });
  assert.deepEqual(fs.list(folder), [`${folder}/last-failure.json`]);
  assert.deepEqual(await engine.runs.last(APP), { ok: false, error: 'second' });
  assert.equal(await engine.runs.last('nope'), null);
  // the record travels with the application
  const zip = await zipRead((await ask(engine, 'GET', `/__applications/export?app=${APP}`, { headers: CHAT })).bytes);
  assert.ok(zip.some(e => e.name === 'runs/last-failure.json'));
  // a record with a picture of several megabytes is taken (the limit is 8 MB, not the 200 kB of other requests)
  const big = 'data:image/png;base64,' + toBase64(new Uint8Array(5_000_000).fill(7));
  assert.equal((await post(engine, '/__run/record', { app: APP, record: { ok: false, shot: big } })).status, 200);
  assert.equal((await fs.read(`${folder}/last-failure.png`)).length, 5_000_000);
});

test('an attachment never lands on a file that is there, also when several arrive at once', { skip: !CHECKOUT }, async () => {
  const { fs, engine } = pageEngine(PACK);
  await fs.ready;
  const folder = `applications/${APP}/materials`;
  await fs.write(`${folder}/sketch.png`, 'the one that was here');
  const up = (name, body) => ask(engine, 'POST', `/__chat/upload?app=${APP}&name=${encodeURIComponent(name)}`, { headers: CHAT, body: enc.encode(body) }).then(r => r.json());
  const answers = await Promise.all(Array.from({ length: 8 }, (_, i) => up('sketch.png', `upload ${i}`)));
  assert.deepEqual(answers.map(a => a.name).sort(), ['sketch-2.png', 'sketch-3.png', 'sketch-4.png', 'sketch-5.png', 'sketch-6.png', 'sketch-7.png', 'sketch-8.png', 'sketch-9.png']);
  assert.equal(await fs.readText(`${folder}/sketch.png`), 'the one that was here');
  for (const [i, a] of answers.entries()) {
    assert.deepEqual(a, { ok: true, path: `${folder}/${a.name}`, name: a.name });
    assert.equal(await fs.readText(a.path), `upload ${i}`, 'two uploads took the same name');
  }
  // a folder of that name is in the way too
  await fs.write(`${folder}/photos/a.png`, 'x');
  assert.equal((await up('photos', 'x')).name, 'photos-2');
  // the name is made safe, and what is sent as the files of a message is checked against what is really there
  assert.equal((await up('../../../cell_fr3/robot.json', '{}')).path, `${folder}/robot.json`);
  assert.notEqual(await fs.readText('cell_fr3/robot.json'), '{}');
});

test('requests do not wait for one another: 24 at once through the page\'s fetch, each answer to its own question', { skip: !CHECKOUT }, async () => {
  const { engine } = pageEngine(PACK, { hold: 300 });
  let network = 0;
  const fetch2 = engineFetch(engine, async () => { network++; return new Response('from the network'); }, { pageUrl: 'https://host.example/a/xyz/' });
  // three polls are held all the while, as in a page
  const ctl = new AbortController();
  const polls = [fetch2(`/__reload?gen=${engine.generation()}`, { signal: ctl.signal }), fetch2(`/__run/next?app=${APP}&page=p`, { headers: CHAT, signal: ctl.signal }),
    fetch2(`/__chat/events?app=${APP}&epoch=0&since=0`, { headers: CHAT })];
  const t = performance.now();
  const kinds = [
    ['/__applications', r => r.json().then(j => assert.ok(Array.isArray(j) && j[0].id === APP))],
    ['../cell_fr3/robot.json', r => r.json().then(j => assert.ok(j.arm && j.table))],
    [`/__steps?app=${APP}`, r => r.json().then(j => assert.ok(j.length >= 3 && j[0].name))],
    [`../applications/${APP}/items/holder/holder.glb`, async r => assert.ok(Buffer.from(await r.arrayBuffer()).equals(readFileSync(join(ROOT, `applications/${APP}/items/holder/holder.glb`))))],
    ['/no/such/file.json', async r => assert.equal(r.status, 404)],
    [`/applications/${APP}/steps/drop-demo.ts?v=${Date.now()}`, r => r.text().then(s => assert.match(s, /^export const name/m))],
  ];
  await Promise.all(Array.from({ length: 24 }, (_, i) => fetch2(kinds[i % kinds.length][0]).then(kinds[i % kinds.length][1])));
  assert.ok(performance.now() - t < 250, 'the requests waited for the held polls');
  // the mesh as three's loader asks for it: a Request, made absolute against the page
  const viaRequest = await fetch2(new Request(new URL(`../applications/${APP}/items/holder/holder.glb`, 'https://host.example/a/xyz/').href));
  assert.equal(viaRequest.status, 200);
  // a POST with a body, as the page sends it
  const bad = await fetch2('/__loop/save', { method: 'POST', headers: JSON_HEAD, body: JSON.stringify({ app: 'no-such-app', steps: [] }) });
  assert.deepEqual([bad.status, await bad.json()], [400, { error: 'bad request' }]);
  assert.equal((await fetch2('/__chat/agent')).status, 403);
  assert.equal((await (await fetch2('/__chat/agent', { headers: CHAT })).json()).name, 'Assistant');
  // a dropped poll rejects as the page expects; the page's own files stay on the network
  ctl.abort();
  await assert.rejects(polls[0], { name: 'AbortError' }); await assert.rejects(polls[1], { name: 'AbortError' });
  assert.deepEqual((await (await polls[2]).json()).events, []);
  await fetch2('https://host.example/a/xyz/viewer/app.js');
  assert.equal(network, 1);
});

test('what is too large is refused with the server\'s words: 200 kB of JSON, 8 MB for a run\'s result, 50 MB for an attachment, 1000 MB for an import', { skip: !CHECKOUT }, async () => {
  const { fs, engine } = pageEngine(PACK);
  await fs.ready;
  const pad = (obj, n) => { const s = JSON.stringify(obj); return enc.encode(s + ' '.repeat(n - s.length)); };
  const send = (path, body) => ask(engine, 'POST', path, { headers: JSON_HEAD, body });
  for (const path of ['/__loop/save', '/__applications/new', '/__run/alive', '/__run/request', '/__chat/send', '/__chat/stop']) {
    const r = await send(path, pad({ app: 'nope' }, 200_000));
    assert.deepEqual([r.status, r.json()], [400, { error: 'bad request' }], path);
  }
  assert.deepEqual((await send('/__run/alive', pad({ id: 'x' }, 199_999))).json(), { ok: false });
  // a run's result and record may carry pictures
  assert.deepEqual((await send('/__run/result', pad({ id: 'x', result: {} }, 7_999_999))).json(), { ok: false });
  assert.deepEqual((await send('/__run/result', pad({ id: 'x', result: {} }, 8_000_000))).json(), { error: 'bad request' });
  assert.equal((await send('/__run/record', pad({ app: APP, record: {} }, 7_999_999))).status, 200);
  assert.deepEqual((await send('/__run/record', pad({ app: APP, record: {} }, 8_000_000))).json(), { error: 'bad request' });
  // an attachment
  const most = new Uint8Array(50_000_001);
  let r = await ask(engine, 'POST', `/__chat/upload?app=${APP}&name=big.bin`, { headers: CHAT, body: most });
  assert.deepEqual([r.status, r.json()], [413, { error: 'file too large (limit 50 MB)' }]);
  assert.ok(!fs.exists(`applications/${APP}/materials/big.bin`));
  r = await ask(engine, 'POST', `/__chat/upload?app=${APP}&name=big.bin`, { headers: CHAT, body: most.subarray(0, 50_000_000) });
  assert.deepEqual([r.status, r.json().name, fs.size(`applications/${APP}/materials/big.bin`)], [200, 'big.bin', 50_000_000]);
  // an import: only its length is looked at before it is refused (a gigabyte is not made for this)
  const r2 = await engine.request('POST', '/__applications/import?name=x.microfactory&existing=ask', CHAT, /** @type {any} */ ({ length: 1_000_000_001 }));
  assert.deepEqual([r2.status, JSON.parse(dec.decode(fromBase64(r2.body)))], [413, { error: 'file too large (limit 1000 MB)' }]);
});

test('MuJoCo is answered from what the artifact carries, at the addresses the installed page asks', { skip: !CHECKOUT }, async () => {
  const wasm = Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0, 9, 8, 7]);
  let loads = 0;
  const { engine } = pageEngine(PACK, { mujoco: { version: '4.0.1', wasm: async () => { loads++; return wasm; } } });
  const fetch2 = engineFetch(engine, async () => new Response('network'), { pageUrl: 'https://host.example/a/xyz/' });
  // as viewer/app.js does it
  const pkg = await fetch2('/node_modules/@mujoco/mujoco/package.json');
  assert.ok(pkg.ok);
  const info = await pkg.json();
  assert.deepEqual(info, { name: '@mujoco/mujoco', version: '4.0.1' });
  assert.match(info.version, /^\d+\.\d+\.\d+$/);
  const bin = await fetch2('/node_modules/@mujoco/mujoco/mujoco.wasm');
  assert.ok(bin.ok);
  assert.equal(bin.headers.get('content-type'), 'application/wasm');
  assert.deepEqual(new Uint8Array(await bin.arrayBuffer()), wasm);
  assert.equal(loads, 1, 'the wasm is fetched when asked for, not before');
  assert.equal((await fetch2('/node_modules/@mujoco/mujoco/package.json?v=3')).status, 200);
  // nothing else of node_modules is there
  assert.equal((await fetch2('/node_modules/@mujoco/mujoco/mujoco.js')).status, 404);
  assert.equal((await fetch2('/node_modules/three/package.json')).status, 404);
  // an engine that was given no MuJoCo has no such files
  const bare = pageEngine(PACK, { mujoco: undefined }).engine;
  assert.equal((await ask(bare, 'GET', '/node_modules/@mujoco/mujoco/package.json')).status, 404);
  assert.equal((await ask(bare, 'GET', '/node_modules/@mujoco/mujoco/mujoco.wasm')).status, 404);
});

test('the chat\'s requests reach the assistant as the server would pass them on: checked, cut to size, with only real attachments', { skip: !CHECKOUT }, async () => {
  const chat = fakeChat(30);
  const { fs, engine } = pageEngine(PACK, { chat });
  await fs.ready;
  const m = `applications/${APP}/materials`;
  await fs.write(`${m}/photo.png`, pngBytes);
  await fs.write(`${m}/sub/deep.png`, pngBytes);
  assert.deepEqual((await ask(engine, 'GET', '/__chat/agent', { headers: CHAT })).json(), chat.agent());
  const sent = await post(engine, '/__chat/send', {
    app: APP, text: 'look at this', context: 'c'.repeat(500), model: 'm'.repeat(50),
    files: [`${m}/photo.png`, `${m}/missing.png`, `${m}/sub/deep.png`, 'cell_fr3/robot.json', `applications/${APP}/layout.json`, `${m}/../materials/./photo.png`, `/${m}/photo.png`, '../../etc/passwd', 7, null],
  });
  assert.deepEqual([sent.status, sent.json()], [200, { ok: true }]);
  assert.deepEqual(chat.calls.at(-1), ['send', { app: APP, text: 'look at this', context: 'c'.repeat(400), files: [`${m}/photo.png`, `${m}/photo.png`], model: 'm'.repeat(40) }]);
  // at most twenty attachments; a message of other things than text is still text
  await post(engine, '/__chat/send', { app: APP, text: 42, files: Array(30).fill(`${m}/photo.png`) });
  assert.equal(chat.calls.at(-1)[1].files.length, 20);
  assert.deepEqual([chat.calls.at(-1)[1].text, chat.calls.at(-1)[1].context, chat.calls.at(-1)[1].model], ['42', '', '']);
  // what the assistant refuses comes back with its words and its status
  const empty = await post(engine, '/__chat/send', { app: APP, text: '   ' });
  assert.deepEqual([empty.status, empty.json()], [409, { error: 'empty message' }]);
  // the events, from where the page says it is
  const ev = (await ask(engine, 'GET', `/__chat/events?app=${APP}&epoch=0&since=1`, { headers: CHAT })).json();
  assert.deepEqual(ev, { epoch: 0, events: [{ type: 'user', text: '42', files: Array(20).fill(`${m}/photo.png`) }], next: 2, running: false, available: true });
  assert.deepEqual(chat.calls.at(-1), ['events', APP, 0, 1]);
  await ask(engine, 'GET', `/__chat/events?app=${APP}`, { headers: CHAT });
  assert.deepEqual(chat.calls.at(-1), ['events', APP, -1, 0], 'a page that says nothing starts from the beginning');
  // stop, and a new conversation
  assert.deepEqual((await post(engine, '/__chat/stop', { app: APP })).json(), { ok: true });
  assert.deepEqual(chat.calls.at(-1), ['stop', APP]);
  assert.deepEqual((await post(engine, '/__chat/new', { app: APP })).json(), { ok: true });
  assert.deepEqual(chat.calls.at(-1), ['reset', APP]);
  // nothing of it reaches the assistant for an application that is not there, or without the page's header
  const n = chat.calls.length;
  for (const action of ['send', 'stop', 'new']) {
    assert.equal((await post(engine, `/__chat/${action}`, { app: 'nope', text: 'x' })).status, 404);
    assert.equal((await post(engine, `/__chat/${action}`, { app: APP, text: 'x' }, { 'Content-Type': 'application/json' })).status, 403);
  }
  assert.equal((await ask(engine, 'GET', `/__chat/events?app=${APP}`)).status, 403);
  assert.equal(chat.calls.length, n);
});

test('every \'/__…\' address the viewer asks for is one the page engine answers', () => {
  assert.ok(ROUTES.every(r => r.startsWith('/__')) && new Set(ROUTES).size === ROUTES.length);
  const asked = new Set();
  for (const f of readdirSync(join(ROOT, 'viewer')).filter(f => f.endsWith('.js') && f !== 'page-engine.js')) {
    for (const m of readFileSync(join(ROOT, 'viewer', f), 'utf8').matchAll(/['"`](\/__[a-z]+(?:\/[a-z]+)?)/g)) asked.add(m[1]);
  }
  assert.ok(asked.size >= 8, 'the viewer\'s requests were not found');
  for (const a of asked) assert.ok(ROUTES.includes(a) || a === '/__chat', `${a} is asked for by the viewer but is not in ROUTES`);
});

test('HEAD answers for a file without its bytes; other methods are not served', { skip: !CHECKOUT }, async () => {
  const { engine } = pageEngine(PACK);
  const head = await ask(engine, 'HEAD', '/cell_fr3/robot.json');
  assert.deepEqual([head.status, head.bytes.length, head.headers['content-length']], [200, 0, String(statSync(join(ROOT, 'cell_fr3/robot.json')).size)]);
  assert.equal((await ask(engine, 'HEAD', '/nope.json')).status, 404);
  assert.equal((await ask(engine, 'PUT', '/cell_fr3/robot.json', { body: '{}' })).status, 501);
  assert.equal((await ask(engine, 'DELETE', '/cell_fr3/robot.json')).status, 501);
  // a folder is not a file
  for (const folder of ['/cell_fr3', '/cell_fr3/', '/', '']) assert.equal((await ask(engine, 'GET', folder)).status, 404, folder);
});

// ---- writes that fail half-way (the browser's storage is full) ----
// a small pack that needs no checkout: one application with a mesh, a robot with a kit
const SMALL = (() => {
  const text = (path, s) => ({ path, sha: createHash('sha256').update(s).digest('hex'), size: enc.encode(s).length, text: s });
  return { version: 'small', files: [
    text('applications/a/application.json', '{\n "format": 1,\n "uid": "u-1",\n "name": "A",\n "robot": "rob",\n "loop": {\n  "name": "A",\n  "steps": []\n }\n}\n'),
    text('applications/a/layout.json', '{\n "fixtures": []\n}\n'),
    text('applications/a/steps/one.ts', 'export const name = "One";\n'),
    text('applications/a/notes/plan.md', '# plan\n'),
    text('rob/kit/kit.json', '{"grippers": ["g"], "items": []}'),
    text('rob/kit/grippers/g/gripper.json', '{"id": "g"}'),
  ] };
})();
// a store that refuses the n-th write from now on (QuotaExceededError, as IndexedDB says it)
function quotaStore() {
  const store = createMemoryStore();
  let left = Infinity;
  const set = store.set.bind(store);
  store.set = async (k, v) => { if (--left < 0) throw new Error('QuotaExceededError'); return set(k, v); };
  store.failAfter = n => { left = n; };
  return store;
}
// a store with room for so many bytes, as a browser's is: a write that would take it over is refused, deleting frees room
function roomStore() {
  const store = createMemoryStore(), sizes = new Map();
  let room = Infinity;
  const set = store.set.bind(store), del = store.delete.bind(store);
  const used = () => [...sizes.values()].reduce((a, b) => a + b, 0);
  store.set = async (k, v) => {
    const n = v.bytes?.length ?? 0;
    if (used() - (sizes.get(k) ?? 0) + n > room) throw new Error('QuotaExceededError');
    sizes.set(k, n);
    return set(k, v);
  };
  store.delete = async k => { sizes.delete(k); return del(k); };
  store.used = used;
  store.limit = n => { room = n; };
  return store;
}
const snapshot = async (fs, prefix) => Object.fromEntries(await Promise.all(fs.list(prefix).map(async p => [p, dec.decode(await fs.read(p.split('/').map(encodeURIComponent).join('/')))])));

test('an import that fails half-way leaves the application that was here exactly as it was, wherever it fails', async () => {
  const archive = await zipWrite([
    { name: 'application.json', bytes: enc.encode('{"format": 1, "uid": "u-1", "name": "A two"}') },
    { name: 'layout.json', bytes: enc.encode('{"fixtures": [], "parts": []}') },
    { name: 'steps/two.ts', bytes: enc.encode('export const name = "Two";\n') },
    { name: 'notes/more.md', bytes: enc.encode('more\n'.repeat(40)) },
  ]);
  const send = engine => ask(engine, 'POST', '/__applications/import?name=a.microfactory&existing=replace', { headers: CHAT, body: archive });
  const start = async store => {
    const fs = createPageFs({ pack: SMALL, loadBin, store });
    const engine = createPageEngine({ fs, chat: fakeChat(), hold: 30 });
    await fs.write('applications/a/notes/mine.md', 'mine, and long enough to matter\n'.repeat(8));
    await fs.write('applications/a/layout.json', '{"fixtures": [], "changed": true}');
    await fs.remove('applications/a/notes/plan.md');
    return { fs, engine, before: await snapshot(fs, 'applications/a') };
  };
  // the storage runs out: at every amount of room between "none to spare" and "enough"
  let failed = 0, passed = 0;
  for (let spare = 0; passed < 3; spare += 5) {
    assert.ok(spare < 20000, 'the import never fits');
    const store = roomStore();
    const { fs, engine, before } = await start(store);
    store.limit(store.used() + spare);
    const r = await send(engine);
    if (r.status === 200) { passed++; assert.equal(JSON.parse(await fs.readText('applications/a/application.json')).name, 'A two'); continue; }
    failed++;
    assert.deepEqual([r.status, r.json()], [500, { error: 'QuotaExceededError' }], `with ${spare} bytes to spare`);
    assert.deepEqual(await snapshot(fs, 'applications/a'), before, `with ${spare} bytes to spare: the application is not as it was`);
    assert.equal(fs.origin('applications/a/application.json'), 'base');
    assert.deepEqual((await ask(engine, 'GET', '/__applications')).json(), [{ id: 'a', name: 'A', robot: 'rob' }]);
    assert.deepEqual(fs.list('.incoming'), [], `with ${spare} bytes to spare: half an import was left`);
    assert.deepEqual(fs.list('.backups'), [], `with ${spare} bytes to spare: the application was left put aside`);
    // what a reload would find in the store is the same
    const again = createPageFs({ pack: SMALL, loadBin, store });
    await again.ready;
    assert.deepEqual(await snapshot(again, 'applications/a'), before);
  }
  assert.ok(failed > 20, `the import failed at many points (${failed})`);

  // a write that fails outright while the new files arrive or the old ones are copied aside: undone by deleting alone
  for (let n = 0; n < 8; n++) {
    const store = quotaStore();
    const { fs, engine, before } = await start(store);
    store.failAfter(n);
    const r = await send(engine);
    assert.deepEqual([r.status, r.json()], [500, { error: 'QuotaExceededError' }], `failing at write ${n}`);
    assert.deepEqual(await snapshot(fs, 'applications/a'), before, `failing at write ${n}: the application is not as it was`);
    assert.deepEqual([fs.list('.incoming'), fs.list('.backups')], [[], []]);
    store.failAfter(Infinity);
    assert.equal((await send(engine)).status, 200);
  }
});

test('replacing an application again and again keeps one copy put aside, the latest — not one more each time', async () => {
  let clock = Date.UTC(2026, 10, 27, 10, 0, 0);
  const { fs, engine } = pageEngine(SMALL, { now: () => clock });
  const archive = n => zipWrite([{ name: 'application.json', bytes: enc.encode(`{"format": 1, "uid": "u-1", "name": "A ${n}"}`) }, { name: 'layout.json', bytes: enc.encode('{}') }]);
  for (let n = 1; n <= 3; n++) {
    clock += 61_000;
    const r = await ask(engine, 'POST', '/__applications/import?name=a.microfactory&existing=replace', { headers: CHAT, body: await archive(n) });
    assert.equal(r.status, 200);
    const kept = fs.dirs('.backups/applications');
    assert.equal(kept.length, 1, `after replace ${n}: ${kept.join(', ')}`);
    assert.equal(JSON.parse(await fs.readText(`.backups/applications/${kept[0]}/application.json`)).name, n === 1 ? 'A' : `A ${n - 1}`, 'the one that was here just before');
  }
  // another application's copy is not this one's to drop
  await fs.write('.backups/applications/a-2-20261127-100000/application.json', '{}');
  clock += 61_000;
  await ask(engine, 'POST', '/__applications/import?name=a.microfactory&existing=replace', { headers: CHAT, body: await archive(4) });
  assert.deepEqual(fs.dirs('.backups/applications').map(d => d.replace(/\d{8}-\d{6}$/, '')).sort(), ['a-', 'a-2-']);
});

test('a new application that fails half-way leaves nothing behind, and its name stays free', async () => {
  const store = quotaStore();
  const fs = createPageFs({ pack: SMALL, loadBin, store });
  const engine = createPageEngine({ fs, chat: fakeChat(), hold: 30 });
  await fs.ready;
  for (let n = 0; n < 3; n++) {                  // the kit's gripper, layout.json, application.json
    store.failAfter(n);
    const r = await post(engine, '/__applications/new', { name: 'New one', like: 'a' });
    assert.deepEqual([r.status, r.json()], [500, { error: 'QuotaExceededError' }], `failing at write ${n}`);
    store.failAfter(Infinity);
    assert.deepEqual(fs.list('applications/new-one'), [], `failing at write ${n}: a half-made application was left`);
    assert.deepEqual((await ask(engine, 'GET', '/__applications')).json().map(a => a.id), ['a']);
  }
  const r = await post(engine, '/__applications/new', { name: 'New one', like: 'a' });
  assert.deepEqual([r.status, r.json()], [200, { ok: true, id: 'new-one' }]);
  assert.deepEqual(fs.list('applications/new-one').map(p => p.slice('applications/new-one/'.length)), ['application.json', 'grippers/g/gripper.json', 'layout.json']);
});

test('an import is refused when it holds a file and a folder of one name, or declares more than an application may be — before anything is unpacked', async () => {
  const { fs, engine } = pageEngine(SMALL);
  const manifest = { name: 'application.json', bytes: enc.encode('{"format": 1, "name": "B"}') };
  const send = async entries => ask(engine, 'POST', '/__applications/import?name=b.microfactory&existing=ask', { headers: CHAT, body: await zipWrite(entries) });
  for (const pair of [['application.json/n.md', 'x'], ['notes/a.md', 'x', 'notes/a.md/deep/b.md', 'y'], ['./steps//one.ts', 'x', 'steps/one.ts/z.ts', 'y']]) {
    const more = [];
    for (let i = 0; i < pair.length; i += 2) more.push({ name: pair[i], bytes: enc.encode(pair[i + 1]) });
    const r = await send([manifest, ...more]);
    assert.equal(r.status, 400, pair[0]);
    assert.match(r.json().error, /^the file holds both a file and a folder named /);
  }
  assert.deepEqual(fs.dirs('applications'), ['a']);
  // 20 001 entries, by the directory's own count: refused without inflating one of them
  const many = await zipWrite([manifest, ...Array.from({ length: 20_000 }, (_, i) => ({ name: `n/${i}.txt`, bytes: new Uint8Array(0) }))]);
  const r = await ask(engine, 'POST', '/__applications/import?name=b.microfactory&existing=ask', { headers: CHAT, body: many });
  assert.deepEqual([r.status, r.json()], [400, { error: 'the file is too large to be an application' }]);
});
