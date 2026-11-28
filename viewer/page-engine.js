// The engine of the shareable edition: what viewer/serve.py is to the other
// two editions, written for the page itself. The page's requests arrive
// through the same seam (viewer/desktop-bridge.js, engineFetch) and are
// answered here from the virtual file system (viewer/page-fs.js) — with the
// same statuses, the same JSON and the same words as the server gives,
// because the page shows those words. viewer/serve.py, appfiles.py and
// runs.py are the reference; test/page-engine.test.mjs puts the two side by
// side, request by request.
//
// No DOM in here: it runs under node, where the tests drive it.
import { toBase64 } from './desktop-bridge.js';
import { zipRead, zipWrite } from './zip.js';

// the literal '/__…' prefixes this engine answers (the build checks the
// viewer's requests against this list)
export const ROUTES = [
  '/__reload',
  '/__applications', '/__applications/new', '/__applications/export', '/__applications/import',
  '/__steps', '/__loop/save',
  '/__run/next', '/__run/request', '/__run/result', '/__run/record', '/__run/alive',
  '/__chat/agent', '/__chat/events', '/__chat/send', '/__chat/stop', '/__chat/new', '/__chat/upload',
];

const enc = new TextEncoder();
const EMPTY = new Uint8Array(0);

// ---- what the server's scan for the live reload looks at (serve.py) ----
const WATCH_EXT = new Set(['.html', '.js', '.ts', '.css', '.json', '.glb', '.stl', '.py']);
// (.incoming and .undo are this edition's own: an import being unpacked, and the earlier versions the assistant's undo keeps)
const SKIP_DIRS = new Set(['.git', 'node_modules', 'out', 'dist', '__pycache__', '.DS_Store', '.backups', 'chats', '.runs', 'runs', '.incoming', '.undo']);
const SKIP_FILES = new Set(['.chat-sessions.json', '.server.json', '.chat-models.json']);

const MATERIALS = 'materials';
const MAX_UPLOAD = 50_000_000;
const MAX_IMPORT = 1_000_000_000;
const MAX_JSON = 200_000, MAX_JSON_RUN = 8_000_000;      // a run's result may carry a picture

// ---- appfiles.py ----
const FORMAT = 1;
const EXTENSION = '.microfactory';
const EXPORT_SKIP_NAMES = new Set(['.DS_Store', 'Thumbs.db']);
const EXPORT_SKIP_DIRS = new Set(['__pycache__', '.git']);
const MAX_FILES = 20_000;
const MAX_UNPACKED = 2_000_000_000;
const ABOUT = 'An application: one job and its environment, in one folder that can be copied, saved and '
  + 'shared. This file says what it is; layout.json what stands where; grippers/ and items/ hold '
  + 'one folder per gripper and per kind of thing (its description and meshes); steps/ the steps; '
  + 'robots/ what was taught on a particular robot; print/ the CAD the items are made from; notes/ '
  + "the agent's notes; materials/ what was attached in the chat. Every pose is in the table frame, "
  + "so the application does not depend on which robot runs it; 'robot' names the one it is set up "
  + 'on now.';
const LAYOUT_ABOUT = 'What stands where: each fixture and part is a placement of an item (items/<item>/item.json '
  + 'says what the thing is; here is only which one, where, and what is particular to this '
  + 'placement), plus the stands of the tool rack and the gripper each one holds. Poses are in '
  + 'the table frame.';

// the types Python's server gives the files the page asks for (no call site
// reads them; kept the same so that nothing depends on which edition runs)
const MIME = {
  '.json': 'application/json', '.js': 'text/javascript', '.mjs': 'text/javascript', '.ts': 'video/mp2t',
  '.glb': 'model/gltf-binary', '.stl': 'application/vnd.ms-pki.stl', '.wasm': 'application/wasm',
  '.md': 'text/markdown', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml', '.txt': 'text/plain',
  '.py': 'text/x-python', '.pdf': 'application/pdf',
};

// ---- small things Python does its own way ----

// A path for the file system. page-fs reads what it is given the way a
// request is written (percent-decoded, cut at '?' and '#'), so a real name
// is encoded first: 'notes/50%.md' and 'a#b.txt' are files like any other.
const q = path => path.split('/').map(encodeURIComponent).join('/');

// str(x), for the few values that end up in a message or a name
const pyStr = v => (v === null || v === undefined ? 'None' : v === true ? 'True' : v === false ? 'False'
  : typeof v === 'string' ? v : typeof v === 'number' ? String(v) : JSON.stringify(v));
const isDict = v => v !== null && typeof v === 'object' && !Array.isArray(v);
// s[:n] counts characters, not UTF-16 units
const cut = (s, n) => (s.length <= n ? s : Array.from(s).slice(0, n).join(''));
// sorted() orders text by code point; JS by UTF-16 unit (they differ beyond U+FFFF)
function byCodePoint(a, b) {
  if (a === b) return 0;
  const x = Array.from(a), y = Array.from(b);
  for (let i = 0; i < x.length && i < y.length; i++) {
    const d = x[i].codePointAt(0) - y[i].codePointAt(0);
    if (d) return d;
  }
  return x.length - y.length;
}
const strip = (s, chars) => { let a = 0, b = s.length; while (a < b && chars.includes(s[a])) a++; while (b > a && chars.includes(s[b - 1])) b--; return s.slice(a, b); };
// os.path.splitext: the extension starts at the LAST dot, and a name's leading dots are not one
function splitext(name) {
  const i = name.lastIndexOf('.');
  let lead = 0;
  while (name[lead] === '.') lead++;
  return i >= lead && i > 0 ? [name.slice(0, i), name.slice(i)] : [name, ''];
}
const basename = p => p.slice(p.lastIndexOf('/') + 1);
const slug = name => cut(strip(pyStr(name).toLowerCase().replace(/[^a-z0-9]+/g, '-'), '-'), 60);

function unquote(s, plus) {
  if (plus) s = s.replace(/\+/g, ' ');
  try { return decodeURIComponent(s); } catch { return s; }
}
// urllib.parse.parse_qs, first value of each name: percent-decoded, '+' is a
// space, a name without a value is left out
function parseQs(path) {
  const query = path.split('#')[0].split('?').slice(1).join('?');
  const out = {};
  for (const pair of query.split('&')) {
    const i = pair.indexOf('=');
    if (i < 0 || i === pair.length - 1) continue;
    const k = unquote(pair.slice(0, i), true);
    if (!(k in out)) out[k] = unquote(pair.slice(i + 1), true);
  }
  return out;
}
// the server's other way (/__run/next, /__chat/events): nothing is decoded, the last value wins
function rawQs(path) {
  const i = path.indexOf('?');
  const out = {};
  if (i < 0) return out;
  for (const pair of path.slice(i + 1).split('&')) {
    const k = pair.indexOf('=');
    if (k >= 0) out[pair.slice(0, k)] = pair.slice(k + 1);
  }
  return out;
}
// int(text), or null
function pyInt(text) {
  const s = String(text).trim();
  return /^[+-]?\d+(_\d+)*$/.test(s) ? Number(s.replace(/_/g, '')) : null;
}

// A path with its '.', '..' and empty parts worked out (posixpath.normpath).
// null when it steps above where it started.
function resolveParts(p) {
  const parts = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (!parts.length) return null; parts.pop(); } else parts.push(seg);
  }
  return parts;
}

// The workspace path a static GET names, read as Python's http.server reads
// it: query and hash dropped, percent-decoded, '.' and empty parts ignored,
// '..' steps back but never above the root. null: a folder was asked for
// (a trailing '/'), which this engine does not serve.
function staticPath(path) {
  let p = path.split('?')[0].split('#')[0];
  if (p.trimEnd().endsWith('/')) return null;
  p = unquote(p, false);
  const parts = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop(); else parts.push(seg);
  }
  return parts.length ? parts.join('/') : null;
}

// ---- JSON the way the server writes it ----
//
// Python and JavaScript agree on JSON except for how a number is spelled:
// Python writes 0.0 and 1e-05 where JSON.stringify writes 0 and 0.00001. A
// file that passes through here (the manifest when the loop is saved, the
// kit's poses in a new layout.json) must come out as the server would write
// it — a file whose loop did not change must not change at all. So numbers
// are not parsed: each is held aside as written, a marker stands in for it
// while the object is worked on, and it is put back, spelled as Python
// spells it, when the text is made.
const NUMBER = /"[^"\\]*(?:\\.[^"\\]*)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
const HELD = /"\\u0000#(\d+)#"/g;

/** JSON.parse, but every number becomes a marker string; `nums` collects them as written. */
export function parseKeeping(text, nums) {
  return JSON.parse(text.replace(NUMBER, m => (m[0] === '"' ? m : `"\\u0000#${nums.push(m) - 1}#"`)));
}

// repr() of the number a JSON token spells
function pyNumber(tok) {
  if (!/[.eE]/.test(tok)) return tok === '-0' ? '0' : tok;      // an int stays as written
  const x = Number(tok);
  if (!Number.isFinite(x)) return x > 0 ? 'Infinity' : '-Infinity';
  if (x === 0) return tok.startsWith('-') ? '-0.0' : '0.0';
  // the shortest digits that give the number back — the same in both languages — laid out as repr() does
  const [m, e] = Math.abs(x).toExponential().split('e');
  const digits = m.replace('.', ''), exp = Number(e);
  let s;
  if (exp < -4 || exp >= 16) s = digits[0] + (digits.length > 1 ? '.' + digits.slice(1) : '') + 'e' + (exp < 0 ? '-' : '+') + String(Math.abs(exp)).padStart(2, '0');
  else if (exp < 0) s = '0.' + '0'.repeat(-exp - 1) + digits;
  else if (digits.length <= exp + 1) s = digits + '0'.repeat(exp + 1 - digits.length) + '.0';
  else s = digits.slice(0, exp + 1) + '.' + digits.slice(exp + 1);
  return (x < 0 ? '-' : '') + s;
}
const putBack = (text, nums) => text.replace(HELD, (_, i) => pyNumber(nums[Number(i)]));

/**
 * appfiles.dumps: one key per line, a list of plain values on ONE line, a
 * newline at the end. `nums` are the numbers parseKeeping held aside.
 */
export function pyDumps(obj, nums = []) {
  const text = JSON.stringify(obj, null, 1)
    .replace(/\[\s*([^\[\]{}]*?)\s*\]/g, (_, inner) => '[' + inner.replace(/,\s*\n\s*/g, ', ') + ']');
  return putBack(text, nums) + '\n';
}

// json.dump(obj, indent=1): plain indent, everything beyond ASCII escaped, no newline at the end
function pyDumpAscii(obj, nums = []) {
  return putBack(JSON.stringify(obj, null, 1), nums)
    .replace(/[\u0080-\uffff]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

function parseJson(bytes) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return undefined; }
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  try { return JSON.parse(text); } catch { return undefined; }
}

async function sha256Hex(bytes) {
  const d = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  let s = '';
  for (const b of d) s += b.toString(16).padStart(2, '0');
  return s;
}

function uuid4() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const b = globalThis.crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, v => v.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// %Y%m%d-%H%M%S, local time: when a file was exported, when a folder was put aside
function stamp(ms) {
  const d = new Date(ms), two = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
}

/** The application id a file's name gives (appfiles.id_from_file_name). */
export function idFromFileName(name) {
  let stem = name;
  // The page's downloads may only be saved under a known extension, so an
  // export leaves this edition as <name>.microfactory.zip (and a person may
  // rename one to .zip): that ending says nothing about the application.
  if (/\.zip$/i.test(stem)) stem = stem.slice(0, -4);
  const copy = /\s*\(\d+\)\s*$/;                 // the " (1)" a browser adds to a second download
  stem = stem.replace(copy, '');                 // …which lands before the .zip
  if (stem.toLowerCase().endsWith(EXTENSION)) stem = stem.slice(0, -EXTENSION.length);
  stem = stem.replace(copy, '');
  stem = stem.replace(/-\d{8}-\d{6}$/, '');      // the date and time export put at its end
  return slug(stem);
}

class Refused extends Error {}                   // appfiles.ImportError_: answered with 400 and its words

// Something to wait on: wait(ms) resolves when notify() is called, or after ms.
function condition() {
  const waiting = new Set();
  return {
    wait(ms) {
      return new Promise(resolve => {
        const done = () => { clearTimeout(timer); waiting.delete(done); resolve(); };
        const timer = setTimeout(done, Math.max(0, ms));
        waiting.add(done);
      });
    },
    notify() { for (const done of [...waiting]) done(); },
  };
}

/**
 * fs      the virtual file system (viewer/page-fs.js)
 * chat    the assistant (viewer/page-agent.js): agent(), events(app, epoch, since),
 *         send({ app, text, context, files, model }), stop(app), reset(app), forget(app)
 * mujoco  { version, wasm: () => Promise<Uint8Array> } — answered at /node_modules/@mujoco/mujoco/
 * now     the wall clock (ms): the first reload generation, the date in a file's name
 * hold    how long a long poll with nothing to say is held (ms)
 * vouch, listen   runs.py's VOUCH_FOR and LISTEN_FOR, in ms — parameters only so that the tests need not wait for them
 *
 * `now` is only the calendar. How long something has been waiting is
 * measured by the timers themselves, so a test's fixed clock holds nothing up.
 */
export function createPageEngine({ fs, chat, mujoco, now = Date.now, hold = 25000, vouch = 8000, listen = 40000 }) {
  const mono = () => globalThis.performance.now();

  // ---- answers ----
  const answer = (status, headers, bytes) => ({
    status,
    headers: { ...headers, 'Content-Length': String(bytes.length), 'Cache-Control': 'no-store' },
    body: bytes.length ? toBase64(bytes) : '',
  });
  const json = (obj, status = 200) => answer(status, { 'Content-Type': 'application/json' }, enc.encode(JSON.stringify(obj)));
  const notFound = () => answer(404, { 'Content-Type': 'text/html;charset=utf-8' },
    enc.encode('<!DOCTYPE HTML>\n<html lang="en"><head><meta charset="utf-8"><title>Error response</title></head>'
      + '<body><h1>Error response</h1><p>Error code: 404</p><p>Message: File not found.</p></body></html>\n'));
  const FORBIDDEN = () => json({ error: 'forbidden' }, 403);
  const BAD = () => json({ error: 'bad request' }, 400);
  const NO_APP = () => json({ error: 'no such application' }, 404);

  // ---- files ----
  const exists = path => fs.exists(q(path));
  const anything = path => fs.exists(q(path)) || fs.isDir(q(path));       // os.path.exists
  const read = path => fs.read(q(path));
  const readText = path => fs.readText(q(path));
  // _app_dir: is this the name of an application here?
  const isApp = app => typeof app === 'string' && app !== '' && !app.includes('/') && app !== '.' && app !== '..'
    && exists(`applications/${app}/application.json`);

  // ---- the reload generation ----
  // Starts at the clock, as the server's does: a page left open over a new
  // start of the engine sees a newer generation.
  let generation = Math.floor(now() / 1000);
  const reloads = condition();
  const own = new Set();        // paths the page itself is saving right now (the step order, an attachment): already on screen
  let batches = 0, batchMoved = false;
  const bump = () => { generation++; reloads.notify(); };

  // would the server's scan have seen a change to this file?
  function watched(path) {
    const parts = path.split('/'), name = parts.pop();
    if (parts.some(d => SKIP_DIRS.has(d))) return false;
    return WATCH_EXT.has(splitext(name)[1]) && !SKIP_FILES.has(name);
  }
  fs.onChange(({ path }) => {
    if (own.has(path) || !watched(path)) return;
    if (batches) batchMoved = true; else bump();
  });
  async function ownWrite(path, data) {
    own.add(path);
    try { await fs.write(q(path), data); } finally { own.delete(path); }
  }
  // An import or a new application writes many files. The server's scan
  // sees them as one change; here a reload in the middle would be worse than
  // one reload too many — the page IS the engine, and reloading it would
  // leave the application half written. So the generation moves once, when
  // all of it is in place.
  async function asOne(always, work) {
    batches++;
    try { return await work(); } finally {
      if (--batches === 0) {
        if (batchMoved || always) bump();
        batchMoved = false;
      }
    }
  }

  // ---- static files ----
  async function staticGet(path, head) {
    const p = staticPath(path);
    let bytes = null, type = null;
    if (p !== null) {
      // MuJoCo comes with the artifact, not with the workspace: these two
      // addresses are what app.js asks for when it is an installed page
      if (mujoco && p === 'node_modules/@mujoco/mujoco/package.json') {
        bytes = enc.encode(JSON.stringify({ name: '@mujoco/mujoco', version: mujoco.version }));
      } else if (mujoco && p === 'node_modules/@mujoco/mujoco/mujoco.wasm') {
        bytes = await mujoco.wasm();
      } else if (exists(p)) bytes = await read(p);
    }
    // A folder is not served: the server answers one with a redirect or a
    // listing, which nothing in the page asks for.
    if (!bytes) return head ? { ...notFound(), body: '' } : notFound();
    type = MIME[splitext(basename(p))[1].toLowerCase()] ?? 'application/octet-stream';
    const a = answer(200, { 'Content-type': type }, bytes);
    return head ? { ...a, body: '' } : a;
  }

  // ---- /__reload ----
  async function reloadPoll(path) {
    const at = path.indexOf('gen=');
    const seen = (at < 0 ? null : pyInt(path.slice(at + 4).split('gen=')[0])) ?? -1;
    if (generation <= seen) await reloads.wait(hold);
    return answer(200, { 'Content-Type': 'text/plain' }, enc.encode(String(generation)));
  }

  // ---- applications ----
  async function manifestOf(app) {
    const b = await read(`applications/${app}/application.json`);
    const m = b ? parseJson(b) : undefined;
    return isDict(m) ? m : null;
  }

  async function applications() {
    const apps = [];
    for (const id of fs.dirs('applications').sort(byCodePoint)) {
      const a = await manifestOf(id);
      if (a) apps.push({ id, name: 'name' in a ? a.name : id, robot: a.robot ?? null });
    }
    return json(apps);
  }

  async function steps(path) {
    const app = parseQs(path).app ?? '';
    const out = [];
    const dir = `applications/${app}/steps`;
    if (app && !app.includes('/') && app !== '.' && app !== '..' && fs.isDir(q(dir))) {
      const names = fs.list(q(dir)).map(p => p.slice(dir.length + 1)).filter(n => !n.includes('/') && n.endsWith('.ts'));
      for (const fn of names.sort(byCodePoint)) {
        const src = await readText(`${dir}/${fn}`);
        if (src === null) continue;
        const step = { id: fn.slice(0, -3) };
        for (const key of ['name', 'tool']) {
          const m = new RegExp(`^export const ${key}\\s*=\\s*(['"])(.*?)\\1`, 'm').exec(src);
          if (m) step[key] = m[2];
        }
        out.push(step);
      }
    }
    return json(out);
  }

  async function saveLoop(data) {
    const app = data.app, list = data.steps;
    if (!isApp(app) || !Array.isArray(list) || list.length > 200) return BAD();
    for (const st of list) {
      if (!(typeof st === 'string' && /^[\p{L}\p{N}_-]+$/u.test(st) && exists(`applications/${app}/steps/${st}.ts`)))
        return json({ error: `no such step: ${pyStr(st)}` }, 400);
    }
    // appfiles.write_loop_steps: only the loop's steps change; a file that
    // already says this is left alone
    const path = `applications/${app}/application.json`;
    const src = await readText(path);
    const nums = [];
    const manifest = parseKeeping(src, nums);
    if (!('loop' in manifest)) manifest.loop = { name: 'name' in manifest ? manifest.name : 'loop', steps: [] };
    manifest.loop.steps = [...list];
    const out = pyDumps(manifest, nums);
    if (out !== src) await ownWrite(path, out);          // the order is already on screen: no reload for it
    return json({ ok: true });
  }

  async function newApplication(data) {
    const name = cut(('name' in data ? pyStr(data.name) : '').trim().split(/\s+/).join(' '), 60);
    const id = strip(name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), '-');
    if (!id) return json({ error: 'give the application a name (letters or digits)' }, 400);
    if (anything(`applications/${id}`)) return json({ error: `applications/${id} already exists` }, 409);
    if (!isApp(data.like)) return BAD();
    const dir = `applications/${id}`;
    await asOne(true, async () => {
     try {
      // appfiles.new_application: the robot's kit (its basic grippers and the
      // rack they stand in) is COPIED in; without a kit it starts empty
      const nums = [];
      const old = parseKeeping(await readText(`applications/${data.like}/application.json`), nums);
      const kitDir = old.robot ? `${old.robot}/kit` : null;
      let kit = {};
      if (kitDir && exists(`${kitDir}/kit.json`)) kit = parseKeeping(await readText(`${kitDir}/kit.json`), nums);
      for (const sub of ['grippers', 'items']) {
        for (const ident of kit[sub] ?? []) {
          if (typeof ident !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(ident) || ident === '.' || ident === '..')
            throw new Error(`kit: bad id ${typeof ident === 'string' ? `'${ident}'` : pyStr(ident)}`);
          const from = `${kitDir}/${sub}/${ident}`;
          const files = fs.list(q(from));
          if (!files.length) throw new Error(`[Errno 2] No such file or directory: '${from}'`);
          for (const f of files) await fs.write(q(`${dir}/${sub}/${ident}${f.slice(from.length)}`), await read(f));
        }
      }
      const manifest = {
        format: FORMAT,
        uid: uuid4(),
        name,
        description: '',
        authors: [],
        about: ABOUT,
        robot: old.robot ?? null,
        units: old.units ?? null,
        conventions: 'conventions' in old ? old.conventions : {},
        grippers: [...(kit.grippers ?? [])],
        items: [...(kit.items ?? [])],
        mounted_tool: null,
        loop: { name, steps: [] },
      };
      const layout = { about: LAYOUT_ABOUT, fixtures: [...(kit.fixtures ?? [])], parts: [],
        tool_rack: kit.tool_rack || { stands: [] }, unplaced_parts: [] };
      // (the server also makes empty steps/, grippers/ and items/ folders;
      // here a folder is only there while a file is in it, and nothing asks)
      // application.json LAST: a folder is an application once it has one
      await fs.write(q(`${dir}/layout.json`), pyDumps(layout, nums));
      await fs.write(q(`${dir}/application.json`), pyDumps(manifest, nums));
     } catch (e) {
      // half an application is worse than none: it would be listed, would not open, and would hold its name
      await fs.removeTree(q(dir)).catch(() => {});
      throw e;
     }
    });
    return json({ ok: true, id });
  }

  // ---- one file to share: <name>.microfactory ----

  // the files an export takes, as paths inside the application, sorted
  function exportFiles(app) {
    const dir = `applications/${app}/`;
    return fs.list(q(dir.slice(0, -1))).map(p => p.slice(dir.length)).filter(rel => {
      const parts = rel.split('/'), name = parts.pop();
      return !EXPORT_SKIP_NAMES.has(name) && !parts.some(d => EXPORT_SKIP_DIRS.has(d));
    }).sort(byCodePoint);
  }

  // appfiles._version: a short hash of every file's path and contents, in path order
  async function versionOf(entries) {
    const sorted = [...entries].sort((a, b) => byCodePoint(a.name, b.name));
    const parts = [];
    let total = 0;
    for (const e of sorted) {
      const head = enc.encode(`${e.name}\0${e.bytes.length}\0`);
      parts.push(head, e.bytes);
      total += head.length + e.bytes.length;
    }
    const all = new Uint8Array(total);
    let at = 0;
    for (const p of parts) { all.set(p, at); at += p.length; }
    return (await sha256Hex(all)).slice(0, 8);
  }

  async function folderEntries(app) {
    const out = [];
    for (const rel of exportFiles(app)) {
      const bytes = await read(`applications/${app}/${rel}`);
      if (bytes) out.push({ name: rel, bytes });
    }
    return out;
  }

  async function exportApplication(path) {
    const app = parseQs(path).app ?? '';
    if (!isApp(app)) return NO_APP();
    const entries = await folderEntries(app);
    // application.json first, then the rest in path order
    entries.sort((a, b) => (a.name === 'application.json' ? -1 : b.name === 'application.json' ? 1 : 0));
    const bytes = await zipWrite(entries);
    // the file's name says when it was saved, to the second
    const name = `${app}-${stamp(now())}${EXTENSION}`;
    return answer(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${name}"`,
      'X-Microfactory-File': name,
    }, bytes);
  }

  // as unpacking does: an empty part or a '.' in a name is passed over
  const relOf = name => name.split('/').filter(part => part !== '' && part !== '.').join('/');

  // appfiles.inspect_archive
  function inspect(entries) {
    if (entries.length > MAX_FILES || entries.reduce((s, e) => s + e.bytes.length, 0) > MAX_UNPACKED)
      throw new Refused('the file is too large to be an application');
    // A name cannot be a file and a folder at once ("application.json" and
    // "application.json/n.md"): no folder on a computer can hold both, so
    // the other editions could not unpack what this one would export.
    const placed = new Set(entries.map(e => relOf(e.name)));
    for (const rel of placed) {
      for (let up = rel.slice(0, rel.lastIndexOf('/')); up; up = up.slice(0, up.lastIndexOf('/')))
        if (placed.has(up)) throw new Refused(`the file holds both a file and a folder named ${up}`);
    }
    for (const { name } of entries) {
      const parts = name.split('/');
      // nothing may land outside the application's own folder. (The server
      // also refuses a symbolic link; here an entry can only ever become a
      // plain file of the virtual file system, so there is nothing to refuse.)
      if (name.startsWith('/') || name.includes('\\') || parts[0].includes(':') || parts.includes('..'))
        throw new Refused(`the file contains an unsafe path: ${name}`);
    }
    const found = entries.filter(e => e.name === 'application.json').pop();
    if (!found) throw new Refused('not an application: there is no application.json in the file');
    const manifest = parseJson(found.bytes);
    if (manifest === undefined) throw new Refused('not an application: its application.json cannot be read');
    if (!isDict(manifest) || manifest.format !== FORMAT)
      throw new Refused(`the application is in format ${isDict(manifest) ? pyStr(manifest.format) : '?'}; this viewer reads format ${FORMAT}`);
    return { manifest, source: found.bytes };
  }

  async function importApplication(path, bytes) {
    const query = parseQs(path);
    const existing = query.existing ?? 'ask';
    const n = bytes.length;
    if (!(n > 0) || !['ask', 'replace', 'copy'].includes(existing)) return BAD();
    if (n > MAX_IMPORT) return json({ error: `file too large (limit ${MAX_IMPORT / 1_000_000} MB)` }, 413);
    const fileName = basename((query.name ?? '').replace(/\\/g, '/'));
    try {
      let entries;
      // whatever is wrong with the container, the person hears the same thing
      // (the limits are checked against what the file DECLARES, before anything of it is inflated)
      try { entries = await zipRead(bytes, { maxFiles: MAX_FILES, maxBytes: MAX_UNPACKED }); }
      catch (e) { throw new Refused(e?.code === 'too_large' ? 'the file is too large to be an application' : `not a ${EXTENSION} file`); }
      const { manifest, source } = inspect(entries);
      const version = await versionOf(entries);
      let id = idFromFileName(fileName) || slug('name' in manifest ? manifest.name : '') || 'application';
      let fork = false, replaced = false;
      if (anything(`applications/${id}`)) {
        if (existing === 'ask') {
          const here = (await manifestOf(id)) ?? {};
          return json({
            ok: true, exists: true, id, name: 'name' in here ? here.name : id, version,
            same: Boolean(manifest.uid) && here.uid === manifest.uid,
            // the file holds exactly what is here already: nothing to import
            identical: (await versionOf(await folderEntries(id))) === version,
          });
        }
        if (existing === 'copy') {                 // a free id beside it
          let k = 2;
          while (anything(`applications/${id}-${k}`)) k++;
          id = `${id}-${k}`; fork = true;
        } else replaced = true;
      }
      // The conversation the assistant has open under this id is about to
      // be put aside with the folder: it lets go of it BEFORE the files move,
      // so that nothing it still had to save lands on the imported one.
      if (replaced) { try { await chat?.forget?.(id); } catch (e) { console.error('page-engine: the chat could not forget', id, e); } }
      await asOne(true, async () => {
        // The server unpacks beside the place and renames; a rename is one
        // step there and many writes here, any of which can fail (the
        // browser's storage is full). So, in an order that can be undone:
        //   1. the new files, whole, under .incoming/ — the one here untouched;
        //   2. replace: the one here is COPIED aside under .backups/ — still
        //      untouched, so undoing 1 and 2 is only deleting;
        //   3. the one here is removed and the new files are moved in.
        // When 3 fails, what got in is deleted and the copy put aside is
        // moved back: by then more room is free than it needs (the new
        // files are gone, and each file frees its copy as it returns).
        // Whatever fails, the application that was here is back as it was
        // and nothing half-made is left.
        const dir = `applications/${id}`, incoming = `.incoming/${id}`;
        let backup = null, swapping = false;
        await fs.removeTree(q('.incoming'));       // what a page closed in the middle of an import left
        try {
          for (const e of entries) {
            const rel = relOf(e.name);
            if (rel) await fs.write(q(`${incoming}/${rel}`), e.bytes);
          }
          if (fork) {                              // kept beside the original: it is another application now
            const nums = [];
            let text = new TextDecoder().decode(source);
            if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
            const m = parseKeeping(text, nums);
            m.uid = uuid4();
            await fs.write(q(`${incoming}/application.json`), pyDumps(m, nums));
          }
          if (replaced) {
            // Nothing in this edition opens .backups/, and each copy is a
            // whole application in the browser's storage (its meshes too):
            // only the latest one of an application is kept.
            const older = new RegExp(`^${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d{8}-\\d{6}$`);
            for (const d of fs.dirs(q('.backups/applications'))) if (older.test(d)) await fs.removeTree(q(`.backups/applications/${d}`));
            backup = `.backups/applications/${id}-${stamp(now())}`;
            for (const p of fs.list(q(dir))) {
              const bytes = await read(p);
              if (bytes) await fs.write(q(backup + p.slice(dir.length)), bytes);
            }
            swapping = true;
            await fs.removeTree(q(dir));
          }
          swapping = true;
          await fs.moveTree(q(incoming), q(dir));
        } catch (e) {
          await fs.removeTree(q(incoming)).catch(() => {});
          if (swapping) await fs.removeTree(q(dir)).catch(() => {});
          if (backup && swapping) await fs.moveTree(q(backup), q(dir)).catch(err => console.error('page-engine: the application put aside could not be put back', backup, err));
          else if (backup) await fs.removeTree(q(backup)).catch(() => {});          // the one here was never touched
          throw e;
        }
      });
      // The conversation travels with the application: the one the assistant
      // has in memory under this id is no longer the one in the files (it
      // may have been read again while they were being written).
      try { await chat?.forget?.(id); } catch (e) { console.error('page-engine: the chat could not forget', id, e); }
      return json({ ok: true, id, version });
    } catch (e) {
      if (e instanceof Refused) return json({ error: e.message }, 400);
      throw e;
    }
  }

  // ---- runs (viewer/runs.py) ----
  // The assistant cannot drive the scene, but it can ask for a run: the
  // request waits here until the page's own agent-run.js takes it through
  // /__run/next and answers through /__run/result. One job at a time per
  // application. A page that takes a job keeps saying so (/__run/alive); a
  // job nobody vouches for — its answer went to a poll the page had already
  // dropped — is given out again.
  const jobs = new Map();        // application -> the job waiting or running
  const lastAsked = new Map();   // application -> when a page last asked for work
  const runsMoved = condition();
  const hex32 = () => uuid4().replace(/-/g, '');
  const beat = Math.max(5, vouch / 4);

  async function runsRequest(app, job, timeout = 300) {
    const me = { id: hex32(), job, page: null, alive: -Infinity, result: null };
    if (jobs.has(app)) return { ok: false, error: 'another run was asked for and has not finished' };
    jobs.set(app, me);
    runsMoved.notify();
    const start = mono(), end = start + timeout * 1000;
    try {
      while (me.result === null) {
        const t = mono();
        if (me.page === null && t - (lastAsked.get(app) ?? -Infinity) > listen && t > start + vouch)
          return { ok: false, error: `the application '${app}' is not open in the viewer (or its window is hidden): ask the user to open it and keep it on screen` };
        if (t >= end) return { ok: false, error: `no result within ${timeout} s — the run may still be going in the viewer` };
        await runsMoved.wait(Math.min(2000, end - t, beat));
      }
      return me.result;
    } finally {
      if (jobs.get(app) === me) jobs.delete(app);
    }
  }

  async function runsNext(app, page) {
    const end = mono() + hold;
    for (;;) {
      lastAsked.set(app, mono());
      const j = jobs.get(app);
      if (j && j.result === null && mono() - j.alive > vouch) {
        j.page = page; j.alive = mono();
        runsMoved.notify();
        return { id: j.id, ...j.job };
      }
      const left = end - mono();
      if (left <= 0) return null;
      await runsMoved.wait(Math.min(5000, left, beat));
    }
  }

  function runsAlive(id, page) {
    for (const j of jobs.values()) {
      if (j.id === id && j.page === page && j.result === null) { j.alive = mono(); return true; }
    }
    return false;
  }

  function runsResult(id, data) {
    for (const j of jobs.values()) {
      if (j.id === id && j.result === null) { j.result = data; runsMoved.notify(); return true; }
    }
    return false;
  }

  // The pictures a run carries (data URLs under shot / shot_close) become
  // files <folder>/<stem>.png and <stem>-close.png; `res` then names them.
  async function savePictures(res, folder, stem) {
    for (const [key, name, suffix] of [['shot', 'picture', ''], ['shot_close', 'picture_close', '-close']]) {
      const shot = res[key];
      delete res[key];
      if (!(typeof shot === 'string' && shot.startsWith('data:image/png;base64,'))) continue;
      const path = `${folder}/${stem}${suffix}.png`;
      try {
        const bin = atob(shot.slice(shot.indexOf(',') + 1));
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        await fs.write(q(path), bytes);
        res[name] = path;
      } catch { /* a picture that cannot be kept is left out, the run still counts */ }
    }
  }

  function jobOf(o) {
    return {
      steps: (Array.isArray(o.steps) ? o.steps : []).map(x => cut(pyStr(x), 80)).slice(0, 50),
      loop: Boolean(o.loop),
      // `keep` is the word of scripts/run-step.mjs (--keep) for "do not reset the scene first"
      reset: 'reset' in o ? Boolean(o.reset) : !o.keep,
      shot: Boolean(o.shot),
      fast: 'fast' in o ? Boolean(o.fast) : true,
    };
  }

  const runs = {
    /**
     * Ask the open page to run steps and wait for what came of it:
     * { app, steps, loop, keep | reset, shot, fast, timeout (seconds, 300) }.
     * Always resolves with a result object ({ ok: false, error } when the run could not be made).
     */
    async request(o = {}) {
      await fs.ready;
      const app = pyStr(o.app ?? '');
      if (!isApp(app)) return { ok: false, error: `no application '${app}'` };
      const timeout = Number.isFinite(Number(o.timeout)) && Number(o.timeout) > 0 ? Number(o.timeout) : 300;
      const res = { ...(await runsRequest(app, jobOf(o), timeout)) };
      await savePictures(res, '.runs', app);
      return res;
    },
    /** The record of the last run that failed in the page (applications/<app>/runs/last-failure.json), or null. */
    async last(app) {
      await fs.ready;
      if (!isApp(app)) return null;
      const b = await read(`applications/${app}/runs/last-failure.json`);
      return (b && parseJson(b)) ?? null;
    },
  };

  async function runRequest(data) {
    const app = 'app' in data ? pyStr(data.app) : '';
    if (!isApp(app)) return json({ ok: false, error: `no application '${app}'` }, 404);
    let timeout = 300;
    if ('timeout' in data) {
      const t = typeof data.timeout === 'number' ? Math.trunc(data.timeout) : typeof data.timeout === 'string' ? pyInt(data.timeout) : null;
      if (t !== null && Number.isFinite(t)) timeout = Math.max(10, Math.min(1800, t));
    }
    const res = { ...(await runsRequest(app, jobOf(data), timeout)) };
    await savePictures(res, '.runs', app);
    return json(res);
  }

  // the page: a run failed. Its record is kept with the application
  // (runs/last-failure.json + pictures), replacing the one before
  async function runRecord(bytes) {
    // read again with the numbers as written, so that the record's file is the one the server would keep
    const nums = [];
    const data = parseKeeping(new TextDecoder().decode(bytes), nums);
    const app = 'app' in data ? pyStr(data.app) : '';
    if (!isApp(app) || !isDict(data.record)) return BAD();
    const folder = `applications/${app}/runs`;
    const rec = { ...data.record };
    for (const stale of ['last-failure.png', 'last-failure-close.png']) await fs.remove(q(`${folder}/${stale}`));
    await savePictures(rec, folder, 'last-failure');
    await fs.write(q(`${folder}/last-failure.json`), pyDumpAscii(rec, nums));
    return json({ ok: true });
  }

  // ---- the chat ----
  async function chatEvents(path) {
    const query = rawQs(path);
    const app = query.app ?? '';
    if (!isApp(app)) return NO_APP();
    const epoch = 'epoch' in query ? pyInt(query.epoch) : -1;
    const since = 'since' in query ? pyInt(query.since) : 0;
    if (epoch === null || since === null) return BAD();
    const r = await chat.events(app, epoch, since);           // held by the chat itself while there is nothing new
    // (the chat has its own idea of what an application's name may be: its refusal keeps its status)
    return r?.error ? json({ error: r.error }, r.status ?? 404) : json(r);
  }

  async function chatAction(action, data) {
    const app = 'app' in data ? pyStr(data.app) : '';
    if (!isApp(app)) return NO_APP();
    if (action === 'send') {
      // attachments: only files that really are in an application's materials/
      const files = [];
      for (const p of Array.isArray(data.files) ? data.files : []) {
        const name = pyStr(p);
        const parts = name.startsWith('/') ? null : resolveParts(name);       // a path of the workspace, not of the computer
        if (parts && parts.length === 4 && parts[0] === 'applications' && parts[2] === MATERIALS && exists(parts.join('/')))
          files.push(parts.join('/'));
      }
      const r = await chat.send({
        app,
        text: 'text' in data ? pyStr(data.text) : '',
        context: cut('context' in data ? pyStr(data.context) : '', 400),
        files: files.slice(0, 20),
        model: cut('model' in data ? pyStr(data.model) : '', 40),
      });
      return r?.error ? json({ error: r.error }, r.status ?? 409) : json({ ok: true });
    }
    if (action === 'stop') { await chat.stop(app); return json({ ok: true }); }
    if (action === 'new') { await chat.reset(app); return json({ ok: true }); }
    return json({ error: 'not found' }, 404);
  }

  // a file attached in the chat: saved in the application's materials/
  // folder under a safe name, never over an existing file
  const claimed = new Set();     // names being written right now: two attachments sent together must not take the same one
  async function upload(path, bytes) {
    const query = parseQs(path);
    const app = query.app ?? '';
    if (!isApp(app)) return BAD();
    if (bytes.length > MAX_UPLOAD) return json({ error: `file too large (limit ${MAX_UPLOAD / 1_000_000} MB)` }, 413);
    // keep letters, digits, dot, dash, underscore; no folders, no hidden files
    const raw = basename((query.name ?? 'file').replace(/\\/g, '/'));
    let [stem, ext] = splitext(strip(raw.replace(/[^\p{L}\p{N}_.-]+/gu, '-'), '.-') || 'file');
    stem = cut(stem || 'file', 80); ext = cut(ext, 12);
    const folder = `applications/${app}/${MATERIALS}`;
    let file = stem + ext, k = 1;
    while (anything(`${folder}/${file}`) || claimed.has(`${folder}/${file}`)) file = `${stem}-${++k}${ext}`;
    const full = `${folder}/${file}`;
    claimed.add(full);
    try { await ownWrite(full, bytes); } finally { claimed.delete(full); }      // no page reload for it
    return json({ ok: true, path: full, name: file });
  }

  // ---- which request is which (serve.py: do_GET, do_POST — prefixes, in this order) ----
  const POSTS = ['/__chat/', '/__loop/save', '/__applications/new', '/__applications/import', '/__run/'];

  async function route(method, path, headers, bytes) {
    const ours = headers['x-microfactory'] === 'chat';
    if (method === 'GET') {
      if (path.startsWith('/__reload')) return reloadPoll(path);
      await fs.ready;
      if (path.startsWith('/__applications/export')) return ours ? exportApplication(path) : FORBIDDEN();
      if (path.startsWith('/__applications')) return applications();
      if (path.startsWith('/__steps')) return steps(path);
      if (path.startsWith('/__run/next')) {
        if (!ours) return FORBIDDEN();
        const query = rawQs(path);
        if (!isApp(query.app)) return NO_APP();
        return json({ job: await runsNext(query.app, cut(query.page ?? '', 40)) });
      }
      if (path.startsWith('/__chat/agent')) return ours ? json(await chat.agent()) : FORBIDDEN();
      if (path.startsWith('/__chat/events')) return ours ? chatEvents(path) : FORBIDDEN();
      return staticGet(path, false);
    }
    if (method === 'HEAD') { await fs.ready; return staticGet(path, true); }
    if (method !== 'POST') return answer(501, { 'Content-Type': 'text/html;charset=utf-8' }, enc.encode(`Unsupported method (${method})`));

    if (!POSTS.some(p => path.startsWith(p))) return json({ error: 'not found' }, 404);
    if (!ours) return FORBIDDEN();
    await fs.ready;
    if (path.startsWith('/__chat/upload')) return upload(path, bytes);
    if (path.startsWith('/__applications/import')) return importApplication(path, bytes);
    // the page sends no Content-Length of its own: the limit is on what arrived
    const big = path.startsWith('/__run/result') || path.startsWith('/__run/record') ? MAX_JSON_RUN : MAX_JSON;
    const data = bytes.length < big ? (bytes.length ? parseJson(bytes) : {}) : undefined;
    if (!isDict(data)) return BAD();
    if (path.startsWith('/__applications/new')) return newApplication(data);
    if (path.startsWith('/__run/request')) return runRequest(data);
    if (path.startsWith('/__run/result')) {
      const result = isDict(data.result) ? data.result : { ok: false, error: 'the viewer sent no result' };
      return json({ ok: runsResult('id' in data ? pyStr(data.id) : '', result) });
    }
    if (path.startsWith('/__run/record')) return runRecord(bytes);
    if (path.startsWith('/__run/alive'))
      return json({ ok: runsAlive('id' in data ? pyStr(data.id) : '', cut('page' in data ? pyStr(data.page) : '', 40)) });
    if (path.startsWith('/__loop/save')) return saveLoop(data);
    return chatAction(path.slice('/__chat/'.length), data);
  }

  /** The bridge's contract: resolves { status, headers, body } (body base64, '' when empty). Never rejects. */
  async function request(method, path, headers, bytes) {
    const m = String(method ?? 'GET').toUpperCase(), p = String(path ?? '');
    try {
      const h = {};
      for (const [k, v] of Object.entries(headers ?? {})) h[k.toLowerCase()] = v;
      return await route(m, p, h, bytes ?? EMPTY);
    } catch (e) {
      // /__reload must never answer anything but 200: the page gives up its reload loop for good on the first failure
      if (m === 'GET' && p.startsWith('/__reload')) return answer(200, { 'Content-Type': 'text/plain' }, enc.encode(String(generation)));
      // what the server answers when a file could not be written or read
      return json({ error: String(e?.message ?? e) }, 500);
    }
  }

  return {
    request, runs, generation: () => generation,
    /**
     * Several changes to the files that are ONE change to the page (putting
     * an application back as it came): the generation moves once, when
     * `work` has finished, and only if a file the page shows was changed —
     * so the page does not reload itself with half of them made.
     */
    asOne: work => asOne(false, work),
  };
}
