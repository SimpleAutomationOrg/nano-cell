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

test('touch on the exact backend: wall ignored, floor stops, settles close', { skip: !mj }, async () => {
  const { createMjWorld } = await import('../viewer/mj-world.js');
  // synthetic cell: a floor slab, a wall column 4 mm beside the falling
  // part's corner all the way down (tight insertion), and a slab part
  const mount = cell.arm.mount_table;
  const HOME = [-95.8, -109.03, -35.38, -125.69, 89.91, 61.48].map(d2r);
  const rel = IK.translate([0, 0, 0.16]);
  // where the part's +x+y corner travels, to plant the wall beside it
  const mountMat = IK.fromXyzRpy(mount.xyz_m, mount.rpy);
  const pm0 = IK.mul(IK.mul(mountMat, IK.fkFlange(HOME)), rel);
  const corner = [
    pm0[0] * 0.02 + pm0[1] * 0.02 + pm0[3],
    pm0[4] * 0.02 + pm0[5] * 0.02 + pm0[7]];
  const zeroPose = { xyz_m: [0, 0, 0], rpy: [0, 0, 0] };
  const synth = {
    arm: cell.arm, tools: cell.tools, cameras: [],
    fixtures: [
      { id: 'floor', pose_table: zeroPose, boxes: [{ center: [0.85, 0.25, 0.02], size: [0.8, 0.8, 0.06] }] },
      { id: 'wall', pose_table: zeroPose, boxes: [{ center: [corner[0] + 0.006, corner[1], 0.2], size: [0.004, 0.04, 0.3] }] },
    ],
    parts: [
      { id: 'slab', pose_table: { xyz_m: [0.3, 0.5, 0.05], rpy: [0, 0, 0] },
        boxes: [{ center: [0, 0, 0], size: [0.04, 0.04, 0.006] }] },
    ],
  };
  const world = await createMjWorld({ mj, cellData: synth, armCapsules: [], toolCapsules: [], loadStlBuffer: async () => { throw new Error('no meshes'); } });
  const planner = createPlanner({
    cellData: synth, mountMat, getToolId: () => 'rcup16_p0', mjWorld: () => world,
  });
  const res = planner.planUntilTouch(HOME, [0, 0, -1],
    { maxDist: 0.3, held: { id: 'slab', rel } });
  assert.equal(res.item, 'floor', `stopped on '${res.item}' — the wall must not stop the move`);
  const qEnd = res.path[res.path.length - 1];
  const pmEnd = IK.mul(IK.mul(mountMat, IK.fkFlange(qEnd)), rel);
  const bottom = pmEnd[11] - 0.003;             // slab half-thickness
  const gap = bottom - 0.05;                    // floor top
  assert.ok(gap > 0, 'must not penetrate the floor');
  assert.ok(gap < 0.005, `settled ${(gap * 1000).toFixed(1)} mm above the floor — too high`);
});

test('drop test: a released case falls and settles into the pocket', { skip: !mj }, async () => {
  const { createMjWorld } = await import('../viewer/mj-world.js');
  const world = await createMjWorld({
    mj, cellData: cell, armCapsules: [], toolCapsules: [],
    loadStlBuffer: async p => readStl(p),
  });
  // pocket centre from the holder pose (matches the live measurements)
  const HX = 0.8982, HY = 0.0864, RIM = 0.0138;
  // pose a case flat, 120 mm above the pocket, aligned to it
  const high = IK.mul(
    IK.fromXyzRpy([HX, HY, RIM + 0.12], [0, 0, -1.572 + Math.PI]),
    IK.fromXyzRpy([0, 0, 0], [Math.PI, 0, 0]));
  world.setPartPose('front_case_1', high);
  const settled = world.settlePart('front_case_1', { duration: 1.5 });
  assert.ok(settled?.pose, 'settle returned nothing');
  assert.ok(settled.traj.length > 5, 'trajectory must have samples to animate');
  const [x, y, z] = [settled.pose[3], settled.pose[7], settled.pose[11]];
  assert.ok(Math.hypot(x - HX, y - HY) < 0.02, `landed ${(Math.hypot(x - HX, y - HY) * 1000).toFixed(0)} mm off the pocket centre`);
  assert.ok(z < RIM + 0.01, `rested at z=${(z * 1000).toFixed(1)} mm — above the rim, not inside`);
  assert.ok(z > 0, 'fell through the floor');
});

test('settle of a press-fit part: slides straight down, no lateral ratchet', { skip: !mj }, async () => {
  const { createMjWorld } = await import('../viewer/mj-world.js');
  // a channel 0.4 mm NARROWER than the part (0.2 mm squeeze per side) —
  // the settle must lower it onto the floor WITHOUT walking it sideways
  // (the regression: coarse-step contact chatter ratcheted tight parts
  // ~1.4 mm into a wall)
  const zeroPose = { xyz_m: [0, 0, 0], rpy: [0, 0, 0] };
  const synth = {
    arm: cell.arm, tools: cell.tools, cameras: [],
    fixtures: [
      { id: 'floor', pose_table: zeroPose, boxes: [{ center: [0.85, 0.25, 0.02], size: [0.8, 0.8, 0.06] }] },
      { id: 'wallA', pose_table: zeroPose, boxes: [{ center: [0.83, 0.25, 0.175], size: [0.02, 0.1, 0.25] }] },
      { id: 'wallB', pose_table: zeroPose, boxes: [{ center: [0.8804, 0.25, 0.175], size: [0.02, 0.1, 0.25] }] },
    ],
    parts: [
      { id: 'slab', pose_table: { xyz_m: [0.8552, 0.25, 0.0565], rpy: [0, 0, 0] },
        boxes: [{ center: [0, 0, 0], size: [0.0308, 0.04, 0.01] }] },   // 30.8 vs 30.4 mm opening
    ],
  };
  const world = await createMjWorld({ mj, cellData: synth, armCapsules: [], toolCapsules: [], loadStlBuffer: async () => { throw new Error('no meshes'); } });
  const before = world.readPartPose('slab');
  const res = world.settlePart('slab', { duration: 1.5 });
  assert.ok(res?.pose, 'a symmetric squeeze must still settle onto the floor');
  const after = world.readPartPose('slab');
  const dxy = Math.hypot(after[3] - before[3], after[7] - before[7]);
  assert.ok(dxy < 2e-4, `part walked ${(dxy * 1000).toFixed(2)} mm sideways during settle`);
  assert.ok(before[11] - after[11] > 1e-3, 'part must have dropped onto the floor');
});

test('settle may only relax: a snap-fit case is never wedged deeper', { skip: !mj }, async () => {
  const { createMjWorld } = await import('../viewer/mj-world.js');
  // the real pocket is a SNAP fit: its end ledges leave the opening
  // ~0.3 mm narrower than the case corners, so rigid physics has no
  // penetration-free rest pose. Settling from the ideal insertion pose
  // must not deepen the overlap or drag the case sideways (the
  // regression: the case wedged to -2.6 mm, hanging on the walls at
  // ~500 N with the floor carrying nothing).
  const world = await createMjWorld({
    mj, cellData: cell, armCapsules: [], toolCapsules: [],
    loadStlBuffer: async p => readStl(p),
  });
  // measured best-fit insertion pose: case flat, long axis along the
  // pocket, translation scanned to minimise probe-point overlap with the
  // holder's wall boxes (the residual overlap IS the snap interference)
  const fix = cell.fixtures.find(f => f.id === 'holder');
  const H = IK.mul(IK.fromXyzRpy(fix.pose_table.xyz_m, [0, 0, 0]), IK.fromXyzRpy([0, 0, 0], fix.pose_table.rpy));
  const Hrot = IK.fromXyzRpy([0, 0, 0], [Math.PI, 0, Math.PI / 2]);
  const walls = [...world.getBoxes().get('holder')].filter(b => b.center[2] + b.size[2] / 2 > 0.0062);
  const loc = world.probePoints('front_case_1').map(p => [
    Hrot[0] * p[0] + Hrot[1] * p[1] + Hrot[2] * p[2],
    Hrot[4] * p[0] + Hrot[5] * p[1] + Hrot[6] * p[2],
    Hrot[8] * p[0] + Hrot[9] * p[1] + Hrot[10] * p[2]]);
  let zmin = Infinity;
  for (const p of loc) zmin = Math.min(zmin, p[2]);
  const zoff = 0.0077 - zmin;                       // bottom where a touch descent rests
  const maxPen = (dx, dy) => {
    let m = 0;
    for (const [x0, y0, z0] of loc) {
      const x = x0 + dx, y = y0 + dy, z = z0 + zoff;
      for (const b of walls) {
        const a = b.size[0] / 2 - Math.abs(x - b.center[0]); if (a <= 0) continue;
        const c = b.size[1] / 2 - Math.abs(y - b.center[1]); if (c <= 0) continue;
        const d = b.size[2] / 2 - Math.abs(z - b.center[2]); if (d <= 0) continue;
        const e = Math.min(a, c, d); if (e > m) m = e;
      }
    }
    return m;
  };
  let best = { pen: Infinity };
  for (let dx = -2e-3; dx <= 2e-3; dx += 1e-4)
    for (let dy = -2e-3; dy <= 2e-3; dy += 1e-4) {
      const p = maxPen(dx, dy);
      if (p < best.pen) best = { pen: p, dx, dy };
    }
  // the pocket IS tighter than the case — if this ever reads ~0 the
  // snap-fit premise (and this test's reason to exist) has changed
  assert.ok(best.pen > 1e-4 && best.pen < 1e-3, `snap interference ${(best.pen * 1000).toFixed(3)} mm`);
  const pose = IK.mul(IK.mul(H, IK.translate([best.dx, best.dy, zoff])), Hrot);
  world.setPartPose('front_case_1', pose);
  const penOf = () => {
    let p = 0;
    for (const c of world.contacts(0))
      if ((c.a === 'front_case_1' || c.b === 'front_case_1') && c.dist < p) p = c.dist;
    return p;
  };
  const pen0 = penOf();
  world.settlePart('front_case_1', { duration: 1.5 });
  const after = world.readPartPose('front_case_1');
  const pen1 = penOf();
  assert.ok(pen1 >= pen0 - 2e-4,
    `settle deepened the overlap: ${(pen0 * 1000).toFixed(2)} -> ${(pen1 * 1000).toFixed(2)} mm`);
  const dxy = Math.hypot(after[3] - pose[3], after[7] - pose[7]);
  assert.ok(dxy < 1e-3, `settle dragged the case ${(dxy * 1000).toFixed(2)} mm sideways`);
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
