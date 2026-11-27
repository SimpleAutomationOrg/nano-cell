// Motion regression tests: every rule we established while building the
// viewer, as assertions. Run with:  node --test test/
// These run the pure planner (viewer/planner.js) against the real cell
// data, no browser and no collision meshes (geometry rules only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as IK from '../viewer/ik.js';
import { createPlanner, footprintAzimuth } from '../viewer/planner.js';

const d2r = d => d * Math.PI / 180;
const r2d = r => r * 180 / Math.PI;

const cell = JSON.parse(readFileSync(new URL('../cell/dvt01/cell.json', import.meta.url)));
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

test('moveUntilTouch: firm directional contact, settles close, ignores side walls', () => {
  // synthetic scene: a floor of points at z = 0.05 under the descent, and a
  // WALL of points 4 mm beside one corner of the held part all the way
  // down — a tight-pocket insertion. The wall must never stop the move;
  // the floor must, and the part must settle within a few mm of it.
  const FLOOR_Z = 0.05;
  const mount = IK.fromXyzRpy(cell.arm.mount_table.xyz_m, cell.arm.mount_table.rpy);
  const rel = IK.translate([0, 0, 0.16]);   // part frame: 160 mm out along the flange
  const heldPts = [];
  for (let x = -0.02; x <= 0.02; x += 0.02)
    for (let y = -0.02; y <= 0.02; y += 0.02) heldPts.push([x, y, 0]);

  // where the part's corner point travels, to plant the wall 4 mm beside it
  const fl0 = IK.mul(mount, IK.fkFlange(HOME));
  const pm0 = IK.mul(fl0, rel);
  const corner = [
    pm0[0] * 0.02 + pm0[1] * 0.02 + pm0[3],
    pm0[4] * 0.02 + pm0[5] * 0.02 + pm0[7],
    pm0[8] * 0.02 + pm0[9] * 0.02 + pm0[11]];

  const obstacles = [];
  for (let x = 0.6; x <= 1.1; x += 0.005)
    for (let y = 0.0; y <= 0.5; y += 0.005) obstacles.push({ p: [x, y, FLOOR_Z], item: 'floor' });
  for (let z = FLOOR_Z; z <= corner[2]; z += 0.003)
    obstacles.push({ p: [corner[0] + 0.004, corner[1], z], item: 'wall' });

  const fakeWorld = {
    maxZ: FLOOR_Z, items: new Map(), maxZInCorridor: () => FLOOR_Z,
    hitCapsule: (a, b, r) => {
      let best = null;
      for (const o of obstacles) {
        const d = Math.hypot(o.p[0] - a[0], o.p[1] - a[1], o.p[2] - a[2]);
        if (d <= r && (!best || d < best.dist)) best = { point: o.p, item: o.item, dist: d };
      }
      return best;
    },
  };
  const p = createPlanner({
    cellData: cell,
    mountMat: mount,
    getToolId: () => 'rcup16_p0',
    world: fakeWorld,
    getToolCapsules: () => [],
  });
  const held = { id: 'part', rel, pts: heldPts };
  const res = p.planUntilTouch(HOME, [0, 0, -1], { maxDist: 0.3, held });
  assert.equal(res.item, 'floor', `stopped on '${res.item}', the wall must not stop the move`);
  // settle: the part's points end within a few mm of the floor, no penetration
  const qEnd = res.path[res.path.length - 1];
  const pmEnd = IK.mul(IK.mul(mount, IK.fkFlange(qEnd)), rel);
  const minZ = Math.min(...heldPts.map(pt => pmEnd[8] * pt[0] + pmEnd[9] * pt[1] + pmEnd[11]));
  const gap = minZ - FLOOR_Z;
  assert.ok(gap > 0, 'must not penetrate the floor');
  assert.ok(gap < 0.005, `settled ${(gap * 1000).toFixed(1)} mm above the floor — too high`);
  // and with no obstacles at all: full travel, item null
  const free = createPlanner({
    cellData: cell, mountMat: mount, getToolId: () => 'rcup16_p0', getToolCapsules: () => [],
  }).planUntilTouch(HOME, [0, 0, -1], { maxDist: 0.1, held });
  assert.equal(free.item, null);
  assert.ok(Math.abs(free.dist - 0.1) < 1e-9);
});

test('leg timing respects the FR3 joint velocity limits', () => {
  const path = [HOME, HOME.map((v, i) => i === 0 ? v + Math.PI / 2 : v)]; // 90° J1 swing
  const dur = planner.legDurations(path, 1000); // absurd tip speed: joints must cap it
  assert.ok(dur[0] >= (Math.PI / 2) / 3.15 - 1e-9, `leg of ${dur[0]}s beats the J1 limit`);
});
