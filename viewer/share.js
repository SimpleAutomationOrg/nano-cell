// The entry point of the SHAREABLE EDITION.
//
// microfactory is also published as an artifact that asks for no access to
// anyone's computer (scripts/build-artifact.mjs --share), so that its link
// can be given to anybody. There is no workspace folder and no local
// server behind this page. This file, which that artifact loads in place
// of app.js and chat.js — it is to this edition what viewer/desktop.js is
// to the installed app — puts the same things behind the viewer from what
// a page has:
//
//  1. the FILES: the pack the artifact carries (the robot, the starter
//     application, the guides) with the viewer's own changes laid over it,
//     kept in this browser (page-fs.js, page-store.js). Export is the copy
//     that lasts;
//  2. the SERVER: a page engine (page-engine.js) that answers every
//     request the viewer makes, from those files — so app.js and chat.js
//     run as they do in a browser served by serve.py;
//  3. the ASSISTANT: asked through the artifact's `sample` function, on
//     the viewer's own account, with the page's functions as its tools
//     (page-agent.js). Outside Claude there is none, and the chat says so;
//  4. what the viewer needs of its host: saving a file for the person,
//     an address for an attached file, the way back to the original.
//
// What does not exist here, and is said plainly where it is asked for: the
// CAD pipeline, web lookups, changing the engine itself, git.
//
// Everything above the line "the page itself" is free of the DOM and runs
// under node, where test/share.test.mjs drives it over the built pack. In
// a browser served by serve.py, and in the installed app, this file is not
// loaded at all.

import { engineFetch, fromBase64 } from './desktop-bridge.js';
import { openIdbStore, createMemoryStore } from './page-store.js';
import { createPageFs } from './page-fs.js';
import { createPageEngine } from './page-engine.js';
import { createPageChat } from './page-agent.js';

// page-fs reads a path as a request address (it decodes %xx and stops at ? and #):
// a real file name is handed over with each part encoded
const q = path => path.split('/').map(encodeURIComponent).join('/');

// ---- the pack's binaries ----
// A mesh travels as base64 text, gzip'd first when its entry says so
// (`enc: 'gzip'`). Each is fetched when it is first asked for and kept in
// memory from then on: the scene asks for the same mesh more than once
// (a kit gripper and its copy in the application are one file).
async function gunzip(bytes) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
}
/**
 * @param {(ref: string) => Promise<string>} readText  the text of one carried file ('ws/b/3.txt')
 * @returns {{ bin(entry): Promise<Uint8Array>, wasm(record): Promise<Uint8Array> }}
 */
export function packLoader(readText) {
  const kept = new Map();             // the carried file -> a promise of its bytes
  const load = (ref, enc, size, what) => {
    if (!kept.has(ref)) {
      const p = (async () => {
        let bytes = fromBase64((await readText(ref)).trim());
        if (enc === 'gzip') bytes = await gunzip(bytes);
        if (typeof size === 'number' && bytes.length !== size) throw new Error(`${what} did not arrive whole`);
        return bytes;
      })();
      p.catch(() => kept.delete(ref));          // a failed download is tried again when asked again
      kept.set(ref, p);
    }
    return kept.get(ref);
  };
  return {
    bin: entry => load(entry.bin, entry.enc, entry.size, entry.path),
    wasm: record => load(record.wasm, record.enc, record.size, 'MuJoCo'),
  };
}

// ---- storage the page may be refused ----
// localStorage and sessionStorage can throw the moment they are touched (a
// private window, blocked site data, a preview). app.js and chat.js use
// them bare, at load — so before they are imported, a storage that throws
// is replaced by one in memory with the same methods. What it holds is
// gone at a reload: the application opened last, the folded chat, a draft.
export function memoryStorage() {
  const m = new Map();
  return {
    getItem: k => (m.has(String(k)) ? m.get(String(k)) : null),
    setItem: (k, v) => { m.set(String(k), String(v)); },
    removeItem: k => { m.delete(String(k)); },
    clear: () => m.clear(),
    key: i => [...m.keys()][i] ?? null,
    get length() { return m.size; },
  };
}
/** Make `win[name]` safe to use. Returns true when the browser's own works. */
export function safeStorage(win, name) {
  try {
    const s = win[name], probe = 'microfactory.probe';
    s.setItem(probe, '1'); s.removeItem(probe);
    return true;
  } catch {
    try { Object.defineProperty(win, name, { value: memoryStorage(), configurable: true, writable: true }); } catch { /* nothing more can be done */ }
    return false;
  }
}

// ---- saving a file for the person ----
// The artifact's `downloads` function saves only files of the kinds it
// knows, by the end of the name. An export is a zip under its own name
// (.microfactory): it is saved as <name>.microfactory.zip, and Import takes
// it back under either name. (Only the export is saved from here; a file
// that is not a zip would need a name of its own kind.)
const SAVED_AS = /\.(gif|png|jpe?g|webp|mp4|webm|mov|txt|json|md|docx|pptx|epub|csv|ttf|html|svg|pdf|xlsx|zip|fig)$/i;
export const saveName = name => (SAVED_AS.test(name) ? name : `${name}.zip`);
/** Why a save did not happen, in plain words. Nothing here is tried again by itself. */
export function downloadWords(e) {
  switch (e?.code) {
    case 'declined': return 'the file was not saved: the save was declined (press Export again to save it)';
    case 'rate_limited': return 'another save is still waiting for your answer: answer it, then press Export again';
    case 'too_large': return 'the file is too large to be saved from this view';
    case 'host_unavailable': return 'this app cannot save files: open Microfactory in a browser or on a computer to export';
    case 'rejected_extension': case 'extension_not_enabled': return 'this view does not allow a .zip file to be saved';
    default: return 'saving files is not available in this view';
  }
}

// ---- measured geometry, for the assistant ----
// What the assistant's `measure` tool answers with, read from the step host
// of the live scene (viewer/cell-host.js): the same measured values a step
// gets from ctx (topCenter, topLongAxis), never CAD origins. Millimetres
// and degrees, table frame — the units a run's report uses.
const mm = v => (Math.round(v * 10000) / 10).toFixed(1);
const xyz = p => `(${mm(p[0])}, ${mm(p[1])}, ${mm(p[2])})`;
const deg = r => (Math.round(r * 1800 / Math.PI) / 10).toFixed(1);
/**
 * @param host   the step host (window.host): { ctx, api, state }
 * @param ids    fixture or part ids; empty = every fixture and part, one line each
 * @param o      { tool: the mounted tool's id, probe: id => the item's collision sample points or null }
 */
export function measureText(host, ids = [], { tool = null, probe = () => null } = {}) {
  const cell = host.ctx.cell;
  const kinds = [['fixture', cell.fixtures ?? []], ['part', cell.parts ?? []]];
  const find = id => {
    for (const [kind, list] of kinds) if (list.some(it => it.id === id)) return { kind, item: kind === 'part' ? host.ctx.part(id) : host.ctx.fixture(id) };
    return null;
  };
  // the box an item fills now, from its collision samples (item frame) put through its current pose
  const span = (id, m) => {
    const pts = probe(id);
    if (!pts?.length) return null;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const p of pts) for (let k = 0; k < 3; k++) {
      const v = m[4 * k] * p[0] + m[4 * k + 1] * p[1] + m[4 * k + 2] * p[2] + m[4 * k + 3];
      if (v < lo[k]) lo[k] = v;
      if (v > hi[k]) hi[k] = v;
    }
    return { lo, hi };
  };
  const out = [];
  const measured = [...kinds[0][1], ...kinds[1][1]].some(it => probe(it.id)?.length);
  if (!measured) out.push('(the physics is not loaded: nothing is measured, and each "top centre" below is only the item\'s origin, a CAD datum)');
  if (!ids.length) {
    out.push('Every fixture and part, where it is now — the centre of its top rim, mm, table frame (z up). Name ids to get the long edge and the size.');
    for (const [kind, list] of kinds) for (const it of list) out.push(`${kind} ${it.id}: top centre ${xyz(find(it.id).item.topCenter)}`);
    if (out.length === (measured ? 1 : 2)) out.push('(this application has no fixtures and no parts)');
  }
  for (const id of ids) {
    const f = find(id);
    if (!f) { out.push(`${id}: no fixture or part has this id — this application has: ${kinds.flatMap(([, l]) => l.map(it => it.id)).join(', ') || 'none'}`); continue; }
    const it = f.item, m = it.matrix, box = span(id, m);
    out.push(`${f.kind} ${id}${it.name && it.name !== id ? ` (${it.name})` : ''}:`);
    out.push(`  top centre ${xyz(it.topCenter)} mm — the centre of its top rim; place onto this`);
    out.push(`  long top edge at ${deg(it.topLongAxis)}° (azimuth in the table frame, from +x toward +y)`);
    if (box) {
      out.push(`  fills x ${mm(box.lo[0])}..${mm(box.hi[0])}, y ${mm(box.lo[1])}..${mm(box.hi[1])}, z ${mm(box.lo[2])}..${mm(box.hi[2])} mm`
        + ` — ${mm(box.hi[0] - box.lo[0])} x ${mm(box.hi[1] - box.lo[1])} x ${mm(box.hi[2] - box.lo[2])} mm along the table's axes`);
    }
    out.push(`  origin ${xyz([m[3], m[7], m[11]])} mm — a CAD datum, not a place to put things`);
  }
  const held = host.api.held();
  const io = Object.entries(host.state.io ?? {}).map(([k, v]) => `${k}=${v ? 'on' : 'off'}`).join(', ');
  out.push(`arm: joints [${host.api.joints().map(j => (Math.round(j * 100) / 100).toFixed(2)).join(', ')}] deg; tool on the flange: ${tool ?? 'unknown'}; holding: ${held ?? 'nothing'}${io ? `; io: ${io}` : ''}`);
  return out.join('\n');
}

// ---- files, assistant and engine, put together ----
const NO_ASSISTANT = 'The assistant is not available in this view: it answers only to people signed in to Claude who have been given this page. To have a copy of your own where it answers, give Claude Code one line: install https://github.com/SimpleAutomationOrg/nano-cell. '
  + 'The simulation works here all the same: running and reordering the steps, New and Import.';
/**
 * @param o.pack       the parsed ws/files.json
 * @param o.readText   (ref) => Promise<string>: the text of a carried file ('ws/b/3.txt', 'ws/mujoco.wasm.txt')
 * @param o.store      a store of page-store.js
 * @param o.getSample  () => the artifact's sample function, a promise of it, or null when there is none
 * @param o.measure    (ids) => Promise<string>, optional (the live scene; without it the assistant has no measure tool)
 * @param o.engine     options passed on to createPageEngine (tests shorten the holds)
 * @param o.chat       options passed on to createPageChat (likewise)
 * @returns {{ fs, chat, engine }}
 */
export function createShare({ pack, readText, store, getSample = () => null, measure, engine: engineOptions = {}, chat: chatOptions = {} }) {
  const loader = packLoader(readText);
  const fs = createPageFs({ pack, loadBin: loader.bin, store });
  // (the chat is made first and the engine is given it; the chat reaches the engine's run queue when a run is asked for)
  let engine = null;
  const chat = createPageChat({ fs, getSample, runs: () => engine.runs, measure, ...chatOptions });
  // Where there is no assistant the empty conversation says so, instead of
  // inviting a message that can only fail. The answer is not waited for
  // long: a view that never says whether it has one is treated as having one,
  // and a message sent there is answered with the same words.
  const said = Object.create(chat);
  said.agent = async () => {
    const a = await chat.agent();
    let sample, timer;
    try { sample = await Promise.race([getSample(), new Promise(res => { timer = setTimeout(res, 3000, undefined); })]); } catch { sample = null; }
    clearTimeout(timer);
    return sample === null ? { ...a, hint: NO_ASSISTANT } : a;
  };
  engine = createPageEngine({
    fs, chat: said,
    mujoco: pack.mujoco ? { version: pack.mujoco.version, wasm: () => loader.wasm(pack.mujoco) } : undefined,
    ...engineOptions,
  });
  return { fs, chat: said, engine };
}

/**
 * Put an application's files back as the pack has them: every change kept
 * in the store is dropped, file by file — but not the conversation and not
 * what was attached to it (chats/, materials/), which no change to the
 * application's files can have broken. Resolves with the paths put back.
 */
export async function resetFiles(fs, store, id) {
  const prefix = `applications/${id}/`, back = [];
  for (const key of await store.keys()) {
    if (!key.startsWith(prefix) || /^(chats|materials)\//.test(key.slice(prefix.length))) continue;
    await fs.reset(q(key));
    back.push(key);
  }
  return back.sort();
}

// ---- an address for an attached file ----
// A blob: address belongs to the page's own origin, and a document opened
// from one runs there — with this browser's copy of every application and
// conversation in reach. An attachment can come from anyone (an imported
// application carries its materials/ and its conversation). So only
// pictures that cannot carry a script are given their own type; anything
// else — an SVG, a PDF, HTML — is plain bytes, which no browser opens as
// a document. And only what the chat itself saves is given an address at all.
const RASTER = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };
/** The type a file of the workspace is handed out with. */
export const fileType = path => RASTER[String(path).split('.').pop().toLowerCase()] ?? 'application/octet-stream';
/** Is this a file attached in a chat: applications/<app>/materials/<file>, and nothing else? */
export const isAttachment = path => typeof path === 'string' && !/[\\%?#]/.test(path) && /^applications\/[^/]+\/materials\/[^/]+$/.test(path)
  && !path.split('/').some(part => part === '.' || part === '..');

// ---- one page at a time ----
// Every tab of this page keeps its changes in the same store, and each has
// its own picture of what is in it, read once at the start: two tabs would
// write over each other's files without seeing them. So a page holds a
// lock (the browser's, by name, shared by the tabs of this origin) for as
// long as it lives, and a second one waits for the first to close.
//   locks    navigator.locks, or nothing where the browser has none
//   waiting  called when another page holds it: say so, the wait may be long
// Resolves 'held' | 'none' (no locks here, or they do not answer: carry on
// as before — the page must not be kept from starting by this).
export async function onePage(locks, waiting = () => {}, { name = 'microfactory', patience = 3000 } = {}) {
  if (!locks?.request) return 'none';
  // the lock is kept by never finishing the function that was given it
  const take = options => new Promise((resolve, reject) => {
    Promise.resolve().then(() => locks.request(name, options, lock => {
      resolve(lock ? 'held' : 'busy');
      return lock ? new Promise(() => {}) : undefined;
    })).catch(reject);
  });
  let timer;
  try {
    const first = await Promise.race([take({ ifAvailable: true }), new Promise(res => { timer = setTimeout(res, patience, 'none'); })]);
    if (first !== 'busy') return first;
    waiting();
    return await take({});
  } catch { return 'none'; }
  finally { clearTimeout(timer); }
}

// ================= the page itself =================

/**
 * Start the page. `viewer` loads the viewer itself once everything it
 * needs is behind it (the test stands in for it: app.js needs a real page).
 */
export async function startPage({ viewer = async () => { await import('./app.js'); await import('./chat.js'); } } = {}) {
  // 1. the browser's own fetch, kept for the files the artifact carries; storage made safe
  const realFetch = window.fetch.bind(window);
  safeStorage(window, 'localStorage');
  safeStorage(window, 'sessionStorage');

  // 2. a card over the page while it starts (the look of the installed app's setup screens)
  const ui = document.createElement('div');
  ui.id = 'setup';
  ui.innerHTML = `
    <style>
      #setup { position: fixed; inset: 0; z-index: 100; display: grid; place-items: center; background: #0d1115; color: #cdd6e0; font-size: 13px; }
      #setup[hidden] { display: none; }
      #setup .card { width: min(520px, calc(100vw - 48px)); background: #151b22; border: 1px solid #2f3b4a; border-radius: 14px; padding: 22px; }
      #setup h2 { margin: 0 0 6px; font-size: 16px; color: #fff; }
      #setup p { margin: 6px 0; line-height: 1.5; color: #9fb0c0; }
      #setup pre { margin: 10px 0 0; padding: 9px; background: #0c0f13; border-radius: 7px; color: #ff9f9f; font-size: 11px; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 180px; overflow: auto; }
      #pageNote { position: fixed; left: 12px; bottom: 12px; z-index: 90; max-width: 420px; display: flex; gap: 10px; align-items: flex-start; background: #2a2212; border: 1px solid #6b5422; color: #f0d9a8; border-radius: 9px; padding: 9px 11px; font-size: 12px; line-height: 1.45; }
      #pageNote button { flex: none; padding: 1px 7px; }
    </style>
    <div class="card"><h2></h2><p></p><pre hidden></pre></div>`;
  document.body.appendChild(ui);
  const screen = (title, line, detail = '') => {
    ui.hidden = false;
    ui.querySelector('h2').textContent = title;
    ui.querySelector('p').textContent = line;
    const pre = ui.querySelector('pre');
    pre.hidden = !detail; pre.textContent = detail;
  };

  try {
    // 3. the pack: the list at once, each mesh when the scene asks for it
    screen('Loading Microfactory…', 'Reading the robot and the application …');
    const carried = async ref => {
      const r = await realFetch(new URL('./' + ref, document.baseURI));
      if (!r.ok) throw new Error(`${ref}: ${r.status}`);
      return r;
    };
    const pack = await (await carried('ws/files.json')).json();

    // 4. where the viewer's own changes are kept: this browser, or nowhere — and one page at a time on it
    await onePage(globalThis.navigator?.locks, () => screen('Microfactory is open in another tab',
      'It is already open in another tab or window of this browser, and two at once would overwrite each other\'s changes. Use that one — or close it, and this one starts by itself.'));
    screen('Loading Microfactory…', 'Opening what you changed here before …');
    let store;
    try { store = await openIdbStore('microfactory'); }
    catch (e) { console.info('no storage in this browser, changes are kept in memory:', e?.message ?? e); store = createMemoryStore(); }

    // 5. files, assistant, engine — and from here on the engine answers the page's requests
    screen('Loading Microfactory…', 'Starting …');
    // (asked for once; a view outside Claude has no window.claude at all)
    const cap = name => (window.claude?.use ? window.claude.use(name).catch(() => null) : null);
    const { fs, engine } = createShare({
      pack, store,
      readText: async ref => (await carried(ref)).text(),
      getSample: () => cap('sample'),
      // the scene is built by app.js after this file has finished: wait for it
      measure: async ids => {
        for (let n = 0; n < 100 && !window.host; n++) await new Promise(res => setTimeout(res, 200));
        if (!window.host) throw new Error('the 3D scene has not loaded: there is nothing to measure');
        const world = window.mjWorld?.();
        return measureText(window.host, ids, { tool: document.getElementById('toolSel')?.value || null, probe: id => world?.probePoints?.(id) ?? null });
      },
    });
    await fs.ready;
    window.fetch = engineFetch(engine, realFetch, { pageUrl: document.baseURI });

    // 6. what the viewer asks of its host (app.js and chat.js read window.microfactoryDesktop)
    const packed = new Set(pack.files.map(f => f.path));
    const framed = (() => { try { return window.top !== window; } catch { return true; } })();
    const urls = new Map();
    window.microfactoryDesktop = {
      kind: 'page',                    // the installed app's object has no `kind`
      workspace: '',
      keptFiles: [],
      changeWorkspace() {},
      // A file for the person, through the artifact's own save (it asks them
      // first). Resolves with where it went, in words for the status line.
      async saveFile(name, blob) {
        const downloads = await cap('downloads');
        if (!downloads) {
          // Inside Claude's frame a page cannot start a download itself: without the function there is no way.
          if (window.claude?.use && framed) throw new Error(downloadWords(null));
          // Opened by itself (a plain web server): the browser's own download, under the file's own name.
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = name;
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 10000);
          return `${name} — with your browser's downloads`;
        }
        const filename = saveName(name);
        try { await downloads.save({ filename, data: blob }); }
        catch (e) { throw new Error(downloadWords(e)); }
        return `${filename} — with your downloads`;
      },
      // An address for a file attached in a chat (the chat shows attachments with it).
      async fileUrl(path) {
        if (!isAttachment(path)) throw new Error(`${path}: not an attached file`);
        if (!urls.has(path)) {
          const bytes = await fs.read(q(path));
          if (!bytes) throw new Error(`${path}: not found`);
          urls.set(path, URL.createObjectURL(new Blob([bytes], { type: fileType(path) })));
        }
        return urls.get(path);
      },
      // Is this application one the page came with (so that it can be put back)?
      original: id => packed.has(`applications/${id}/application.json`),
      // The way back when a change broke an application: its files as the page
      // came with them. The conversation and what was attached to it stay.
      async resetApplication(id) {
        // (as one change: each file put back would otherwise ask for a reload
        // of its own, and the page would reload with only some of them back)
        await engine.asOne(() => resetFiles(fs, store, id));
        location.reload();
      },
    };

    // texts of the page that speak of a folder and a server, which are not here
    const words = (sel, set) => { const el = document.querySelector(sel); if (el) set(el); };
    words('#panel .sub', el => { el.textContent = el.textContent.replace(/\s*·\s*live reload\s*$/, ''); });
    words('#appSel', el => { el.title = 'your applications — pick one to open it'; });
    words('#appExport', el => { el.title = 'save this application as one file, to keep or to send to someone — your changes live only in this browser until you do'; });
    words('#appImport', el => { el.title = 'open an exported application (.microfactory or .microfactory.zip)'; });
    if (store.kind === 'memory') {
      // said once, in the page: nothing typed or changed here outlives the page
      const note = document.createElement('div');
      note.id = 'pageNote';
      const text = document.createElement('span');
      text.textContent = 'This browser gives the page nowhere to keep things: your changes last only until the page reloads — and opening another application, New and Import reload it. Use Export to keep your work.';
      const close = document.createElement('button');
      close.type = 'button'; close.textContent = '×'; close.title = 'close';
      close.onclick = () => note.remove();
      note.append(text, close);
      document.body.appendChild(note);
    }

    // 7. the viewer itself
    ui.hidden = true;
    await viewer();
  } catch (e) {
    console.error(e);
    screen('Microfactory could not start', 'Something failed while loading. Reloading the page may help; the detail below says what went wrong.', String(e?.stack ?? e));
  }
}

if (typeof document !== 'undefined') startPage();
