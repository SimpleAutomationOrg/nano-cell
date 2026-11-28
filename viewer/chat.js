// The chat, in the page: one conversation with the project's assistant
// about the application that is open.
//
// The conversation itself lives in the dev server (viewer/chat.py): each
// message runs the agent in the repository, and the server keeps the list
// of everything said and done (on disk, with the application). This file
// only draws that list and sends what you type — so when the agent saves
// a file and the page reloads itself, the chat comes back exactly as it
// was.
import { pollFetch } from './poll.js';
import { splitQuestions, answerText, allAnswered } from './ask.js';
import { rich } from './md.js';

const HEAD = { 'X-Microfactory': 'chat', 'Content-Type': 'application/json' };

const box = document.createElement('div');
box.id = 'chat';
box.innerHTML = `
  <div id="chatMain">
    <header title="show / hide the conversation"><div class="who"><b id="chatName">Assistant</b></div></header>
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
            <select id="chatModel" title="the model that answers the next message" hidden></select>
            <button id="chatSend">Send</button>
          </div>
        </div>
      </form>
    </div>
  </div>`;
document.body.appendChild(box);
const log = box.querySelector('#chatLog'), input = box.querySelector('#chatIn');
const sendBtn = box.querySelector('#chatSend');

// open/closed and a half-typed message survive the page reloading. Closed,
// the chat folds to its header in the corner and the simulation takes the
// width back.
const setClosed = on => {
  box.classList.toggle('closed', on);
  document.body.classList.toggle('chat-closed', on);
  localStorage.setItem('chat.closed', on ? '1' : '0');
};
setClosed(localStorage.getItem('chat.closed') === '1');
box.querySelector('header').addEventListener('click', ev => {
  setClosed(!box.classList.contains('closed'));
});

let agent = null;                   // { name, hint } once the server has said who answers
const draftKey = () => `chat.draft.${document.documentElement.dataset.application}`;
input.addEventListener('input', () => sessionStorage.setItem(draftKey(), input.value));

// ---- drawing ----
const IMAGE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
function draw(ev) {
  if (ev.type === 'done') return;
  const el = document.createElement('div');
  el.className = `msg ${ev.type}`;
  // the user has answered (in whatever way): questions asked before are settled
  if (ev.type === 'user') for (const a of log.querySelectorAll('.ask:not(.settled)')) settle(a);
  if (ev.type === 'text') {
    // an agent's questions come as a block at the end of its message: shown as buttons
    const { text, questions } = splitQuestions(ev.text.trim());
    el.innerHTML = rich(text);
    if (questions.length) el.appendChild(askBox(questions));
  }
  else if (ev.type === 'note') el.textContent = `→ ${ev.text}`;      // (in conversations kept from when there were several agents)
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
// While the agent is working: a line under the conversation with moving
// dots, saying what it is doing (its latest action) and for
// how long.
let running = false, since = 0, doing = '';
const work = box.querySelector('#chatWork'), workText = box.querySelector('#chatWorkText');
function drawWork() {
  work.hidden = !running;
  box.classList.toggle('working', running);
  if (!running) return;
  const s = Math.round((Date.now() - since) / 1000);
  workText.textContent = `Working${doing ? ` — ${doing}` : ''} · ${s} s`;
}
setInterval(drawWork, 1000);
function setRunning(on) {
  if (on && !running) since = Date.now();
  if (!on) doing = '';
  running = on;
  sendBtn.textContent = on ? 'Stop' : 'Send';
  drawWork();
}
// ---- talking to the server ----
// the conversation belongs to the application that is open
const appId = () => document.documentElement.dataset.application ?? '';
const post = (action, body = {}) =>
  fetch(`/__chat/${action}`, { method: 'POST', headers: HEAD, body: JSON.stringify({ app: appId(), ...body }) }).then(r => r.json());

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

// ---- which model answers: chosen here, remembered on this computer, sent with each message ----
const MODEL_KEY = 'microfactory.chat.model';
const modelPick = box.querySelector('#chatModel');
function offerModels(models) {
  if (!models?.length) return;
  modelPick.innerHTML = '';
  for (const m of models) {
    const o = document.createElement('option');
    o.value = m.id; o.textContent = m.label; o.title = m.note ?? '';
    modelPick.appendChild(o);
  }
  const saved = localStorage.getItem(MODEL_KEY) ?? '';
  modelPick.value = models.some(m => m.id === saved) ? saved : models[0].id;
  modelPick.hidden = false;
}
modelPick.addEventListener('change', () => {
  localStorage.setItem(MODEL_KEY, modelPick.value);
  modelPick.title = modelPick.selectedOptions[0]?.title || 'the model that answers the next message';
});
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
    method: 'POST', headers: { 'X-Microfactory': 'chat', 'Content-Type': 'application/octet-stream' }, body: p.file,
  })).json();
  if (r.error) throw new Error(`${p.name}: ${r.error}`);
  return r.path;
}

let sending = false;
async function send() {
  if (!agent || sending) return;
  if (running) { await post('stop'); return; }
  const text = input.value.trim();
  if (!text && !pending.length) return;
  sending = true;
  try {
    const files = [];
    for (const p of pending) files.push(await upload(p));
    const r = await post('send', { text, context: context(), files, model: modelPick.value });
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

// follow the conversation from its start (the server has all of it)
async function follow() {
  let epoch = -1, next = 0;
  for (;;) {
    try {
      const resp = await pollFetch(`/__chat/events?app=${encodeURIComponent(appId())}&epoch=${epoch}&since=${next}`, { headers: HEAD });
      if (!resp) continue;            // the tab was hidden: wait until it is shown
      const r = await resp.json();
      if (r.error) throw new Error(r.error);
      if (r.epoch !== epoch) { epoch = r.epoch; log.innerHTML = ''; }
      const atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
      if (!r.next && !log.children.length)
        hint(r.available
          ? (agent.hint || 'Describe what you want to do.')
          : 'The `claude` command was not found. Install Claude Code and sign in, then restart viewer/serve.py.');
      else if (r.events.length && log.querySelector('.hint')) log.innerHTML = '';
      r.events.forEach(draw);
      // what it is doing right now: its latest action since the last message
      for (const ev of r.events) doing = ev.type === 'tool' ? ev.text : '';
      next = r.next;
      setRunning(r.running);
      if (atEnd) log.scrollTop = log.scrollHeight;
    } catch { await new Promise(res => setTimeout(res, 2000)); }
  }
}

(async () => {
  for (;;) {
    try {
      const a = await (await fetch('/__chat/agent', { headers: HEAD })).json();
      if (a && typeof a.name === 'string') { agent = a; offerModels(a.models); break; }
    } catch { /* server not up yet */ }
    await new Promise(res => setTimeout(res, 2000));
  }
  box.querySelector('#chatName').textContent = agent.name;
  // the conversation is per application: wait until the page knows which one is open
  while (!appId()) await new Promise(res => setTimeout(res, 150));
  input.value = sessionStorage.getItem(draftKey()) ?? '';
  follow();
})();
