// Motion regression tests: every rule we established while building the
// viewer, as assertions. Run with:  node --test test/
// These run the pure planner (viewer/planner.js) against the real cell
// data, no browser and no collision meshes (geometry rules only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as IK from '../viewer/ik.js';
import { createPlanner, footprintAzimuth, dockedTools } from '../viewer/planner.js';
import { loadCell } from '../viewer/cell-data.js';

const d2r = d => d * Math.PI / 180;
const r2d = r => r * 180 / Math.PI;

const readJson = async p => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url)));
const cell = await loadCell(readJson, 'case-assembly');
const planner = createPlanner({
  cellData: cell,
  mountMat: IK.fromXyzRpy(cell.arm.mount_table.xyz_m, cell.arm.mount_table.rpy),
  getToolId: () => 'rcup16_p0',
});

const HOME = [-95.8, -109.03, -35.38, -125.69, 89.91, 61.48].map(d2r);
const item = it => ({ ...it, matrix: IK.fromXyzRpy(it.pose_table.xyz_m, it.pose_table.rpy) });
const CASE1 = item(cell.parts.find(p => p.id === 'front_case_1'));
const HOLDER = item(cell.fixtures.find(f => f.id === 'holder'));

const j6Profile = path => {
  let travel = 0, reversals = 0, dir = 0;
  const legs = [];
  for (let i = 1; i < path.length; i++) {
    const d = r2d(path[i][5] - path[i - 1][5]);
    legs.push(Math.abs(d));
    travel += Math.abs(d);
    if (Math.abs(d) < 1) continue;
    const nd = Math.sign(d);
    if (dir !== 0 && nd !== dir) reversals++;
    dir = nd;
  }
  return { travel, reversals, legs };
};

test('IK round-trip stays sub-millimetre and inside limits', () => {
  let fails = 0, worst = 0;
  for (let t = 0; t < 100; t++) {
    const q = [0, 1, 2, 3, 4, 5].map(i =>
      d2r((Math.random() * 2 - 1) * 80) + [0, -90, -45, -45, 90, 0][i] * Math.PI / 180);
    const seed = q.map(v => v + d2r((Math.random() * 2 - 1) * 8));
    try {
      const sol = IK.ikNear(IK.fkFlange(q), seed);
      const p1 = IK.pos(IK.fkFlange(sol)), p0 = IK.pos(IK.fkFlange(q));
      worst = Math.max(worst, Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]));
      sol.forEach((v, j) => assert.ok(
        v >= IK.CHAIN[j].lim[0] - 1e-6 && v <= IK.CHAIN[j].lim[1] + 1e-6, `J${j + 1} out of limits`));
    } catch { fails++; }
  }
  assert.ok(fails <= 5, `${fails}/100 IK failures`);
  assert.ok(worst < 5e-4, `worst position error ${worst} m`);
});

test('suction grasp: cup lip parallel to the part face', () => {
  const pose = planner.suctionGrasp(CASE1, 0.002);
  // face outward normal = -z of the part frame; cup (pose z) must oppose it
  const n = IK.axis(CASE1.matrix, 2).map(v => -v);
  const z = IK.axis(pose, 2);
  const dot = z[0] * n[0] + z[1] * n[1] + z[2] * n[2];
  assert.ok(dot < -0.999998, `cup axis vs face normal: dot=${dot}`); // anti-parallel < 0.1°
});

test('suction grasp: wrist camera parallel to the breadboard, image down', () => {
  const pose = planner.suctionGrasp(CASE1, 0.06);
  const cam = cell.cameras.find(c => c.parent === 'flange');
  const R = IK.fromXyzRpy([0, 0, 0], cam.pose.rpy);
  const fl = IK.mul(pose, IK.invRigid(planner.toolTcp()));
  const rot = (m, v) => [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[4] * v[0] + m[5] * v[1] + m[6] * v[2],
    m[8] * v[0] + m[9] * v[1] + m[10] * v[2]];
  const xw = rot(fl, IK.axis(R, 0)), yw = rot(fl, IK.axis(R, 1));
  assert.ok(Math.abs(xw[2]) < 0.03, `horizon ${r2d(Math.asin(Math.abs(xw[2]))).toFixed(2)}° off level`);
  assert.ok(yw[2] < 0, 'image must look down, not up');
});

test('suction grasp stands off from the MEASURED face, not the CAD origin', () => {
  // a part whose exposed face (-z) lies 5 mm from its origin — like the
  // front case. Aiming the standoff at the origin once made a "2 mm"
  // approach a 7 mm air gap, which the vacuum seat closed as a visible jump.
  const pts = [];
  for (let x = -0.03; x <= 0.03; x += 0.005)
    for (let y = -0.02; y <= 0.02; y += 0.005)
      for (const z of [-0.005, 0.001]) pts.push([x, y, z]);
  const points = new Map([['slab', pts]]);
  const p = createPlanner({
    cellData: cell,
    mountMat: IK.fromXyzRpy(cell.arm.mount_table.xyz_m, cell.arm.mount_table.rpy),
    getToolId: () => 'rcup16_p0',
    mjWorld: () => ({ probePoints: id => points.get(id) ?? null }),
  });
  const item = { id: 'slab', matrix: IK.fromXyzRpy([0.5, 0.3, 0.1], [0, 0, 0]) };
  const pose = p.suctionGrasp(item, 0.01);     // 10 mm standoff requested
  // face plane along -z sits at origin z − 5 mm = 0.095; lip must be 10 mm past it
  const lipZ = IK.pos(pose)[2];
  assert.ok(Math.abs(lipZ - (0.095 - 0.01)) < 1e-6,
    `lip at z=${(lipZ * 1000).toFixed(1)} mm, expected 85.0 (face 95.0 − standoff 10)`);
  // and a part whose origin sits IN FRONT of its face (the front case):
  // the offset must go the other way, not be clamped to zero
  const pts2 = [];
  for (let x = -0.03; x <= 0.03; x += 0.005)
    for (let y = -0.02; y <= 0.02; y += 0.005)
      for (const z of [0.003, 0.009]) pts2.push([x, y, z]);
  points.set('slab2', pts2);
  const item2 = { id: 'slab2', matrix: IK.fromXyzRpy([0.5, 0.3, 0.1], [0, 0, 0]) };
  const lip2Z = IK.pos(p.suctionGrasp(item2, 0.01))[2];
  assert.ok(Math.abs(lip2Z - (0.103 - 0.01)) < 1e-6,
    `lip at z=${(lip2Z * 1000).toFixed(1)} mm, expected 93.0 (face 103.0 − standoff 10)`);
});

test('free transit: J6 never reverses direction mid-flight', () => {
  const target = planner.suctionGrasp(CASE1, 0.06);
  const plan = planner.planTransit(HOME, target, { spin: 'free' });
  const { reversals } = j6Profile(plan.path);
  assert.equal(reversals, 0, `J6 reversed ${reversals}×`);
});

test('exact transit: the re-spin blends into travel, no second move at the end', () => {
  // the regression: all yaw change dumped into the final leg ("two moves")
  const hp = IK.pos(HOLDER.matrix);
  const hx = IK.axis(HOLDER.matrix, 0);
  const target = IK.poseZDown([hp[0], hp[1], hp[2] + 0.15], Math.atan2(hx[1], hx[0]));
  const plan = planner.planTransit(HOME, target, { spin: 'exact' });
  const { travel, legs } = j6Profile(plan.path);
  if (travel > 30) {
    const maxLeg = Math.max(...legs);
    assert.ok(maxLeg < 0.5 * travel,
      `one leg carries ${maxLeg.toFixed(0)}° of ${travel.toFixed(0)}° total J6 — yaw dumped into a single move`);
  }
});

test('transit picks the fastest candidate and reports it', () => {
  const plan = planner.planTransit(HOME, planner.suctionGrasp(CASE1, 0.06), { spin: 'exact' });
  assert.equal(plan.name, 'direct'); // no obstacle world here: direct must win
  assert.ok(plan.est > 0 && plan.est < 10, `est ${plan.est}s`);
});

test('poseZDown yaw spins about the DOWNWARD axis: +yaw turns world azimuth NEGATIVE', () => {
  // the sign that once placed a case 36° across the pocket: a part hanging
  // under the cup rotates by MINUS the commanded yaw in world azimuth
  const az = pose => { const x = IK.axis(pose, 0); return Math.atan2(x[1], x[0]); };
  const a0 = az(IK.poseZDown([0.8, 0.3, 0.2], 0));
  const a1 = az(IK.poseZDown([0.8, 0.3, 0.2], d2r(30)));
  const d = Math.atan2(Math.sin(a1 - a0), Math.cos(a1 - a0));
  assert.ok(Math.abs(d + d2r(30)) < 1e-9, `yaw +30° moved azimuth by ${r2d(d)}°, expected −30°`);
});

test('footprint azimuth follows the EDGES, not the point distribution', () => {
  // the bug: PCA tilted ~9° off a rectangle's true edge when interior
  // features were asymmetric. The min-area rectangle must not.
  const pts = [];
  for (let x = -0.037; x <= 0.037; x += 0.004)       // 74 × 48 mm outline
    for (let y = -0.024; y <= 0.024; y += 0.004)
      if (Math.abs(x) > 0.033 || Math.abs(y) > 0.02) pts.push([x, y, 0]);
  for (let i = 0; i < 300; i++)                       // asymmetric interior blob
    pts.push([0.01 + Math.random() * 0.02, -0.015 + Math.random() * 0.01, 0]);
  const ident = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const az = footprintAzimuth(pts, ident);
  assert.ok(Math.abs(az) < d2r(1.1), `long edge measured at ${r2d(az).toFixed(1)}°, true 0°`);
  // rotated 30°: measurement must follow
  const rot = IK.fromXyzRpy([0, 0, 0], [0, 0, d2r(30)]);
  const az30 = footprintAzimuth(pts, rot);
  assert.ok(Math.abs(az30 - d2r(30)) < d2r(1.1), `rotated edge at ${r2d(az30).toFixed(1)}°, true 30°`);
});

test('leg timing respects the FR3 joint velocity limits', () => {
  const path = [HOME, HOME.map((v, i) => i === 0 ? v + Math.PI / 2 : v)]; // 90° J1 swing
  const dur = planner.legDurations(path, 1000); // absurd tip speed: joints must cap it
  assert.ok(dur[0] >= (Math.PI / 2) / 3.15 - 1e-9, `leg of ${dur[0]}s beats the J1 limit`);
});

test('stack picking takes the EXPOSED part, by position — never by id', () => {
  // the real 45° stack: six front cases leaning on the stop. The exposed
  // one is the last in the lean direction; once it is gone (carried off
  // to the holder) the next one becomes exposed.
  const ids = [1, 2, 3, 4, 5, 6].map(i => `front_case_${i}`);
  const item = id => {
    const it = cell.parts.find(p => p.id === id);
    return { id, matrix: IK.fromXyzRpy(it.pose_table.xyz_m, it.pose_table.rpy) };
  };
  const stackIt = cell.fixtures.find(f => f.id === 'stack_north');
  const stack = IK.fromXyzRpy(stackIt.pose_table.xyz_m, stackIt.pose_table.rpy);
  const all = ids.map(item);
  assert.equal(planner.exposedOnStack(all, stack).id, 'front_case_6');
  // case 6 has been carried away: far from the stack, so not a candidate
  const moved = all.map(p => p.id === 'front_case_6' ? { ...p, matrix: IK.translate([0.5, 0.4, 0.02]) } : p);
  assert.equal(planner.exposedOnStack(moved, stack).id, 'front_case_5');
  // nothing left near the stack
  assert.equal(planner.exposedOnStack(all.map(p => ({ ...p, matrix: IK.translate([0.5, 0.4, 0.02]) })), stack), null);
});

test('exact transit: when the short way round runs J6 into its limit, it goes the long way — no back-and-forth', () => {
  // captured from the place half of the pick-place step: after picking a front case the wrist
  // sits at J6 = +23°, and the pose over the holder needs J6 = +175°.
  // The shortest reorientation of the TIP turns J6 the other way, toward
  // -185° — past the limit — so the wrist wound 180° negative and then
  // spun 330° back in the last moment.
  const from = [-45.0, -95.6, -107.3, -74.9, 71.5, 23.3].map(d2r);
  const to = [-72.1, -113.5, -77.9, -76.6, 65.1, 174.7].map(d2r);
  const plan = planner.planTransit(from, planner.tipMatAt(to), { spin: 'exact' });
  const { reversals, travel } = j6Profile(plan.path);
  assert.equal(reversals, 0, `J6 reversed ${reversals}x over ${travel.toFixed(0)}° of travel`);
  assert.ok(travel < 200, `J6 travelled ${travel.toFixed(0)}° for a 151° change`);
});

test('tool rack: the tool of every stand rests in it except the one on the arm; far to near is medium cup, small cup, screwdriver', () => {
  const farToNear = id => dockedTools(cell, id).sort((a, b) => b.pose_table.xyz_m[1] - a.pose_table.xyz_m[1]).map(t => t.id);
  assert.deepEqual(farToNear(null), ['rcup16_p0', 'rcup6_p0', 'screwdriver_p0']);
  assert.deepEqual(farToNear('rcup16_p0'), ['rcup6_p0', 'screwdriver_p0'], 'the mounted tool is on the arm, not in its stand');
  // a docked tool hangs where the arm leaves it: its pose is the flange pose of the stand's return joints
  const mount = IK.fromXyzRpy(cell.arm.mount_table.xyz_m, cell.arm.mount_table.rpy);
  for (const s of cell.changer.stands) {
    const f = IK.pos(IK.mul(mount, IK.fkFlange(s.return_deg.map(d2r))));
    const off = Math.hypot(...f.map((v, k) => v - s.pose_table.xyz_m[k]));
    assert.ok(off < 0.002, `${s.name}: docked pose is ${(off * 1000).toFixed(1)} mm from where the arm docks`);
  }
});
