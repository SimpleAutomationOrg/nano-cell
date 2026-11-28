#!/usr/bin/env node
// Strip a GLB down to its geometry: drop the notes tools leave in it
// ("extras", object names, the tool's own signature) and keep the buffer
// as it is. The shapes do not change by a byte.
//
//   node scripts/clean-mesh.mjs <file.glb> [more.glb …]
//
// scripts/mesh-check.mjs is what then confirms a file holds nothing else.
import { readFileSync, writeFileSync } from 'node:fs';

export function cleanGlb(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('not a GLB file');
  const jsonLen = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLen)));
  const rest = bytes.subarray(20 + jsonLen);
  const strip = v => {
    if (Array.isArray(v)) v.forEach(strip);
    else if (v && typeof v === 'object') { delete v.extras; delete v.name; Object.values(v).forEach(strip); }
  };
  strip(json);
  json.asset = { version: json.asset?.version ?? '2.0', generator: 'microfactory' };
  let text = new TextEncoder().encode(JSON.stringify(json));
  const pad = (4 - text.length % 4) % 4;
  const out = new Uint8Array(20 + text.length + pad + rest.length);
  out.set(bytes.subarray(0, 12));
  out.set(text, 20);
  out.fill(0x20, 20 + text.length, 20 + text.length + pad);
  out.set(rest, 20 + text.length + pad);
  const o = new DataView(out.buffer);
  o.setUint32(8, out.length, true);
  o.setUint32(12, text.length + pad, true);
  o.setUint32(16, 0x4e4f534a, true);
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const f of process.argv.slice(2)) {
    const before = new Uint8Array(readFileSync(f)), after = cleanGlb(before);
    writeFileSync(f, after);
    console.log(`${f}: ${before.length} -> ${after.length} bytes`);
  }
}
