// Exact-backend tests (MuJoCo). Skipped when @mujoco/mujoco is not
// installed — the sampled fallback keeps the viewer fully functional,
// so the dependency is optional by design.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as IK from '../viewer/ik.js';
import { parseBinaryStl } from '../viewer/stl.js';
import { boxify } from '../viewer/boxify.js';
import { createPlanner } from '../viewer/planner.js';

const d2r = d => d * Math.PI / 180;
const ROOT = new URL('..', import.meta.url).pathname;
const cell = JSON.parse(readFileSync(`${ROOT}cell/dvt01/cell.json`));
const readStl = p => {
  const r = readFileSync(`${ROOT}cell/dvt01/${p}`);
  return r.buffer.slice(r.byteOffset, r.byteOffset + r.byteLength);
};

let mj = null;
try {
  mj = await (await import('@mujoco/mujoco')).default();
} catch { /* not installed */ }

test('boxify preserves cavities (the holder pocket is real)', () => {
  const tris = parseBinaryStl(readStl('meshes/holder.collision.stl'));
  const boxes = boxify(tris);
  assert.ok(boxes.length > 5 && boxes.length < 100, `${boxes.length} boxes`);
  // cavity centre = footprint centre at mid-height; no box may contain it
  let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
  for (let i = 0; i < tris.length; i += 3) {
    minX = Math.min(minX, tris[i]); maxX = Math.max(maxX, tris[i]);
    minY = Math.min(minY, tris[i + 1]); maxY = Math.max(maxY, tris[i + 1]);
  }
  const p = [(minX + maxX) / 2, (minY + maxY) / 2, 0.0095];
  const inside = boxes.filter(b =>
    Math.abs(p[0] - b.center[0]) < b.size[0] / 2 &&
    Math.abs(p[1] - b.center[1]) < b.size[1] / 2 &&
    Math.abs(p[2] - b.center[2]) < b.size[2] / 2);
  assert.equal(inside.length, 0, 'a box fills the pocket cavity');
});

test('MuJoCo world: dock pose near the rack, home pose clean', { skip: !mj }, async () => {
  const { createMjWorld } = await import('../viewer/mj-world.js');
  const world = await createMjWorld({
    mj, cellData: cell,
    armCapsules: [
      { jointIdx: 1, a: [0, 0, 0.105], b: [-0.28, 0, 0.105], r: 0.05 },
      { jointIdx: 2, a: [0, 0, 0], b: [-0.24, 0, 0], r: 0.045 },
    ],
    toolCapsules: [{ a: [0.016, 0, 0.06], b: [0.016, 0, 0.15], r: 0.02 }],
    loadStlBuffer: async p => readStl(p),
  });
  world.setArm([-27.55, -93.04, -110.382, -66.561, 90.068, -140.229].map(d2r));
  const dock = world.contacts(0.005).filter(c => c.a.startsWith('arm:') || c.b.startsWith('arm:'));
  assert.ok(dock.some(c => (c.a + c.b).includes('rack_stand')), 'dock pose must be near a rack stand');
  world.setArm([-95.8, -109.03, -35.38, -125.69, 89.91, 61.48].map(d2r));
  const home = world.contacts(0.005).filter(c => c.a.startsWith('arm:') || c.b.startsWith('arm:'));
  assert.equal(home.length, 0, `home pose contacts: ${home.map(c => c.a + '/' + c.b)}`);
});

test('planner on the exact backend: clear transit passes, rack approach rejected', { skip: !mj }, async () => {
  const { createMjWorld } = await import('../viewer/mj-world.js');
  const toolCaps = [{ a: [0.016, 0, 0.06], b: [0.016, 0, 0.15], r: 0.02 }];
  const world = await createMjWorld({
    mj, cellData: cell,
    armCapsules: [
      { jointIdx: 1, a: [0, 0, 0.105], b: [-0.28, 0, 0.105], r: 0.05 },
      { jointIdx: 2, a: [0, 0, 0], b: [-0.24, 0, 0], r: 0.045 },
    ],
    toolCapsules: toolCaps,
    loadStlBuffer: async p => readStl(p),
  });
  const planner = createPlanner({
    cellData: cell,
    mountMat: IK.fromXyzRpy(cell.arm.mount_table.xyz_m, cell.arm.mount_table.rpy),
    getToolId: () => 'rcup16_p0',
    mjWorld: () => world,
    armCapsules: [
      { jointIdx: 1, a: [0, 0, 0.105], b: [-0.28, 0, 0.105], r: 0.05 },
      { jointIdx: 2, a: [0, 0, 0], b: [-0.24, 0, 0], r: 0.045 },
    ],
    getToolCapsules: () => toolCaps,
  });
  const HOME = [-95.8, -109.03, -35.38, -125.69, 89.91, 61.48].map(d2r);
  const scene = (cell.parts ?? []).map(it =>
    ({ id: it.id, mat: IK.fromXyzRpy(it.pose_table.xyz_m, it.pose_table.rpy) }));

  // a transfer above the open table must pass
  const plan = planner.planTransit(HOME, IK.poseZDown([0.75, 0.3, 0.2]), { scene });
  assert.ok(plan.path.length > 2);

  // driving the tool into the rack region must be rejected with the culprit
  assert.throws(
    () => planner.planTip(HOME, IK.poseZDown([1.23, 0.14, 0.05]), { scene }),
    e => /rack_stand|guard|collision/.test(String(e.message)),
    'rack approach must collide');
});
