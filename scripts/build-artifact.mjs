#!/usr/bin/env node
// Build microfactory as an ARTIFACT: the one that installs as a desktop
// app, or — with --share — the one that asks for no access to a computer
// and can be given to anyone.
//
//   node scripts/build-artifact.mjs [--out dist/artifact]
//   node scripts/build-artifact.mjs --share [--out dist/share]
//   … --dirty       build from a working tree that differs from its commit
//                   (see "only files TRACKED by git" below)
//
// What comes out, ready to hand to the Artifact tool (the /publish-app
// step does it — .claude/skills/publish-app/SKILL.md):
//
//   <out>/index.html          the page: the viewer's own markup and styles,
//                             the desktop manifest, the installed app's
//                             entry (viewer/desktop.js)
//   <out>/viewer/*.js         the viewer's modules, as they are
//   <out>/ws/files.json       the WORKSPACE PACK: every file a new workspace
//                             is made of — the local programs, the guides,
//                             the robot, the starter application(s) — text
//                             inline, meshes by reference
//   <out>/ws/b/<n>.txt        the meshes of the pack, as base64 text (artifacts
//                             serve text and no arbitrary binary files)
//   <out>/publish.json        the arguments of the publish call: file_path,
//                             files, capabilities, title, description, icon
//   <out>-report.txt          what went in, for a person to read
//
// The app is self-contained: installed, it makes its workspace from the
// pack (viewer/workspace-install.js) and needs no access to the
// repository. What may go in is decided here and nowhere else:
//
//  - only files TRACKED by git, so nothing local rides along (attachments,
//    conversations, backups, CAD that was never committed) — the viewer's
//    modules too: a viewer/*.js that git does not know (a scratch file, an
//    experiment) is left out. And the build is stamped with its commit, so
//    it should BE that commit: the shareable edition, whose link is given
//    to anyone, is refused when a file it carries differs from the commit
//    or a viewer module is untracked. --dirty builds anyway — untracked
//    viewer modules included, the stamp marked "+dirty" — for trying out
//    work that is not committed yet (the tests build that way);
//  - of applications/, only the starter ones named in artifact.json
//    ("starter") — an application is somebody's work and is not given
//    away by being committed;
//  - text files as text; meshes only when scripts/mesh-check.mjs accounts
//    for every byte as geometry; anything else stops the build;
//  - nothing third-party as code: three.js and MuJoCo's module come from
//    the CDN, the tools from npm when the workspace is made.
//
// THE SHAREABLE EDITION (--share) is the same page with another entry
// (viewer/share.js in place of viewer/desktop.js): no desktop manifest, no
// access to files or programs. Its pack is not installed anywhere — the
// page engine (viewer/page-engine.js) answers the viewer's requests from
// it — so it carries only what the page reads: the robot, the starter
// application(s), the guides and recipes, the step API types. No python,
// no scripts. Its meshes are gzip'd before the base64 (the page inflates
// them; it more than halves what a visitor downloads). And it carries ONE
// thing the other edition leaves to npm: MuJoCo's compiled physics
// (mujoco.wasm, from node_modules), because there is no workspace to
// install it into and a page may not fetch it from the CDN. The module
// that runs it still comes from the CDN, at exactly that version.
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, copyFileSync, statSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { checkMesh } from './mesh-check.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const oi = args.indexOf('--out');
const SHARE = args.includes('--share');
const DIRTY = args.includes('--dirty');
const OUT = join(ROOT, oi >= 0 ? args[oi + 1] : SHARE ? 'dist/share' : 'dist/artifact');
const REPORT = OUT.replace(/[\\/]+$/, '') + '-report.txt';
const fail = msg => { console.error(`build-artifact: ${msg}`); process.exit(1); };

// what the publish call may carry (the Artifact tool's limits)
const LIMITS = { files: 255, text: 16e6, binary: 15e6, total: 64e6 };
const TITLE = 'Microfactory';
const DESCRIPTION = SHARE
  ? 'A robot cell in a page: simulate it, run and reorder its steps, and work on it with an assistant — nothing to install, your changes stay in your browser.'
  : 'A robot cell on your computer: simulate it, program its steps and work on it with an assistant — installs as a desktop app.';
// the module the page starts with, and what each edition asks of the platform
const ENTRY = SHARE ? 'share.js' : 'desktop.js';
const CAPABILITIES = SHARE ? { sample: { images: true }, downloads: true } : { desktop: {} };
// the installed app's own modules: the shareable edition has no use for them and must not carry them
const DESKTOP_ONLY = ['desktop.js', 'workspace-install.js'];

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, 'viewer'), { recursive: true });
mkdirSync(join(OUT, 'ws/b'), { recursive: true });

// ---- what git knows ----
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' });
const lines = text => text.split('\n').filter(Boolean);
let knownModules = null, untrackedModules = [], changed = [];
try {
  knownModules = lines(git('ls-files', '--', 'viewer')).filter(f => /^viewer\/[^/]+\.js$/.test(f)).map(f => f.slice('viewer/'.length));
  untrackedModules = lines(git('ls-files', '--others', '--exclude-standard', '--', 'viewer')).filter(f => /^viewer\/[^/]+\.js$/.test(f)).map(f => f.slice('viewer/'.length));
  // tracked files whose content here is not the commit's (staged or not)
  changed = lines(git('diff', '--name-only', 'HEAD', '--'));
} catch { /* not a checkout: the pack below says so */ }

// ---- the viewer's modules, unchanged ----
const onDisk = readdirSync(join(ROOT, 'viewer')).filter(f => f.endsWith('.js'));
const modules = onDisk.filter(f => !knownModules || knownModules.includes(f) || (DIRTY && untrackedModules.includes(f)))
  .filter(f => !SHARE || !DESKTOP_ONLY.includes(f)).sort();
const leftOut = onDisk.filter(f => !modules.includes(f) && !(SHARE && DESKTOP_ONLY.includes(f)));
for (const f of modules) copyFileSync(join(ROOT, 'viewer', f), join(OUT, 'viewer', f));
if (!modules.includes(ENTRY)) fail(untrackedModules.includes(ENTRY)
  ? `viewer/${ENTRY} is not tracked by git: commit it, or build with --dirty to try out uncommitted work`
  : `viewer/${ENTRY} is missing`);

// ---- the page, from the viewer's own index.html (one source for both) ----
const html = readFileSync(join(ROOT, 'viewer/index.html'), 'utf8');
const pick = (re, what) => { const m = re.exec(html); if (!m) fail(`viewer/index.html: no ${what}`); return m[1]; };
const style = pick(/<style>([\s\S]*?)<\/style>/, '<style>');
const importmap = pick(/<script type="importmap">([\s\S]*?)<\/script>/, 'import map');
const body = pick(/<body>([\s\S]*?)<\/body>/, '<body>')
  .replace(/<script type="module" src="\.\/[\w.-]+"><\/script>\s*/g, '');      // app.js and chat.js: the entry loads them
if (/<script/.test(body)) fail('viewer/index.html: a script in <body> that the build does not know');

let commit = 'unknown';
try { commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(); } catch { /* not a checkout */ }
const built = new Date().toISOString().slice(0, 16).replace('T', ' ');
// (what differs from the commit, among the files this build carries, is worked out once the pack is listed)

// ---- the workspace pack ----
let starter = [];
try { starter = JSON.parse(readFileSync(join(ROOT, 'artifact.json'), 'utf8')).starter ?? []; } catch { /* none */ }
// (LICENSE names its holder, a person: it stays in the repository)
const LEFT_OUT = [/^\.claude\//, /^docs\//, /^artifact\.json$/, /^README\.md$/, /^LICENSE$/];
const PACK_TEXT = /(\.(js|mjs|ts|py|json|md|sh|html|txt)|^LICENSE|^\.gitignore)$/;
// the shareable edition's pack: what the page itself reads, and nothing that needs a computer
const SHARE_KEEPS = [/^cell_fr3\//, /^applications\//, /^guides\//, /^recipes\//, /^viewer\/cell\.d\.ts$/];
const tracked = execFileSync('git', ['ls-files', '-s'], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n')
  .map(l => { const [mode, , , ...path] = l.split(/\s+/); return { mode, path: path.join(' ') }; })
  .filter(f => !LEFT_OUT.some(re => re.test(f.path)))
  .filter(f => !SHARE || SHARE_KEEPS.some(re => re.test(f.path)))
  .filter(f => !f.path.startsWith('applications/') || starter.includes(f.path.split('/')[1]))
  .filter(f => existsSync(join(ROOT, f.path)));
for (const id of starter) if (!tracked.some(f => f.path === `applications/${id}/application.json`)) fail(`starter application '${id}' is not in the repository`);
// (the installed app can start with no application and make one; a page with none has nothing to open)
if (SHARE && !starter.length) fail('the shareable edition needs a starter application: name one in artifact.json ("starter")');
// ---- is this build its commit? ----
const carriedPaths = new Set([...tracked.map(f => f.path), ...modules.map(f => `viewer/${f}`), 'viewer/index.html']);
// (an untracked module counts where it is carried, --dirty, and where it must stop the build, --share)
const strays = SHARE || DIRTY ? untrackedModules.filter(f => !SHARE || !DESKTOP_ONLY.includes(f)) : [];
const differs = [...changed.filter(f => carriedPaths.has(f)), ...strays.map(f => `viewer/${f} (untracked)`)].sort();
if (differs.length) {
  if (SHARE && !DIRTY) fail(`the working tree is not commit ${commit} — the shareable edition is given to anyone and must be exactly its commit:\n  ${differs.join('\n  ')}\ncommit these (or remove what should not go), or build with --dirty to try out uncommitted work`);
  commit += '+dirty';
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const pack = { version: '', files: [] };
const report = [];
let bins = 0;
const carried = new Map();      // sha -> the file that carries it
for (const f of tracked) {
  const bytes = readFileSync(join(ROOT, f.path));
  const entry = { path: f.path, sha: sha(bytes), size: bytes.length };
  if (f.mode === '100755') entry.exec = true;
  if (/\.(glb|stl)$/.test(f.path)) {
    let info;
    try { info = checkMesh(f.path, new Uint8Array(bytes)); } catch (e) { fail(`${f.path}: ${e.message} — a mesh must be geometry only (scripts/clean-mesh.mjs strips a GLB)`); }
    // the same mesh in two places (a kit gripper and its copy in an application) is carried once
    if (!carried.has(entry.sha)) {
      carried.set(entry.sha, `ws/b/${bins++}.txt`);
      writeFileSync(join(OUT, carried.get(entry.sha)), (SHARE ? gzipSync(bytes, { level: 9 }) : bytes).toString('base64'));
    }
    entry.bin = carried.get(entry.sha);
    if (SHARE) entry.enc = 'gzip';
    const mm = info.bounds[1].map((h, k) => Math.round((h - info.bounds[0][k]) * 1000));
    report.push(`mesh  ${f.path}  ${info.triangles} triangles, ${mm.join(' x ')} mm${info.text.length ? '  text: ' + JSON.stringify(info.text) : ''}`);
  } else if (PACK_TEXT.test(f.path)) {
    try { entry.text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail(`${f.path} is not text`); }
    if (entry.text.includes(homedir())) fail(`${f.path} contains this computer's home folder path`);
    report.push(`text  ${f.path}  ${bytes.length} bytes`);
  } else fail(`${f.path} is neither text nor a mesh: the app may not carry it`);
  pack.files.push(entry);
}
// the pack's version is its content: two builds of the same files are the same version
pack.version = sha(pack.files.map(f => `${f.path} ${f.sha}`).join('\n')).slice(0, 12);
// ---- MuJoCo's compiled physics, in the shareable edition only ----
// Not a file of the workspace (it stays out of pack.files): the page engine
// answers the two addresses the viewer asks MuJoCo at from this record.
if (SHARE) {
  const MJ = join(ROOT, 'node_modules/@mujoco/mujoco');
  let version, wasm;
  try {
    version = JSON.parse(readFileSync(join(MJ, 'package.json'), 'utf8')).version;
    wasm = readFileSync(join(MJ, 'mujoco.wasm'));
  } catch { fail('MuJoCo is not installed here: run `npm install`, then build again'); }
  // the page imports the module from the CDN at this version: it must be one exact version, the one the lock file names
  if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`unexpected MuJoCo version ${version}`);
  let pinned = null;
  try { pinned = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')).packages?.['node_modules/@mujoco/mujoco']?.version ?? null; } catch { /* no lock file */ }
  if (pinned && pinned !== version) fail(`node_modules has MuJoCo ${version}, package-lock.json names ${pinned}: run \`npm install\``);
  const text = gzipSync(wasm, { level: 9 }).toString('base64');
  pack.mujoco = { version, wasm: 'ws/mujoco.wasm.txt', enc: 'gzip', sha: sha(wasm), size: wasm.length };
  if (sha(gunzipSync(Buffer.from(text, 'base64'))) !== pack.mujoco.sha) fail('mujoco.wasm did not survive its packing');
  writeFileSync(join(OUT, pack.mujoco.wasm), text);
  report.push(`wasm  node_modules/@mujoco/mujoco/mujoco.wasm  ${wasm.length} bytes, MuJoCo ${version} — the one third-party file carried`);
  // nothing that needs a computer may ride in this pack
  const stray = pack.files.find(f => /\.py$|^scripts\/|^test\//.test(f.path));
  if (stray) fail(`${stray.path} is in the shareable pack: it carries only what the page reads`);
}
writeFileSync(join(OUT, 'ws/files.json'), JSON.stringify(pack));
writeFileSync(REPORT, `workspace pack ${pack.version} — ${pack.files.length} files\n` + report.join('\n') + '\n');

// The Artifact tool wraps this in its own <!doctype html>…<body>: no html,
// head or body tags here; the title and the styles come first.
const page = `<title>${TITLE}</title>
<style>
/* the app commits to one dark look */
:root { color-scheme: dark; }
${style.trim()}
</style>
${SHARE ? '' : '<script type="application/json" id="claude-artifacts-manifest">{"permissions": ["full-access"]}</script>\n'}<script>window.MICROFACTORY_BUILD = ${JSON.stringify({ commit, built, pack: pack.version, ...(SHARE ? { edition: 'share' } : {}) })};</script>
<script type="importmap">${importmap.trim()}</script>
${body.trim()}
<script type="module" src="./viewer/${ENTRY}"></script>
`;
writeFileSync(join(OUT, 'index.html'), page);

// ---- check what is going out ----
const all = [];
const walk = d => { for (const e of readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(join(d, e.name)) : all.push(join(d, e.name)); };
walk(OUT);
const supporting = all.filter(f => f !== join(OUT, 'index.html')).sort();
const TEXT = /\.(js|html|json|css|md|txt)$/;
const MAY_CARRY = SHARE
  ? /^(index\.html|viewer\/[\w.-]+\.js|ws\/files\.json|ws\/b\/\d+\.txt|ws\/mujoco\.wasm\.txt)$/
  : /^(index\.html|viewer\/[\w.-]+\.js|ws\/files\.json|ws\/b\/\d+\.txt)$/;
let total = 0;
for (const f of all) {
  const size = statSync(f).size, rel = relative(OUT, f);
  total += size;
  if (!MAY_CARRY.test(rel)) fail(`${rel} is not something the artifact may carry`);
  if (size > (TEXT.test(f) ? LIMITS.text : LIMITS.binary)) fail(`${rel} is ${(size / 1e6).toFixed(1)} MB: over the limit for one file`);
  if (TEXT.test(f)) {
    const text = readFileSync(f, 'utf8');
    // nothing of this machine or its owner may ride along
    if (text.includes(homedir())) fail(`${rel} contains this computer's home folder path`);
  }
}
if (supporting.length + 1 > LIMITS.files) fail(`${supporting.length + 1} files: over the limit of ${LIMITS.files}`);
if (total > LIMITS.total) fail(`${(total / 1e6).toFixed(1)} MB in all: over the limit of ${LIMITS.total / 1e6} MB`);

// every import in the shipped modules must be one the page can load:
// a module shipped beside it, a name in the import map, or the CDN
const names = Object.keys(JSON.parse(importmap).imports);
for (const f of modules) {
  // (comments aside: a JSDoc type may name a .d.ts the page never loads)
  const text = readFileSync(join(OUT, 'viewer', f), 'utf8').split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  for (const m of text.matchAll(/(?:^|\n)\s*import\s[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const spec = m[1] ?? m[2];
    const ok = spec.startsWith('./') ? modules.includes(spec.slice(2))
      : names.some(n => (n.endsWith('/') ? spec.startsWith(n) : spec === n)) || spec.startsWith('https://cdn.jsdelivr.net/npm/');
    if (!ok) fail(`viewer/${f} imports '${spec}', which the installed page cannot load`);
  }
}

// ---- what only the shareable edition must hold to ----
if (SHARE) {
  const code = f => readFileSync(join(OUT, 'viewer', f), 'utf8').split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  // it asks for no access to the computer: no desktop manifest, none of the installed app's modules
  // (the import check above has already proved that nothing shipped imports them)
  if (/claude-artifacts-manifest|full-access/.test(page)) fail('the shareable page carries the desktop manifest');
  for (const f of DESKTOP_ONLY) if (existsSync(join(OUT, 'viewer', f))) fail(`viewer/${f} is the installed app's: the shareable edition must not carry it`);
  for (const f of modules) if (/claude-artifacts-manifest|full-access|use\(\s*['"]desktop['"]\s*\)/.test(code(f))) fail(`viewer/${f} asks for access to the computer`);
  // every request the viewer makes of its server is one the page engine answers
  // (a literal may be the start of an address put together in the code: '/__chat/' + action)
  const { ROUTES } = await import(new URL('../viewer/page-engine.js', import.meta.url).href);
  for (const f of modules) for (const m of code(f).matchAll(/['"`](\/__[a-z]+(?:\/[a-z]+)*)/g))
    if (!ROUTES.includes(m[1]) && !ROUTES.some(r => r.startsWith(m[1] + '/'))) fail(`viewer/${f} requests ${m[1]}, which the page engine does not answer`);
  // code from the CDN is named at one exact version (or one read at run time and checked there: MuJoCo's)
  for (const [where, text] of [['the import map', importmap], ...modules.map(f => [`viewer/${f}`, code(f)])])
    for (const m of text.matchAll(/https:\/\/cdn\.jsdelivr\.net\/npm\/[^'"`\s)]*/g))
      if (!/\/npm\/(@[\w.-]+\/)?[\w.-]+@(\d+\.\d+\.\d+(\/|$)|\$\{)/.test(m[0])) fail(`${where} loads ${m[0]} without naming an exact version`);
}

// ---- the publish call, as data ----
const rel = f => relative(ROOT, f).split('\\').join('/');
const publish = {
  file_path: rel(join(OUT, 'index.html')),
  files: Object.fromEntries(supporting.map(f => [relative(OUT, f).split('\\').join('/'), rel(f)])),
  capabilities: CAPABILITIES,
  title: TITLE,
  description: DESCRIPTION,
  icon: 'robot',
  build: { commit, built, pack: pack.version },
};
writeFileSync(join(OUT, 'publish.json'), JSON.stringify(publish, null, 1) + '\n');

console.log(`built ${rel(OUT)}: the page + ${supporting.length} files, ${(total / 1e6).toFixed(1)} MB (commit ${commit}); workspace pack ${pack.version}, ${pack.files.length} files — listed in ${rel(REPORT)}`);
console.log(`publish with the arguments in ${rel(join(OUT, 'publish.json'))}`);
if (leftOut.length) console.log(`left out, not tracked by git: ${leftOut.map(f => `viewer/${f}`).join(', ')} (--dirty takes them in)`);
if (differs.length) console.log(`NOT the commit it is stamped with (${commit}) — ${differs.length} file(s) differ: ${differs.join(', ')}`);
