// The viewer's keyboard shortcuts, as pure functions (tested in
// test/keys.test.mjs — no browser needed).

// The key an event stands for: letters by their PHYSICAL position on the
// keyboard ('w' is the key where W sits on a QWERTY board), everything
// else by name ('ArrowUp', 'Escape'). Going by the printed character
// instead made every letter shortcut dead under a non-Latin layout: the
// W key then reports 'ц', never 'w'.
export function physicalKey(ev) {
  const m = /^Key([A-Z])$/.exec(ev.code ?? '');
  if (m) return m[1].toLowerCase();
  const k = ev.key ?? '';
  return k.length === 1 ? k.toLowerCase() : k;
}

// The same, but null when the keystroke is not meant for the viewer: the
// user is typing in a field, or holding Ctrl / Cmd / Alt (a browser or
// system shortcut such as Cmd+S, not "sink").
export function shortcutKey(ev) {
  const t = ev.target;
  if (t && (/^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName ?? '') || t.isContentEditable)) return null;
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return null;
  return physicalKey(ev);
}

// Fly camera: W/S rise and sink, A/D strafe, E/Q forward and back.
export const FLY_KEYS = new Set(['w', 'a', 's', 'd', 'q', 'e']);

// Direction of flight for the keys held down, as a sum of the camera's
// forward / right / up unit vectors ([x, y, z] arrays). Not normalised;
// [0, 0, 0] when nothing (or opposite keys) is held.
export function flyDirection(keys, fwd, right, up) {
  const sum = [0, 0, 0];
  const add = (v, s) => { for (let i = 0; i < 3; i++) sum[i] += s * v[i]; };
  if (keys.has('w')) add(up, 1);
  if (keys.has('s')) add(up, -1);
  if (keys.has('d')) add(right, 1);
  if (keys.has('a')) add(right, -1);
  if (keys.has('e')) add(fwd, 1);
  if (keys.has('q')) add(fwd, -1);
  return sum;
}
