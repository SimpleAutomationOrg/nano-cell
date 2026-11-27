// A cell is a robot with an application set up on it (viewer/cell-data.js).
// These hold the two halves apart: the application must stay movable to
// another robot, and a robot that cannot run it must say why.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { composeCell, loadCell } from '../viewer/cell-data.js';

const ROOT = new URL('..', import.meta.url);
const readJson = async p => JSON.parse(readFileSync(new URL(p, ROOT)));
const APP = 'case-assembly';
const application = { ...await readJson(`applications/${APP}/application.json`), id: APP };
const robot = { ...await readJson(`robots/${application.robot}/robot.json`), id: application.robot };

test('every application composes onto its robot, and every mesh it names exists', async () => {
  for (const name of readdirSync(new URL('applications/', ROOT))) {
    if (!existsSync(new URL(`applications/${name}/application.json`, ROOT))) continue;
    const cell = await loadCell(readJson, name);
    for (const it of [...cell.fixtures, ...cell.parts, ...cell.tools, ...cell.flange_stack]) {
      for (const k of ['mesh', 'collision_mesh']) {
        if (it[k]) assert.ok(existsSync(new URL(it[k], ROOT)), `${name}: ${it.id} ${k} ${it[k]} is missing`);
      }
    }
    // tasks belong to the application and use its grippers
    const tdir = new URL(`applications/${name}/tasks/`, ROOT);
    for (const t of existsSync(tdir) ? readdirSync(tdir) : []) {
      if (!existsSync(new URL(`${t}/task.json`, tdir))) continue;
      const task = await readJson(`applications/${name}/tasks/${t}/task.json`);
      assert.ok(cell.tools.some(x => x.id === task.tool), `${name}/${t}: tool '${task.tool}' is not a gripper of the application`);
      for (const s of task.segments) assert.ok(existsSync(new URL(`${t}/segments/${s}`, tdir)), `${name}/${t}: ${s} is missing`);
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
