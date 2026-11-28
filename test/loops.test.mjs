// Every application's loop runs to its end — without the viewer.
//
// scripts/headless-cell.mjs builds the cell in node with the same planner,
// physics and step host the viewer uses, and runs the steps as written. So
// a change to the simulation, the robot or an application that breaks a
// loop fails here, with the viewer's own message, instead of waiting to be
// seen on screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { openCell } from '../scripts/headless-cell.mjs';

const APPS = new URL('../applications/', import.meta.url);
const apps = readdirSync(APPS).filter(a => existsSync(new URL(`${a}/application.json`, APPS))).sort();
let mj = true;
try { await import('@mujoco/mujoco'); } catch { mj = false; }

for (const app of apps) {
  const loop = JSON.parse(readFileSync(new URL(`${app}/application.json`, APPS), 'utf8')).loop?.steps ?? [];
  test(`${app}: the loop runs to its end (${loop.join(', ') || 'no steps'})`, { skip: !mj || !loop.length }, async () => {
    const cell = await openCell(app);
    const res = await cell.run(cell.loop);
    assert.ok(res.ok, `${app}: FAILED at ${res.step}: ${res.error}\n  ${res.log.slice(-8).join('\n  ')}`);
    assert.equal(res.held, null, `${app}: the loop ended with ${res.held} still on the tool`);
    // nothing fell out of the world or sank into the table
    for (const p of res.parts_moved) assert.ok(p.to_m[2] > -0.005 && p.to_m[2] < 0.6, `${app}: ${p.id} ended at z ${(p.to_m[2] * 1000).toFixed(1)} mm`);
  });
}

test('without the viewer a step ends where it ends in the viewer: the case goes from the stack into the holder', { skip: !mj }, async () => {
  // the numbers are what the viewer itself reports for this step (scripts/run-step.mjs case-assembly pick-place-case)
  const cell = await openCell('case-assembly');
  const res = await cell.run(['pick-place-case']);
  assert.ok(res.ok, res.error);
  assert.equal(res.parts_moved.length, 1);
  const p = res.parts_moved[0];
  assert.equal(p.id, 'front_case_6');
  const want = [0.5252, 0.0874, 0.0171];
  p.to_m.forEach((v, i) => assert.ok(Math.abs(v - want[i]) < 0.002, `${'xyz'[i]} ${(v * 1000).toFixed(1)} mm, the viewer puts it at ${(want[i] * 1000).toFixed(1)}`));
  // a failure reads as it does in the viewer, and names the step
  const bad = await cell.run(['pick-place-case', 'nope']);
  assert.match(bad.error, /no such step: nope/);
});
