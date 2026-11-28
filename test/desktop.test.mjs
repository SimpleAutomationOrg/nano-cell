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
import { startEngine, engineFetch, repoPath, toBase64, fromBase64, absolutePath, setupSteps } from '../viewer/desktop-bridge.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

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
    const agent = await (await fetch2('/__chat/agent', { headers: { 'X-Nano-Cell': 'chat' } })).json();
    assert.ok(agent.name && agent.hint);
    const bad = await fetch2('/__loop/save', { method: 'POST', headers: { 'X-Nano-Cell': 'chat', 'Content-Type': 'application/json' }, body: JSON.stringify({ app: 'no-such-app', steps: [] }) });
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

test('the build puts the page and its code in the artifact — and nothing of the project', () => {
  const out = mkdtempSync(join(ROOT, 'dist-test-'));
  try {
    const rel = out.slice(ROOT.length);
    const said = execFileSync('node', ['scripts/build-artifact.mjs', '--out', rel], { cwd: ROOT, encoding: 'utf8' });
    assert.match(said, /the page \+ \d+ files/);
    const page = readFileSync(join(out, 'index.html'), 'utf8');
    // the Artifact tool wraps the page itself: no document tags of our own, the title first
    assert.ok(page.startsWith('<title>Nano Cell</title>'), 'the title comes first');
    assert.ok(!/<!doctype|<html|<head|<body/i.test(page), 'the page must not carry its own document tags');
    assert.match(page, /<script type="application\/json" id="claude-artifacts-manifest">\{"permissions": \["full-access"\]\}<\/script>/, 'the desktop manifest');
    assert.ok(page.indexOf('type="importmap"') < page.indexOf('type="module"'), 'the import map must come before the first module');
    assert.match(page, /<script type="module" src="\.\/viewer\/desktop\.js"><\/script>\s*$/, 'the installed app\'s entry, and only it');
    assert.ok(!/src="\.\/app\.js"|src="\.\/chat\.js"/.test(page), 'app.js and chat.js are loaded by desktop.js, after the engine is up');
    // what the publish call carries
    const publish = JSON.parse(readFileSync(join(out, 'publish.json'), 'utf8'));
    assert.deepEqual(publish.capabilities, { desktop: {} });
    assert.equal(publish.title, 'Nano Cell');
    const names = Object.keys(publish.files).sort();
    assert.ok(names.includes('viewer/desktop.js') && names.includes('viewer/app.js') && names.includes('viewer/desktop-bridge.js'));
    for (const [name, from] of Object.entries(publish.files)) {
      assert.match(name, /^viewer\/[\w.-]+\.js$/, `${name} is not page code written here`);
      assert.ok(existsSync(join(ROOT, from)), `${from} was not built`);
    }
    // nothing of the project or of this machine: no cell, no applications, no agents, no engine, no paths
    const all = [];
    const walk = d => { for (const e of readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(join(d, e.name)) : all.push(join(d, e.name)); };
    walk(out);
    assert.ok(all.every(f => !/\.(py|glb|stl|step|md|ts|wasm)$/i.test(f)), 'engine code, meshes, CAD, notes or third-party binaries got into the artifact');
    for (const f of all.filter(f => /\.(js|html|json)$/.test(f))) assert.ok(!readFileSync(f, 'utf8').includes(homedir()), `${f} names this computer's home folder`);
    const total = all.reduce((s, f) => s + statSync(f).size, 0);
    assert.ok(total < 64e6 && all.length <= 255, 'over the publish limits');
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('the viewer opens no browser dialogs: they do nothing in the installed app', () => {
  for (const f of readdirSync(join(ROOT, 'viewer')).filter(f => f.endsWith('.js'))) {
    const code = readFileSync(join(ROOT, 'viewer', f), 'utf8').split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n');
    assert.ok(!/(^|[^\w.])(prompt|confirm|alert)\(/.test(code), `viewer/${f} calls prompt(), confirm() or alert(): use viewer/dialogs.js`);
  }
});

test('a workspace is made where there is none: the typed path becomes absolute, and the download puts the engine there', () => {
  assert.equal(absolutePath('~/microfactory', '/Users/x'), '/Users/x/microfactory');
  assert.equal(absolutePath('~', '/Users/x/'), '/Users/x');
  assert.equal(absolutePath('work/cell/', '/Users/x'), '/Users/x/work/cell');
  assert.equal(absolutePath('/opt/cell//', '/Users/x'), '/opt/cell');

  // the real first step, from this checkout standing in for the remote, into a folder with a space and a quote in its name
  const tmp = mkdtempSync(join(tmpdir(), 'nano-ws-'));
  try {
    const dir = join(tmp, "my cell's place");
    const steps = setupSteps('file://' + ROOT.replace(/\/$/, ''), dir);
    assert.equal(steps.length, 2);
    execFileSync('/bin/sh', ['-c', steps[0].command], { stdio: 'pipe' });
    for (const f of ['viewer/serve.py', 'viewer/cell-data.js', 'cell_fr3/robot.json', 'guides/agent.md', 'package.json'])
      assert.ok(existsSync(join(dir, f)), f);
    assert.match(steps[1].command, /npm install/);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
