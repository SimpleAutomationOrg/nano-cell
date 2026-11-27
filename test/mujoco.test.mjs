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
  // the tools resting in the rack are obstacles too: above the small
  // cup's stand, 3 cm short of docking, the arm side meets that tool
  world.setArm([-33.3756, -110.0176, -103.6279, -56.3347, 90.0489, -146.0996].map(d2r));
  const overCup = world.contacts(0.03).filter(c => c.a.startsWith('arm:') || c.b.startsWith('arm:'));
  assert.ok(overCup.some(c => (c.a + c.b).includes('rcup6_p0')), `a docked tool is an obstacle: ${overCup.map(c => c.a + '/' + c.b)}`);
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

test('touch: a held part stops on ANOTHER PART lying below it, not on the floor under that part', { skip: !mj }, async () => {
  const { createMjWorld } = await import('../viewer/mj-world.js');
  // regression: the query model has no part-part collision pairs, so a
  // held case passed straight through a case already in the pocket and
  // "touched" the pocket floor beneath it
  const mount = cell.arm.mount_table;
  const HOME = [-95.8, -109.03, -35.38, -125.69, 89.91, 61.48].map(d2r);
  const rel = IK.translate([0, 0, 0.16]);
  const mountMat = IK.fromXyzRpy(mount.xyz_m, mount.rpy);
  const pm0 = IK.mul(IK.mul(mountMat, IK.fkFlange(HOME)), rel);
  const zeroPose = { xyz_m: [0, 0, 0], rpy: [0, 0, 0] };
  const slab = [{ center: [0, 0, 0], size: [0.04, 0.04, 0.006] }];
  const synth = {
    arm: cell.arm, tools: cell.tools, cameras: [],
    fixtures: [{ id: 'floor', pose_table: zeroPose, boxes: [{ center: [0.85, 0.25, 0.02], size: [0.8, 0.8, 0.06] }] }],
    parts: [
      { id: 'held', pose_table: { xyz_m: [0.3, 0.5, 0.05], rpy: [0, 0, 0] }, boxes: slab },
      // already lying on the floor (its top at z=0.056), under the held
      // one and a few mm off — real placements are never exactly aligned
      { id: 'lying', pose_table: { xyz_m: [pm0[3] + 0.003, pm0[7] - 0.002, 0.053], rpy: [0, 0, 0] }, boxes: slab },
    ],
  };
  const world = await createMjWorld({ mj, cellData: synth, armCapsules: [], toolCapsules: [], loadStlBuffer: async () => { throw new Error('no meshes'); } });
  const planner = createPlanner({ cellData: synth, mountMat, getToolId: () => 'rcup16_p0', mjWorld: () => world });
  const res = planner.planUntilTouch(HOME, [0, 0, -1], { maxDist: 0.3, held: { id: 'held', rel } });
  assert.equal(res.item, 'lying', `stopped on '${res.item}' — the part lying below must stop the move`);
  const pmEnd = IK.mul(IK.mul(mountMat, IK.fkFlange(res.path[res.path.length - 1])), rel);
  const gap = (pmEnd[11] - 0.003) - 0.056;      // held underside above the lying part's top
  assert.ok(gap > 0, `went ${(-gap * 1000).toFixed(1)} mm into the part below`);
  assert.ok(gap < 0.005, `stopped ${(gap * 1000).toFixed(1)} mm above the part below — too high`);
  // …and when released there it must come to rest ON that part, not be
  // lowered through it (the settle's square-up step once ignored parts)
  world.setPartPose('held', pmEnd);
  const settled = world.settlePart('held');
  const under = (settled?.pose ?? world.readPartPose('held'))[11] - 0.003;
  assert.ok(Math.abs(under - 0.056) < 1e-3,
    `released part rests with its underside at ${(under * 1000).toFixed(2)} mm — the part below tops out at 56.00`);
});

test('drop test: a released case falls INTO the pocket and seats on its floor', { skip: !mj }, async () => {
  const { createMjWorld } = await import('../viewer/mj-world.js');
  const world = await createMjWorld({
    mj, cellData: cell, armCapsules: [], toolCapsules: [],
    loadStlBuffer: async p => readStl(p),
  });
  // The pose the arm really lets go at (captured from the viewer's drop
  // demo: case flat, upside down, 120 mm above the pocket, ~0.2 deg
  // off-square), then made WORSE: turned end-for-end, yawed, shifted —
  // all about the case's measured centre, not its CAD origin.
  // Two regressions live here:
  //  - with MuJoCo's default slow-spring contact the case reached the
  //    6 mm pocket floor at 1.5 m/s and went straight through it;
  //  - with ~0.1 mm clearance per side, an off-square case tipped and
  //    wedged a few mm above the floor (the box model has stair-steps
  //    where the real parts have chamfers) — settle now squares it up.
  const RELEASE = [
    -0.9999944964343017, 0.003317695140755128, 2.4781328796414203e-7, 0.9002326400330014,
    0.0033176951429548943, 0.9999944963894115, 0.000009477635979200905, 0.08740166683600563,
    -2.1636801726226562e-7, 0.000009478405987350463, -0.9999999999550571, 0.1330620677464584,
    0, 0, 0, 1];
  const pts = world.probePoints('front_case_1');
  // centre of the case's bounding box — NOT the mean of the points, which
  // leans toward wherever the mesh has more detail
  const gc = [0, 1, 2].map(k => (Math.min(...pts.map(p => p[k])) + Math.max(...pts.map(p => p[k]))) / 2);
  const centre = M => [0, 1, 2].map(r => M[r * 4] * gc[0] + M[r * 4 + 1] * gc[1] + M[r * 4 + 2] * gc[2] + M[r * 4 + 3]);
  const C = centre(RELEASE);
  const variant = (deg, dx) => {             // yaw about the centre, then shift
    const T = IK.mul(IK.fromXyzRpy([C[0] + dx, C[1], 0], [0, 0, deg * Math.PI / 180]), IK.fromXyzRpy([-C[0], -C[1], 0], [0, 0, 0]));
    return IK.mul(T, RELEASE);
  };
  const drops = [['as released', 0, 0], ['end-for-end', 180, 0], ['+0.5 deg', 0.5, 0], ['-0.5 deg', -0.5, 0], ['0.3 mm off', 0, 3e-4]];
  for (const [name, deg, dx] of drops) {
    world.setPartPose('front_case_1', variant(deg, dx));
    const settled = world.settlePart('front_case_1', { duration: 1.5 });
    assert.ok(settled?.pose, `${name}: settle returned nothing`);
    assert.ok(settled.traj.length > 5, 'trajectory must have samples to animate');
    const M = settled.pose;
    const E = centre(M), dxy = Math.hypot(E[0] - C[0], E[1] - C[1]);
    assert.ok(dxy < 0.003, `${name}: ended ${(dxy * 1000).toFixed(1)} mm from where it was dropped`);
    // underside (lowest measured point) on the pocket floor, 6.1 mm up
    const zs = world.probePoints('front_case_1').map(p => M[8] * p[0] + M[9] * p[1] + M[10] * p[2] + M[11]);
    const under = Math.min(...zs), tilt = Math.max(...zs) - under - 0.0058;
    assert.ok(under > 0.0055 && under < 0.0068,
      `${name}: underside at ${(under * 1000).toFixed(2)} mm — the pocket floor is at 6.1`);
    assert.ok(tilt < 1e-3, `${name}: lies tilted by ${(tilt * 1000).toFixed(2)} mm`);
    // and it never dipped through the floor on the way (origin ~11 mm above the underside)
    const low = Math.min(...settled.traj.map(s => s.mat[11]));
    assert.ok(low > 0.012, `${name}: sank to z=${(low * 1000).toFixed(1)} mm — through the pocket floor`);
  }
});

test('settle: a part with nothing below it is reported, not left falling', { skip: !mj }, async () => {
  const { createMjWorld } = await import('../viewer/mj-world.js');
  const world = await createMjWorld({
    mj, cellData: cell, armCapsules: [], toolCapsules: [],
    loadStlBuffer: async p => readStl(p),
  });
  const out = IK.fromXyzRpy([3, 3, 0.2], [0, 0, 0]);       // far outside the cell
  world.setPartPose('front_case_1', out);
  assert.throws(() => world.settlePart('front_case_1'), /fell out of the cell/);
  const after = world.readPartPose('front_case_1');
  assert.ok(Math.abs(after[11] - 0.2) < 1e-6, 'the part must be put back where it was released');
  // and the speed it picked up must not leak into the next settle
  world.setPartPose('front_case_1', IK.mul(IK.fromXyzRpy([0.8982, 0.0864, 0.0138 + 0.12], [0, 0, -1.572]),
    IK.fromXyzRpy([0, 0, 0], [Math.PI, 0, 0])));
  const again = world.settlePart('front_case_1');
  assert.ok(again?.pose && again.pose[11] > 0.012, 'a later drop must start from rest');
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

test('the case FITS the holder pocket: clearance, seats on the floor under its own weight', { skip: !mj }, async () => {
  const { createMjWorld } = await import('../viewer/mj-world.js');
  // The pocket is a clearance fit (74.5 x 48.1 mm for a 74.1 x 47.8 mm
  // case, per the print files). A decimated collision mesh once skewed
  // its walls up to 1 mm inward, which read as a 0.3 mm interference
  // "snap fit": the case hung on the walls at hundreds of newtons and
  // never reached the floor. Meshes come from the print STEP files —
  // regenerate with scripts/step-to-mesh.mjs if this fails.
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
  assert.ok(best.pen < 2e-5, `the case does not fit the pocket: ${(best.pen * 1000).toFixed(3)} mm overlap at the best pose`);
  const pose = IK.mul(IK.mul(H, IK.translate([best.dx, best.dy, zoff])), Hrot);
  world.setPartPose('front_case_1', pose);
  const settled = world.settlePart('front_case_1', { duration: 1.5 });
  assert.ok(settled?.pose, 'settle found no rest pose in a clearance pocket');
  const after = world.readPartPose('front_case_1');
  const dxy = Math.hypot(after[3] - pose[3], after[7] - pose[7]);
  assert.ok(dxy < 1e-3, `settle dragged the case ${(dxy * 1000).toFixed(2)} mm sideways`);
  const mine = world.contacts(0).filter(c => c.a === 'front_case_1' || c.b === 'front_case_1');
  assert.ok(mine.some(c => Math.abs(c.normalAB[2]) > 0.7), 'the case must rest ON the pocket floor');
  // nothing but its 20 g weight (0.2 N) should be pressing on it
  const load = world.contactForces()
    .filter(c => (c.a + c.b).includes('front_case_1') && (c.a + c.b).includes('holder'))
    .reduce((t, c) => t + c.fn, 0);
  assert.ok(load < 2, `the holder presses on the case with ${load.toFixed(1)} N — it should only carry its weight`);
});

test('pushPart: a firm press seats a press fit, a gentle nudge is blocked by walls', { skip: !mj }, async () => {
  const { createMjWorld } = await import('../viewer/mj-world.js');
  const zeroPose = { xyz_m: [0, 0, 0], rpy: [0, 0, 0] };
  const synth = {
    arm: cell.arm, tools: cell.tools, cameras: [],
    fixtures: [
      { id: 'floor', pose_table: zeroPose, boxes: [{ center: [0.85, 0.25, 0.02], size: [0.8, 0.8, 0.06] }] },
      { id: 'wallA', pose_table: zeroPose, boxes: [{ center: [0.83, 0.25, 0.175], size: [0.02, 0.1, 0.25] }] },
      { id: 'wallB', pose_table: zeroPose, boxes: [{ center: [0.8804, 0.25, 0.175], size: [0.02, 0.1, 0.25] }] },
    ],
    parts: [
      { id: 'slab', pose_table: { xyz_m: [0.8552, 0.25, 0.0585], rpy: [0, 0, 0] },
        boxes: [{ center: [0, 0, 0], size: [0.0308, 0.04, 0.01] }] },   // 0.2 mm squeeze per side
    ],
  };
  const world = await createMjWorld({ mj, cellData: synth, armCapsules: [], toolCapsules: [], loadStlBuffer: async () => { throw new Error('no meshes'); } });
  // firm press down: must reach the floor (bottom = part centre - 5 mm -> 0.05)
  const r1 = world.pushPart('slab', [0, 0, -1], 0.01, { force: 30 });
  const z1 = world.readPartPose('slab')[11];
  assert.ok(r1.moved > 2e-3, `press only moved ${(r1.moved * 1000).toFixed(2)} mm`);
  assert.ok(Math.abs(z1 - 0.055) < 1e-3, `did not seat on the floor: centre z=${(z1 * 1000).toFixed(2)} mm`);
  // gentle sideways nudge: the wall must block it (squeeze is only 0.2 mm)
  const r2 = world.pushPart('slab', [1, 0, 0], 0.005, { force: 8 });
  assert.ok(r2.moved < 1e-3, `wall did not block: moved ${(r2.moved * 1000).toFixed(2)} mm`);
  // and it must not have tunnelled out of the channel
  const x = world.readPartPose('slab')[3];
  assert.ok(Math.abs(x - 0.8552) < 1.5e-3, `slab left the channel: x=${(x * 1000).toFixed(2)} mm`);
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
