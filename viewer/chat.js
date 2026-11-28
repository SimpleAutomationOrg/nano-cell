// Chat with the project's agents, in the page.
//
// The agents are the Markdown files in agents/ (viewer/chat.py reads them):
// a narrow bar of profiles down the left edge, and beside it the
// conversation with the one picked. Every agent has its own conversation.
//
// The conversations themselves live in the dev server: each message runs
// that agent in the repository, and the server keeps the list of
// everything said and done. This file only draws that list and sends what
// you type — so when an agent saves a file and the page reloads itself,
// the chat comes back exactly as it was.
import { pollFetch } from './poll.js';

const HEAD = { 'X-Nano-Cell': 'chat', 'Content-Type': 'application/json' };

const box = document.createElement('div');
box.id = 'chat';
box.innerHTML = `
  <nav id="chatRail" aria-label="agents"></nav>
  <div id="chatMain">
    <header title="show / hide the conversation"><div class="who"><b id="chatName">Agents</b><span id="chatRole"></span></div>
      <button id="chatNew" title="forget this conversation and start a new one">New</button></header>
    <div id="chatBody">
      <div id="chatLog"></div>
      <form>
        <div id="chatFiles"></div>
        <div class="line">
          <button type="button" id="chatAttach" title="attach files — or paste a screenshot, or drop files here">＋</button>
          <input type="file" id="chatPick" multiple hidden>
          <textarea id="chatIn" placeholder="Message…  (Enter to send, Shift+Enter for a new line)"></textarea>
          <button id="chatSend">Send</button>
        </div>
      </form>
    </div>
  </div>`;
document.body.appendChild(box);
const rail = box.querySelector('#chatRail');
const log = box.querySelector('#chatLog'), input = box.querySelector('#chatIn');
const sendBtn = box.querySelector('#chatSend');

// open/closed, the agent picked and half-typed messages survive the page
// reloading. Closed, only the bar of profiles is left and the simulation
// takes the width back; picking a profile opens the conversation again.
const setClosed = on => {
  box.classList.toggle('closed', on);
  document.body.classList.toggle('chat-closed', on);
  localStorage.setItem('chat.closed', on ? '1' : '0');
};
setClosed(localStorage.getItem('chat.closed') === '1');
box.querySelector('header').addEventListener('click', ev => {
  if (ev.target.id !== 'chatNew') setClosed(!box.classList.contains('closed'));
});

let agents = [];
let current = null;                 // the agent whose conversation is shown
let poll = null;                    // AbortController of its long poll
const draftKey = () => `chat.draft.${current?.id}`;
input.addEventListener('input', () => sessionStorage.setItem(draftKey(), input.value));

// ---- drawing ----
const esc = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
// just enough markdown for an agent's replies: code blocks, `code`, **bold**
function rich(text) {
  return text.split(/```/).map((part, i) => i % 2
    ? `<pre><code>${esc(part.replace(/^[a-z]*\n/, ''))}</code></pre>`
    : esc(part).replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')).join('');
}
const IMAGE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
function draw(ev) {
  if (ev.type === 'done') return;
  const el = document.createElement('div');
  el.className = `msg ${ev.type}`;
  if (ev.type === 'text') el.innerHTML = rich(ev.text.trim());
  else el.textContent = ev.type === 'tool' ? `· ${ev.text}` : ev.text;
  // what the user attached: images shown, other files named; both open the saved file
  for (const path of ev.files ?? []) {
    const a = document.createElement('a');
    a.className = 'sent-file';
    a.href = '/' + path.split('/').map(encodeURIComponent).join('/');
    a.target = '_blank';
    a.title = path;
    if (IMAGE.test(path)) { const img = document.createElement('img'); img.src = a.href; img.alt = path.split('/').pop(); a.appendChild(img); }
    else a.textContent = '📎 ' + path.split('/').pop();
    el.appendChild(a);
  }
  log.appendChild(el);
}
function hint(text) {
  log.innerHTML = '';
  const el = document.createElement('div');
  el.className = 'msg hint';
  el.textContent = text;
  log.appendChild(el);
}
let running = false;
function setRunning(on) {
  running = on;
  sendBtn.textContent = on ? 'Stop' : 'Send';
}
// the dot on a profile: that agent is working, whichever one is shown
function setBusy(ids) {
  for (const b of rail.children) b.classList.toggle('busy', ids.includes(b.dataset.id));
}

function drawRail() {
  rail.innerHTML = '';
  for (const a of agents) {
    const b = document.createElement('button');
    b.className = 'agent';
    b.dataset.id = a.id;
    b.title = `${a.name} — ${a.role}`;
    b.style.setProperty('--c', a.color);
    b.innerHTML = '<span class="face"></span><span class="lbl"></span><i></i>';
    b.querySelector('.face').textContent = a.initials;
    b.querySelector('.lbl').textContent = a.name;
    b.addEventListener('click', () => { pick(a.id); setClosed(false); });
    rail.appendChild(b);
  }
}

// ---- talking to the server ----
const post = (action, body = {}) =>
  fetch(`/__chat/${action}`, { method: 'POST', headers: HEAD, body: JSON.stringify({ agent: current?.id, ...body }) }).then(r => r.json());

// what the agent cannot see for itself: which application and step are up, and how the last run ended
const context = () => {
  const step = document.documentElement.dataset.step || 'none';
  const line = document.getElementById('stepline')?.textContent.trim() || '';
  const app = document.documentElement.dataset.application || 'unknown';
  return `application: ${app}; step selected: ${step}; last status line: "${line}"`;
};

// ---- attachments ----
// Files wait here as chips until the message is sent; only then are they
// saved, into the open application's materials/ folder, and named to the
// agent. Three ways in: the + button, pasting (a screenshot), dropping.
let pending = [];                   // [{ file, name, url }]
const filesEl = box.querySelector('#chatFiles');
const stamp = () => new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
function attach(list) {
  for (const file of list) {
    // a pasted screenshot arrives as "image.png": give it a name that says when
    const name = /^image\.\w+$/i.test(file.name || '') || !file.name
      ? `screenshot-${stamp()}.${(file.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}` : file.name;
    pending.push({ file, name, url: file.type.startsWith('image/') ? URL.createObjectURL(file) : null });
  }
  drawPending();
}
function drawPending() {
  filesEl.innerHTML = '';
  pending.forEach((p, i) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.title = `${p.name} · ${(p.file.size / 1024).toFixed(0)} kB`;
    if (p.url) { const img = document.createElement('img'); img.src = p.url; chip.appendChild(img); }
    const n = document.createElement('span'); n.textContent = p.name; chip.appendChild(n);
    const x = document.createElement('button');
    x.type = 'button'; x.textContent = '×'; x.title = 'remove';
    x.onclick = () => { if (p.url) URL.revokeObjectURL(p.url); pending.splice(i, 1); drawPending(); };
    chip.appendChild(x);
    filesEl.appendChild(chip);
  });
}
const picker = box.querySelector('#chatPick');
box.querySelector('#chatAttach').addEventListener('click', () => picker.click());
picker.addEventListener('change', () => { attach(picker.files); picker.value = ''; });
input.addEventListener('paste', ev => {
  const files = [...(ev.clipboardData?.files ?? [])];
  if (files.length) { ev.preventDefault(); attach(files); }
});
const main = box.querySelector('#chatMain');
const hasFiles = ev => [...(ev.dataTransfer?.types ?? [])].includes('Files');
main.addEventListener('dragover', ev => { if (hasFiles(ev)) { ev.preventDefault(); main.classList.add('dropping'); } });
main.addEventListener('dragleave', ev => { if (!main.contains(ev.relatedTarget)) main.classList.remove('dropping'); });
main.addEventListener('drop', ev => {
  if (!hasFiles(ev)) return;
  ev.preventDefault();
  main.classList.remove('dropping');
  attach(ev.dataTransfer.files);
});

async function upload(p) {
  const app = document.documentElement.dataset.application;
  if (!app) throw new Error('no application is open');
  const r = await (await fetch(`/__chat/upload?app=${encodeURIComponent(app)}&name=${encodeURIComponent(p.name)}`, {
    method: 'POST', headers: { 'X-Nano-Cell': 'chat', 'Content-Type': 'application/octet-stream' }, body: p.file,
  })).json();
  if (r.error) throw new Error(`${p.name}: ${r.error}`);
  return r.path;
}

let sending = false;
async function send() {
  if (!current || sending) return;
  if (running) { await post('stop'); return; }
  const text = input.value.trim();
  if (!text && !pending.length) return;
  sending = true;
  try {
    const files = [];
    for (const p of pending) files.push(await upload(p));
    const r = await post('send', { text, context: context(), files });
    if (r.error) throw new Error(r.error);
    input.value = '';
    sessionStorage.removeItem(draftKey());
    pending.forEach(p => p.url && URL.revokeObjectURL(p.url));
    pending = [];
    drawPending();
  } catch (e) {
    draw({ type: 'error', text: String(e.message ?? e) });
    log.scrollTop = log.scrollHeight;
  } finally { sending = false; }
}
box.querySelector('form').addEventListener('submit', ev => { ev.preventDefault(); send(); });
input.addEventListener('keydown', ev => {
  if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); send(); }
});
box.querySelector('#chatNew').addEventListener('click', () => post('new'));

// show one agent's conversation: drop the poll of the one shown before and
// follow this one from its start (the server has all of it)
function pick(id) {
  const a = agents.find(x => x.id === id) ?? agents[0];
  if (!a || a === current) return;
  current = a;
  localStorage.setItem('chat.agent', a.id);
  for (const b of rail.children) b.classList.toggle('sel', b.dataset.id === a.id);
  box.querySelector('#chatName').textContent = a.name;
  box.querySelector('#chatRole').textContent = a.role;
  box.style.setProperty('--c', a.color);
  input.placeholder = `Message the ${a.name}…  (Enter to send, Shift+Enter for a new line)`;
  input.value = sessionStorage.getItem(draftKey()) ?? '';
  log.innerHTML = '';
  setRunning(false);
  poll?.abort();
  poll = new AbortController();
  follow(a, poll.signal);
}

async function follow(agent, signal) {
  let epoch = -1, next = 0;
  while (!signal.aborted) {
    try {
      const resp = await pollFetch(`/__chat/events?agent=${encodeURIComponent(agent.id)}&epoch=${epoch}&since=${next}`, { headers: HEAD, signal });
      if (!resp) continue;            // the tab was hidden, or another agent was picked
      const r = await resp.json();
      if (signal.aborted) return;
      if (r.error) throw new Error(r.error);
      if (r.epoch !== epoch) { epoch = r.epoch; log.innerHTML = ''; }
      const atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
      if (!r.next && !log.children.length)
        hint(r.available
          ? (agent.hint || `Write to the ${agent.name}.`)
          : 'The `claude` command was not found. Install Claude Code and sign in, then restart viewer/serve.py.');
      else if (r.events.length && log.querySelector('.hint')) log.innerHTML = '';
      r.events.forEach(draw);
      next = r.next;
      setRunning(r.running);
      setBusy(r.busy ?? []);
      if (atEnd) log.scrollTop = log.scrollHeight;
    } catch { await new Promise(res => setTimeout(res, 2000)); }
  }
}

(async () => {
  for (;;) {
    try {
      agents = await (await fetch('/__chat/agents', { headers: HEAD })).json();
      if (Array.isArray(agents)) break;
    } catch { /* server not up yet */ }
    await new Promise(res => setTimeout(res, 2000));
  }
  if (!agents.length) { hint('No agents: add Markdown files to agents/ (see AGENTS.md).'); return; }
  drawRail();
  pick(localStorage.getItem('chat.agent'));
})();
