// A cell is a robot with an application set up on it (viewer/cell-data.js).
// These hold the two halves apart: the application must stay movable to
// another robot, and a robot that cannot run it must say why.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { composeCell, loadCell, loadApplication, assembleApplication, FORMAT } from '../viewer/cell-data.js';
import { sections, moveStep } from '../viewer/step-order.js';

const ROOT = new URL('..', import.meta.url);
const readJson = async p => JSON.parse(readFileSync(new URL(p, ROOT)));
const APP = 'case-assembly';
const application = await loadApplication(readJson, APP);
const appJson = f => readJson(`applications/${APP}/${f}`);
const dirs = p => readdirSync(new URL(p, ROOT)).filter(n => statSync(new URL(`${p}${n}`, ROOT)).isDirectory());
const robot = { ...await readJson(`${application.robot}/robot.json`), id: application.robot };

test('every application composes onto its robot, and every mesh it names exists', async () => {
  for (const name of readdirSync(new URL('applications/', ROOT))) {
    if (!existsSync(new URL(`applications/${name}/application.json`, ROOT))) continue;
    const cell = await loadCell(readJson, name);
    for (const it of [...cell.fixtures, ...cell.parts, ...cell.tools, ...cell.flange_stack]) {
      for (const k of ['mesh', 'collision_mesh']) {
        if (it[k]) assert.ok(existsSync(new URL(it[k], ROOT)), `${name}: ${it.id} ${k} ${it[k]} is missing`);
      }
    }
    // steps belong to the application, use its grippers, and import the
    // cell API by name — not by a path into the engine, which would tie
    // the application to where its folder happens to live
    const tdir = new URL(`applications/${name}/steps/`, ROOT);
    for (const t of existsSync(tdir) ? readdirSync(tdir) : []) {
      // one file per step, saying its name and its gripper the way the
      // server reads them (viewer/serve.py): export const name = '...';
      assert.match(t, /\.ts$/, `${name}/steps/${t}: a step is a single .ts file`);
      const src = readFileSync(new URL(t, tdir), 'utf8');
      const said = key => src.match(new RegExp(`^export const ${key}\\s*=\\s*(['"])(.*?)\\1`, 'm'))?.[2];
      assert.ok(said('name'), `${name}/steps/${t}: no  export const name = '...'`);
      assert.ok(cell.tools.some(x => x.id === said('tool')), `${name}/steps/${t}: tool '${said('tool')}' is not a gripper of the application`);
      assert.match(src, /^export const entry\b/m, `${name}/steps/${t}: no entry pose`);
      assert.match(src, /^export default async function/m, `${name}/steps/${t}: no default function`);
      assert.match(src, /from 'microfactory'/, `${name}/steps/${t}: import the cell API from 'microfactory'`);
      assert.ok(!/from '\.\.\//.test(src), `${name}/steps/${t}: imports by a relative path out of the application`);
    }
  }
});

test('the step list: the loop in order, the rest below it, and a drag reorders, adds or removes', () => {
  const steps = ['a', 'b', 'c', 'd'].map(id => ({ id, name: id.toUpperCase() }));
  const ids = s => [s.loop.map(x => x.id), s.free.map(x => x.id)];
  assert.deepEqual(ids(sections(steps, { name: 'L', steps: ['c', 'a'] })), [['c', 'a'], ['b', 'd']]);
  // a loop naming a step that no longer exists just does not show it; no loop file: every step is free
  assert.deepEqual(ids(sections(steps, { name: 'L', steps: ['gone', 'a'] })), [['a'], ['b', 'c', 'd']]);
  assert.deepEqual(ids(sections(steps, null)), [[], ['a', 'b', 'c', 'd']]);

  const loop = ['c', 'a'];
  const after = (...args) => { const r = moveStep(loop, ...args); return [r.steps, r.changed]; };
  assert.deepEqual(after('a', true, 0), [['a', 'c'], true], 'reorder up');
  assert.deepEqual(after('c', true, 2), [['a', 'c'], true], 'reorder down, past the end');
  assert.deepEqual(after('c', true, 1), [['c', 'a'], false], 'dropped where it was: nothing to save');
  assert.deepEqual(after('b', true, 1), [['c', 'b', 'a'], true], 'a free step joins the loop in its place');
  assert.deepEqual(after('a', false), [['c'], true], 'dragged out: it leaves the loop but still exists');
  assert.deepEqual(after('b', false), [['c', 'a'], false], 'free steps have no order to save');
  assert.deepEqual(loop, ['c', 'a'], 'the input must not be changed');
});

test('the application folder: a manifest of the current format that lists exactly its grippers and items', async () => {
  for (const name of dirs('applications/')) {
    const m = await readJson(`applications/${name}/application.json`);
    assert.equal(m.format, FORMAT, `${name}: format`);
    assert.match(m.uid, /^[0-9a-f-]{36}$/, `${name}: uid`);
    assert.ok(m.name && typeof m.description === 'string' && Array.isArray(m.authors), `${name}: name, description, authors`);
    // every folder is listed and every listed thing has its folder: nothing loads by accident, nothing is orphaned
    for (const [key, sub, file] of [['grippers', 'grippers/', 'gripper.json'], ['items', 'items/', 'item.json']]) {
      const have = existsSync(new URL(`applications/${name}/${sub}`, ROOT)) ? dirs(`applications/${name}/${sub}`).sort() : [];
      assert.deepEqual([...m[key]].sort(), have, `${name}: "${key}" in application.json and the folders in ${sub} differ`);
      for (const id of m[key]) {
        const d = await readJson(`applications/${name}/${sub}${id}/${file}`);
        assert.equal(d.id, id, `${name}/${sub}${id}/${file}: its id is not its folder's name`);
        for (const k of ['mesh', 'collision_mesh']) {
          if (d[k]) assert.ok(!d[k].includes('/') && existsSync(new URL(`applications/${name}/${sub}${id}/${d[k]}`, ROOT)), `${name}/${sub}${id}: ${k} must be a file beside ${file}`);
        }
      }
    }
    // the layout only places: what a thing IS lives in its item.json, once
    const layout = await readJson(`applications/${name}/layout.json`);
    for (const p of [...layout.fixtures, ...layout.parts]) {
      assert.ok(m.items.includes(p.item), `${name}: '${p.id}' places the unknown item '${p.item}'`);
      for (const k of ['mesh', 'collision_mesh', 'mesh_source', 'mass_kg']) assert.ok(!(k in p), `${name}: layout.json repeats '${k}' for '${p.id}' — it belongs in items/${p.item}/item.json`);
    }
    for (const id of m.items) assert.ok([...layout.fixtures, ...layout.parts].some(p => p.item === id), `${name}: items/${id} is placed nowhere`);
  }
});

test('putting an application together: a placement is its item plus where it stands; bad files are named', async () => {
  const [manifest, layout] = [await appJson('application.json'), await appJson('layout.json')];
  const items = Object.fromEntries(await Promise.all(manifest.items.map(async i => [i, await appJson(`items/${i}/item.json`)])));
  const grippers = Object.fromEntries(await Promise.all(manifest.grippers.map(async g => [g, await appJson(`grippers/${g}/gripper.json`)])));
  const files = { manifest, layout, items, grippers, taught: null };
  const app = assembleApplication(APP, files, 'cell_fr3');
  const c1 = app.parts.find(p => p.id === 'front_case_1'), c2 = app.parts.find(p => p.id === 'front_case_2');
  assert.equal(c1.mesh, 'items/front_case/front_case.glb');
  assert.equal(c1.mesh, c2.mesh, 'two placements of one item share its mesh');
  assert.notDeepEqual(c1.pose_table, c2.pose_table);
  assert.ok(c1.name !== items.front_case.name && !('item' in c1) && !('kind' in c1), 'the placement keeps its own name; item and kind are not carried into the cell');
  assert.equal(app.tools.find(t => t.id === 'rcup16_p0').mesh, 'grippers/rcup16_p0/rcup16_p0.glb');
  assert.deepEqual(app.taught_on, {}, 'nothing taught on this robot: no joint values');

  assert.throws(() => assembleApplication(APP, { ...files, manifest: { ...manifest, format: 99 } }, 'cell_fr3'), /format 99; this viewer reads format 1/);
  const stray = { ...layout, parts: [...layout.parts, { id: 'x', item: 'nope', pose_table: c1.pose_table }] };
  assert.throws(() => assembleApplication(APP, { ...files, layout: stray }, 'cell_fr3'), /places 'x' as the item 'nope'/);
  const wrong = { ...layout, parts: [...layout.parts, { id: 'x', item: 'holder', pose_table: c1.pose_table }] };
  assert.throws(() => assembleApplication(APP, { ...files, layout: wrong }, 'cell_fr3'), /'x' is listed under parts, but items\/holder is a fixture/);
});

test('the server side: the loop is saved into the manifest and nothing else changes; a new application loads', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'mf-app-'));
  try {
    const out = JSON.parse(execFileSync('python3', ['-c', `
import json, os, shutil, sys, appfiles
src, tmp = sys.argv[1], sys.argv[2]
copy = os.path.join(tmp, 'applications', 'copy')
os.makedirs(copy)
shutil.copy(os.path.join(src, 'application.json'), copy)
before = open(os.path.join(copy, 'application.json')).read()
was = appfiles.read_loop(copy)
same = appfiles.write_loop_steps(copy, was['steps'])
appfiles.write_loop_steps(copy, was['steps'][::-1])
after = json.load(open(os.path.join(copy, 'application.json')))
rest = {k: v for k, v in after.items() if k != 'loop'} == {k: v for k, v in json.loads(before).items() if k != 'loop'}
appfiles.new_application(os.path.join(tmp, 'applications', 'fresh'), 'Fresh one', src)
print(json.dumps({'was': was, 'same': same is None, 'rev': appfiles.read_loop(copy), 'rest': rest,
  'flat': appfiles.dumps({'p': [1.5, 2, 3], 'q': [[1, 2], [3, 4]], 'e': []})}))`,
      new URL(`applications/${APP}`, ROOT).pathname, tmp], { cwd: new URL('viewer/', ROOT), encoding: 'utf8' }));
    assert.ok(out.was.name && out.was.steps.length >= 2, 'the loop has a name and steps to reorder');
    assert.ok(out.same, 'saving the same order must not rewrite the file');
    assert.deepEqual(out.rev, { name: out.was.name, steps: [...out.was.steps].reverse() });
    assert.ok(out.rest, 'something besides the loop changed in the manifest');
    assert.match(out.flat, /"p": \[1\.5, 2, 3\]/, 'a list of plain values is written on one line');
    assert.deepEqual(JSON.parse(out.flat), { p: [1.5, 2, 3], q: [[1, 2], [3, 4]], e: [] });
    // the empty application the New button makes is a valid one, on the same robot
    const fresh = await loadApplication(async p => JSON.parse(readFileSync(join(tmp, p))), 'fresh');
    assert.deepEqual([fresh.name, fresh.robot, fresh.tools, fresh.fixtures, fresh.loop.steps], ['Fresh one', application.robot, [], [], []]);
    const cell = composeCell(robot, fresh);
    assert.equal(cell.mounted_tool, robot.changer.bare_tool_id, 'an application with no gripper leaves the changer bare');
  } finally { rmSync(tmp, { recursive: true }); }
});

test('one file to share: export then import gives the same application; nothing is overwritten unasked; unsafe files are refused', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'mf-file-'));
  try {
    const out = JSON.parse(execFileSync('python3', ['-c', `
import io, json, os, sys, zipfile, appfiles
like, tmp = sys.argv[1], sys.argv[2]
apps, backups = os.path.join(tmp, 'applications'), os.path.join(tmp, 'backups')
src = os.path.join(apps, 'demo')
appfiles.new_application(src, 'Demo', like)
os.makedirs(os.path.join(src, 'items', 'block'))
open(os.path.join(src, 'items', 'block', 'block.glb'), 'wb').write(bytes(range(256)) * 40)
open(os.path.join(src, 'steps', 'go.ts'), 'w').write('export const name = "Go";')
open(os.path.join(src, '.DS_Store'), 'w').write('x')
def tree(d):
    return {os.path.relpath(os.path.join(p, f), d): open(os.path.join(p, f), 'rb').read().hex()[:64] + str(os.path.getsize(os.path.join(p, f)))
            for p, _, fs in os.walk(d) for f in fs if f != '.DS_Store'}
buf = io.BytesIO(); appfiles.export_application(src, buf)
names = zipfile.ZipFile(io.BytesIO(buf.getvalue())).namelist()
imp = lambda name, mode, data=None: appfiles.import_application(apps, io.BytesIO(data or buf.getvalue()), name, mode, backup_root=backups)
res = {'first': names[0], 'ds': '.DS_Store' in names}
v = appfiles.version_of(src); buf2 = io.BytesIO()
res['version'] = [v, appfiles.export_application(src, buf2), appfiles.version_of_archive(zipfile.ZipFile(io.BytesIO(buf.getvalue())))]
import time; t = time.mktime((2026, 11, 28, 14, 30, 5, 0, 0, -1))
res['file'] = [appfiles.export_name('demo', t), appfiles.export_name('demo', t + 1)]
res['ids'] = [appfiles.id_from_file_name(n) for n in (res['file'][0], 'demo-20261128-143005 (2).microfactory', 'Demo.microfactory', 'line-2.microfactory', 'batch-20261128.microfactory')]
res['new'] = imp('Shared Demo-20261128-143005.microfactory', 'ask'); res['same_tree'] = tree(os.path.join(apps, 'shared-demo')) == tree(src)
res['ask'] = imp('demo', 'ask')
open(os.path.join(src, 'steps', 'go.ts'), 'a').write('// edited'); res['changed'] = [appfiles.version_of(src) != v, imp('demo', 'ask')['identical']]
uid = appfiles.read_manifest(src)['uid']
res['copy'] = imp('demo', 'copy'); res['copy_uid_new'] = appfiles.read_manifest(os.path.join(apps, 'demo-2'))['uid'] != uid
open(os.path.join(src, 'mine.txt'), 'w').write('local work')
res['replace'] = imp('demo', 'replace')
res['replaced_gone'] = not os.path.exists(os.path.join(src, 'mine.txt'))
kept = os.listdir(backups); res['kept'] = len(kept) == 1 and os.path.exists(os.path.join(backups, kept[0], 'mine.txt'))
def bad(make):
    b = io.BytesIO()
    with zipfile.ZipFile(b, 'w') as z: make(z)
    try: imp('bad', 'ask', b.getvalue()); return 'accepted'
    except appfiles.ImportError_ as e: return str(e)
m = json.dumps(appfiles.read_manifest(src))
res['escape'] = bad(lambda z: (z.writestr('application.json', m), z.writestr('../escaped.txt', 'x')))
res['absolute'] = bad(lambda z: (z.writestr('application.json', m), z.writestr('/etc/x', 'x')))
res['nomanifest'] = bad(lambda z: z.writestr('layout.json', '{}'))
res['format'] = bad(lambda z: z.writestr('application.json', json.dumps({**json.loads(m), 'format': 7})))
try: imp('junk', 'ask', b'not a zip at all'); res['junk'] = 'accepted'
except appfiles.ImportError_ as e: res['junk'] = str(e)
res['nothing_escaped'] = not os.path.exists(os.path.join(tmp, 'escaped.txt')) and not os.path.exists(os.path.join(apps, 'bad'))
res['left'] = sorted(os.listdir(apps))
print(json.dumps(res))`, new URL(`applications/${APP}`, ROOT).pathname, tmp], { cwd: new URL('viewer/', ROOT), encoding: 'utf8' }));
    assert.equal(out.first, 'application.json', 'the manifest is the first file of the archive');
    assert.ok(!out.ds, 'desktop clutter is not exported');
    const v = out.version[0];
    assert.match(v, /^[0-9a-f]{8}$/);
    assert.deepEqual(out.version, [v, v, v], 'the contents hash is the same for the folder, a second export, and the archive itself');
    assert.deepEqual(out.file, ['demo-20261128-143005.microfactory', 'demo-20261128-143006.microfactory'], 'the exported file is named by when it was saved, to the second — so names sort in time order');
    assert.deepEqual(out.ids, ['demo', 'demo', 'demo', 'line-2', 'batch-20261128'], 'import drops the date and time (and a browser\'s " (2)") from the name, and nothing else');
    assert.deepEqual(out.new, { id: 'shared-demo', version: v }, 'the application is named after the file, without the date');
    assert.deepEqual(out.changed, [true, false], 'any edit changes the contents hash, and the file is then no longer "what is here already"');
    assert.ok(out.same_tree, 'the imported folder differs from the exported one');
    assert.deepEqual(out.ask, { exists: true, id: 'demo', name: 'Demo', version: v, same: true, identical: true }, 'an existing application is reported, not touched');
    assert.deepEqual(out.copy, { id: 'demo-2', version: v });
    assert.ok(out.copy_uid_new, 'a copy kept beside the original is another application: it needs its own uid');
    assert.deepEqual(out.replace, { id: 'demo', version: v });
    assert.ok(out.replaced_gone && out.kept, 'replacing must move the application that was here to the backups, with its files');
    assert.match(out.escape, /unsafe path: \.\.\/escaped\.txt/);
    assert.match(out.absolute, /unsafe path/);
    assert.match(out.nomanifest, /no application\.json/);
    assert.match(out.format, /format 7; this viewer reads format 1/);
    assert.match(out.junk, /not a \.microfactory file/);
    assert.ok(out.nothing_escaped, 'a refused file wrote something');
    assert.deepEqual(out.left, ['demo', 'demo-2', 'shared-demo'], 'no half-imported folder is left behind');
  } finally { rmSync(tmp, { recursive: true }); }
});

test('an application has ONE loop, naming steps that exist, each once', async () => {
  for (const name of dirs('applications/')) {
    const m = await readJson(`applications/${name}/application.json`);
    assert.ok(m.loop && typeof m.loop.name === 'string' && Array.isArray(m.loop.steps), `${name}: "loop" in application.json needs a name and steps`);
    assert.ok(!existsSync(new URL(`applications/${name}/loop.ts`, ROOT)), `${name}: loop.ts — the loop lives in application.json`);
    assert.equal(new Set(m.loop.steps).size, m.loop.steps.length, `${name}: a step is in the loop twice`);
    for (const st of m.loop.steps) assert.ok(existsSync(new URL(`applications/${name}/steps/${st}.ts`, ROOT)), `${name}: loop step '${st}' does not exist`);
  }
});

test('an application holds nothing of the robot: joint values only in robots/, no arm, no IO', () => {
  const walk = d => readdirSync(new URL(d, ROOT), { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? (['print', 'materials', 'notes', 'chats'].includes(e.name) ? [] : walk(`${d}${e.name}/`)) : e.name.endsWith('.json') ? [`${d}${e.name}`] : []);
  for (const f of walk(`applications/${APP}/`)) {
    const text = readFileSync(new URL(f, ROOT), 'utf8');
    if (!f.includes('/robots/')) assert.ok(!/_deg"/.test(text), `${f}: a joint-space value outside robots/`);
    const d = JSON.parse(text);
    for (const k of ['arm', 'table', 'guard', 'flange_stack', 'io', 'cameras']) assert.ok(!(k in d), `${f} has '${k}' — that is the robot's`);
  }
  assert.ok(Object.keys(application.taught_on).length === 1 && application.taught_on[application.robot].stands, 'what was taught on its robot is loaded from robots/');
  // and every pose it places is in the table frame (tools: the flange frame)
  for (const it of [...application.fixtures, ...application.parts]) assert.ok(it.pose_table, `${it.id} has no pose_table`);
});

test('moved to another robot: the setup is unchanged in the table frame, taught joint values do not follow', () => {
  const other = { ...robot, id: 'other', name: 'other',
    arm: { ...robot.arm, mount_table: { xyz_m: [0.2, 0.3, 0], rpy: [0, 0, 0] } } };
  const here = composeCell(robot, application), there = composeCell(other, application);
  assert.deepEqual(there.fixtures, here.fixtures);
  assert.deepEqual(there.parts, here.parts);
  assert.deepEqual(there.tools, here.tools);
  assert.deepEqual(there.arm.mount_table.xyz_m, [0.2, 0.3, 0]);
  assert.ok(here.changer.stands.every(s => s.return_deg), 'taught values are missing on the robot they were taught on');
  assert.ok(there.changer.stands.every(s => !('return_deg' in s) && s.pose_table), 'joint values followed the application to another robot');
  assert.ok(!there.changer.unlock_interlock);
});

test('a robot that cannot run the application says what is missing', () => {
  const noVacuum = { ...robot, io: robot.io.filter(s => s.name !== 'vacuum') };
  assert.throws(() => composeCell(noVacuum, application), /gripper '\w+' needs the output 'vacuum', which the robot does not have/);
  const { changer, ...noChanger } = robot;
  assert.throws(() => composeCell(noChanger, application), /tool rack, but the robot has no tool changer/);
  assert.throws(() => composeCell(robot, { ...application, mounted_tool: 'nope' }), /mounted_tool 'nope' is not one of its grippers/);
});
