// The files of the shareable edition (viewer/page-fs.js over a store of
// viewer/page-store.js): the pack underneath, the user's changes on top,
// and what is still there after a reload. Every rule is checked twice: over
// the memory store and over the IndexedDB store — the latter against a
// small stand-in for IndexedDB, since node has none.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createPageFs, normalize } from '../viewer/page-fs.js';
import { createMemoryStore, openIdbStore } from '../viewer/page-store.js';

const text = s => new TextEncoder().encode(s);
const sha = b => createHash('sha256').update(b).digest('hex');
const same = (a, b, why) => assert.deepEqual(Buffer.from(a), Buffer.from(b), why);

// ---- a pack as the build writes it: text inside, meshes by reference ----
const MESH = Uint8Array.from({ length: 5000 }, (_, i) => (i * 7) % 251);
const GLB = Uint8Array.from({ length: 900 }, (_, i) => (i * 13) % 256);
const LAYOUT = '{\n  "fixtures": []\n}\n';
const BINS = {                         // what ws/b/N.txt would hold, base64
  'ws/b/0.txt': Buffer.from(MESH).toString('base64'),
  'ws/b/1.txt': Buffer.from(gzipSync(GLB)).toString('base64'),       // the share build gzips meshes
};
const entry = (path, body, more) => ({ path, sha: sha(typeof body === 'string' ? text(body) : body), size: (typeof body === 'string' ? text(body) : body).length, ...more });
function makePack() {
  return {
    version: 'abc',
    files: [
      entry('applications/demo/application.json', '{"name": "Demo"}\n', { text: '{"name": "Demo"}\n' }),
      entry('applications/demo/layout.json', LAYOUT, { text: LAYOUT }),
      entry('applications/demo/steps/pick.ts', 'export const name = "pick";\n', { text: 'export const name = "pick";\n' }),
      entry('applications/demo/items/case/case.stl', MESH, { bin: 'ws/b/0.txt' }),
      entry('applications/demo/items/case/case.glb', GLB, { bin: 'ws/b/1.txt', enc: 'gzip' }),
      entry('cell_fr3/robot.json', '{"arm": "fr3"}\n', { text: '{"arm": "fr3"}\n' }),
      entry('guides/agent.md', '# żółw\n', { text: '# żółw\n' }),
    ],
  };
}
// the entry module's part: fetch the reference, decode, inflate when the entry says so
function makeLoadBin() {
  const loadBin = async e => {
    loadBin.calls.push(e.path);
    const raw = Buffer.from(BINS[e.bin], 'base64');
    return new Uint8Array(e.enc === 'gzip' ? gunzipSync(raw) : raw);
  };
  loadBin.calls = [];
  return loadBin;
}

// ---- a stand-in for IndexedDB: just what page-store.js uses of it ----
// Requests answer on a later turn and values are cloned on the way in and
// out, as the real one does. `trouble.put` makes every write fail the way a
// private window's does: the open works, the transaction aborts.
function fakeIndexedDB(trouble = {}) {
  const dbs = new Map();
  const later = fn => setTimeout(fn, 0);
  return {
    open(name) {
      if (trouble.open === 'throw') throw new Error('The operation is insecure.');
      /** @type {any} */ const req = {};
      later(() => {
        if (trouble.open) { req.error = new Error('denied'); req.onerror?.(); return; }
        let stores = dbs.get(name);
        const fresh = !stores;
        if (fresh) dbs.set(name, stores = new Map());
        req.result = {
          createObjectStore(n) { stores.set(n, new Map()); },
          close() {},
          transaction(n, mode) {
            const map = stores.get(n);
            if (!map) throw new Error('no such object store');
            /** @type {any} */ const tx = { error: null };
            let failed = false;
            const ask = fn => {
              /** @type {any} */ const r = {};
              try { r.result = fn(); } catch (e) { failed = true; tx.error = e; }
              return r;
            };
            const writes = fn => () => {
              if (mode !== 'readwrite') throw new Error('read-only transaction');
              if (trouble.put) throw new Error('QuotaExceededError');
              return fn();
            };
            later(() => (failed ? tx.onabort?.() : tx.oncomplete?.()));
            return { ...tx, objectStore: () => ({
              put: (value, key) => ask(writes(() => { map.set(key, structuredClone(value)); })),
              get: key => ask(() => structuredClone(map.get(key))),
              delete: key => ask(writes(() => { map.delete(key); })),
              clear: () => ask(writes(() => { map.clear(); })),
              getAllKeys: () => ask(() => [...map.keys()]),
            }), set oncomplete(f) { tx.oncomplete = f; }, set onabort(f) { tx.onabort = f; }, set onerror(f) { tx.onerror = f; }, get error() { return tx.error; } };
          },
        };
        if (fresh) req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
  };
}

// Each kind gives `open()`: the SAME kept data every time it is called —
// which is what a reload of the page is to the file system.
const KINDS = {
  memory: () => { const store = createMemoryStore(); return async () => store; },
  idb: () => { const idb = fakeIndexedDB(); return () => openIdbStore('microfactory', idb); },
};

for (const [kind, make] of Object.entries(KINDS)) {
  const fresh = async () => {
    const open = make(), loadBin = makeLoadBin();
    let clock = 1000;
    const boot = async () => {
      const store = await open();
      const fs = createPageFs({ pack: makePack(), loadBin, store, now: () => clock++ });
      await fs.ready;
      return { fs, store };
    };
    return { ...(await boot()), boot, loadBin };
  };
  const t = (name, fn) => test(`[${kind}] ${name}`, fn);

  t('the store says what it is and keeps values apart from the arrays it was given', async () => {
    const { store } = await fresh();
    assert.equal(store.kind, kind);
    assert.deepEqual(await store.keys(), [], 'nothing of the probe is left');
    assert.equal(await store.get('nothing'), undefined);
    const bytes = text('abc');
    await store.set('a/b.txt', { bytes, time: 5 });
    bytes[0] = 0;
    const got = await store.get('a/b.txt');
    assert.ok(got.bytes instanceof Uint8Array);
    same(got.bytes, text('abc'));
    assert.equal(got.time, 5);
    await store.set('gone.txt', { bytes: null, time: 6 });
    assert.deepEqual(await store.get('gone.txt'), { bytes: null, time: 6 });
    assert.deepEqual((await store.keys()).sort(), ['a/b.txt', 'gone.txt']);
    await store.delete('a/b.txt');
    assert.deepEqual(await store.keys(), ['gone.txt']);
    await store.clear();
    assert.deepEqual(await store.keys(), []);
  });

  t('a file of the pack is read as it is: text, a mesh through loadBin, a gzipped mesh inflated', async () => {
    const { fs, loadBin } = await fresh();
    assert.equal(await fs.readText('applications/demo/layout.json'), LAYOUT);
    assert.equal(await fs.readText('guides/agent.md'), '# żółw\n');
    same(await fs.read('guides/agent.md'), text('# żółw\n'));
    assert.deepEqual(loadBin.calls, [], 'text needs no fetch');
    same(await fs.read('applications/demo/items/case/case.stl'), MESH);
    same(await fs.read('applications/demo/items/case/case.glb'), GLB);
    assert.deepEqual(loadBin.calls, ['applications/demo/items/case/case.stl', 'applications/demo/items/case/case.glb']);
    assert.equal(await fs.read('applications/demo/nothing.json'), null);
    assert.equal(await fs.readText('applications/demo/nothing.json'), null);
    // as the page asks for it: a leading slash, a cache-buster
    assert.equal(await fs.readText('/applications/demo/layout.json?v=12'), LAYOUT);
  });

  t('what exists, what is a folder, what a folder holds, how long a file is', async () => {
    const { fs } = await fresh();
    assert.equal(fs.exists('cell_fr3/robot.json'), true);
    assert.equal(fs.exists('cell_fr3'), false, 'a folder is not a file');
    assert.equal(fs.exists('cell_fr3/nothing.json'), false);
    assert.equal(fs.isDir('cell_fr3'), true);
    assert.equal(fs.isDir('applications/demo/items/'), true);
    assert.equal(fs.isDir('applications/dem'), false, 'a folder, not the beginning of a name');
    assert.equal(fs.isDir('cell_fr3/robot.json'), false);
    assert.equal(fs.isDir(''), true);
    assert.deepEqual(fs.list('applications/demo/items'), ['applications/demo/items/case/case.glb', 'applications/demo/items/case/case.stl']);
    assert.deepEqual(fs.list('applications/demo/items/'), fs.list('applications/demo/items'));
    assert.deepEqual(fs.list('applications/dem'), []);
    assert.equal(fs.list().length, 7);
    assert.deepEqual(fs.list(), [...fs.list()].sort());
    assert.deepEqual(fs.dirs(''), ['applications', 'cell_fr3', 'guides']);
    assert.deepEqual(fs.dirs('applications'), ['demo']);
    assert.deepEqual(fs.dirs('applications/demo'), ['items', 'steps']);
    assert.deepEqual(fs.dirs('guides'), []);
    assert.equal(fs.size('applications/demo/items/case/case.stl'), 5000);
    assert.equal(fs.size('guides/agent.md'), text('# żółw\n').length, 'bytes, not characters');
    assert.equal(fs.size('nothing'), null);
  });

  t('a write lies over the pack and is read back; the pack\'s file is "changed", a new one "yours"', async () => {
    const { fs, store } = await fresh();
    assert.equal(fs.origin('applications/demo/layout.json'), 'base');
    assert.equal(fs.origin('applications/demo/notes/plan.md'), null);
    await fs.write('applications/demo/layout.json', '{"fixtures": [1]}\n');
    await fs.write('applications/demo/notes/plan.md', text('# plan\n'));
    assert.equal(await fs.readText('applications/demo/layout.json'), '{"fixtures": [1]}\n');
    assert.equal(await fs.readText('applications/demo/notes/plan.md'), '# plan\n');
    assert.equal(fs.origin('applications/demo/layout.json'), 'changed');
    assert.equal(fs.origin('applications/demo/notes/plan.md'), 'yours');
    assert.equal(fs.size('applications/demo/layout.json'), 18);
    assert.equal(fs.exists('applications/demo/notes/plan.md'), true);
    assert.deepEqual(fs.dirs('applications/demo'), ['items', 'notes', 'steps']);
    assert.ok(fs.list('applications/demo').includes('applications/demo/notes/plan.md'));
    // when write() has resolved the bytes ARE in the store, with the time of the change
    const kept = await store.get('applications/demo/layout.json');
    same(kept.bytes, text('{"fixtures": [1]}\n'));
    assert.equal(kept.time, 1000);
    assert.deepEqual((await store.keys()).sort(), ['applications/demo/layout.json', 'applications/demo/notes/plan.md']);
  });

  t('the array given to write can be reused: what was written is what it held then', async () => {
    const { fs } = await fresh();
    const bytes = text('first');
    const done = fs.write('applications/demo/a.bin', bytes);
    bytes.fill(0);
    await done;
    assert.equal(await fs.readText('applications/demo/a.bin'), 'first');
  });

  t('writing the pack\'s own bytes back takes the file out of the overlay again — text and mesh', async () => {
    const { fs, store } = await fresh();
    await fs.write('applications/demo/layout.json', 'something else');
    await fs.write('applications/demo/items/case/case.glb', text('not a mesh'));
    assert.equal((await store.keys()).length, 2);
    await fs.write('applications/demo/layout.json', LAYOUT);
    await fs.write('applications/demo/items/case/case.glb', GLB);
    assert.deepEqual(await store.keys(), [], 'nothing is kept for a file that is the pack\'s');
    assert.equal(fs.origin('applications/demo/layout.json'), 'base');
    assert.equal(fs.origin('applications/demo/items/case/case.glb'), 'base');
    same(await fs.read('applications/demo/items/case/case.glb'), GLB);
    // and a first write of the same bytes never enters it
    await fs.write('cell_fr3/robot.json', text('{"arm": "fr3"}\n'));
    assert.deepEqual(await store.keys(), []);
    // same length, other bytes: that IS a change
    await fs.write('applications/demo/items/case/case.stl', MESH.map(b => b ^ 1));
    assert.equal(fs.origin('applications/demo/items/case/case.stl'), 'changed');
  });

  t('a deleted file of the pack stays deleted after a reload, and so does everything else that was changed', async () => {
    const { fs, boot } = await fresh();
    assert.equal(await fs.remove('applications/demo/steps/pick.ts'), true);
    assert.equal(await fs.remove('applications/demo/steps/pick.ts'), false, 'nothing there the second time');
    assert.equal(await fs.remove('applications/demo/never.ts'), false);
    await fs.write('applications/demo/layout.json', 'changed');
    await fs.write('applications/demo/steps/place.ts', 'mine');
    assert.equal(fs.exists('applications/demo/steps/pick.ts'), false);
    assert.equal(await fs.read('applications/demo/steps/pick.ts'), null);
    assert.equal(fs.origin('applications/demo/steps/pick.ts'), null);
    assert.equal(fs.size('applications/demo/steps/pick.ts'), null);

    const again = (await boot()).fs;                    // the page reloaded
    assert.equal(again.exists('applications/demo/steps/pick.ts'), false);
    assert.equal(await again.read('applications/demo/steps/pick.ts'), null);
    assert.deepEqual(again.list('applications/demo/steps'), ['applications/demo/steps/place.ts']);
    assert.equal(await again.readText('applications/demo/layout.json'), 'changed');
    assert.equal(again.origin('applications/demo/layout.json'), 'changed');
    assert.equal(again.origin('applications/demo/steps/place.ts'), 'yours');
    assert.equal(again.size('applications/demo/steps/place.ts'), 4);
    // a deleted file can be written again
    await again.write('applications/demo/steps/pick.ts', 'new pick');
    assert.equal(again.origin('applications/demo/steps/pick.ts'), 'changed');
    assert.equal(await (await boot()).fs.readText('applications/demo/steps/pick.ts'), 'new pick');
  });

  t('removing a file of your own leaves nothing behind in the store', async () => {
    const { fs, store } = await fresh();
    await fs.write('applications/demo/notes/a.md', 'a');
    assert.equal(await fs.remove('applications/demo/notes/a.md'), true);
    assert.deepEqual(await store.keys(), []);
    assert.equal(fs.exists('applications/demo/notes/a.md'), false);
    assert.equal(fs.isDir('applications/demo/notes'), false, 'a folder is only its files');
  });

  t('reset drops the changes under a folder and brings deleted files back; it says which paths changed', async () => {
    const { fs, store, boot } = await fresh();
    await fs.write('applications/demo/layout.json', 'changed');
    await fs.write('applications/demo/notes/a.md', 'mine');
    await fs.remove('applications/demo/steps/pick.ts');
    await fs.write('cell_fr3/robot.json', 'other robot');
    const paths = await fs.reset('applications/demo');
    assert.deepEqual(paths, ['applications/demo/layout.json', 'applications/demo/notes/a.md', 'applications/demo/steps/pick.ts']);
    assert.equal(await fs.readText('applications/demo/layout.json'), LAYOUT);
    assert.equal(fs.exists('applications/demo/notes/a.md'), false);
    assert.equal(await fs.readText('applications/demo/steps/pick.ts'), 'export const name = "pick";\n');
    assert.equal(await fs.readText('cell_fr3/robot.json'), 'other robot', 'outside the folder: untouched');
    assert.deepEqual(await store.keys(), ['cell_fr3/robot.json']);
    assert.deepEqual(await fs.reset('applications/demo'), [], 'nothing left to drop');
    // one file, then everything
    await fs.write('guides/agent.md', 'x');
    assert.deepEqual(await fs.reset('guides/agent.md'), ['guides/agent.md']);
    assert.deepEqual(await fs.reset(), ['cell_fr3/robot.json']);
    assert.deepEqual(await store.keys(), []);
    assert.deepEqual((await boot()).fs.list(), makePack().files.map(f => f.path).sort(), 'after a reload: the pack, exactly');
  });

  t('moveTree takes every file under a folder to another, meshes of the pack included, and the old place is gone for good', async () => {
    const { fs, boot } = await fresh();
    await fs.write('applications/demo/notes/a.md', 'mine');
    await fs.write('applications/demo/layout.json', 'changed');
    const before = fs.list('applications/demo');
    assert.equal(await fs.moveTree('applications/demo', '.backups/demo-20261127-101500'), before.length);
    assert.deepEqual(fs.list('applications/demo'), []);
    assert.equal(fs.isDir('applications/demo'), false);
    assert.deepEqual(fs.list('.backups/demo-20261127-101500'), before.map(p => p.replace('applications/demo', '.backups/demo-20261127-101500')).sort());
    same(await fs.read('.backups/demo-20261127-101500/items/case/case.glb'), GLB);
    assert.equal(await fs.readText('.backups/demo-20261127-101500/layout.json'), 'changed');
    assert.equal(await fs.readText('.backups/demo-20261127-101500/notes/a.md'), 'mine');
    const again = (await boot()).fs;
    assert.deepEqual(again.list('applications'), []);
    same(await again.read('.backups/demo-20261127-101500/items/case/case.stl'), MESH);
    // moved back, the pack's files are the pack's again: nothing kept for them
    await again.moveTree('.backups/demo-20261127-101500/items', 'applications/demo/items');
    assert.equal(again.origin('applications/demo/items/case/case.stl'), 'base');
    await assert.rejects(again.moveTree('applications', 'applications/demo/inside'), /cannot move/);
    await assert.rejects(again.moveTree('applications/../x', 'y'), /not a folder/);
  });

  t('removeTree removes a folder\'s files, the pack\'s and your own, and counts them', async () => {
    const { fs, boot } = await fresh();
    await fs.write('applications/demo/steps/place.ts', 'mine');
    assert.equal(await fs.removeTree('applications/demo/steps'), 2);
    assert.equal(await fs.removeTree('applications/demo/steps'), 0);
    assert.deepEqual(fs.dirs('applications/demo'), ['items']);
    assert.deepEqual((await boot()).fs.list('applications/demo/steps'), []);
    assert.equal(fs.exists('applications/demo/layout.json'), true, 'files beside the folder stay');
  });

  t('every change is told to those who asked, after it is done, until they stop listening', async () => {
    const { fs } = await fresh();
    const seen = [];
    const stop = fs.onChange(c => seen.push(`${c.kind} ${c.path} ${fs.exists(c.path)}`));
    await fs.write('applications/demo/notes/a.md', 'a');
    await fs.remove('applications/demo/notes/a.md');
    await fs.remove('applications/demo/notes/a.md');           // nothing there: nothing told
    await fs.remove('cell_fr3/robot.json');
    await fs.reset('cell_fr3');
    await fs.write('guides/x.md', 'x');
    await fs.reset('guides');
    assert.deepEqual(seen, [
      'write applications/demo/notes/a.md true',
      'remove applications/demo/notes/a.md false',
      'remove cell_fr3/robot.json false',
      'write cell_fr3/robot.json true',          // reset brought the pack's file back
      'write guides/x.md true',
      'remove guides/x.md false',                // reset took the user's own file away
    ]);
    stop();
    await fs.write('guides/y.md', 'y');
    assert.equal(seen.length, 6);
    // one listener failing does not undo the write or silence the others
    const quiet = console.error; console.error = () => {};
    try {
      let told = 0;
      fs.onChange(() => { throw new Error('listener broke'); });
      fs.onChange(() => told++);
      await fs.write('guides/z.md', 'z');
      assert.equal(told, 1);
      assert.equal(await fs.readText('guides/z.md'), 'z');
    } finally { console.error = quiet; }
  });

  t('writes to one path happen one after another, in the order they were asked for', async () => {
    const { fs, store, boot } = await fresh();
    const order = [];
    fs.onChange(c => order.push(c.kind));
    const path = 'applications/demo/layout.json';
    // not awaited one by one: a save, the pack's content, a delete, a save —
    // if they overlapped, the delete of the overlay entry could land last
    const all = [fs.write(path, 'one'), fs.write(path, LAYOUT), fs.remove(path), fs.write(path, 'two'), fs.write(path, 'three')];
    const reading = fs.readText(path);                 // asked for now: sees what was asked before it
    await Promise.all(all);
    assert.equal(await reading, 'three');
    assert.equal(await fs.readText(path), 'three');
    same((await store.get(path)).bytes, text('three'));
    assert.deepEqual(order, ['write', 'write', 'remove', 'write', 'write']);
    assert.equal(await (await boot()).fs.readText(path), 'three');
    // many at once on many paths
    await Promise.all(Array.from({ length: 40 }, (_, i) => fs.write(`applications/demo/notes/n${i % 4}.md`, `v${i}`)));
    for (let k = 0; k < 4; k++) assert.equal(await fs.readText(`applications/demo/notes/n${k}.md`), `v${36 + k}`);
  });

  t('a path that points outside the workspace is never read, written or removed', async () => {
    const { fs, store } = await fresh();
    for (const bad of ['../secret', 'applications/../../x', 'a\\b', 'a//b', '', './a', 'applications/%2e%2e/x', 'a/%ZZ']) {
      assert.equal(fs.exists(bad), false, bad);
      assert.equal(await fs.read(bad), null, bad);
      assert.equal(fs.origin(bad), null, bad);
      assert.equal(fs.size(bad), null, bad);
      assert.equal(await fs.remove(bad), false, bad);
      await assert.rejects(fs.write(bad, 'x'), /not a path in the workspace/, bad);
    }
    assert.deepEqual(fs.list('../applications'), []);
    assert.deepEqual(fs.dirs('a\\b'), []);
    assert.deepEqual(await fs.reset('..'), []);
    assert.deepEqual(await store.keys(), []);
  });
}

// ---- rules that do not depend on the store ----

test('normalize: a leading slash, a query and a hash go; escapes are decoded; anything that could point elsewhere is null', () => {
  assert.equal(normalize('applications/demo/layout.json'), 'applications/demo/layout.json');
  assert.equal(normalize('/applications/demo/layout.json'), 'applications/demo/layout.json');
  assert.equal(normalize('/cell_fr3/robot.json?v=17'), 'cell_fr3/robot.json');
  assert.equal(normalize('guides/agent.md#how'), 'guides/agent.md');
  assert.equal(normalize('applications/demo/materials/my%20photo.png'), 'applications/demo/materials/my photo.png');
  assert.equal(normalize('notes/za%C5%BC%C3%B3%C5%82%C4%87.md'), 'notes/zażółć.md');
  assert.equal(normalize('notes/what%3Fnow.md'), 'notes/what?now.md', 'an escaped ? is part of the name');
  assert.equal(normalize('.backups/demo/a.json'), '.backups/demo/a.json', 'a dot at the start of a name is fine');
  for (const bad of ['..', '../x', 'a/../b', 'a/..', '/../etc/passwd', 'a/./b', '.', 'a//b', '//a', 'a/', '', '/',
    'a\\b', '..\\x', 'a/%2e%2e/b', '%2e%2e/x', 'a%5Cb', 'a%2F%2Fb', 'a/%E0%A4%A', null, undefined, 7]) {
    assert.equal(normalize(/** @type {any} */ (bad)), null, String(bad));
  }
});

test('a "deleted" mark for a file the pack no longer carries is dropped at start; the user\'s own files stay', async () => {
  const store = createMemoryStore();
  await store.set('applications/old/gone.json', { bytes: null, time: 1 });
  await store.set('applications/old/mine.json', { bytes: text('{}'), time: 2 });
  const fs = createPageFs({ pack: makePack(), loadBin: makeLoadBin(), store });
  await fs.ready;
  assert.deepEqual(await store.keys(), ['applications/old/mine.json']);
  assert.equal(fs.exists('applications/old/gone.json'), false);
  assert.equal(fs.origin('applications/old/mine.json'), 'yours');
});

test('before the kept changes are loaded the pack answers; reads and writes wait for them', async () => {
  const store = createMemoryStore();
  await store.set('applications/demo/layout.json', { bytes: text('kept'), time: 1 });
  const fs = createPageFs({ pack: makePack(), loadBin: makeLoadBin(), store });
  const early = fs.readText('applications/demo/layout.json');       // asked before ready
  assert.equal(await early, 'kept');
  await fs.ready;
  assert.equal(fs.origin('applications/demo/layout.json'), 'changed');
});

test('a store that fails makes ready and every read and write fail with its words, not hang', async () => {
  const store = { ...createMemoryStore(), kind: 'memory', async keys() { throw new Error('site data is blocked'); } };
  const fs = createPageFs({ pack: makePack(), loadBin: makeLoadBin(), store });
  await assert.rejects(fs.ready, /site data is blocked/);
  await assert.rejects(fs.read('cell_fr3/robot.json'), /site data is blocked/);
  await assert.rejects(fs.write('cell_fr3/robot.json', 'x'), /site data is blocked/);
  // and a write the store refuses is a rejection; the file stays as it was, later writes still work
  const picky = createMemoryStore(), set = picky.set;
  let refuse = true;
  picky.set = async (k, v) => { if (refuse) throw new Error('quota exceeded'); return set(k, v); };
  const fs2 = createPageFs({ pack: makePack(), loadBin: makeLoadBin(), store: picky });
  await assert.rejects(fs2.write('cell_fr3/robot.json', 'x'), /quota exceeded/);
  assert.equal(fs2.origin('cell_fr3/robot.json'), 'base');
  refuse = false;
  await fs2.write('cell_fr3/robot.json', 'y');
  assert.equal(await fs2.readText('cell_fr3/robot.json'), 'y');
});

test('openIdbStore throws in words where IndexedDB cannot be used: none at all, an open that is refused, writes that fail', async () => {
  assert.equal(globalThis.indexedDB, undefined, 'node has none: this is the path the page falls back from');
  await assert.rejects(openIdbStore('microfactory'), /IndexedDB is not available/);
  await assert.rejects(openIdbStore('microfactory', fakeIndexedDB({ open: 'throw' })), /insecure/);
  await assert.rejects(openIdbStore('microfactory', fakeIndexedDB({ open: 'deny' })), /denied/);
  // the open works and the first write does not: the probe is what catches it
  await assert.rejects(openIdbStore('microfactory', fakeIndexedDB({ put: true })), /QuotaExceededError/);
});

test('two databases by different names do not see each other; the same name is the same data', async () => {
  const idb = fakeIndexedDB();
  const a = await openIdbStore('one', idb), b = await openIdbStore('two', idb);
  await a.set('x', { bytes: text('1'), time: 1 });
  assert.deepEqual(await b.keys(), []);
  assert.deepEqual(await (await openIdbStore('one', idb)).keys(), ['x']);
});
