// How the installed app's page reaches the engine: a child process
// (`python3 viewer/serve.py --stdio`) spoken to through its pipes, and a
// fetch() that sends the page's requests there. No DOM in here — it runs
// under node as well, where the tests drive it against the real engine.
// viewer/desktop.js is what uses it.

// ---- bytes <-> base64, in pieces (a mesh is megabytes) ----
export function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function fromBase64(b64) {
  const s = atob(b64), out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// ---- the engine, through its pipes ----
// `spawn` is the desktop API's childProcess.spawn (or anything shaped like it).
export function startEngine(spawn, workspace, platform) {
  // a login shell, so that python3, node and the agents' CLI are found as
  // they are in the person's terminal (an app started from the Dock has a
  // bare PATH)
  const proc = platform === 'win32'
    ? spawn('python', ['viewer/serve.py', '--stdio'], { cwd: workspace, shell: true })
    : spawn('/bin/zsh', ['-lc', 'exec python3 viewer/serve.py --stdio'], { cwd: workspace });
  const waiting = new Map();          // request id -> resolve
  let buffer = '', errors = '', next = 1, dead = null;
  let readyResolve, readyReject;
  const ready = new Promise((res, rej) => { readyResolve = res; readyReject = rej; });
  const fail = why => {
    dead = why;
    readyReject(new Error(why));
    for (const resolve of waiting.values()) resolve({ status: 502, headers: {}, body: btoa(JSON.stringify({ error: why })) });
    waiting.clear();
  };
  proc.stdout.on('data', chunk => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.ready) { readyResolve(msg); continue; }
      const resolve = waiting.get(msg.id);
      if (resolve) { waiting.delete(msg.id); resolve(msg); }
    }
  });
  proc.stderr.on('data', chunk => { errors = (errors + chunk).slice(-4000); });
  proc.on('error', e => fail(`the engine could not be started: ${e.message}`));
  proc.on('exit', code => fail(`the engine stopped (exit ${code})${errors ? `:\n${errors}` : ''}`));
  const request = (method, path, headers, bytes) => new Promise(resolve => {
    if (dead) return resolve({ status: 502, headers: {}, body: btoa(JSON.stringify({ error: dead })) });
    const id = next++;
    waiting.set(id, resolve);
    proc.stdin.write(JSON.stringify({ id, method, path, headers, body: bytes?.length ? toBase64(bytes) : '' }) + '\n')
      .catch(e => { waiting.delete(id); resolve({ status: 502, headers: {}, body: btoa(JSON.stringify({ error: String(e.message ?? e) })) }); });
  });
  return { ready, request, errors: () => errors };
}

// Which requests go to the engine, and as what path.
//
// The viewer is written for a page at /viewer/ of the repository, so
// '../cell_fr3/robot.json' and '/__steps' are repository paths. Relative
// addresses are read that way wherever the artifact itself is hosted. Only
// the page's own shipped files (viewer/*.js) and other hosts (the CDN,
// blob: and data: addresses) stay on the network.
//
// Returns the repository path (with its query), or null for "not ours".
// `pageUrl` is the address of the artifact's page (document.baseURI).
export function repoPath(input, pageUrl) {
  const s = typeof input === 'string' ? input : (input?.url ?? String(input));
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) {                           // a relative address, as written in the viewer
    const u = new URL(s, 'http://microfactory.local/viewer/');
    return u.pathname + u.search;
  }
  const u = new URL(s), page = new URL(pageUrl);
  if (u.protocol !== page.protocol || u.host !== page.host) return null;       // another host, a blob, data
  const pageDir = new URL('.', page).pathname;                     // where the artifact's page is
  const parent = pageDir.replace(/[^/]+\/$/, '');
  let p = u.pathname;
  if (p.startsWith(pageDir)) {
    const rel = p.slice(pageDir.length);
    if (/^viewer\/[\w.-]+\.js$/.test(rel) || rel === '' || rel === 'index.html') return null;   // shipped with the page
    p = '/' + rel;
  } else if (parent !== '/' && p.startsWith(parent)) p = '/' + p.slice(parent.length);   // '../x' from the page
  return p + u.search;
}

const aborted = () => {
  const e = new Error('The request was aborted.');
  e.name = 'AbortError';
  return e;
};

// A fetch() for the page: requests for the cell are answered by the engine,
// everything else by `real` (the browser's own fetch).
export function engineFetch(engine, real, { pageUrl }) {
  return async (input, init = {}) => {
    const path = repoPath(input, pageUrl);
    if (path === null) return real(input, init);
    const req = typeof input === 'string' || input instanceof URL ? null : input;
    const signal = init.signal ?? req?.signal;
    if (signal?.aborted) throw aborted();
    const headers = {};
    new Headers(init.headers ?? req?.headers ?? {}).forEach((v, k) => { headers[k] = v; });
    const method = (init.method ?? req?.method ?? 'GET').toUpperCase();
    let body = init.body ?? null;
    if (body == null && req && !['GET', 'HEAD'].includes(method)) body = await req.arrayBuffer();
    let bytes = null;
    if (typeof body === 'string') bytes = new TextEncoder().encode(body);
    else if (typeof Blob !== 'undefined' && body instanceof Blob) bytes = new Uint8Array(await body.arrayBuffer());
    else if (body instanceof ArrayBuffer) bytes = new Uint8Array(body);
    else if (ArrayBuffer.isView(body)) bytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    const answer = await new Promise((resolve, reject) => {
      const onAbort = () => reject(aborted());
      signal?.addEventListener('abort', onAbort, { once: true });
      engine.request(method, path, headers, bytes).then(r => { signal?.removeEventListener('abort', onAbort); resolve(r); });
    });
    const data = answer.body ? fromBase64(answer.body) : new Uint8Array(0);
    const noBody = [204, 205, 304].includes(answer.status) || method === 'HEAD';
    return new Response(noBody ? null : data, { status: answer.status, headers: answer.headers ?? {} });
  };
}

// ---- making a workspace where there is none ----

// a path as the person types it -> an absolute one ("~" and relative paths start at the home folder)
export function absolutePath(path, home) {
  let p = String(path).trim();
  const h = home.replace(/[\\/]+$/, '');
  if (p === '~') p = h;
  else if (/^~[\\/]/.test(p)) p = h + '/' + p.slice(2);
  else if (!/^([\\/]|[A-Za-z]:)/.test(p)) p = h + '/' + p;
  return p.length > 1 ? p.replace(/[\\/]+$/, '') : p;
}

export const shellQuote = s => `'${String(s).replace(/'/g, `'\\''`)}'`;

// The shell commands that finish a workspace written into `dir` (absolute):
// make its scripts runnable, and install the tools it runs (from npm).
// Run in a login shell so that node and npm are found as they are in the
// person's terminal.
const login = cmd => `/bin/zsh -lc ${shellQuote(cmd)}`;
export const chmodCommand = (dir, paths) => `chmod +x ${paths.map(p => shellQuote(`${dir}/${p}`)).join(' ')}`;
export const toolsCommand = dir => login(`cd ${shellQuote(dir)} && npm install --no-audit --no-fund`);
