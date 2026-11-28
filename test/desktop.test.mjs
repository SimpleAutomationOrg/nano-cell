// The installed desktop app (an artifact page): how its page reaches the
// engine through a child process's pipes, and what the build puts in the
// artifact. The desktop API itself exists only in the installed app; here
// its childProcess.spawn is stood in for by node's own, running the real
// engine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync, rmSync, readdirSync, statSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as nodeFs from 'node:fs/promises';
import { installWorkspace, MARKER } from '../viewer/workspace-install.js';
import { startEngine, engineFetch, repoPath, toBase64, fromBase64, absolutePath, chmodCommand, toolsCommand } from '../viewer/desktop-bridge.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
// the engines started here must not take over the port file of a server the developer is running
process.env.MICROFACTORY_NO_PORT_FILE = '1';

// node's child process, in the shape the desktop API gives one
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

test('which requests go to the engine: the viewer\'s addresses become repository paths, shipped files and other hosts do not', () => {
  for (const page of ['https://abc.example/', 'https://abc.example/index.html', 'https://host.example/a/xyz/', 'https://host.example/a/xyz/index.html']) {
    const dir = new URL('.', page).href;
    // as written in the viewer (a page at /viewer/ of the repository)
    assert.equal(repoPath('../cell_fr3/robot.json', page), '/cell_fr3/robot.json');
    assert.equal(repoPath('/__steps?app=case-assembly', page), '/__steps?app=case-assembly');
    assert.equal(repoPath('/applications/x/steps/a.ts?v=1', page), '/applications/x/steps/a.ts?v=1');
    assert.equal(repoPath('../applications/x/items/y/y.glb', page), '/applications/x/items/y/y.glb');
    // the same addresses once a loader has made them absolute against the real page
    assert.equal(repoPath({ url: new URL('../cell_fr3/robot.json', page).href }, page), '/cell_fr3/robot.json', page);
    assert.equal(repoPath(new URL('/__chat/agent', page).href, page), '/__chat/agent');
    // the page's own files, the CDN and in-memory addresses stay on the network
    assert.equal(repoPath(dir + 'viewer/app.js', page), null);
    // MuJoCo's compiled physics is read from the workspace, like any file of it
    assert.equal(repoPath('/node_modules/@mujoco/mujoco/mujoco.wasm', page), '/node_modules/@mujoco/mujoco/mujoco.wasm');
    assert.equal(repoPath('https://cdn.jsdelivr.net/npm/sucrase@3.35.0/+esm', page), null);
    assert.equal(repoPath('blob:https://abc.example/1234', page), null);
    assert.equal(repoPath('data:text/plain,hi', page), null);
  }
});

test('bytes survive the pipe encoding, megabytes of them', () => {
  const bytes = new Uint8Array(3_000_001);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 255;
  const back = fromBase64(toBase64(bytes));
  assert.equal(back.length, bytes.length);
  assert.ok(back.every((v, i) => v === bytes[i]));
});

test('the page talks to the real engine through its pipes: files, the API, binary meshes, many at once, aborts', async () => {
  const engine = startEngine(desktopSpawn, ROOT, process.platform);
  try {
    const ready = await engine.ready;
    assert.equal(ready.ready, true);
    let network = 0;
    const fetch2 = engineFetch(engine, async () => { network++; return new Response('from the network'); }, { pageUrl: 'https://host.example/a/xyz/' });

    const apps = await (await fetch2('/__applications')).json();
    assert.ok(apps.some(a => a.id === 'case-assembly'), 'the engine lists the applications');
    const robot = await (await fetch2('../cell_fr3/robot.json')).json();
    assert.ok(robot.arm && robot.table, 'a file of the workspace, as the viewer asks for it');

    // a binary mesh arrives byte for byte
    const rel = 'applications/case-assembly/items/holder/holder.glb';
    const got = new Uint8Array(await (await fetch2('../' + rel)).arrayBuffer());
    assert.deepEqual(Buffer.from(got), readFileSync(join(ROOT, rel)), 'the mesh changed on the way');

    // the chat's endpoints need its header, as in a browser
    assert.equal((await fetch2('/__chat/agent')).status, 403);
    const agent = await (await fetch2('/__chat/agent', { headers: { 'X-Microfactory': 'chat' } })).json();
    assert.ok(agent.name && agent.hint);
    const bad = await fetch2('/__loop/save', { method: 'POST', headers: { 'X-Microfactory': 'chat', 'Content-Type': 'application/json' }, body: JSON.stringify({ app: 'no-such-app', steps: [] }) });
    assert.equal(bad.status, 400, 'a POST with a body reaches the engine');
    assert.equal((await fetch2('/no/such/file.json')).status, 404);

    // requests do not wait for one another: answers are matched to their questions
    const many = await Promise.all(Array.from({ length: 24 }, (_, i) =>
      fetch2(i % 2 ? '/__applications' : '../cell_fr3/robot.json').then(r => r.json())));
    many.forEach((m, i) => assert.equal(Array.isArray(m), i % 2 === 1, `answer ${i} went to the wrong request`));

    // a request can be dropped (the chat's long poll is, when another agent is picked)
    const ctl = new AbortController();
    const waiting = fetch2('/__reload?gen=99999999999', { signal: ctl.signal });
    ctl.abort();
    await assert.rejects(waiting, { name: 'AbortError' });

    // the page's own files and the CDN are not sent to the engine
    await fetch2('https://host.example/a/xyz/viewer/app.js');
    await fetch2('https://cdn.jsdelivr.net/npm/sucrase@3.35.0/+esm');
    assert.equal(network, 2);
  } finally {
    for (const k of kids) k.kill();
  }
});

test('an engine that cannot start says why, and requests then fail with that instead of hanging', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'no-engine-'));
  try {
    const engine = startEngine(desktopSpawn, dir, process.platform);        // no viewer/serve.py in there
    await assert.rejects(engine.ready, /the engine stopped \(exit \d+\)/);
    const r = await engineFetch(engine, fetch, { pageUrl: 'https://x.example/' })('/__applications');
    assert.equal(r.status, 502);
    assert.match((await r.json()).error, /the engine stopped/);
  } finally { rmSync(dir, { recursive: true, force: true }); for (const k of kids) k.kill(); }
});

// The build and the pack are made from the repository (git says what is
// tracked): in a workspace the app installed there is nothing to build.
const CHECKOUT = existsSync(join(ROOT, '.git'));

// node's fs in the shape the desktop API gives one
const desktopFs = {
  exists: async p => existsSync(p),
  readFile: async (p, enc) => (enc ? nodeFs.readFile(p, enc) : new Uint8Array(await nodeFs.readFile(p))),
  writeFile: (p, data) => nodeFs.writeFile(p, data),
  mkdir: (p, o) => nodeFs.mkdir(p, o),
};

test('the build puts the page and a workspace pack in the artifact — tracked files of the starter only, meshes that are geometry and nothing else', { skip: !CHECKOUT }, () => {
  const out = mkdtempSync(join(ROOT, 'dist-test-'));
  try {
    const rel = out.slice(ROOT.length);
    const said = execFileSync('node', ['scripts/build-artifact.mjs', '--out', rel], { cwd: ROOT, encoding: 'utf8' });
    assert.match(said, /the page \+ \d+ files/);
    const page = readFileSync(join(out, 'index.html'), 'utf8');
    // the Artifact tool wraps the page itself: no document tags of our own, the title first
    assert.ok(page.startsWith('<title>Microfactory</title>'), 'the title comes first');
    assert.ok(!/<!doctype|<html|<head|<body/i.test(page), 'the page must not carry its own document tags');
    assert.match(page, /<script type="application\/json" id="claude-artifacts-manifest">\{"permissions": \["full-access"\]\}<\/script>/, 'the desktop manifest');
    assert.ok(page.indexOf('type="importmap"') < page.indexOf('type="module"'), 'the import map must come before the first module');
    assert.match(page, /<script type="module" src="\.\/viewer\/desktop\.js"><\/script>\s*$/, 'the installed app\'s entry, and only it');
    assert.ok(!/src="\.\/app\.js"|src="\.\/chat\.js"/.test(page), 'app.js and chat.js are loaded by desktop.js, after the engine is up');
    // what the publish call carries
    const publish = JSON.parse(readFileSync(join(out, 'publish.json'), 'utf8'));
    assert.deepEqual(publish.capabilities, { desktop: {} });
    assert.equal(publish.title, 'Microfactory');
    const names = Object.keys(publish.files).sort();
    assert.ok(names.includes('viewer/desktop.js') && names.includes('viewer/app.js') && names.includes('ws/files.json'));
    for (const [name, from] of Object.entries(publish.files)) {
      assert.match(name, /^(viewer\/[\w.-]+\.js|ws\/files\.json|ws\/b\/\d+\.txt)$/, `${name} is not something the app carries`);
      assert.ok(existsSync(join(ROOT, from)), `${name} was not built`);
    }
    // the pack: only what git tracks, only the starter application, nothing local
    const pack = JSON.parse(readFileSync(join(out, 'ws/files.json'), 'utf8'));
    const tracked = new Set(execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n'));
    const starter = JSON.parse(readFileSync(join(ROOT, 'artifact.json'), 'utf8')).starter;
    for (const f of pack.files) {
      assert.ok(tracked.has(f.path), `${f.path} is not tracked`);
      assert.ok(!/(^|\/)(materials|chats|print|\.backups|\.claude|node_modules)\//.test(f.path) && !/\.(step|stp|wasm)$/i.test(f.path), `${f.path} must not be given away`);
      if (f.path.startsWith('applications/')) assert.ok(starter.includes(f.path.split('/')[1]), `${f.path}: not a starter application`);
      assert.ok(('text' in f) !== ('bin' in f), f.path);
      if (f.text) assert.ok(!f.text.includes(homedir()), `${f.path} names this computer's home folder`);
    }
    for (const need of ['viewer/serve.py', 'viewer/chat.py', 'guides/agent.md', 'cell_fr3/robot.json', 'cell_fr3/arm/meshes/base_link.glb', 'package.json', 'scripts/check.sh', 'applications/case-assembly/application.json'])
      assert.ok(pack.files.some(f => f.path === need), `${need} is missing from the pack`);
    assert.ok(pack.files.find(f => f.path === 'scripts/check.sh').exec, 'check.sh must stay runnable');
    const all = [];
    const walk = d => { for (const e of readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(join(d, e.name)) : all.push(join(d, e.name)); };
    walk(out);
    const total = all.reduce((s, f) => s + statSync(f).size, 0);
    assert.ok(total < 64e6 && all.length <= 255, 'over the publish limits');
  } finally { rmSync(out, { recursive: true, force: true }); rmSync(out + '-report.txt', { force: true }); }
});

test('a mesh with anything but geometry in it is refused; cleaning a GLB keeps its shape', async () => {
  const { checkGlb, checkStl } = await import('../scripts/mesh-check.mjs');
  const { cleanGlb } = await import('../scripts/clean-mesh.mjs');
  const glb = new Uint8Array(readFileSync(join(ROOT, 'cell_fr3/arm/meshes/base_link.glb')));
  const ok = checkGlb(glb);
  assert.ok(ok.triangles > 100);
  // the same file with a note slipped into it
  const n = new DataView(glb.buffer).getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + n)));
  json.meshes[0].extras = { note: 'hello' }; json.nodes[0].name = 'secret part';
  const text = new TextEncoder().encode(JSON.stringify(json) + '   '.slice(0, (4 - JSON.stringify(json).length % 4) % 4));
  const noted = new Uint8Array(20 + text.length + glb.length - 20 - n);
  noted.set(glb.subarray(0, 20)); noted.set(text, 20); noted.set(glb.subarray(20 + n), 20 + text.length);
  const dv = new DataView(noted.buffer); dv.setUint32(8, noted.length, true); dv.setUint32(12, text.length, true);
  assert.throws(() => checkGlb(noted), /extras/);
  const cleaned = checkGlb(cleanGlb(noted));
  assert.deepEqual([cleaned.triangles, cleaned.bounds, cleaned.text], [ok.triangles, ok.bounds, ['microfactory']]);
  // bytes after the end, and an STL with bytes attached to a triangle
  const longer = new Uint8Array(glb.length + 4); longer.set(glb);
  assert.throws(() => checkGlb(longer));
  const stl = new Uint8Array(readFileSync(join(ROOT, 'cell_fr3/meshes/adapter.collision.stl')));
  assert.ok(checkStl(stl).triangles > 10);
  const marked = stl.slice(); marked[84 + 48] = 7;
  assert.throws(() => checkStl(marked), /extra bytes/);
});

test('the app makes its workspace from the pack, the engine starts in it, and an update keeps what the person changed', { skip: !CHECKOUT }, async () => {
  const out = mkdtempSync(join(ROOT, 'dist-test-'));
  const tmp = mkdtempSync(join(tmpdir(), 'mf-ws-'));
  try {
    execFileSync('node', ['scripts/build-artifact.mjs', '--out', out.slice(ROOT.length)], { cwd: ROOT, encoding: 'utf8' });
    const pack = JSON.parse(readFileSync(join(out, 'ws/files.json'), 'utf8'));
    const load = async e => fromBase64(readFileSync(join(out, e.bin), 'utf8'));
    const dir = join(tmp, "my cell's place");
    const first = await installWorkspace({ fs: desktopFs, load, dir, pack });
    assert.ok(first.fresh && first.tools && first.written.length === pack.files.length);
    assert.deepEqual(first.exec, ['scripts/check.sh']);
    // every file arrived as it is in the repository
    for (const f of pack.files) assert.ok(readFileSync(join(dir, f.path)).equals(readFileSync(join(ROOT, f.path))), f.path);
    execFileSync('/bin/sh', ['-c', chmodCommand(dir, first.exec)]);
    assert.ok(statSync(join(dir, 'scripts/check.sh')).mode & 0o100);
    assert.match(toolsCommand(dir), /npm install/);

    // the engine runs there and serves the starter application
    const engine = startEngine(desktopSpawn, dir, process.platform);
    await engine.ready;
    const fetchIt = engineFetch(engine, fetch, { pageUrl: 'https://abc.example/' });
    const apps = await (await fetchIt('/__applications')).json();
    assert.deepEqual(apps.map(a => a.id), ['case-assembly']);
    assert.equal((await fetchIt('../cell_fr3/arm/meshes/base_link.glb')).status, 200);
    engine.stop?.();

    // the same version again: nothing to do
    assert.ok((await installWorkspace({ fs: desktopFs, load, dir, pack })).upToDate);

    // a newer app: one guide and one program changed, a file added. The person had edited the guide
    // of buying, made an application of their own, and deleted nothing.
    await nodeFs.writeFile(join(dir, 'guides/buying.md'), 'my own way of buying\n');
    await nodeFs.mkdir(join(dir, 'applications/mine'), { recursive: true });
    await nodeFs.writeFile(join(dir, 'applications/mine/application.json'), '{}');
    const enc = new TextEncoder();
    const { sha256 } = await import('../viewer/workspace-install.js');
    const change = async (f, text) => ({ ...f, text, sha: await sha256(enc.encode(text)) });
    const next = { version: 'next', files: await Promise.all(pack.files.map(f =>
      f.path === 'guides/buying.md' ? change(f, 'the new guide of buying\n')
        : f.path === 'viewer/serve.py' ? change(f, f.text + '\n# newer\n') : f)) };
    next.files.push(await change({ path: 'guides/welding.md' }, 'a new guide\n'));
    const up = await installWorkspace({ fs: desktopFs, load, dir, pack: next });
    assert.deepEqual(up.written.sort(), ['guides/welding.md', 'viewer/serve.py']);
    assert.deepEqual(up.kept, ['guides/buying.md']);
    assert.ok(!up.tools, 'the tools did not change');
    assert.equal(readFileSync(join(dir, 'guides/buying.md'), 'utf8'), 'my own way of buying\n');
    assert.ok(readFileSync(join(dir, 'viewer/serve.py'), 'utf8').endsWith('# newer\n'));
    assert.ok(existsSync(join(dir, 'applications/mine/application.json')));
    assert.equal(JSON.parse(readFileSync(join(dir, MARKER), 'utf8')).version, 'next');

    // the starter application, deleted by the person, is not brought back by the next update
    rmSync(join(dir, 'applications/case-assembly'), { recursive: true });
    const later = await installWorkspace({ fs: desktopFs, load, dir, pack: { ...next, version: 'later' } });
    assert.ok(!existsSync(join(dir, 'applications/case-assembly')) && later.written.length === 0);
  } finally {
    for (const k of kids) k.kill();
    rmSync(out, { recursive: true, force: true }); rmSync(out + '-report.txt', { force: true }); rmSync(tmp, { recursive: true, force: true });
  }
});

test('the viewer opens no browser dialogs: they do nothing in the installed app', () => {
  for (const f of readdirSync(join(ROOT, 'viewer')).filter(f => f.endsWith('.js'))) {
    const code = readFileSync(join(ROOT, 'viewer', f), 'utf8').split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n');
    assert.ok(!/(^|[^\w.])(prompt|confirm|alert)\(/.test(code), `viewer/${f} calls prompt(), confirm() or alert(): use viewer/dialogs.js`);
  }
});

test('the folder the person types becomes an absolute path', () => {
  assert.equal(absolutePath('~/microfactory', '/Users/x'), '/Users/x/microfactory');
  assert.equal(absolutePath('~', '/Users/x/'), '/Users/x');
  assert.equal(absolutePath('work/cell/', '/Users/x'), '/Users/x/work/cell');
  assert.equal(absolutePath('/opt/cell//', '/Users/x'), '/opt/cell');
});
