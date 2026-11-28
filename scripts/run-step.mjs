#!/usr/bin/env node
// Run steps in the simulation and report what came of it.
//
//   node scripts/run-step.mjs <application> <step> [<step> …]    these steps, back to back
//   node scripts/run-step.mjs <application> --loop               the application's loop
//   node scripts/run-step.mjs <application> --last-failure       the last run that FAILED in the viewer,
//                                                                as it was recorded (no run is made)
//
//   --headless    run here, with no window: nobody watches, nothing has to be open, and it is fast.
//                 Same planner, physics and steps as the viewer. No pictures. Always starts from the
//                 application as its files describe it.
//   --keep        (viewer) do not reset the scene first: carry on from how the last run left it
//   --shot        (viewer) also save pictures of the scene after the run: the whole cell, and a
//                 close-up of the tool and the parts that moved (their paths are printed; open them)
//   --slow        (viewer) at the speed the viewer is set to (default: as fast as it plays)
//   --timeout N   (viewer) give up waiting after N seconds (default 300)
//   --json        print the raw result
//
// Without --headless the run happens in the REAL viewer the user has open
// on that application — they see the arm move, and pictures can be taken.
// The viewer must be open and on screen. What comes back either way: done,
// or the error exactly as the viewer shows it; the log lines; every part
// that is no longer where the layout put it; what is held; the IO; the
// arm's joints. Exit code 0 when the run finished, 1 when it failed, 2
// when it could not be made.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };
const value = (name, d) => { const i = args.indexOf(name); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const loop = flag('--loop'), keep = flag('--keep'), shot = flag('--shot'), slow = flag('--slow'), json = flag('--json');
const headless = flag('--headless'), last = flag('--last-failure');
const timeout = Number(value('--timeout', 300));
const [app, ...steps] = args;
const cannot = msg => { console.error(`run-step: ${msg}`); process.exit(2); };
if (!app || (!loop && !last && !steps.length) || args.some(a => a.startsWith('--')))
  cannot('usage: node scripts/run-step.mjs <application> <step> [<step> …] | --loop | --last-failure   [--headless] [--keep] [--shot] [--slow] [--timeout N] [--json]');
if (!existsSync(`${ROOT}applications/${app}/application.json`)) cannot(`no application '${app}'`);

const mm = v => (v * 1000).toFixed(1);
function print(res) {
  if (res.when) console.log(`recorded ${res.when} — the last run that failed in the viewer\n`);
  if (res.stale) console.log('NOTE: files changed since the viewer loaded this application (layout, items, grippers), and it has not reloaded yet:\n      this run used the OLD ones. Step files are always read fresh.\n');
  console.log(res.ok ? `DONE: ${res.ran.join(', ')}${res.seconds !== undefined ? ` (${res.seconds} s)` : ''}${res.headless ? ' — without the viewer' : ''}`
    : `FAILED at ${res.step ?? '?'}: ${res.error}${res.ran ? `   (running: ${res.ran.join(', ')})` : ''}`);
  if (res.log?.length) { console.log('\nlog:'); for (const l of res.log) console.log('  ' + l); }
  console.log(`\ntool on the arm: ${res.tool}; holding: ${res.held ?? 'nothing'}; io: ${JSON.stringify(res.io ?? {})}`);
  console.log(`joints (deg): ${JSON.stringify(res.joints_deg)}`);
  if (res.parts_moved?.length) {
    console.log('\nparts no longer where the layout put them (table frame, mm):');
    for (const p of res.parts_moved) console.log(`  ${p.id}: moved ${p.moved_mm} mm, now at x ${mm(p.to_m[0])} y ${mm(p.to_m[1])} z ${mm(p.to_m[2])} (was x ${mm(p.from_m[0])} y ${mm(p.from_m[1])} z ${mm(p.from_m[2])})`);
  } else console.log('\nno part moved');
  if (res.picture) console.log(`\npictures (open them): the whole cell: ${res.picture}` + (res.picture_close ? `\n                      close-up of the tool and the parts that moved: ${res.picture_close}` : ''));
}
const finish = res => {
  if (json) console.log(JSON.stringify(res, null, 1)); else print(res);
  process.exit(res.ok ? 0 : 1);
};

// ---- the record of the last failed run ----
if (last) {
  const path = `${ROOT}applications/${app}/runs/last-failure.json`;
  if (!existsSync(path)) { console.log(`no failed run is recorded for '${app}' (a record is kept when a run fails in the viewer)`); process.exit(0); }
  const rec = JSON.parse(readFileSync(path, 'utf8'));
  if (json) console.log(JSON.stringify(rec, null, 1)); else print(rec);
  process.exit(0);
}

// ---- here, with no window ----
if (headless) {
  if (shot || keep) cannot('--shot and --keep need the viewer: leave --headless out');
  const { openCell } = await import('./headless-cell.mjs');
  let cell;
  try { cell = await openCell(app); } catch (e) { cannot(`the application could not be loaded: ${e.message}`); }
  const res = await cell.run(loop ? cell.loop : steps);
  if (!res.ran) cannot(res.error);
  finish(res);
}

// ---- in the viewer the user has open ----
let port;
try { port = JSON.parse(readFileSync(ROOT + '.server.json', 'utf8')).port; }
catch { cannot('the viewer\'s server is not running here (no .server.json): start it with `python3 viewer/serve.py`, or open the Microfactory app — or add --headless to run without the viewer'); }

let res;
try {
  const r = await fetch(`http://127.0.0.1:${port}/__run/request`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Microfactory': 'chat' },
    body: JSON.stringify({ app, steps, loop, reset: !keep, shot, fast: !slow, timeout }),
    signal: AbortSignal.timeout((timeout + 30) * 1000),
  });
  res = await r.json();
} catch (e) { cannot(`the viewer's server did not answer on port ${port}: ${e.message} — add --headless to run without the viewer`); }
if (!res.ran) cannot((res.error ?? 'no result') + (/not open/.test(res.error ?? '') ? ' — or add --headless to run without the viewer' : ''));
finish(res);
