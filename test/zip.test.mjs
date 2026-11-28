// The .microfactory container in the page (viewer/zip.js): what it writes
// Python's zipfile reads, and what Python's zipfile writes it reads — the
// server packs and unpacks these files with zipfile (viewer/appfiles.py).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { zipWrite, zipRead } from '../viewer/zip.js';

const text = s => new TextEncoder().encode(s);
const noise = new Uint8Array(randomBytes(3000));                 // does not get smaller: stored
const prose = text('the cup face stays parallel to the part face\n'.repeat(400));   // does: deflated

// one of each kind the two directions have to agree on
const FILES = [
  { name: 'application.json', bytes: prose },
  { name: 'items/case/case.stl', bytes: noise },
  { name: 'notes/deep/er/still.md', bytes: text('# nested\n') },
  { name: 'empty.txt', bytes: new Uint8Array(0) },
  { name: 'notes/zażółć-部品.md', bytes: text('gęślą jaźń\n') },
];

const python = (code, ...args) => execFileSync('python3', ['-c', code, ...args], { encoding: 'utf8', maxBuffer: 64e6 });
function inTemp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'mf-zip-'));
  return Promise.resolve().then(() => fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}
// the method an entry was written with, from its directory record
function methods(zip) {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength), out = [];
  for (let at = v.getUint32(zip.length - 22 + 16, true); v.getUint32(at, true) === 0x02014b50;
    at += 46 + v.getUint16(at + 28, true) + v.getUint16(at + 30, true) + v.getUint16(at + 32, true)) out.push(v.getUint16(at + 10, true));
  return out;
}

test('what is written is read back: names, bytes and order, with nothing for an empty list', async () => {
  const back = await zipRead(await zipWrite(FILES));
  assert.deepEqual(back.map(e => e.name), FILES.map(e => e.name));
  for (const [i, e] of back.entries()) assert.deepEqual(Buffer.from(e.bytes), Buffer.from(FILES[i].bytes), e.name);
  assert.deepEqual(await zipRead(await zipWrite([])), []);
});

test('an entry is deflated when that makes it smaller and stored when it does not', async () => {
  const zip = await zipWrite(FILES);
  const m = methods(zip);
  assert.equal(m.length, FILES.length);
  assert.equal(m[0], 8, 'the prose is deflated');
  assert.equal(m[1], 0, 'the noise is stored');
  assert.equal(m[3], 0, 'and so is the empty file');
  assert.ok(zip.length < prose.length, 'the archive is smaller than the prose alone');
});

test('Python reads what the page wrote: the same names and bytes, and its own test finds nothing wrong', () => inTemp(async dir => {
  const file = join(dir, 'out.microfactory');
  writeFileSync(file, await zipWrite(FILES));
  const got = JSON.parse(python(`
import sys, json, zipfile, base64
with zipfile.ZipFile(sys.argv[1]) as z:
    bad = z.testzip()
    print(json.dumps({"bad": bad, "files": [[i.filename, base64.b64encode(z.read(i)).decode(), i.compress_type, i.file_size] for i in z.infolist()]}))
`, file));
  assert.equal(got.bad, null, 'testzip() is clean');
  assert.deepEqual(got.files.map(f => f[0]), FILES.map(f => f.name));
  for (const [i, [name, b64, , size]] of got.files.entries()) {
    assert.deepEqual(Buffer.from(b64, 'base64'), Buffer.from(FILES[i].bytes), name);
    assert.equal(size, FILES[i].bytes.length);
  }
  assert.equal(got.files[0][2], 8, 'Python sees the prose as deflated');
  assert.equal(got.files[1][2], 0, 'and the noise as stored');
  // and the command-line tool lists it
  const listing = execFileSync('python3', ['-m', 'zipfile', '-l', file], { encoding: 'utf8' });
  for (const f of FILES) assert.ok(listing.includes(f.name), `listed: ${f.name}`);
}));

test('the page reads what Python wrote: deflated and stored entries, a nested folder, an empty file, a name that is not ASCII', () => inTemp(async dir => {
  const file = join(dir, 'in.microfactory');
  for (const [i, f] of FILES.entries()) writeFileSync(join(dir, `f${i}`), f.bytes);
  python(`
import sys, json, zipfile, os
d, names = sys.argv[1], json.loads(sys.argv[2])
with zipfile.ZipFile(os.path.join(d, "in.microfactory"), "w", zipfile.ZIP_DEFLATED) as z:
    for i, name in enumerate(names):
        data = open(os.path.join(d, "f%d" % i), "rb").read()
        # the mesh stored, the rest deflated (as the server writes them)
        z.writestr(name, data, zipfile.ZIP_STORED if i == 1 else zipfile.ZIP_DEFLATED)
    z.writestr(zipfile.ZipInfo("an-empty-folder/"), b"")
`, dir, JSON.stringify(FILES.map(f => f.name)));
  const zip = new Uint8Array(readFileSync(file));
  assert.deepEqual(methods(zip).slice(0, 2), [8, 0], 'Python did write one deflated and one stored');
  const back = await zipRead(zip);
  assert.deepEqual(back.map(e => e.name), FILES.map(e => e.name), 'the folder entry is left out');
  for (const [i, e] of back.entries()) assert.deepEqual(Buffer.from(e.bytes), Buffer.from(FILES[i].bytes), e.name);
}));

test('a file that is not a zip file, or one cut short, is refused as "not a zip file"', async () => {
  await assert.rejects(zipRead(text('{"format": 1}')), /^Error: not a zip file$/);
  await assert.rejects(zipRead(new Uint8Array(0)), /^Error: not a zip file$/);
  await assert.rejects(zipRead(new Uint8Array(randomBytes(5000))), /not a zip file/);
  const zip = await zipWrite(FILES);
  await assert.rejects(zipRead(zip.subarray(0, zip.length - 40)), /not a zip file/);
  await assert.rejects(zipRead(zip.subarray(200)), /not a zip file/, 'its beginning missing');
});

test('an entry whose bytes were damaged is refused by name, deflated or stored', async () => {
  const zip = await zipWrite(FILES);
  const hit = at => { const z = zip.slice(); z[at] ^= 0xFF; return z; };
  // inside the first entry's deflated data (30 bytes of header + its name)
  await assert.rejects(zipRead(hit(30 + FILES[0].name.length + 20)), /damaged zip file: application\.json/);
  // inside the stored noise: the last entry data byte before the third header is far enough in
  const v = new DataView(zip.buffer);
  const packed0 = v.getUint32(18, true);
  const second = 30 + FILES[0].name.length + packed0;
  await assert.rejects(zipRead(hit(second + 30 + FILES[1].name.length + 100)), /damaged zip file: items\/case\/case\.stl/);
});

test('a compression it does not know is refused in words, not read wrong', async () => {
  const zip = await zipWrite([{ name: 'a.txt', bytes: prose }]);
  const v = new DataView(zip.buffer);
  const cd = v.getUint32(zip.length - 22 + 16, true);
  v.setUint16(8, 12, true);            // bzip2, in the entry's header
  v.setUint16(cd + 10, 12, true);      // and in the directory
  await assert.rejects(zipRead(zip), /unsupported compression method 12: a\.txt/);
});

test('what a file declares is checked before anything is inflated: too many entries or too many bytes are refused, a lie about a size is damage', async () => {
  const big = new Uint8Array(3_000_000);                         // three million zeros: a few kilobytes deflated
  const zip = await zipWrite([{ name: 'a.bin', bytes: big }, { name: 'b.bin', bytes: big }, { name: 'c.txt', bytes: prose }]);
  assert.ok(zip.length < 20_000);
  const refusal = e => e instanceof Error && e.code === 'too_large';
  await assert.rejects(zipRead(zip, { maxBytes: 5_000_000 }), refusal, 'the directory says 6 MB');
  await assert.rejects(zipRead(zip, { maxFiles: 2 }), refusal);
  assert.equal((await zipRead(zip, { maxFiles: 3, maxBytes: 6_000_000 + prose.length })).length, 3, 'at the limits it is read');
  // refused from the directory alone: the entries' data may be anything (here: gone)
  const hollow = zip.slice();
  hollow.fill(0, 30 + 5 + 10, 2000);
  await assert.rejects(zipRead(hollow, { maxBytes: 5_000_000 }), refusal, 'nothing was inflated to find out');

  // an entry that declares less than it inflates to is not inflated to its end
  const v = new DataView(zip.buffer);
  const cd = v.getUint32(zip.length - 22 + 16, true);
  const lying = zip.slice(), lv = new DataView(lying.buffer);
  lv.setUint32(cd + 24, 1000, true);                             // a.bin: "1000 bytes"
  await assert.rejects(zipRead(lying, { maxBytes: 4_000_000 }), /damaged zip file: a\.bin/);
  // …and one that declares more than its data could ever hold is refused without asking for the memory
  const greedy = zip.slice(), gv = new DataView(greedy.buffer);
  gv.setUint32(cd + 24, 0xFFFFFFF0, true);
  await assert.rejects(zipRead(greedy), /damaged zip file: a\.bin/);
});

test('entries that share their data — one small blob named many times over — are not a zip file', async () => {
  const zip = await zipWrite([{ name: 'a.bin', bytes: new Uint8Array(100_000) }, { name: 'b.bin', bytes: new Uint8Array(100_000) }]);
  const v = new DataView(zip.buffer);
  const cd = v.getUint32(zip.length - 22 + 16, true);
  const second = cd + 46 + v.getUint16(cd + 28, true);
  v.setUint32(second + 42, 0, true);                             // b.bin's record points at a.bin's header and data
  await assert.rejects(zipRead(zip), /not a zip file/);
});
