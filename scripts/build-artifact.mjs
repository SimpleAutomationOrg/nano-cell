#!/usr/bin/env node
// Build microfactory as an ARTIFACT that installs as a desktop app.
//
//   node scripts/build-artifact.mjs [--out dist/artifact]
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
//    conversations, backups, CAD that was never committed);
//  - of applications/, only the starter ones named in artifact.json
//    ("starter") — an application is somebody's work and is not given
//    away by being committed;
//  - text files as text; meshes only when scripts/mesh-check.mjs accounts
//    for every byte as geometry; anything else stops the build;
//  - nothing third-party as code: three.js and MuJoCo's module come from
//    the CDN, the tools from npm when the workspace is made.
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, copyFileSync, statSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { checkMesh } from './mesh-check.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const oi = args.indexOf('--out');
const OUT = join(ROOT, oi >= 0 ? args[oi + 1] : 'dist/artifact');
const REPORT = OUT.replace(/[\\/]+$/, '') + '-report.txt';
const fail = msg => { console.error(`build-artifact: ${msg}`); process.exit(1); };

// what the publish call may carry (the Artifact tool's limits)
const LIMITS = { files: 255, text: 16e6, binary: 15e6, total: 64e6 };
const TITLE = 'Microfactory';
const DESCRIPTION = 'A robot cell on your computer: simulate it, program its steps and work on it with an assistant — installs as a desktop app.';

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, 'viewer'), { recursive: true });
mkdirSync(join(OUT, 'ws/b'), { recursive: true });

// ---- the viewer's modules, unchanged ----
const modules = readdirSync(join(ROOT, 'viewer')).filter(f => f.endsWith('.js')).sort();
for (const f of modules) copyFileSync(join(ROOT, 'viewer', f), join(OUT, 'viewer', f));
if (!modules.includes('desktop.js')) fail('viewer/desktop.js is missing');

// ---- the page, from the viewer's own index.html (one source for both) ----
const html = readFileSync(join(ROOT, 'viewer/index.html'), 'utf8');
const pick = (re, what) => { const m = re.exec(html); if (!m) fail(`viewer/index.html: no ${what}`); return m[1]; };
const style = pick(/<style>([\s\S]*?)<\/style>/, '<style>');
const importmap = pick(/<script type="importmap">([\s\S]*?)<\/script>/, 'import map');
const body = pick(/<body>([\s\S]*?)<\/body>/, '<body>')
  .replace(/<script type="module" src="\.\/[\w.-]+"><\/script>\s*/g, '');      // app.js and chat.js: desktop.js loads them
if (/<script/.test(body)) fail('viewer/index.html: a script in <body> that the build does not know');

let commit = 'unknown';
try { commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(); } catch { /* not a checkout */ }
const built = new Date().toISOString().slice(0, 16).replace('T', ' ');

// ---- the workspace pack ----
let starter = [];
try { starter = JSON.parse(readFileSync(join(ROOT, 'artifact.json'), 'utf8')).starter ?? []; } catch { /* none */ }
// (LICENSE names its holder, a person: it stays in the repository)
const LEFT_OUT = [/^\.claude\//, /^docs\//, /^artifact\.json$/, /^README\.md$/, /^LICENSE$/];
const PACK_TEXT = /(\.(js|mjs|ts|py|json|md|sh|html|txt)|^LICENSE|^\.gitignore)$/;
const tracked = execFileSync('git', ['ls-files', '-s'], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n')
  .map(l => { const [mode, , , ...path] = l.split(/\s+/); return { mode, path: path.join(' ') }; })
  .filter(f => !LEFT_OUT.some(re => re.test(f.path)))
  .filter(f => !f.path.startsWith('applications/') || starter.includes(f.path.split('/')[1]))
  .filter(f => existsSync(join(ROOT, f.path)));
for (const id of starter) if (!tracked.some(f => f.path === `applications/${id}/application.json`)) fail(`starter application '${id}' is not in the repository`);
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
      writeFileSync(join(OUT, carried.get(entry.sha)), bytes.toString('base64'));
    }
    entry.bin = carried.get(entry.sha);
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
<script type="application/json" id="claude-artifacts-manifest">{"permissions": ["full-access"]}</script>
<script>window.MICROFACTORY_BUILD = ${JSON.stringify({ commit, built, pack: pack.version })};</script>
<script type="importmap">${importmap.trim()}</script>
${body.trim()}
<script type="module" src="./viewer/desktop.js"></script>
`;
writeFileSync(join(OUT, 'index.html'), page);

// ---- check what is going out ----
const all = [];
const walk = d => { for (const e of readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(join(d, e.name)) : all.push(join(d, e.name)); };
walk(OUT);
const supporting = all.filter(f => f !== join(OUT, 'index.html')).sort();
const TEXT = /\.(js|html|json|css|md|txt)$/;
const MAY_CARRY = /^(index\.html|viewer\/[\w.-]+\.js|ws\/files\.json|ws\/b\/\d+\.txt)$/;
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

// ---- the publish call, as data ----
const rel = f => relative(ROOT, f).split('\\').join('/');
const publish = {
  file_path: rel(join(OUT, 'index.html')),
  files: Object.fromEntries(supporting.map(f => [relative(OUT, f).split('\\').join('/'), rel(f)])),
  capabilities: { desktop: {} },
  title: TITLE,
  description: DESCRIPTION,
  icon: 'robot',
  build: { commit, built, pack: pack.version },
};
writeFileSync(join(OUT, 'publish.json'), JSON.stringify(publish, null, 1) + '\n');

console.log(`built ${rel(OUT)}: the page + ${supporting.length} files, ${(total / 1e6).toFixed(1)} MB (commit ${commit}); workspace pack ${pack.version}, ${pack.files.length} files — listed in ${rel(REPORT)}`);
console.log(`publish with the arguments in ${rel(join(OUT, 'publish.json'))}`);
