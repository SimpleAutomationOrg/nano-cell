// Chat with the step agent, in the page.
//
// The conversation itself lives in the dev server (viewer/chat.py): each
// message runs a coding agent in the repository, and the server keeps the
// list of everything said and done. This file only draws that list and
// sends what you type — so when the agent saves a file and the page
// reloads itself, the chat comes back exactly as it was.
import { pollFetch } from './poll.js';

const HEAD = { 'X-Nano-Cell': 'chat', 'Content-Type': 'application/json' };

const box = document.createElement('div');
box.id = 'chat';
box.innerHTML = `
  <header title="show / hide"><span class="dot"></span><b>Step agent</b>
    <button id="chatNew" title="forget this conversation and start a new one">New</button></header>
  <div id="chatBody">
    <div id="chatLog"></div>
    <form><textarea id="chatIn" placeholder="Ask for a change to the step…  (Enter to send, Shift+Enter for a new line)"></textarea>
      <button id="chatSend">Send</button></form>
  </div>`;
document.body.appendChild(box);
const log = box.querySelector('#chatLog'), input = box.querySelector('#chatIn');
const sendBtn = box.querySelector('#chatSend');

// open/closed and a half-typed message survive the page reloading
// (the chat is a full-height column beside the simulation; closed, it
// folds to its header and the simulation takes the width back)
const setClosed = on => { box.classList.toggle('closed', on); document.body.classList.toggle('chat-closed', on); };
setClosed(localStorage.getItem('chat.closed') === '1');
box.querySelector('header').addEventListener('click', ev => {
  if (ev.target.id === 'chatNew') return;
  setClosed(!box.classList.contains('closed'));
  localStorage.setItem('chat.closed', box.classList.contains('closed') ? '1' : '0');
});
input.value = sessionStorage.getItem('chat.draft') ?? '';
input.addEventListener('input', () => sessionStorage.setItem('chat.draft', input.value));

// ---- drawing ----
const esc = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
// just enough markdown for an agent's replies: code blocks, `code`, **bold**
function rich(text) {
  return text.split(/```/).map((part, i) => i % 2
    ? `<pre><code>${esc(part.replace(/^[a-z]*\n/, ''))}</code></pre>`
    : esc(part).replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')).join('');
}
function draw(ev) {
  if (ev.type === 'done') return;
  const el = document.createElement('div');
  el.className = `msg ${ev.type}`;
  if (ev.type === 'text') el.innerHTML = rich(ev.text.trim());
  else el.textContent = ev.type === 'tool' ? `· ${ev.text}` : ev.text;
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
  box.classList.toggle('busy', on);
  sendBtn.textContent = on ? 'Stop' : 'Send';
}

// ---- talking to the server ----
const post = (action, body = {}) =>
  fetch(`/__chat/${action}`, { method: 'POST', headers: HEAD, body: JSON.stringify(body) }).then(r => r.json());

// what the agent cannot see for itself: which application and step are up, and how the last run ended
const context = () => {
  const step = document.documentElement.dataset.step || 'none';
  const line = document.getElementById('stepline')?.textContent.trim() || '';
  const app = document.documentElement.dataset.application || 'unknown';
  return `application: ${app}; step selected: ${step}; last status line: "${line}"`;
};

async function send() {
  if (running) { await post('stop'); return; }
  const text = input.value.trim();
  if (!text) return;
  const r = await post('send', { text, context: context() }).catch(e => ({ error: String(e) }));
  if (r.error) { draw({ type: 'error', text: r.error }); log.scrollTop = log.scrollHeight; return; }
  input.value = '';
  sessionStorage.removeItem('chat.draft');
}
box.querySelector('form').addEventListener('submit', ev => { ev.preventDefault(); send(); });
input.addEventListener('keydown', ev => {
  if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); send(); }
});
box.querySelector('#chatNew').addEventListener('click', () => post('new'));

(async () => {
  let epoch = -1, next = 0;
  for (;;) {
    try {
      const resp = await pollFetch(`/__chat/events?epoch=${epoch}&since=${next}`, { headers: HEAD });
      if (!resp) continue;            // the tab was hidden: wait until it is shown
      const r = await resp.json();
      if (r.error) throw new Error(r.error);
      if (r.epoch !== epoch) { epoch = r.epoch; log.innerHTML = ''; }
      const atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
      if (!r.next && !log.children.length)
        hint(r.available
          ? 'Tell the agent what to change in the step — for example “place the case 5 mm higher before the touch descent” or “make a new step that stacks two cases”. It edits the files; the page reloads by itself.'
          : 'The `claude` command was not found. Install Claude Code and sign in, then restart viewer/serve.py.');
      else if (r.events.length && log.querySelector('.hint')) log.innerHTML = '';
      r.events.forEach(draw);
      next = r.next;
      setRunning(r.running);
      if (atEnd) log.scrollTop = log.scrollHeight;
    } catch { await new Promise(res => setTimeout(res, 2000)); }
  }
})();
