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
import { splitQuestions, answerText, allAnswered, splitHandoffs } from './ask.js';

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
      <div id="chatWork" hidden><span class="dots"><i></i><i></i><i></i></span><span id="chatWorkText"></span></div>
      <form>
        <div id="chatBox">
          <div id="chatFiles"></div>
          <textarea id="chatIn" placeholder="Message…"></textarea>
          <div class="line">
            <button type="button" id="chatAttach" title="choose files to attach">📎 Attach files</button>
            <span class="tip">or paste a screenshot, or drop files here</span>
            <input type="file" id="chatPick" multiple hidden>
            <button id="chatSend">Send</button>
          </div>
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
  if (typeof drawUnread === 'function' && rail.children.length) drawUnread();   // opening it is reading it
};
setClosed(localStorage.getItem('chat.closed') === '1');
box.querySelector('header').addEventListener('click', ev => {
  if (ev.target.id !== 'chatNew') setClosed(!box.classList.contains('closed'));
});

let agents = [];
let current = null;                 // the agent whose conversation is shown
let poll = null;                    // AbortController of its long poll
const draftKey = () => `chat.draft.${document.documentElement.dataset.application}.${current?.id}`;
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
  // the user has answered (in whatever way): questions asked before are settled
  if (ev.type === 'user') for (const a of log.querySelectorAll('.ask:not(.settled)')) settle(a);
  if (ev.type === 'text') {
    // an agent's questions come as a block at the end of its message: shown as buttons
    const asked = splitQuestions(ev.text.trim());
    // ...and work it hands to colleagues as another: shown as who gets what
    const { text, handoffs } = splitHandoffs(asked.text);
    el.innerHTML = rich(text);
    for (const h of handoffs) el.appendChild(handoffCard(h));
    if (asked.questions.length) el.appendChild(askBox(asked.questions));
  }
  else if (ev.type === 'note') {
    // what happened to handed-over work; it names the colleague, whose chat one click opens
    el.textContent = `→ ${ev.text}`;
    const a = agents.find(x => x.id === ev.to);
    if (a) { el.classList.add('link'); el.title = `open the ${a.name}'s chat`; el.addEventListener('click', () => pick(a.id)); }
  }
  else el.textContent = ev.type === 'tool' ? `· ${ev.text}` : ev.text;
  // a task that came from a colleague, not from the user
  if (ev.type === 'user' && ev.from) {
    el.classList.add('handed');
    const who = document.createElement('div');
    who.className = 'from';
    who.textContent = `from the ${ev.from}`;
    el.prepend(who);
  }
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
// a task handed to a colleague: who gets it, and what (click to open their chat)
function handoffCard(h) {
  const a = agents.find(x => x.id === h.to);
  const card = document.createElement('div');
  card.className = 'handoff';
  if (a) card.style.setProperty('--c', a.color);
  card.innerHTML = '<div class="to"></div><div class="task"></div>';
  card.querySelector('.to').textContent = `→ ${a?.name ?? h.to}`;
  card.querySelector('.task').textContent = h.task;
  if (a) { card.title = `open the ${a.name}'s chat`; card.addEventListener('click', () => pick(a.id)); }
  return card;
}

// ---- questions with options ----
// Each question is a card: its options as buttons (the recommended one
// first and marked), and a field for an answer in the user's own words.
// "Send answers" sends them as one message. Once the user has sent
// anything, the cards are settled: shown, but no longer clickable.
function settle(box) {
  box.classList.add('settled');
  for (const c of box.querySelectorAll('button, input')) c.disabled = true;
}
function askBox(questions) {
  const box = document.createElement('div');
  box.className = 'ask';
  const picks = questions.map(() => ({ labels: [], other: '' }));
  const sendBtn = document.createElement('button');
  const refresh = () => {
    sendBtn.disabled = !answerText(questions, picks);
    sendBtn.textContent = allAnswered(questions, picks) || questions.length === 1 ? 'Send answers'
      : `Send answers (${questions.filter((q, i) => picks[i].labels.length || picks[i].other.trim()).length} of ${questions.length})`;
  };
  questions.forEach((q, i) => {
    const card = document.createElement('div');
    card.className = 'ask-q';
    const title = document.createElement('div');
    title.className = 'ask-title';
    title.textContent = (questions.length > 1 ? `${i + 1}. ` : '') + q.question + (q.multi ? '  (pick any)' : '');
    card.appendChild(title);
    const opts = document.createElement('div');
    opts.className = 'ask-opts';
    for (const o of q.options) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ask-opt' + (o.recommended ? ' rec' : '');
      b.innerHTML = '<span class="l"></span><span class="d"></span>';
      b.querySelector('.l').textContent = o.label + (o.recommended ? '  · recommended' : '');
      b.querySelector('.d').textContent = o.description;
      b.addEventListener('click', () => {
        const on = !picks[i].labels.includes(o.label);
        if (q.multi) picks[i].labels = on ? [...picks[i].labels, o.label] : picks[i].labels.filter(l => l !== o.label);
        else picks[i].labels = on ? [o.label] : [];
        for (const x of opts.children) x.classList.toggle('on', picks[i].labels.includes(x.dataset.label));
        refresh();
      });
      b.dataset.label = o.label;
      opts.appendChild(b);
    }
    card.appendChild(opts);
    const other = document.createElement('input');
    other.type = 'text';
    other.className = 'ask-other';
    other.placeholder = 'or answer in your own words…';
    other.addEventListener('input', () => { picks[i].other = other.value; refresh(); });
    other.addEventListener('keydown', ev => { if (ev.key === 'Enter' && !sendBtn.disabled) { ev.preventDefault(); sendBtn.click(); } });
    card.appendChild(other);
    box.appendChild(card);
  });
  sendBtn.type = 'button';
  sendBtn.className = 'ask-send';
  sendBtn.addEventListener('click', async () => {
    const text = answerText(questions, picks);
    if (!text || running || sending) return;
    // anything typed in the message box goes along as a note
    const note = input.value.trim();
    input.value = text + (note ? `\n\n${note}` : '');
    await send();
  });
  box.appendChild(sendBtn);
  refresh();
  return box;
}

function hint(text) {
  log.innerHTML = '';
  const el = document.createElement('div');
  el.className = 'msg hint';
  el.textContent = text;
  log.appendChild(el);
}
// While the agent shown is working: a line under the conversation with
// moving dots, saying who is working, on what (its latest action) and for
// how long. The profile in the bar gets a turning ring as well.
let running = false, since = 0, doing = '';
const work = box.querySelector('#chatWork'), workText = box.querySelector('#chatWorkText');
function drawWork() {
  work.hidden = !running;
  box.classList.toggle('working', running);
  if (!running) return;
  const s = Math.round((Date.now() - since) / 1000);
  workText.textContent = `${current?.name ?? 'The agent'} is working${doing ? ` — ${doing}` : ''} · ${s} s`;
}
setInterval(drawWork, 1000);
function setRunning(on) {
  if (on && !running) since = Date.now();
  if (!on) doing = '';
  running = on;
  sendBtn.textContent = on ? 'Stop' : 'Send';
  drawWork();
}
// the ring on a profile: that agent is working, whichever one is shown
function setBusy(ids) {
  for (const b of rail.children) b.classList.toggle('busy', ids.includes(b.dataset.id));
}

// ---- unread answers ----
// The server says how many answers each conversation holds; the page
// remembers how many the user has seen. An agent with more than that gets
// a badge on its profile. "Seen" means its conversation is on screen: the
// agent is the one picked, the conversation is open and the tab is shown.
let answers = {};
const seen = JSON.parse(localStorage.getItem('chat.seen') || '{}');
const watching = id => current?.id === id && !box.classList.contains('closed') && !document.hidden;
function drawUnread() {
  let changed = false;
  for (const b of rail.children) {
    const id = b.dataset.id, n = answers[id] ?? 0, key = `${appId()}/${id}`;
    // a conversation that was cleared starts counting again
    if ((seen[key] ?? 0) > n || (watching(id) && seen[key] !== n)) { seen[key] = n; changed = true; }
    const unread = n - (seen[key] ?? 0);
    b.classList.toggle('unread', unread > 0);
    b.querySelector('.badge').textContent = unread > 9 ? '9+' : unread || '';
    b.title = b.title.replace(/ · \d+ unread$/, '') + (unread > 0 ? ` · ${unread} unread` : '');
  }
  if (changed) localStorage.setItem('chat.seen', JSON.stringify(seen));
}
document.addEventListener('visibilitychange', drawUnread);

function drawRail() {
  rail.innerHTML = '';
  for (const a of agents) {
    const b = document.createElement('button');
    b.className = 'agent';
    b.dataset.id = a.id;
    b.title = `${a.name} — ${a.role}`;
    b.style.setProperty('--c', a.color);
    b.innerHTML = '<span class="face"></span><span class="lbl"></span><span class="badge"></span>';
    b.querySelector('.face').textContent = a.initials;
    b.querySelector('.lbl').textContent = a.name;
    b.addEventListener('click', () => { pick(a.id); setClosed(false); });
    rail.appendChild(b);
  }
}

// ---- talking to the server ----
// a conversation belongs to an agent AND to the application that is open
const appId = () => document.documentElement.dataset.application ?? '';
const post = (action, body = {}) =>
  fetch(`/__chat/${action}`, { method: 'POST', headers: HEAD, body: JSON.stringify({ app: appId(), agent: current?.id, ...body }) }).then(r => r.json());

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
  input.placeholder = `Message the ${a.name}…`;
  input.value = sessionStorage.getItem(draftKey()) ?? '';
  log.innerHTML = '';
  setRunning(false);
  drawUnread();
  poll?.abort();
  poll = new AbortController();
  follow(a, poll.signal);
}

async function follow(agent, signal) {
  let epoch = -1, next = 0;
  while (!signal.aborted) {
    try {
      const resp = await pollFetch(`/__chat/events?app=${encodeURIComponent(appId())}&agent=${encodeURIComponent(agent.id)}&epoch=${epoch}&since=${next}`, { headers: HEAD, signal });
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
      // what it is doing right now: its latest action since the last message
      for (const ev of r.events) doing = ev.type === 'tool' ? ev.text : '';
      next = r.next;
      setRunning(r.running);
      setBusy(r.busy ?? []);
      answers = r.answers ?? {};
      drawUnread();
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
  // conversations are per application: wait until the page knows which one is open
  while (!appId()) await new Promise(res => setTimeout(res, 150));
  drawRail();
  pick(localStorage.getItem('chat.agent'));
})();
