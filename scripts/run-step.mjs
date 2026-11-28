#!/usr/bin/env node
// Run steps in the open viewer and report what came of it.
//
//   node scripts/run-step.mjs <application> <step> [<step> …]    these steps, back to back
//   node scripts/run-step.mjs <application> --loop               the application's loop
//
//   --keep        do not reset the scene first (carry on from how the last run left it)
//   --shot        also save a picture of the scene after the run (its path is printed; open it)
//   --slow        at the speed the viewer is set to (default: as fast as it plays)
//   --timeout N   give up waiting after N seconds (default 300)
//   --json        print the raw result
//
// The run happens in the REAL simulation, in the viewer the user has open
// on that application — they see the arm move. The viewer must be open and
// on screen. What comes back: done, or the error exactly as the viewer
// shows it; the log lines; every part that is no longer where the layout
// put it; what is held; the IO; the arm's joints. Exit code 0 when the
// run finished, 1 when it failed, 2 when it could not be asked for.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };
const value = (name, d) => { const i = args.indexOf(name); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const loop = flag('--loop'), keep = flag('--keep'), shot = flag('--shot'), slow = flag('--slow'), json = flag('--json');
const timeout = Number(value('--timeout', 300));
const [app, ...steps] = args;
const cannot = msg => { console.error(`run-step: ${msg}`); process.exit(2); };
if (!app || (!loop && !steps.length) || args.some(a => a.startsWith('--')))
  cannot('usage: node scripts/run-step.mjs <application> <step> [<step> …] | --loop   [--keep] [--shot] [--slow] [--timeout N]');

let port;
try { port = JSON.parse(readFileSync(ROOT + '.server.json', 'utf8')).port; }
catch { cannot('the viewer\'s server is not running here (no .server.json): start it with `python3 viewer/serve.py`, or open the Microfactory app'); }

let res;
try {
  const r = await fetch(`http://127.0.0.1:${port}/__run/request`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Microfactory': 'chat' },
    body: JSON.stringify({ app, steps, loop, reset: !keep, shot, fast: !slow, timeout }),
    signal: AbortSignal.timeout((timeout + 30) * 1000),
  });
  res = await r.json();
} catch (e) { cannot(`the viewer's server did not answer on port ${port}: ${e.message}`); }

if (json) { console.log(JSON.stringify(res, null, 1)); process.exit(res.ok ? 0 : 1); }
if (!res.ran) cannot(res.error ?? 'no result');

const mm = v => (v * 1000).toFixed(1);
if (res.stale) console.log('NOTE: files changed since the viewer loaded this application (layout, items, grippers), and it has not reloaded yet:\n      this run used the OLD ones. Step files are always read fresh.\n');
console.log(res.ok ? `DONE: ${res.ran.join(', ')} (${res.seconds} s)` : `FAILED at ${res.step ?? '?'}: ${res.error}`);
if (res.log?.length) { console.log('\nlog:'); for (const l of res.log) console.log('  ' + l); }
console.log(`\ntool on the arm: ${res.tool}; holding: ${res.held ?? 'nothing'}; io: ${JSON.stringify(res.io ?? {})}`);
console.log(`joints (deg): ${JSON.stringify(res.joints_deg)}`);
if (res.parts_moved?.length) {
  console.log('\nparts no longer where the layout put them (table frame, mm):');
  for (const p of res.parts_moved) console.log(`  ${p.id}: moved ${p.moved_mm} mm, now at x ${mm(p.to_m[0])} y ${mm(p.to_m[1])} z ${mm(p.to_m[2])} (was x ${mm(p.from_m[0])} y ${mm(p.from_m[1])} z ${mm(p.from_m[2])})`);
} else console.log('\nno part moved');
if (res.picture) console.log(`\npicture of the scene: ${res.picture}`);
process.exit(res.ok ? 0 : 1);
