// What the assistant of the shareable edition can DO: the page functions
// handed to Claude with each request (the `tools` of the artifact's
// `sample` call). In the installed app the agent has a shell and the whole
// repository; here it has these seven, over the virtual file system
// (viewer/page-fs.js) and the run queue of the page engine:
//
//   list_files  read_file  write_file  edit_file  run_steps  measure  undo
//
// The rules that keep it safe to let a model loose on them:
//   - it reads the OPEN application, the guides, the recipes, the step API
//     and the robot; it writes text files of the open application only,
//     never the conversation, the run records, what the user attached, a
//     mesh or a picture (pathRule);
//   - every write keeps what was there before, so `undo` puts it back —
//     text in a tool result can steer what the model does next, so nothing
//     it does may be final. The earlier versions are FILES (.undo/<app>/…,
//     beside the applications, never exported and never watched): a change
//     to a step or to layout.json reloads the page when the answer ends,
//     and what is only in memory would be gone with it;
//   - a file is checked before it is saved (JSON parses, a step exports
//     what the viewer needs, the loop names steps that exist, the cell
//     still loads): a broken layout.json would leave the user with a page
//     that does not load;
//   - the platform runs the calls of one round TOGETHER: everything that
//     changes a file goes through one queue per application, so a second
//     edit reads what the first one wrote;
//   - a result is a string of at most MAX_RESULT bytes, cut with a line
//     that says how to get the rest (the platform's limit is 32 KB and it
//     does not say what happens beyond it);
//   - the platform does not enforce a tool's schema: every input is
//     coerced and checked here. A refusal is a thrown Error — Claude gets
//     "Error: <message>" and carries on, so the words say what to do.
//
// Pure: no DOM, no `sample`. viewer/page-agent.js builds the tools for a
// turn and turns `emit(text)` into the transcript's "· reads …" lines.

import { loadCell } from './cell-data.js';

export const MAX_RESULT = 30000;        // bytes of UTF-8 per tool result
const MAX_WRITE = 400000;               // bytes: the largest text file today is a 13 KB layout
const UNDO_DEPTH = 10;                  // previous versions kept per file (the oldest, what the file was before the assistant, always among them)
const RUN_WAIT = 120000;                // ms a run_steps call waits (a tool call is ended after 150 s)

const ROOTS = ['applications', 'guides', 'recipes', 'viewer', 'cell_fr3'];
const WRITABLE = ['.ts', '.json', '.md', '.txt', '.mjs'];
const KEPT_BY_THE_PAGE = ['chats', 'runs', 'materials'];
const BINARY = /\.(glb|gltf|stl|step|stp|obj|3mf|png|jpe?g|gif|webp|bmp|ico|pdf|zip|microfactory|wasm|bin|gz)$/i;
// a change to one of these reaches the 3D scene only when the page reloads
const NEEDS_RELOAD = /^applications\/[^/]+\/(layout\.json|application\.json|items\/.+|grippers\/.+|robots\/.+)$/;

// the files the composed cell is read from (viewer/cell-data.js): one that the cell cannot be loaded with is not saved
const CELL_FILE = /^applications\/[^/]+\/(layout\.json|application\.json|items\/[^/]+\/item\.json|grippers\/[^/]+\/gripper\.json|robots\/[^/]+\.json)$/;

const encoder = new TextEncoder();
const bytesOf = s => encoder.encode(s).length;

/**
 * May the assistant read / write this path, with `app` open? Paths are
 * workspace-relative ('applications/<app>/steps/pick.ts'); one that does
 * not start at a workspace folder is taken from the open application's
 * folder ('steps/pick.ts'), since that is how the files are spoken of.
 * → { ok: true, path } (the full workspace path) | { ok: false, why }
 */
export function pathRule(app, path, mode) {
  const no = why => ({ ok: false, why });
  if (typeof path !== 'string' || !path.trim()) return no('give a path, for example steps/pick.ts');
  let p = path.trim();
  // the file system decodes %xx and cuts at ? and #: none of that may get
  // past the checks below (ma%74erials/ is materials/), so such a path is not taken at all
  if (/[%?#\\]/.test(p)) return no(`${path}: a path here is plain: no \\, %, ? or #`);
  p = p.replace(/^\/+/, '').replace(/\/+$/, '');
  if (p === '' || p === '.') return no('give a path, for example steps/pick.ts');
  const parts = p.split('/');
  if (parts.some(s => s === '' || s === '.' || s === '..')) return no(`${path}: a path cannot go through . or .. or have an empty part`);
  if (!ROOTS.includes(parts[0])) parts.unshift('applications', app);
  p = parts.join('/');
  const mine = parts[0] === 'applications' && parts[1] === app;
  if (mode === 'write') {
    if (!mine || parts.length < 3)
      return no(`${p} cannot be changed: only text files of the open application (applications/${app}/) can — guides, recipes, the step API and the robot are read-only`);
    if (KEPT_BY_THE_PAGE.includes(parts[2]))
      return no(`${p} cannot be changed: ${parts[2]}/ is kept by the page (the conversation, the run records, what the user attached)`);
    if (!WRITABLE.some(ext => p.endsWith(ext)))
      return no(`${p} cannot be written: only text files can (${WRITABLE.join(' ')}) — meshes, STEP files and pictures cannot be made here`);
    return { ok: true, path: p };
  }
  if (mine) return { ok: true, path: p };
  if (parts[0] === 'applications')
    return no(parts.length < 2 ? `only the open application can be read: applications/${app}/`
      : `${p} belongs to another application: only the open one (applications/${app}/) can be read — ask the user to open "${parts[1]}"`);
  if (parts[0] === 'viewer' && p !== 'viewer/cell.d.ts' && p !== 'viewer')
    return no(`${p} cannot be read: of viewer/ only viewer/cell.d.ts (the step API) is available here`);
  return { ok: true, path: p };
}

/** Cut a result to MAX_RESULT bytes at a line end, saying how to get the rest. */
export function capText(text, how = 'ask for less at a time') {
  if (bytesOf(text) <= MAX_RESULT) return text;
  const room = MAX_RESULT - bytesOf(how) - 200;
  let out = '', used = 0;
  for (const line of text.split('\n')) {
    const n = bytesOf(line) + 1;
    if (used + n > room) break;
    out += line + '\n'; used += n;
  }
  if (!out) out = cutBytes(text, room) + '\n';          // one endless line
  return `${out}[cut here: the whole result is ${bytesOf(text)} bytes — ${how}]`;
}
// the longest prefix of `s` that fits `room` bytes (never half a character)
function cutBytes(s, room) {
  let lo = 0, hi = Math.min(s.length, room);
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (bytesOf(s.slice(0, mid)) <= room) lo = mid; else hi = mid - 1; }
  if (lo > 0 && /[\uD800-\uDBFF]/.test(s[lo - 1])) lo--;
  return s.slice(0, lo);
}

const mm = v => (Number(v) * 1000).toFixed(1);
/**
 * A run's result, or the record of a failed one, as the text
 * scripts/run-step.mjs prints — the form the guides teach the agent to read.
 * Without the picture paths: a picture cannot be opened from a tool here.
 */
export function runText(res, { logLines = Infinity } = {}) {
  if (!res || typeof res !== 'object') return 'NOT RUN: the viewer sent no result';
  const out = [];
  if (res.when) out.push(`recorded ${res.when} — the last run that failed in the viewer`, '');
  // a run that was refused (a run already going, no such step, the application not on screen) has no `ran`
  if (!res.ok && !res.ran && !res.when) return `NOT RUN: ${res.error ?? 'no result'}`;
  if (res.stale) out.push('NOTE: files changed since the viewer loaded this application (layout, items, grippers), and it has not reloaded yet:',
    '      this run used the OLD ones. Step files are always read fresh. The page reloads when you finish answering:',
    '      say what you changed, ask the user to send a message, and run again then.', '');
  out.push(res.ok ? `DONE: ${(res.ran ?? []).join(', ')}${res.seconds !== undefined ? ` (${res.seconds} s)` : ''}`
    : `FAILED at ${res.step ?? '?'}: ${res.error}${res.ran ? `   (running: ${res.ran.join(', ')})` : ''}`);
  const log = Array.isArray(res.log) ? res.log.map(String) : [];
  if (log.length) {
    const shown = log.slice(-logLines);
    out.push('', shown.length < log.length ? `log (the last ${shown.length} of ${log.length} lines):` : 'log:');
    for (const l of shown) out.push('  ' + l);
  }
  out.push('', `tool on the arm: ${res.tool}; holding: ${res.held ?? 'nothing'}; io: ${JSON.stringify(res.io ?? {})}`);
  out.push(`joints (deg): ${JSON.stringify(res.joints_deg)}`);
  if (res.parts_moved?.length) {
    out.push('', 'parts no longer where the layout put them (table frame, mm):');
    for (const p of res.parts_moved)
      out.push(`  ${p.id}: moved ${p.moved_mm} mm, now at x ${mm(p.to_m[0])} y ${mm(p.to_m[1])} z ${mm(p.to_m[2])} (was x ${mm(p.from_m[0])} y ${mm(p.from_m[1])} z ${mm(p.from_m[2])})`);
  } else out.push('', 'no part moved');
  const text = out.join('\n');
  // a long log is cut from the front first: the last lines before a failure are where to look
  if (bytesOf(text) > MAX_RESULT && logLines > 60) return runText(res, { logLines: 60 });
  return capText(text, 'the log lines were too long to show whole');
}

// ---- checks before a file is saved ----
function checkJson(path, text) {
  try { return JSON.parse(text); }
  catch (e) {
    const at = /position (\d+)/.exec(String(e.message));
    const where = at ? ` (line ${text.slice(0, Number(at[1])).split('\n').length})` : '';
    throw new Error(`${path} was NOT saved: it is not valid JSON${where}: ${e.message}`);
  }
}
// A textual check: this module has no transpiler. A syntax error still
// shows only when the step is run — the run's error names it.
function checkStep(path, text) {
  const missing = ['name', 'tool', 'entry'].filter(k => !new RegExp(`^export\\s+const\\s+${k}\\b[^=\\n]*=`, 'm').test(text));
  if (!/^export\s+default\s+(async\s+)?(function\b|\()/m.test(text) && !/^export\s+default\s+async\s+\w+\s*=>/m.test(text))
    missing.push('a default function (export default async function (cell, ctx) { … })');
  if (missing.length)
    throw new Error(`${path} was NOT saved: a step must export name, tool, entry and a default async function; missing: ${missing.join(', ')}`);
  if (/\bfrom\s+['"]\.{1,2}\//.test(text))
    throw new Error(`${path} was NOT saved: a step imports the cell API as from 'microfactory', never by a relative path`);
}
function checkManifest(fs, app, path, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} was NOT saved: the manifest must be a JSON object`);
  const loop = value.loop;
  const steps = Array.isArray(loop) ? loop : loop?.steps;
  if (loop !== undefined && !Array.isArray(steps)) throw new Error(`${path} was NOT saved: "loop" must be {"name": …, "steps": [step names]}`);
  const gone = (steps ?? []).filter(id => typeof id !== 'string' || !fs.exists(`applications/${app}/steps/${id}.ts`));
  if (gone.length) {
    const have = fs.list(`applications/${app}/steps`).map(f => f.split('/').pop()).filter(f => f.endsWith('.ts')).map(f => f.slice(0, -3));
    const e = new Error(`${path} was NOT saved: the loop names ${gone.map(g => JSON.stringify(g)).join(', ')}, and there is no such step file — steps/ has: ${have.join(', ') || 'none'}. Write the step first.`);
    e.missingStep = true;               // the step may be on its way: a write of it sent in the same round (see `change`)
    throw e;
  }
}
// Would the page still load the application? What viewer/cell-data.js says
// when it puts the cell together from the files, with `swap` ({ path, value })
// standing in for the file about to be saved. → null, or its words.
async function cellError(fs, app, swap) {
  try {
    await loadCell(async p => {
      if (swap && p === swap.path) return swap.value;
      const text = await fs.readText(p);
      if (text === null) throw new Error(`${p}: not found`);
      return JSON.parse(text);
    }, app);
    return null;
  } catch (e) { return String(e?.message ?? e); }
}

// ---- the earlier versions of a file, kept as files ----
// .undo/<app>/<path in the application>/<n>      what the file held before change n
// .undo/<app>/<path in the application>/<n>.new  …it did not exist before change n
// Outside applications/, so an export does not take them; names without a
// watched extension, so keeping one does not ask for a page reload.
const undoDir = (app, path) => `.undo/${app}/${path.slice(`applications/${app}/`.length)}`;
function versions(fs, dir) {
  const out = [];
  for (const p of fs.list(dir)) {
    const m = /^(\d+)(\.new)?$/.exec(p.slice(dir.length + 1));
    if (m) out.push({ n: Number(m[1]), path: p, isNew: Boolean(m[2]) });
  }
  return out.sort((a, b) => a.n - b.n);
}
/** The application's files were replaced whole (an import): its earlier versions are of other files. */
export const forgetUndo = (fs, app) => fs.removeTree(`.undo/${app}`);

// What outlives a turn, per file system and application: the queue its
// changes go through, and whether a file the 3D scene is built from was
// changed since the page loaded (a page reload starts this module anew).
const states = new WeakMap();
function stateOf(fs, app) {
  let apps = states.get(fs);
  if (!apps) states.set(fs, apps = new Map());
  if (!apps.has(app)) apps.set(app, { chain: Promise.resolve(), waiting: 0, sceneChanged: false });
  return apps.get(app);
}

// a run that was started and whose result has not been read yet, per run
// queue and application: it outlives the tool call that started it (a
// loop takes longer than a call may), and the turn too
const pendingRuns = new WeakMap();

const str = v => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
const int = (v, d) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? n : d; };
const truthy = v => v === true || v === 'true' || v === 1;
// a glob on file names: * and ? only; with a / in it, on the whole path
function globTest(glob) {
  const re = new RegExp('^' + glob.split('').map(c => (c === '*' ? '[^/]*' : c === '?' ? '[^/]' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&'))).join('') + '$');
  return glob.includes('/') ? p => re.test(p) : p => re.test(p.split('/').pop());
}

/**
 * The tools for one turn about the open application `app`.
 *   fs       viewer/page-fs.js
 *   runs     the page engine's run queue { request(job) → Promise<result>, last(app) },
 *            or a function that returns it (the chat exists before the engine does)
 *   measure  (ids) → Promise<string>, optional: without it there is no measure tool
 *   emit     (text) → the one-line "what it is doing" for the transcript
 *   runWait  ms a run_steps call waits before it answers "still running" (tests shorten it)
 * → [{ name, description, inputSchema, execute(input, { signal }) }]
 */
export function buildTools({ fs, app, runs, measure, emit = () => {}, runWait = RUN_WAIT }) {
  const home = `applications/${app}`;
  const st = stateOf(fs, app);
  // One change at a time, in the order the calls came: the whole of it
  // (read, check, keep the old version, write) before the next one starts.
  const oneAtATime = job => {
    st.waiting++;
    const run = st.chain.then(job).finally(() => { st.waiting--; });
    st.chain = run.catch(() => {});
    return run;
  };
  // A manifest that names a step "which is not there" may only be ahead of
  // the step's own write, sent in the same round: when other changes are
  // still queued, it is tried once more behind them before it is refused.
  const change = async job => {
    try { return await oneAtATime(job); }
    catch (e) {
      if (e?.missingStep && st.waiting > 0) return oneAtATime(job);
      throw e;
    }
  };
  // a run is told "this used the old scene" only when a file the scene is
  // built from WAS changed here since the page loaded — not when a step
  // was (the viewer's own flag cannot tell: a step file moves it too, and
  // steps are read fresh on every run)
  const withStale = res => (res && typeof res === 'object' ? { ...res, stale: st.sceneChanged } : res);
  const rule = (path, mode) => {
    const r = pathRule(app, str(path), mode);
    if (!r.ok) throw new Error(r.why);
    return r.path;
  };
  const stopped = signal => { if (signal?.aborted) throw new Error('stopped'); };
  const isText = async path => {
    if (BINARY.test(path)) return null;
    const bytes = await fs.read(path);
    if (!bytes || bytes.includes(0)) return null;
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return null; }
  };

  // every write goes through here (inside the queue): checked, the old content kept, then saved
  async function save(path, text, signal) {
    if (bytesOf(text) > MAX_WRITE) throw new Error(`${path} was NOT saved: ${bytesOf(text)} bytes is more than a text file here may hold (${MAX_WRITE})`);
    let value;
    if (path.endsWith('.json')) {
      value = checkJson(path, text);
      if (path === `${home}/application.json`) checkManifest(fs, app, path, value);
    }
    if (new RegExp(`^${home.replace(/[.+]/g, '\\$&')}/steps/[^/]+\\.ts$`).test(path)) checkStep(path, text);
    if (fs.isDir(path)) throw new Error(`${path} is a folder`);
    // a file under a file ("application.json/n.md") would turn that file into a folder for everything that reads it
    for (let up = path.slice(0, path.lastIndexOf('/')); up.length > home.length; up = up.slice(0, up.lastIndexOf('/')))
      if (fs.exists(up)) throw new Error(`${path} was NOT saved: ${up} is a file, so nothing can be put under it`);
    // The page builds the cell from these files when it loads, and one it
    // refuses leaves an application that does not open. So the cell is put
    // together with the new file first. An application that ALREADY does
    // not load is let through (it is being mended, perhaps file by file),
    // with what is still wrong.
    let still = '';
    if (CELL_FILE.test(path)) {
      const bad = await cellError(fs, app, { path, value });
      if (bad) {
        if (!(await cellError(fs, app, null))) throw new Error(`${path} was NOT saved: the application would no longer load with it — ${bad}`);
        still = `\nNOTE: the application still does not load: ${bad}`;
      }
    }
    stopped(signal);
    const before = fs.exists(path) ? await fs.read(path) : null;
    const dir = undoDir(app, path), kept = versions(fs, dir);
    await fs.write(`${dir}/${(kept.at(-1)?.n ?? 0) + 1}${before === null ? '.new' : ''}`, before ?? new Uint8Array([0]));
    // over the depth: the second oldest goes — the oldest is what the file was before the assistant touched it
    if (kept.length >= UNDO_DEPTH) await fs.remove(kept[1].path);
    await fs.write(path, text);
    if (NEEDS_RELOAD.test(path)) st.sceneChanged = true;
    return `saved ${path} (${bytesOf(text)} bytes)` + (before === null ? ' — a new file' : '')
      + (NEEDS_RELOAD.test(path) ? '\nThe 3D scene shows this only after the page reloads, which happens when you finish answering: do not run steps on it in this answer.' : '')
      + still;
  }

  const tools = [
    {
      name: 'read_file',
      description: 'Read a text file: a file of the open application (application.json, layout.json, a step, an item or gripper description, your notes, an attached text file), a guide, a recipe, viewer/cell.d.ts (the step API) or cell_fr3/robot.json. Returns the text, each line after its number and a tab (the numbers are not part of the file). A long file comes in pieces: the last line says which lines you got and how to get the next. Meshes, STEP files and pictures cannot be read: you get their size.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'from the workspace root (guides/steps.md, applications/<name>/layout.json) or from the open application (steps/pick.ts)' },
          offset: { type: 'integer', description: 'first line to return, from 1 (default 1)' },
          limit: { type: 'integer', description: 'how many lines (default: as many as fit)' },
        },
        required: ['path'],
      },
      async execute(input) {
        const path = rule(input?.path, 'read');
        await fs.ready;
        if (fs.isDir(path)) throw new Error(`${path} is a folder: use list_files to see what is in it`);
        if (!fs.exists(path)) throw new Error(`there is no file ${path}: use list_files to see what there is`);
        emit(`reads ${path}`);
        const text = await isText(path);
        if (text === null) return `${path} is not a text file (${fs.size(path)} bytes): meshes, STEP files and pictures cannot be read here`;
        if (text === '') return '(the file is empty)';
        const lines = text.split('\n');
        if (lines[lines.length - 1] === '') lines.pop();
        const first = Math.max(1, int(input?.offset, 1)), want = Math.max(1, int(input?.limit, lines.length));
        if (first > lines.length) throw new Error(`${path} has ${lines.length} lines; offset ${first} is past its end`);
        const room = MAX_RESULT - 300;
        let out = '', used = 0, n = first;
        for (; n <= lines.length && n < first + want; n++) {
          const line = `${n}\t${lines[n - 1]}\n`, size = bytesOf(line);
          if (used + size > room) {
            // one line longer than a result may be (a JSON file written on one line): show its start
            if (n === first) { out = cutBytes(line, room) + '\n'; n++; out += `[line ${first} is ${size} bytes long: only its start is shown]\n`; }
            break;
          }
          out += line; used += size;
        }
        const last = n - 1;
        if (first === 1 && last === lines.length) return out;
        return out + `[lines ${first}-${last} of ${lines.length}` + (last < lines.length ? ` — call read_file with "offset": ${last + 1} for the rest]` : ']');
      },
    },
    {
      name: 'list_files',
      description: 'List the files under a folder, or find text in them. Without "pattern" it returns one line per file: path, size in bytes, and whether it is as shipped (base), changed, or the user\'s own (yours). With "pattern" it searches the text files there and returns the matching lines as path:line: text (at most 100). Use it to see what an application has (steps, items, grippers, notes, materials) and to find where a name is used.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'a folder: the open application when left out; also guides, recipes, cell_fr3, or a folder of the application (steps, items/holder)' },
          pattern: { type: 'string', description: 'text to find (case matters), or a regular expression written /like this/i' },
          glob: { type: 'string', description: 'only files whose name matches, e.g. *.ts or item.json' },
        },
      },
      async execute(input, { signal } = {}) {
        await fs.ready;
        const given = str(input?.path).trim().replace(/^\.?\/*$/, '');
        const path = given ? rule(given, 'read') : home;
        let files;
        if (path === 'viewer') files = fs.exists('viewer/cell.d.ts') ? ['viewer/cell.d.ts'] : [];
        else if (fs.isDir(path)) files = fs.list(path);
        else if (fs.exists(path)) files = [path];
        else throw new Error(`there is no folder ${path}` + (path.startsWith(home + '/') ? ` in this application — it has: ${fs.dirs(home).join(', ') || 'no folders'}` : ''));
        const glob = str(input?.glob).trim();
        if (glob) files = files.filter(globTest(glob));
        const pattern = str(input?.pattern);
        if (!pattern) {
          emit(`lists ${path}${glob ? ` (${glob})` : ''}`);
          if (!files.length) return `no files${glob ? ` matching ${glob}` : ''} under ${path}`;
          return capText(files.map(f => `${f}  ${fs.size(f)}  ${fs.origin(f)}${BINARY.test(f) ? '  (not text)' : ''}`).join('\n'),
            'give a narrower "path" or a "glob" to see the rest');
        }
        emit(`searches ${pattern}`);
        let test;
        const re = /^\/(.+)\/([a-z]*)$/s.exec(pattern);
        if (re) {
          let rx;
          try { rx = new RegExp(re[1], re[2].replace(/[gy]/g, '')); } catch (e) { throw new Error(`${pattern} is not a regular expression: ${e.message}`); }
          test = line => rx.test(line);
        } else test = line => line.includes(pattern);
        const hits = [];
        let more = false;
        search: for (const f of files) {
          // the conversation and the run records would only find the question itself
          if (/^applications\/[^/]+\/(chats|runs)\//.test(f) || (fs.size(f) ?? 0) > 1000000) continue;
          const text = await isText(f);
          stopped(signal);
          if (text === null) continue;
          const lines = text.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (!test(lines[i])) continue;
            if (hits.length === 100) { more = true; break search; }
            hits.push(`${f}:${i + 1}: ${lines[i].trim().slice(0, 240)}`);
          }
        }
        if (!hits.length) return `nothing matches ${pattern} in the ${files.length} file(s) under ${path}`;
        return capText(hits.join('\n') + (more ? '\n[the first 100 matches — give a narrower "path" or "glob" for the rest]' : ''),
          'give a narrower "path" or "glob" to see the rest');
      },
    },
    {
      name: 'write_file',
      description: 'Create a text file in the open application, or replace one whole: steps/<name>.ts, notes/<name>.md, application.json, layout.json, items/<id>/item.json, grippers/<id>/gripper.json. For a small change to an existing file use edit_file. The file is checked BEFORE it is saved and refused with the reason when it fails: JSON must parse; a step must export name, tool, entry and a default async function; the loop in application.json may only name steps that exist. Returns "saved <path> (<n> bytes)". undo puts the previous version back.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'a text file of the open application, e.g. steps/pick-place-case.ts or notes/plan.md' },
          content: { type: 'string', description: 'the whole new content of the file' },
        },
        required: ['path', 'content'],
      },
      async execute(input, { signal } = {}) {
        const path = rule(input?.path, 'write');
        if (typeof input?.content !== 'string') throw new Error('"content" must be the text of the file');
        await fs.ready;
        emit(`writes ${path}`);
        return change(() => save(path, input.content, signal));
      },
    },
    {
      name: 'edit_file',
      description: 'Change a file of the open application by replacing one exact piece of its text. "old_text" must be in the file exactly once, character for character (without the line numbers read_file shows); include a line or two around the change to make it unique, or set "all" to replace every occurrence. The result is checked as write_file checks it. Returns "saved <path> (<n> bytes)", or says that old_text was not found or how many times it occurs. undo puts the previous version back.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'a text file of the open application' },
          old_text: { type: 'string', description: 'the exact text to replace' },
          new_text: { type: 'string', description: 'what to put in its place (may be empty, to delete)' },
          all: { type: 'boolean', description: 'replace every occurrence (default: old_text must occur once)' },
        },
        required: ['path', 'old_text', 'new_text'],
      },
      async execute(input, { signal } = {}) {
        const path = rule(input?.path, 'write');
        const oldText = input?.old_text, newText = input?.new_text;
        if (typeof oldText !== 'string' || !oldText) throw new Error('"old_text" must be the exact text to replace');
        if (typeof newText !== 'string') throw new Error('"new_text" must be text (an empty string deletes old_text)');
        await fs.ready;
        let told = false;
        // read, replace and save as ONE change: another edit of this file sent in the same round waits for it
        return change(async () => {
          stopped(signal);
          if (!fs.exists(path)) throw new Error(`there is no file ${path}: create it with write_file`);
          const text = await fs.readText(path);
          const count = text.split(oldText).length - 1;
          if (count === 0) throw new Error(`old_text was not found in ${path}: read the file again and copy the text exactly, without line numbers`);
          if (count > 1 && !truthy(input?.all)) throw new Error(`old_text occurs ${count} times in ${path}: include more of the lines around it, or set "all": true`);
          if (oldText === newText) throw new Error('old_text and new_text are the same: nothing to change');
          if (!told) { told = true; emit(`edits ${path}`); }
          return save(path, text.split(oldText).join(newText), signal);
        });
      },
    },
    {
      name: 'run_steps',
      description: 'Run steps in the simulation the user is watching and get what came of it: DONE, or FAILED with the error exactly as the viewer gives it; the log; every part that is no longer where the layout put it (table frame, mm); what is held; the IO; the joints. Give "steps" (file names without .ts, run back to back) or "loop": true (the whole loop). The scene is reset first unless "keep" is true. A long run answers "still running": call again with "wait": true for its result. "last_failure": true runs nothing and returns the record of the last run that failed in the viewer.',
      inputSchema: {
        type: 'object',
        properties: {
          steps: { type: 'array', items: { type: 'string' }, description: 'step names, e.g. ["pick-place-case"]; the same name twice runs it twice' },
          loop: { type: 'boolean', description: 'run the application\'s loop' },
          keep: { type: 'boolean', description: 'do not reset the scene first: carry on from how the last run left the parts' },
          wait: { type: 'boolean', description: 'wait for the run already started and return its result' },
          last_failure: { type: 'boolean', description: 'return the record of the last failed run instead of running' },
        },
      },
      async execute(input, { signal } = {}) {
        const queue = typeof runs === 'function' ? runs() : runs;
        if (truthy(input?.last_failure)) {
          emit('reads the last failed run');
          let rec = null;
          if (queue?.last) rec = await queue.last(app);
          else {
            const text = await fs.readText(`${home}/runs/last-failure.json`);
            try { rec = text ? JSON.parse(text) : null; } catch { rec = null; }
          }
          if (!rec) return `no failed run is recorded for '${app}' (a record is kept when a run fails in the viewer)`;
          return runText({ when: 'earlier', ...rec, stale: false });
        }
        stopped(signal);                                // a call that arrives after Stop starts nothing
        if (!queue?.request) throw new Error('the simulation is not ready to take a run yet: try again in a moment');
        let table = pendingRuns.get(queue);
        if (!table) pendingRuns.set(queue, table = new Map());
        let run = table.get(app);
        // A run that ended after it answered "still running", and whose
        // result was never asked for: it is handed over with this call, not
        // dropped — a failure nobody read would be a scene nobody knows.
        let lead = '';
        if (truthy(input?.wait)) {
          if (!run) throw new Error('no run is going: call run_steps with "steps" or "loop"');
          emit(`waits for the run of ${run.label}`);
        } else {
          if (run && !run.settled) throw new Error(`the run of ${run.label} you started is still going: call run_steps with { "wait": true } to get its result first`);
          const loop = truthy(input?.loop);
          const raw = Array.isArray(input?.steps) ? input.steps : typeof input?.steps === 'string' && input.steps ? [input.steps] : [];
          // "steps/pick.ts" and "pick" name the same step
          const steps = raw.map(s => str(s).trim().replace(/^.*\//, '').replace(/\.ts$/, '').slice(0, 80)).filter(Boolean).slice(0, 50);
          if (loop === (steps.length > 0)) throw new Error('give either "steps" (a list of step names) or "loop": true');
          const label = loop ? 'the loop' : steps.join(', ');
          const keep = truthy(input?.keep);
          if (run) {
            table.delete(app);
            const earlier = `The run of ${run.label} you started earlier has ended, and you had not read its result:\n\n${runText(withStale(run.result), { logLines: 30 })}\n\n`;
            // "keep" would carry on from a scene left by a failure it has not seen
            if (keep && !run.result?.ok) return capText(`${earlier}Nothing was run now: "keep" would carry on from the scene that run left. Read the above, then call run_steps again.`, 'the log was too long to show whole');
            lead = `${earlier}---- the run you asked for now (${label}) ----\n\n`;
          }
          emit(`runs ${label}`);
          run = { label, settled: false, result: null, done: null };
          // the job, as scripts/run-step.mjs asks for one (reset, shot, fast) and as the design names it (keep)
          const job = { app, steps, loop, keep, reset: !keep, shot: false, fast: true, timeout: 300 };
          run.done = Promise.resolve().then(() => queue.request(job)).then(
            res => { run.settled = true; run.result = res; },
            e => { run.settled = true; run.result = { ok: false, error: `the run could not be made: ${e?.message ?? e}` }; });
          table.set(app, run);
        }
        // a tool call is ended after 150 s and a loop can take longer: wait
        // most of that, then hand back and let "wait" pick the run up
        let timer, onAbort;
        await Promise.race([
          run.done,
          new Promise(res => { timer = setTimeout(res, runWait); }),
          new Promise(res => { onAbort = () => res(); signal?.addEventListener('abort', onAbort, { once: true }); if (signal?.aborted) res(); }),
        ]);
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (!run.settled) return `${lead}still running (${run.label}) — call run_steps with { "wait": true } to get the result`;
        if (table.get(app) === run) table.delete(app);
        const text = runText(withStale(run.result));
        return lead ? capText(lead + text, 'the two results together were too long to show whole') : text;
      },
    },
  ];

  if (measure) tools.push({
    name: 'measure',
    description: 'Read measured geometry from the live 3D scene — never from CAD origins: for each fixture or part named, where it is now, the centre of its top rim (topCenter), the direction of its long top edge and its size, in mm and degrees, table frame; also the arm\'s joints, the mounted tool and what is held. Without "ids" it lists every fixture and part with its position. It shows the scene as loaded: a layout change you just saved is not in it until the page reloads.',
    inputSchema: {
      type: 'object',
      properties: { ids: { type: 'array', items: { type: 'string' }, description: 'ids of fixtures or parts as placed in layout.json; leave out for the whole scene' } },
    },
    async execute(input) {
      const raw = Array.isArray(input?.ids) ? input.ids : typeof input?.ids === 'string' && input.ids ? [input.ids] : [];
      const ids = raw.map(s => str(s).trim()).filter(Boolean).slice(0, 100);
      emit(`measures ${ids.length ? ids.join(', ') : 'the scene'}`);
      return capText(str(await measure(ids)) || 'nothing to measure', 'name the "ids" you need');
    },
  });

  tools.push({
    name: 'undo',
    description: 'Put a file of the open application back to what it was before your last write_file or edit_file to it (a file you created is removed). Call it again to go one more change back. Returns "restored <path>", or says there is nothing to undo.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'the file to put back' } },
      required: ['path'],
    },
    async execute(input, { signal } = {}) {
      const path = rule(input?.path, 'write');
      await fs.ready;
      return oneAtATime(async () => {
        const last = versions(fs, undoDir(app, path)).pop();
        if (!last) throw new Error(`nothing to undo for ${path}: no earlier version of it is kept (you have not changed it, or every change is already undone)`);
        stopped(signal);
        emit(`undoes ${path}`);
        const before = last.isNew ? null : await fs.read(last.path);
        if (!last.isNew && before === null) { await fs.remove(last.path); throw new Error(`the earlier version of ${path} could not be read: nothing was changed`); }
        if (NEEDS_RELOAD.test(path)) st.sceneChanged = true;
        // back to the shipped file = no change of the user's left: the file system drops it by itself
        if (before === null) await fs.remove(path); else await fs.write(path, before);
        await fs.remove(last.path);
        if (before === null) return `restored ${path}: it did not exist before, so it was removed`;
        return `restored ${path} (${before.length} bytes)` + (NEEDS_RELOAD.test(path) ? '\nThe 3D scene shows this only after the page reloads.' : '');
      });
    },
  });
  return tools;
}
