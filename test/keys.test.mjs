// Keyboard shortcuts of the viewer (viewer/keys.js). Run with: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { physicalKey, shortcutKey, flyDirection, FLY_KEYS } from '../viewer/keys.js';

const near = (a, b, msg) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-9, `${msg ?? ''} got [${a}] want [${b}]`));
// a key press as the browser reports it: the character printed, and the physical key
const press = (key, code, extra = {}) => ({ key, code, target: { tagName: 'BODY' }, ...extra });

test('fly keys move relative to the CAMERA: W/S up and down the screen, A/D across it, E/Q into and out of it', () => {
  // camera looking level along -z: screen-up is the world's up
  const FWD = [0, 0, -1], RIGHT = [1, 0, 0];
  const fly = (...keys) => flyDirection(new Set(keys), FWD, RIGHT);
  near(fly('w'), [0, 1, 0]);
  near(fly('s'), [0, -1, 0]);
  near(fly('d'), [1, 0, 0]);
  near(fly('a'), [-1, 0, 0]);
  near(fly('e'), [0, 0, -1]);
  near(fly('q'), [0, 0, 1]);
  near(fly('w', 'd'), [1, 1, 0], 'two keys add up');
  near(fly('w', 's'), [0, 0, 0], 'opposite keys cancel');
  near(fly(), [0, 0, 0]);
  // regression: W/S followed the WORLD's vertical whatever the view. With
  // the camera pitched 45 deg down, up-on-screen leans forward; looking
  // straight down it lies flat — W then slides the view, it does not lift
  const r = Math.SQRT1_2;
  near(flyDirection(new Set(['w']), [0, -r, -r], RIGHT), [0, r, -r], 'pitched 45 deg down:');
  near(flyDirection(new Set(['w']), [0, -1, 0], RIGHT), [0, 0, -1], 'looking straight down:');
  near(flyDirection(new Set(['s']), [0, -1, 0], RIGHT), [0, 0, 1], 'looking straight down:');
  // and W is always square to the view direction and to "right"
  const w = flyDirection(new Set(['w']), [0.6, -0.48, -0.64], [0.7295372041, 0, 0.6839411288]);
  assert.ok(Math.abs(w[0] * 0.6 + w[1] * -0.48 + w[2] * -0.64) < 1e-6, 'W must not move along the view direction');
});

test('WASD work under any keyboard layout, with Shift and with Caps Lock', () => {
  // regression: the keys were matched by the CHARACTER they print, so
  // under a Cyrillic layout (W prints ц, A ф, S ы, D в) flying was dead
  for (const [char, code, want] of [['ц', 'KeyW', 'w'], ['ф', 'KeyA', 'a'], ['ы', 'KeyS', 's'], ['в', 'KeyD', 'd'],
    ['W', 'KeyW', 'w'], ['w', 'KeyW', 'w'], ['Ц', 'KeyW', 'w']]) {
    const k = shortcutKey(press(char, code));
    assert.equal(k, want, `${char} (${code})`);
    assert.ok(FLY_KEYS.has(k));
    assert.equal(physicalKey(press(char, code)), want, 'key-up must release the same key');
  }
  // an event without a physical code (synthetic, old browser) still works by character
  assert.equal(shortcutKey(press('w', undefined)), 'w');
  // named keys pass through for the part-push shortcuts
  assert.equal(shortcutKey(press('ArrowUp', 'ArrowUp')), 'ArrowUp');
  assert.equal(shortcutKey(press('Escape', 'Escape')), 'Escape');
  assert.equal(shortcutKey(press('я', 'KeyZ')), 'z', 'press-down key under a Cyrillic layout');
});

test('typing in a field or using a system shortcut never moves the camera', () => {
  for (const tagName of ['TEXTAREA', 'INPUT', 'SELECT'])
    assert.equal(shortcutKey(press('w', 'KeyW', { target: { tagName } })), null, `typing in a ${tagName}`);
  assert.equal(shortcutKey(press('w', 'KeyW', { target: { tagName: 'DIV', isContentEditable: true } })), null);
  assert.equal(shortcutKey(press('s', 'KeyS', { metaKey: true })), null, 'Cmd+S is not "sink"');
  assert.equal(shortcutKey(press('a', 'KeyA', { ctrlKey: true })), null);
  assert.equal(shortcutKey(press('d', 'KeyD', { altKey: true })), null);
  // a button or the page itself does not swallow the keys
  assert.equal(shortcutKey(press('w', 'KeyW', { target: { tagName: 'BUTTON' } })), 'w');
  assert.equal(shortcutKey(press('w', 'KeyW', { target: null })), 'w');
});
