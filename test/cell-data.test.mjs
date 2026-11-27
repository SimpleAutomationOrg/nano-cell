// A cell is a robot with an application set up on it (viewer/cell-data.js).
// These hold the two halves apart: the application must stay movable to
// another robot, and a robot that cannot run it must say why.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { composeCell, loadCell } from '../viewer/cell-data.js';
import { sections, moveStep } from '../viewer/step-order.js';

const ROOT = new URL('..', import.meta.url);
const readJson = async p => JSON.parse(readFileSync(new URL(p, ROOT)));
const APP = 'case-assembly';
const application = { ...await readJson(`applications/${APP}/application.json`), id: APP };
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
    // steps belong to the application and use its grippers
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
    }
  }
});

test('the step list: sections follow the loops, and a drag reorders, adds or removes', () => {
  const steps = ['a', 'b', 'c', 'd'].map(id => ({ id, name: id.toUpperCase() }));
  const loops = [{ id: 'main', name: 'Main', steps: ['c', 'a'] }];
  const ids = secs => secs.map(s => [s.loop, s.steps.map(x => x.id)]);
  assert.deepEqual(ids(sections(steps, loops)), [['main', ['c', 'a']], [null, ['b', 'd']]]);
  // a loop naming a step that no longer exists just does not show it
  assert.deepEqual(ids(sections(steps, [{ id: 'main', name: 'Main', steps: ['gone', 'a'] }])), [['main', ['a']], [null, ['b', 'c', 'd']]]);

  const after = (...args) => { const r = moveStep(loops, ...args); return [r.loops[0].steps, r.changed]; };
  assert.deepEqual(after('a', 'main', 'main', 0), [['a', 'c'], ['main']], 'reorder up');
  assert.deepEqual(after('c', 'main', 'main', 2), [['a', 'c'], ['main']], 'reorder down, past the end');
  assert.deepEqual(after('c', 'main', 'main', 1), [['c', 'a'], []], 'dropped where it was: nothing to save');
  assert.deepEqual(after('b', null, 'main', 1), [['c', 'b', 'a'], ['main']], 'a free step joins the loop in its place');
  assert.deepEqual(after('a', 'main', null, 0), [['c'], ['main']], 'dragged out: it leaves the loop but still exists');
  assert.deepEqual(after('b', null, null, 1), [['c', 'a'], []], 'free steps have no order to save');
  assert.deepEqual(loops[0].steps, ['c', 'a'], 'the input must not be changed');

  // between two loops: it leaves the first and lands in the second
  const two = [{ id: 'x', name: 'X', steps: ['a', 'b'] }, { id: 'y', name: 'Y', steps: ['c'] }];
  const r = moveStep(two, 'a', 'x', 'y', 0);
  assert.deepEqual(r.loops.map(l => l.steps), [['b'], ['a', 'c']]);
  assert.deepEqual(r.changed.sort(), ['x', 'y']);
});

test('loops.ts is read and rewritten by the server without touching anything but the step list', () => {
  const run = code => execFileSync('python3', ['-c', code], { cwd: new URL('viewer/', ROOT), encoding: 'utf8' });
  const file = `../applications/${APP}/loops.ts`;
  const out = JSON.parse(run(`
import json, loops
src = open(${JSON.stringify(file)}, encoding='utf-8').read()
was = loops.parse(src)[0]
same = loops.with_steps(src, was['id'], was['steps'])
rev = loops.with_steps(src, was['id'], was['steps'][::-1])
none = loops.with_steps(src, was['id'], [])
strip = lambda t: [l for l in t.splitlines() if not l.strip().startswith("'") and 'steps:' not in l and l.strip() != '],']
print(json.dumps({'was': was, 'same': same == src, 'rev': loops.parse(rev)[0]['steps'], 'none': loops.parse(none)[0]['steps'],
  'rest': strip(rev) == strip(src), 'missing': loops.with_steps(src, 'no-such-loop', []) is None}))`));
  assert.ok(out.was.steps.length >= 2, 'the loop has steps to reorder');
  assert.ok(out.same, 'saving the same order must leave the file byte for byte');
  assert.deepEqual(out.rev, [...out.was.steps].reverse());
  assert.deepEqual(out.none, []);
  assert.ok(out.rest, 'something outside the step list changed');
  assert.ok(out.missing);
});

test('loops name steps that exist, each once', () => {
  for (const name of readdirSync(new URL('applications/', ROOT))) {
    const file = new URL(`applications/${name}/loops.ts`, ROOT);
    if (!existsSync(file)) continue;
    // step names are the quoted entries of each `steps: [...]` list, comments aside
    const src = readFileSync(file, 'utf8').replace(/\/\/.*$/gm, '');
    const lists = [...src.matchAll(/steps:\s*\[([^\]]*)\]/g)].map(m => [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map(x => x[1]));
    assert.ok(lists.length, `${name}/loops.ts: no loop found`);
    for (const steps of lists) {
      assert.ok(steps.length, `${name}/loops.ts: a loop without steps`);
      assert.equal(new Set(steps).size, steps.length, `${name}/loops.ts: a step is listed twice`);
      for (const s of steps) assert.ok(existsSync(new URL(`applications/${name}/steps/${s}.ts`, ROOT)), `${name}/loops.ts: step '${s}' does not exist`);
    }
  }
});

test('an application holds nothing of the robot: no joint values outside taught_on, no arm, no IO', () => {
  const { taught_on, ...rest } = application;
  for (const k of ['arm', 'table', 'guard', 'flange_stack', 'io', 'cameras']) assert.ok(!(k in rest), `application has '${k}'`);
  const text = JSON.stringify(rest);
  assert.ok(!/_deg"/.test(text), 'a joint-space value sits outside taught_on');
  // and every pose it places is in the table frame (tools: the flange frame)
  for (const it of [...rest.fixtures, ...rest.parts]) assert.ok(it.pose_table, `${it.id} has no pose_table`);
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
  assert.throws(() => composeCell(noVacuum, application), /gripper 'rcup16_p0' needs the output 'vacuum', which the robot does not have/);
  const { changer, ...noChanger } = robot;
  assert.throws(() => composeCell(noChanger, application), /tool rack, but the robot has no tool changer/);
  assert.throws(() => composeCell(robot, { ...application, mounted_tool: 'nope' }), /mounted_tool 'nope' is not one of its grippers/);
});
