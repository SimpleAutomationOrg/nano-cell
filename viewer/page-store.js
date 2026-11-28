// Where the shareable edition keeps what the user changed: an async
// key -> value map. Keys are workspace paths
// ('applications/case-assembly/layout.json'); a value is
// { bytes: Uint8Array | null, time: number } — null bytes mean "the file the
// pack carries was deleted". viewer/page-fs.js lays this over the pack.
//
// Two of them: the browser's IndexedDB (what was changed is still there
// after a reload), and plain memory for where IndexedDB cannot be used (a
// private window, a preview, node). No DOM in here beyond `indexedDB`.
//
// store = { kind: 'memory' | 'idb',
//           async keys() -> string[], async get(key) -> value | undefined,
//           async set(key, value), async delete(key), async clear() }

// a value as it is kept: bytes of its own, so that what the caller does to
// its array afterwards does not reach the store
const kept = value => ({ bytes: value.bytes == null ? null : Uint8Array.from(value.bytes), time: Number(value.time) || 0 });

export function createMemoryStore() {
  const map = new Map();
  return {
    kind: 'memory',
    async keys() { return [...map.keys()]; },
    async get(key) { return map.get(key); },
    async set(key, value) { map.set(key, kept(value)); },
    async delete(key) { map.delete(key); },
    async clear() { map.clear(); },
  };
}

const FILES = 'files';                 // the one object store
const PROBE = '\u0000probe';           // never a workspace path
const OPEN_WAIT = 4000;                // ms: some frames hand out an open() that never answers

/**
 * The store in the browser's IndexedDB: one database `name`, one object
 * store. Resolves only after a real write and read back worked — private
 * windows and previews can hand out an IndexedDB that throws later — and
 * throws when it cannot be used (there is none, as under node; opening is
 * refused; the probe fails). The caller then takes createMemoryStore().
 *
 * `idb` is the IndexedDB to use; it is a parameter only so that the tests
 * can hand in a stand-in.
 */
export async function openIdbStore(name, idb = globalThis.indexedDB) {
  if (!idb) throw new Error('IndexedDB is not available here');
  const db = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('IndexedDB did not answer')), OPEN_WAIT);
    const settle = fn => value => { clearTimeout(timer); fn(value); };
    let req;
    try { req = idb.open(name, 1); } catch (e) { settle(reject)(e); return; }
    req.onupgradeneeded = () => { req.result.createObjectStore(FILES); };
    req.onsuccess = () => settle(resolve)(req.result);
    req.onerror = () => settle(reject)(req.error ?? new Error('IndexedDB could not be opened'));
    req.onblocked = () => settle(reject)(new Error('IndexedDB is blocked by another tab'));
  });

  // one transaction per call: it resolves when the transaction is COMPLETE,
  // i.e. the bytes are kept, not merely handed over
  const run = (mode, op) => new Promise((resolve, reject) => {
    const tx = db.transaction(FILES, mode);            // may throw: becomes a rejection
    const req = op(tx.objectStore(FILES));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = tx.onabort = () => reject(tx.error ?? req.error ?? new Error('IndexedDB refused the change'));
  });

  const store = {
    kind: 'idb',
    async keys() { return (await run('readonly', s => s.getAllKeys())).filter(k => typeof k === 'string' && k !== PROBE); },
    async get(key) {
      const v = await run('readonly', s => s.get(key));
      if (!v) return undefined;
      return { bytes: v.bytes == null ? null : (v.bytes instanceof Uint8Array ? v.bytes : new Uint8Array(v.bytes)), time: v.time };
    },
    async set(key, value) { await run('readwrite', s => s.put(kept(value), key)); },
    async delete(key) { await run('readwrite', s => s.delete(key)); },
    async clear() { await run('readwrite', s => s.clear()); },
  };

  // the probe: write, read back, remove
  try {
    await store.set(PROBE, { bytes: Uint8Array.of(1, 2, 3), time: 1 });
    const back = await store.get(PROBE);
    if (!back?.bytes || back.bytes.length !== 3 || back.bytes[2] !== 3) throw new Error('IndexedDB did not keep what was written');
    await store.delete(PROBE);
  } catch (e) {
    try { db.close(); } catch { /* nothing to close */ }
    throw e instanceof Error ? e : new Error(String(e));
  }
  return store;
}
