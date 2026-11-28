#!/usr/bin/env node
// Build nano-cell as an ARTIFACT that installs as a desktop app.
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
//   <out>/publish.json        the arguments of the publish call: file_path,
//                             files, capabilities, title, description, icon
//
// The artifact holds the PAGE ONLY — code written in this repository.
// Nothing third-party is copied in (three.js and MuJoCo's module come from
// the CDN, MuJoCo's compiled physics from the workspace), and the engine,
// the cell, the applications, their CAD and the conversations are never
// put in it: the installed app
// reads them from the workspace folder on the person's computer, through
// the engine it starts there (viewer/desktop.js). The build fails rather
// than let anything else in.
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, copyFileSync, statSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const oi = args.indexOf('--out');
const OUT = join(ROOT, oi >= 0 ? args[oi + 1] : 'dist/artifact');
const fail = msg => { console.error(`build-artifact: ${msg}`); process.exit(1); };

// what the publish call may carry (the Artifact tool's limits)
const LIMITS = { files: 255, text: 16e6, binary: 15e6, total: 64e6 };
const TITLE = 'Nano Cell';
const DESCRIPTION = 'A robot cell on your computer: simulate it, program its steps and work on it with an assistant — installs as a desktop app.';

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, 'viewer'), { recursive: true });

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

// The Artifact tool wraps this in its own <!doctype html>…<body>: no html,
// head or body tags here; the title and the styles come first.
const page = `<title>${TITLE}</title>
<style>
/* the app commits to one dark look */
:root { color-scheme: dark; }
${style.trim()}
</style>
<script type="application/json" id="claude-artifacts-manifest">{"permissions": ["full-access"]}</script>
<script>window.NANO_BUILD = ${JSON.stringify({ commit, built })};</script>
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
let total = 0;
for (const f of all) {
  const size = statSync(f).size, rel = relative(OUT, f);
  total += size;
  if (!/^(index\.html|viewer\/[\w.-]+\.js)$/.test(rel)) fail(`${rel} is not something the artifact may carry`);
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
  build: { commit, built },
};
writeFileSync(join(OUT, 'publish.json'), JSON.stringify(publish, null, 1) + '\n');

console.log(`built ${rel(OUT)}: the page + ${supporting.length} files, ${(total / 1e6).toFixed(1)} MB (commit ${commit})`);
console.log(`publish with the arguments in ${rel(join(OUT, 'publish.json'))}`);
