// The `.microfactory` container, read and written in the page. Such a file
// is an ordinary zip, as Python's zipfile writes it (viewer/appfiles.py):
// the shareable edition has no server to pack and unpack one, so this does
// it, with the deflate the browser (and node >= 18) already has. No DOM.
//
// Only what such files need: stored and deflated entries, UTF-8 names,
// CRC-32. No zip64 (4 GB, 65535 entries), no encryption, no archives split
// over several files.

const enc = new TextEncoder();

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// bytes through a CompressionStream / DecompressionStream
async function through(bytes, stream) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}

const LOCAL = 0x04034b50, CENTRAL = 0x02014b50, END = 0x06054b50;
const UTF8 = 0x0800;                  // flag bit 11: the name is UTF-8

/**
 * entries: [{ name, bytes: Uint8Array, time? }] -> the zip file's bytes.
 * An entry is deflated when that makes it smaller, stored otherwise. `time`
 * (ms, optional) is the time written with the entry; now, when left out.
 */
export async function zipWrite(entries) {
  if (entries.length > 0xFFFF) throw new Error('too many files for a zip file');
  const parts = [], central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = enc.encode(entry.name), bytes = entry.bytes;
    const deflated = bytes.length ? await through(bytes, new CompressionStream('deflate-raw')) : bytes;
    const method = deflated.length < bytes.length ? 8 : 0;
    const data = method ? deflated : bytes;
    const d = new Date(entry.time ?? Date.now());
    // the zip format's clock: local time, two-second steps, not before 1980
    const year = Math.max(1980, d.getFullYear());
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();

    const common = new DataView(new ArrayBuffer(26));    // the part both headers share
    common.setUint16(0, 20, true);                       // version needed: 2.0 (deflate)
    common.setUint16(2, UTF8, true);
    common.setUint16(4, method, true);
    common.setUint16(6, time, true);
    common.setUint16(8, date, true);
    common.setUint32(10, crc32(bytes), true);
    common.setUint32(14, data.length, true);
    common.setUint32(18, bytes.length, true);
    common.setUint16(22, name.length, true);
    common.setUint16(24, 0, true);                       // no extra field
    const shared = new Uint8Array(common.buffer);

    const local = new Uint8Array(30 + name.length);
    new DataView(local.buffer).setUint32(0, LOCAL, true);
    local.set(shared, 4);
    local.set(name, 30);

    const cd = new Uint8Array(46 + name.length), cv = new DataView(cd.buffer);
    cv.setUint32(0, CENTRAL, true);
    cv.setUint16(4, (3 << 8) | 20, true);                // made by: unix, so the mode below counts
    cd.set(shared, 6);
    cv.setUint32(38, (0o100644 << 16) >>> 0, true);      // an ordinary file, rw-r--r--
    cv.setUint32(42, offset, true);
    cd.set(name, 46);

    parts.push(local, data);
    central.push(cd);
    offset += local.length + data.length;
    if (offset > 0xFFFFFFFF) throw new Error('too large for a zip file');
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22), ev = new DataView(end.buffer);
  ev.setUint32(0, END, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);

  const out = new Uint8Array(offset + cdSize + 22);
  let at = 0;
  for (const p of [...parts, ...central, end]) { out.set(p, at); at += p.length; }
  return out;
}

const notZip = () => new Error('not a zip file');
const tooLarge = () => Object.assign(new Error('too large'), { code: 'too_large' });

// Inflate, but never past `size` bytes — the size the directory declares.
// A few crafted kilobytes can inflate to gigabytes: the output is read in
// pieces and the stream is dropped the moment it holds more than it said.
async function inflate(data, size) {
  // (deflate cannot shrink anything to less than about a thousandth: a larger claim is refused before any memory is asked for)
  if (size > data.length * 1040 + 64) throw new Error('longer than its data can hold');
  const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const out = new Uint8Array(size);
  let at = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (at + value.length > size) { await reader.cancel().catch(() => {}); throw new Error('longer than declared'); }
    out.set(value, at); at += value.length;
  }
  if (at !== size) throw new Error('shorter than declared');
  return out;
}

// A name without the UTF-8 flag is cp437 by the letter of the format, but
// what writes such names today (Python for plain ASCII, most tools for
// anything) writes UTF-8 or ASCII: read it as UTF-8, and byte for byte when
// it is not.
function entryName(raw, utf8) {
  try { return new TextDecoder('utf-8', { fatal: !utf8 }).decode(raw); }
  catch { return new TextDecoder('latin1').decode(raw); }
}

/**
 * The files of a zip file: [{ name, bytes }], in the order of its
 * directory. Folder entries (a name ending in '/') carry nothing and are
 * left out; names are returned as written — whether one is safe to use as a
 * path is for the caller to check. Throws Error('not a zip file') for
 * anything that is not one or is cut short, 'unsupported …' for a
 * compression other than stored / deflate, encryption or zip64, and
 * 'damaged zip file: <name>' when an entry does not match its checksum.
 *
 * `maxFiles` and `maxBytes` bound what is unpacked, by what the directory
 * DECLARES, before anything is inflated: over either, it throws an Error
 * with code 'too_large'. No entry is inflated past its declared size, and
 * two entries may not share their data — so the memory used is bounded by
 * what was declared, whatever the file holds.
 */
export async function zipRead(bytes, { maxFiles = Infinity, maxBytes = Infinity } = {}) {
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // the end record is the last thing in the file, before a comment of at most 65535 bytes
  let end = -1;
  for (let i = bytes.length - 22; i >= 0 && i >= bytes.length - 22 - 0xFFFF; i--) {
    if (view.getUint32(i, true) === END) { end = i; break; }
  }
  if (end < 0) throw notZip();
  const count = view.getUint16(end + 10, true);
  const cdSize = view.getUint32(end + 12, true), cdAt = view.getUint32(end + 16, true);
  if (count === 0xFFFF || cdAt === 0xFFFFFFFF || cdSize === 0xFFFFFFFF) throw new Error('unsupported zip file: zip64');
  if (view.getUint16(end + 4, true) !== 0 || view.getUint16(end + 6, true) !== 0) throw new Error('unsupported zip file: split over several files');
  if (cdAt + cdSize > end) throw notZip();

  // the directory first, whole: what the file says it holds
  const dir = [];
  let at = cdAt, declared = 0;
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || view.getUint32(at, true) !== CENTRAL) throw notZip();
    const flags = view.getUint16(at + 8, true), method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const packed = view.getUint32(at + 20, true), size = view.getUint32(at + 24, true);
    const nameLen = view.getUint16(at + 28, true), extraLen = view.getUint16(at + 30, true), commentLen = view.getUint16(at + 32, true);
    const localAt = view.getUint32(at + 42, true);
    if (at + 46 + nameLen > end) throw notZip();
    const name = entryName(bytes.subarray(at + 46, at + 46 + nameLen), (flags & UTF8) !== 0);
    at += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    if (flags & 1) throw new Error(`unsupported zip file: ${name} is encrypted`);
    if (method !== 0 && method !== 8) throw new Error(`unsupported compression method ${method}: ${name}`);
    if (packed === 0xFFFFFFFF || size === 0xFFFFFFFF || localAt === 0xFFFFFFFF) throw new Error('unsupported zip file: zip64');

    // the data follows the entry's own header, whose name and extra field
    // may be of other lengths than the directory's
    if (localAt + 30 > cdAt || view.getUint32(localAt, true) !== LOCAL) throw notZip();
    const dataAt = localAt + 30 + view.getUint16(localAt + 26, true) + view.getUint16(localAt + 28, true);
    if (dataAt + packed > cdAt) throw notZip();
    if (method === 0 && packed !== size) throw new Error(`damaged zip file: ${name}`);
    declared += size;
    dir.push({ name, method, crc, size, localAt, dataAt, packed });
    if (dir.length > maxFiles || declared > maxBytes) throw tooLarge();
  }
  // each entry has its own header and data: a directory whose entries point at the same bytes is not a zip file anyone wrote
  const spans = dir.map(e => [e.localAt, e.dataAt + e.packed]).sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < spans.length; i++) if (spans[i][0] < spans[i - 1][1]) throw notZip();

  const out = [];
  for (const { name, method, crc, size, dataAt, packed } of dir) {
    const data = bytes.subarray(dataAt, dataAt + packed);
    let plain;
    if (method === 0) plain = data.slice();
    else {
      try { plain = await inflate(data, size); }
      catch { throw new Error(`damaged zip file: ${name}`); }
    }
    if (plain.length !== size || crc32(plain) !== crc) throw new Error(`damaged zip file: ${name}`);
    out.push({ name, bytes: plain });
  }
  return out;
}
