// Make a workspace from the pack the installed app carries, and keep it
// up to date when the app is.
//
// The pack (ws/files.json beside the page, built by
// scripts/build-artifact.mjs) lists every file of a new workspace: the
// local programs, the guides, the robot, the starter application(s). This
// module writes them into a folder, and remembers what it wrote in
// MARKER, so that a later version of the app can tell a file it installed
// from one the person has changed since:
//
//   - a file the person has not touched is replaced by the new version;
//   - a file the person changed is KEPT, and reported;
//   - a starter application the person deleted is not brought back.
//
// A folder without the marker (a checkout of the repository, kept up to
// date with git) is never touched: `installWorkspace` is only called for a
// new folder or one that has the marker.
//
// Pure of the desktop API: it is given `fs` (exists, readFile, writeFile,
// mkdir — the desktop API's shapes) and `load(entry)` for a mesh's bytes.

export const MARKER = '.microfactory.json';

export async function sha256(bytes) {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function readMarker(fs, dir) {
  try { return JSON.parse(await fs.readFile(`${dir}/${MARKER}`, 'utf8')); } catch { return null; }
}

/**
 * @returns {{ fresh: boolean, upToDate: boolean, written: string[], kept: string[], exec: string[], tools: boolean }}
 *   written — paths written; kept — paths the person changed, left as they are;
 *   exec — written paths that must be made executable; tools — the tools (npm) must be installed again.
 */
export async function installWorkspace({ fs, load, dir, pack, say = () => {} }) {
  const marker = await readMarker(fs, dir);
  const fresh = !marker;
  const out = { fresh, upToDate: false, written: [], kept: [], exec: [], tools: fresh };
  if (marker?.version === pack.version) { out.upToDate = true; return out; }

  const known = marker?.files ?? {};
  const record = {};
  const made = new Set();
  const gone = new Map();          // starter application -> was deleted by the person
  const enc = new TextEncoder();
  let n = 0;
  for (const entry of pack.files) {
    n++;
    const path = `${dir}/${entry.path}`;
    if (!fresh && entry.path.startsWith('applications/')) {
      const app = entry.path.split('/')[1];
      if (!gone.has(app)) gone.set(app, app in (marker.apps ?? {}) && !(await fs.exists(`${dir}/applications/${app}`)));
      if (gone.get(app)) continue;
    }
    if (!fresh && await fs.exists(path)) {
      const disk = await sha256(await fs.readFile(path));
      if (disk === entry.sha) { record[entry.path] = entry.sha; continue; }
      if (disk !== known[entry.path]) {          // changed by the person (or not ours): keep it
        out.kept.push(entry.path);
        if (known[entry.path]) record[entry.path] = known[entry.path];
        continue;
      }
    }
    if (n % 5 === 0 || entry.bin) say(`${n} of ${pack.files.length}`);
    const parent = path.slice(0, path.lastIndexOf('/'));
    if (!made.has(parent)) { await fs.mkdir(parent, { recursive: true }); made.add(parent); }
    const bytes = entry.bin ? await load(entry) : enc.encode(entry.text);
    if (await sha256(bytes) !== entry.sha) throw new Error(`${entry.path} did not arrive whole`);
    await fs.writeFile(path, bytes);
    record[entry.path] = entry.sha;
    out.written.push(entry.path);
    if (entry.exec) out.exec.push(entry.path);
    if (entry.path === 'package.json' || entry.path === 'package-lock.json') out.tools = true;
  }
  const apps = {};
  for (const entry of pack.files) if (entry.path.startsWith('applications/')) apps[entry.path.split('/')[1]] = true;
  await fs.writeFile(`${dir}/${MARKER}`, JSON.stringify({ version: pack.version, apps, files: record }, null, 1) + '\n');
  return out;
}
