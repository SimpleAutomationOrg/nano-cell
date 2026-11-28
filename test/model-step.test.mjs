// The CAD designer's tools: a model in code becomes a print STEP the mesh
// pipeline reads back with the same bodies and sizes; a STEP is measured
// from its exact surfaces; and geometry is drawn to a picture.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const run = (script, ...args) => execFileSync('node', [join(ROOT, 'scripts', script), ...args], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

test('model-step writes a STEP with true curved faces that step-to-mesh reads back, body for body', () => {
  const dir = mkdtempSync(join(tmpdir(), 'model-step-'));
  try {
    writeFileSync(join(dir, 'nest.model.mjs'), `export default r => {
      const plate = r.drawRoundedRectangle(100, 75, 4).sketchOnPlane('XY').extrude(8);
      const pocket = r.makeBaseBox(60.4, 40.4, 5).translate([0, 0, 3]);
      const bore = r.makeCylinder(3.3, 8, [37.5, 25, 0], [0, 0, 1]);
      return [{ name: 'nest', color: [0.2, 0.6, 0.3], shape: plate.cut(pocket).cut(bore) },
              { name: 'pin', shape: r.makeCylinder(2, 12, [-40, -25, 8], [0, 0, 1]) }];
    };`);
    const built = run('model-step.mjs', join(dir, 'nest.model.mjs'));
    // plate (rounded corners) minus the pocket minus the bore
    const volume = (100 * 75 - 16 * (4 - Math.PI)) * 8 - 60.4 * 40.4 * 5 - Math.PI * 3.3 ** 2 * 8;
    const said = Number(built.match(/^nest: 100\.000 x 75\.000 x 8\.000 mm.*volume ([\d.]+) mm3$/m)?.[1]);
    assert.ok(Math.abs(said - volume) < 0.5, `the nest's volume should be ${volume.toFixed(1)} mm3 (both cuts applied), the tool said: ${built}`);
    assert.match(readFileSync(join(dir, 'nest.step'), 'utf8'), /CYLINDRICAL_SURFACE/, 'a bore must be a true cylinder in the STEP, not facets');
    const listed = run('step-to-mesh.mjs', join(dir, 'nest.step'), '--list');
    assert.match(listed, /^nest: 100\.000 x 75\.000 x 8\.000 mm/m, 'the body keeps its name and size through the mesh pipeline');
    assert.match(listed, /^pin: /m);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('model-step refuses a body that a cut emptied, instead of writing a STEP of nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'model-step-'));
  try {
    writeFileSync(join(dir, 'gone.model.mjs'), `export default r => r.makeBaseBox(10, 10, 10).cut(r.makeBaseBox(20, 20, 20));`);
    assert.throws(() => run('model-step.mjs', join(dir, 'gone.model.mjs')), /empty|failed in the CAD kernel/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('inspect-step measures a bore exactly and says how two parts sit together', () => {
  const dir = mkdtempSync(join(tmpdir(), 'inspect-step-'));
  try {
    writeFileSync(join(dir, 'nest.model.mjs'), `export default r => r.makeBaseBox(100, 75, 8)
      .cut(r.makeBaseBox(60.4, 40.4, 5).translate([0, 0, 3])).cut(r.makeCylinder(3.3, 8, [37.5, 25, 0], [0, 0, 1]));`);
    // the part: 0.2 mm clear of the pocket walls, lifted 1 mm off its floor
    writeFileSync(join(dir, 'part.model.mjs'), `export default r => r.makeBaseBox(60, 40, 10).translate([0, 0, 4]);`);
    // and one too wide for the pocket
    writeFileSync(join(dir, 'wide.model.mjs'), `export default r => r.makeBaseBox(62, 40, 10).translate([0, 0, 4]);`);
    for (const m of ['nest', 'part', 'wide']) run('model-step.mjs', join(dir, `${m}.model.mjs`));
    const said = run('inspect-step.mjs', join(dir, 'nest.step'), '--fit', join(dir, 'part.step'));
    assert.match(said, /^body 1: 100\.000, 75\.000, 8\.000 mm/m);
    assert.match(said, /bore dia 6\.600 {2}axis \(0\.00, 0\.00, 1\.00\) {2}from \(37\.500, 25\.000, 0\.000\) to \(37\.500, 25\.000, 8\.000\) {2}length 8\.000/, 'the M6 clearance bore: its true diameter, axis and ends');
    assert.match(said, /flat face {2}normal \(0\.00, 0\.00, 1\.00\) {2}at 3\.000 along it/, 'the pocket floor, 3 mm up');
    assert.match(said, /clear: the smallest gap between them is 0\.200 mm/, 'the part sits 0.2 mm clear of the pocket walls');
    const clash = run('inspect-step.mjs', join(dir, 'nest.step'), '--fit', join(dir, 'wide.step'));
    // 0.8 mm too wide each side, over the pocket's 40 mm and the 4 mm of wall above the part's base
    assert.match(clash, /THEY INTERFERE: (\d+\.\d+) mm3/);
    assert.ok(Math.abs(Number(clash.match(/INTERFERE: ([\d.]+)/)[1]) - 2 * 0.8 * 40 * 4) < 0.5, clash);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('look draws a part, and an application\'s layout, to a picture that has something in it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'look-'));
  try {
    writeFileSync(join(dir, 'p.model.mjs'), `export default r => r.makeBaseBox(40, 30, 10).cut(r.makeCylinder(5, 10, [0, 0, 0], [0, 0, 1]));`);
    run('model-step.mjs', join(dir, 'p.model.mjs'));
    for (const [what, out] of [[join(dir, 'p.step'), 'part.png'], ['applications/case-assembly', 'layout.png']]) {
      const said = run('look.mjs', what, join(dir, out));
      assert.match(said, /top-left isometric.*top-right top.*One scale: [\d.]+ px per mm/s, 'it says which view is where, and the scale');
      const png = readFileSync(join(dir, out));
      assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], 'a PNG file');
      assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1520, 1120], 'four 760 x 560 views');
      assert.ok(png.length > 6000, `${out} is ${png.length} bytes: a blank sheet`);
    }
    assert.throws(() => run('look.mjs', join(dir, 'nothing.step'), join(dir, 'x.png')), /could not read/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
