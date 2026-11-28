// The files of the shareable edition: the pack the artifact carries (the
// BASE — the robot, the starter application, the guides) with the user's own
// changes laid over it (the OVERLAY, kept in a store of viewer/page-store.js).
// The page engine answers the page's requests from here, the way the local
// server answers them from a folder.
//
// Only what differs from the pack is kept: a file written back to the pack's
// content leaves the overlay again, and a pack file that was deleted is
// remembered as deleted. No DOM in here — it runs under node, where the
// tests drive it.

const enc = new TextEncoder(), dec = new TextDecoder();

/**
 * A workspace path as the file system knows it: '/'-separated, no leading
 * '/'. Strips one leading '/', a '?query' and a '#hash', percent-decodes,
 * and returns null for anything that could point elsewhere: an empty, '.'
 * or '..' segment, a backslash, or an escape that cannot be decoded.
 */
export function normalize(path) {
  if (typeof path !== 'string') return null;
  let p = path;
  const cut = p.search(/[?#]/);                 // before decoding: a %3F is part of a name
  if (cut >= 0) p = p.slice(0, cut);
  try { p = decodeURIComponent(p); } catch { return null; }
  if (p.includes('\\')) return null;
  if (p.startsWith('/')) p = p.slice(1);
  for (const seg of p.split('/')) if (seg === '' || seg === '.' || seg === '..') return null;
  return p;
}

// A folder named by the caller: '' is the whole workspace, a trailing '/' is
// allowed ('applications/' and 'applications' are the same folder).
// Returns the prefix every path in it starts with ('' or 'x/y/'), or null.
function folder(prefix) {
  if (prefix === '' || prefix === '/' || prefix == null) return '';
  const p = normalize(String(prefix).replace(/\/$/, ''));
  return p === null ? null : p + '/';
}

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function sha256(bytes) {
  const d = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  let s = '';
  for (const b of d) s += b.toString(16).padStart(2, '0');
  return s;
}

/**
 * pack     the parsed ws/files.json: { version, files: [{ path, sha, size, text? | bin?, enc? }] }
 * loadBin  (entry) -> Promise<Uint8Array>: the decoded bytes of a `bin` entry
 * store    a store of viewer/page-store.js
 * now      the clock (ms), for the time kept with a change
 */
export function createPageFs({ pack, loadBin, store, now = Date.now }) {
  const base = new Map();                       // path -> the pack's entry
  for (const e of pack?.files ?? []) base.set(e.path, e);
  // path -> { deleted, size }: what the overlay holds, without its bytes.
  // Filled from the store once (ready) and kept in step with every change,
  // which is what lets exists / list / size answer at once.
  const over = new Map();
  const listeners = new Set();

  // The spec's "index (keys only)" is not enough to answer exists() and
  // size() at once: whether an entry is a deletion, and how long it is, are
  // in the value. So each value is looked at once here and only those two
  // facts are kept; the bytes are let go again.
  const ready = (async () => {
    for (const key of await store.keys()) {
      const v = await store.get(key);
      if (!v) continue;
      // "deleted" for a file the pack no longer carries says nothing: drop it
      if (v.bytes == null && !base.has(key)) { await store.delete(key); continue; }
      over.set(key, { deleted: v.bytes == null, size: v.bytes?.length ?? 0 });
    }
  })();
  ready.catch(() => {});                        // whoever awaits it still gets the failure

  // ---- one change at a time per path ----
  const chains = new Map();                     // path -> the end of its queue (never rejects)
  function queued(path, job) {
    const run = (chains.get(path) ?? ready.catch(() => {})).then(() => ready).then(job);
    const tail = run.catch(() => {});
    chains.set(path, tail);
    tail.then(() => { if (chains.get(path) === tail) chains.delete(path); });
    return run;
  }

  function changed(path, kind) {
    for (const fn of [...listeners]) {
      try { fn({ path, kind }); } catch (e) { console.error('page-fs: a change listener failed', e); }
    }
  }

  const baseSize = e => e.size ?? (e.text != null ? enc.encode(e.text).length : 0);

  // The pack's own bytes of a file. Not copied: treat them as read-only
  // (loadBin may hand out the same array every time).
  async function baseBytes(e) {
    return e.text != null ? enc.encode(e.text) : await loadBin(e);
  }

  // Is this what the pack carries for the file? Size first, so that a mesh
  // is fetched or hashed only when it could be the same.
  async function equalsBase(e, bytes) {
    if (e.size != null && e.size !== bytes.length) return false;
    if (e.text != null) return sameBytes(enc.encode(e.text), bytes);
    if (e.sha && globalThis.crypto?.subtle) return (await sha256(bytes)) === e.sha;
    return sameBytes(await loadBin(e), bytes);
  }

  const live = path => { const o = over.get(path); return o ? !o.deleted : base.has(path); };

  function all() {
    const out = [];
    for (const p of base.keys()) if (!over.get(p)?.deleted) out.push(p);
    for (const [p, o] of over) if (!o.deleted && !base.has(p)) out.push(p);
    return out;
  }

  function list(prefix = '') {
    const f = folder(prefix);
    if (f === null) return [];
    return all().filter(p => p.startsWith(f)).sort();
  }

  // (read / write / remove take a path as a request writes it; readAt /
  // writeAt / removeAt take the file's real name, as list() gives it — a
  // name may hold a %, a ? or a #, which the first three would read as
  // an escape, a query or a hash)
  const read = path => { const p = normalize(path); return p === null ? Promise.resolve(null) : readAt(p); };
  async function readAt(p) {
    await ready;
    await chains.get(p);                        // a write under way is seen by the read that follows it
    const o = over.get(p);
    if (o?.deleted) return null;
    if (o) {
      const v = await store.get(p);
      if (v?.bytes) return v.bytes;
      // the store lost it (site data cleared under us): the pack's file, if any
    }
    const e = base.get(p);
    return e ? baseBytes(e) : null;
  }

  function write(path, data) {
    const p = normalize(path);
    if (p === null) return Promise.reject(new Error(`not a path in the workspace: ${path}`));
    return writeAt(p, data);
  }
  function writeAt(p, data) {
    // the bytes as they are NOW: the caller may reuse its array
    const bytes = typeof data === 'string' ? enc.encode(data) : Uint8Array.from(data);
    return queued(p, async () => {
      const e = base.get(p);
      if (e && await equalsBase(e, bytes)) {
        if (over.has(p)) { await store.delete(p); over.delete(p); }
      } else {
        await store.set(p, { bytes, time: now() });
        over.set(p, { deleted: false, size: bytes.length });
      }
      // told even when the bytes are what was there: the server's scan sees
      // a rewritten file as changed too
      changed(p, 'write');
    });
  }

  const remove = path => { const p = normalize(path); return p === null ? Promise.resolve(false) : removeAt(p); };
  function removeAt(p) {
    return queued(p, async () => {
      if (!live(p)) return false;
      if (base.has(p)) {
        await store.set(p, { bytes: null, time: now() });
        over.set(p, { deleted: true, size: 0 });
      } else {
        await store.delete(p);
        over.delete(p);
      }
      changed(p, 'remove');
      return true;
    });
  }

  async function removeTree(prefix) {
    await ready;
    let n = 0;
    for (const p of list(prefix)) if (await removeAt(p)) n++;
    return n;
  }

  // Every file under `from/` becomes `to/...`. A file already at the new
  // place is written over; other files under `to/` stay (the callers move
  // into a folder that is not there yet). Returns how many were moved.
  async function moveTree(from, to) {
    const f = folder(from), t = folder(to);
    if (!f || !t) throw new Error(`not a folder in the workspace: ${!f ? from : to}`);
    if (t.startsWith(f) || f.startsWith(t)) throw new Error(`cannot move ${from} into ${to}`);
    await ready;
    let n = 0;
    for (const p of list(from)) {
      const bytes = await readAt(p);
      if (bytes === null) continue;             // removed meanwhile
      await writeAt(t + p.slice(f.length), bytes);
      await removeAt(p);
      n++;
    }
    return n;
  }

  // Back to the pack: every change under the folder `prefix` ('' = all) is
  // dropped — also a single file, when `prefix` names one. Returns the paths
  // whose content changed by it.
  async function reset(prefix = '') {
    const f = folder(prefix);
    if (f === null) return [];
    await ready;
    const one = f.slice(0, -1);
    const paths = [...over.keys()].filter(p => p.startsWith(f) || p === one).sort();
    const done = [];
    for (const p of paths) {
      await queued(p, async () => {
        if (!over.has(p)) return;
        await store.delete(p);
        over.delete(p);
        done.push(p);
        changed(p, base.has(p) ? 'write' : 'remove');
      });
    }
    return done;
  }

  return {
    ready,
    exists(path) { const p = normalize(path); return p !== null && live(p); },
    isDir(path) { const f = folder(path); return f === '' ? true : f !== null && all().some(p => p.startsWith(f)); },
    list,
    dirs(prefix = '') {
      const f = folder(prefix);
      if (f === null) return [];
      const names = new Set();
      for (const p of all()) {
        if (!p.startsWith(f)) continue;
        const cut = p.indexOf('/', f.length);
        if (cut >= 0) names.add(p.slice(f.length, cut));
      }
      return [...names].sort();
    },
    origin(path) {
      const p = normalize(path);
      if (p === null || !live(p)) return null;
      return !over.has(p) ? 'base' : base.has(p) ? 'changed' : 'yours';
    },
    read,
    async readText(path) { const b = await read(path); return b === null ? null : dec.decode(b); },
    write,
    remove,
    removeTree,
    moveTree,
    reset,
    onChange(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    size(path) {
      const p = normalize(path);
      if (p === null || !live(p)) return null;
      const o = over.get(p);
      return o ? o.size : baseSize(base.get(p));
    },
  };
}
