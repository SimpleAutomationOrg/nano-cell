// Keyboard shortcuts of the viewer (viewer/keys.js). Run with: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { physicalKey, shortcutKey, flyDirection, FLY_KEYS } from '../viewer/keys.js';

const FWD = [0, 0, -1], RIGHT = [1, 0, 0], UP = [0, 1, 0];
const fly = (...keys) => flyDirection(new Set(keys), FWD, RIGHT, UP);
// a key press as the browser reports it: the character printed, and the physical key
const press = (key, code, extra = {}) => ({ key, code, target: { tagName: 'BODY' }, ...extra });

test('fly keys: W/S rise and sink, A/D strafe, E/Q forward and back', () => {
  assert.deepEqual(fly('w'), [0, 1, 0]);
  assert.deepEqual(fly('s'), [0, -1, 0]);
  assert.deepEqual(fly('d'), [1, 0, 0]);
  assert.deepEqual(fly('a'), [-1, 0, 0]);
  assert.deepEqual(fly('e'), [0, 0, -1]);
  assert.deepEqual(fly('q'), [0, 0, 1]);
  assert.deepEqual(fly('w', 'd'), [1, 1, 0], 'two keys add up');
  assert.deepEqual(fly('w', 's'), [0, 0, 0], 'opposite keys cancel');
  assert.deepEqual(fly(), [0, 0, 0]);
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
