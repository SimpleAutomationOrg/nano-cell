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

test('loop.ts is read and rewritten by the server without touching anything but the step list', () => {
  const run = code => execFileSync('python3', ['-c', code], { cwd: new URL('viewer/', ROOT), encoding: 'utf8' });
  const file = `../applications/${APP}/loop.ts`;
  const out = JSON.parse(run(`
import json, loop
src = open(${JSON.stringify(file)}, encoding='utf-8').read()
was = loop.parse(src)
same = loop.with_steps(src, was['steps'])
rev = loop.with_steps(src, was['steps'][::-1])
none = loop.with_steps(src, [])
strip = lambda t: [l for l in t.splitlines() if not l.strip().startswith("'") and 'steps:' not in l and l.strip() != '],']
print(json.dumps({'was': was, 'same': same == src, 'rev': loop.parse(rev)['steps'], 'none': loop.parse(none)['steps'],
  'rest': strip(rev) == strip(src), 'missing': loop.parse('export const x = 1;') is None}))`));
  assert.ok(out.was.name && out.was.steps.length >= 2, 'the loop has a name and steps to reorder');
  assert.ok(out.same, 'saving the same order must leave the file byte for byte');
  assert.deepEqual(out.rev, [...out.was.steps].reverse());
  assert.deepEqual(out.none, []);
  assert.ok(out.rest, 'something outside the step list changed');
  assert.ok(out.missing);
});

test('an application has ONE loop, naming steps that exist, each once', () => {
  for (const name of readdirSync(new URL('applications/', ROOT))) {
    const file = new URL(`applications/${name}/loop.ts`, ROOT);
    if (!existsSync(file)) continue;
    assert.ok(!existsSync(new URL(`applications/${name}/loops.ts`, ROOT)), `${name}: loops.ts — an application has one loop, in loop.ts`);
    // step names are the quoted entries of the `steps: [...]` list, comments aside
    const src = readFileSync(file, 'utf8').replace(/\/\/.*$/gm, '');
    assert.equal([...src.matchAll(/^export const loop\b/gm)].length, 1, `${name}/loop.ts: exactly one  export const loop`);
    const lists = [...src.matchAll(/steps:\s*\[([^\]]*)\]/g)].map(m => [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map(x => x[1]));
    assert.equal(lists.length, 1, `${name}/loop.ts: one steps list`);
    const steps = lists[0];
    assert.equal(new Set(steps).size, steps.length, `${name}/loop.ts: a step is listed twice`);
    for (const st of steps) assert.ok(existsSync(new URL(`applications/${name}/steps/${st}.ts`, ROOT)), `${name}/loop.ts: step '${st}' does not exist`);
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
