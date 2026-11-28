// The chat's assistant in the shareable edition: what viewer/chat.py is to
// the installed app, without a computer behind the page.
//
// chat.py starts a command-line agent for each message. Here a message is
// answered by asking Claude through the artifact's `sample` function, on
// the viewer's own account, with the page's functions as its tools
// (viewer/page-tools.js) and viewer/page-brief.js as all it is told. The
// page engine puts this object behind the same /__chat/… requests, so
// viewer/chat.js draws the conversation without knowing the difference:
// the same events (user, text, tool, error, done), kept in the same file
// (applications/<app>/chats/assistant.json), so a conversation exported
// from one edition opens in the other.
//
// What is different, and why:
//   - `sample` has no memory and no system prompt. Every request carries
//     the standing instructions as a leading user turn, then the saved
//     conversation as a record to read (as chat.py does for an agent that
//     has no session), then the new message.
//   - One `sample` call allows only a handful of tool rounds, and writing
//     a step takes more (read the guide, the recipe, the API, the layout;
//     write; run; fix; run). So a turn asks again, at most `maxPasses`
//     times, handing over a compact record of its own tool calls and what
//     it has said. It goes on only while the last pass used a tool and did
//     not end with the [[DONE]] line the instructions ask for. It stops at
//     the first failure and NEVER asks again by itself: each call spends
//     the viewer's own usage, and they are the one who retries.
//   - A pass's text is ONE `text` event, added when the pass ends: the
//     page only ever appends events, so a text cannot grow in place. Tool
//     events are added as the tools run, which keeps "Working — reads …"
//     moving meanwhile.
//
// WIRING. The chat is made before the engine (the engine is given the
// chat), yet the run tool needs the engine's run queue. So `runs` may be
// the queue itself or a function that returns it, read when a run is asked
// for:   const chat = createPageChat({ fs, getSample, runs: () => engine.runs, measure });
//        const engine = createPageEngine({ fs, chat, … });
//
// No DOM in here: it runs under node, where test/page-agent.test.mjs
// drives it with a stand-in for `sample`.

import { buildTools, forgetUndo } from './page-tools.js';
import { brief as standingBrief, loadAgent, DONE } from './page-brief.js';

// The model picker. `sample` offers tiers, not models, and does not say
// which model a tier is — so `model` (what the header shows after "·")
// stays empty. '' is the default tier, as '' is "the CLI's own setting" in chat.py.
export const MODELS = [
  { id: '', label: 'Default', model: '', note: 'balanced, for everyday work' },
  { id: 'quick', label: 'Quick', model: '', note: 'fastest, for short answers — thinks least' },
  { id: 'complex', label: 'Complex', model: '', note: 'most capable, for hard problems — slowest' },
];

const HISTORY = 24000;              // characters of the saved conversation handed over (chat.py's limit)
const LOG_BUDGET = 120000;          // characters of its own tool results a later pass is given
const PROMPT_BYTES = 262144;        // what one request may hold when the view does not say
const PICTURE = /\.(png|jpe?g|webp|gif)$/i;
const PICTURE_TYPE = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
const NOT_TEXT = /\.(glb|gltf|stl|step|stp|obj|3mf|bmp|ico|pdf|zip|microfactory|wasm|bin|gz)$/i;

const str = v => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
const bytesOf = s => new TextEncoder().encode(s).length;
const QUESTIONS = /```questions\s*\n[\s\S]*?```/;
// When a view takes fewer tools than there are, which go first. Changing a
// file is never offered without the way back (undo), so fewer than these
// first four is no assistant at all.
const NEED = ['read_file', 'write_file', 'edit_file', 'undo', 'run_steps', 'list_files', 'measure'];
const EVENT_TYPES = new Set(['user', 'text', 'tool', 'error', 'done', 'note']);

/**
 * An event read from a conversation's file, as the page may draw it — or
 * null. The file travels with an application that anyone may have made or
 * edited: only the kinds of event there are, their text as text, and as
 * attachments only files of this application's materials/ folder.
 */
export function tidyEvent(app, e) {
  if (!e || typeof e !== 'object' || Array.isArray(e) || !EVENT_TYPES.has(e.type)) return null;
  if (e.type === 'done') return { type: 'done' };
  const out = { type: e.type, text: str(e.text) };
  if (e.type === 'user') {
    if ('files' in e) out.files = (Array.isArray(e.files) ? e.files : []).filter(p => typeof p === 'string'
      && !/[\\%?#]/.test(p) && p.startsWith(`applications/${app}/materials/`) && !p.slice(`applications/${app}/materials/`.length).includes('/')
      && p.length > `applications/${app}/materials/`.length);
    if (e.from !== undefined && e.from !== null) out.from = str(e.from);     // (conversations kept from when there were several agents)
  }
  return out;
}

/** What the user reads when a request to Claude fails: plain words per error code. */
export function errorWords(e) {
  const code = e?.code;
  switch (code) {
    case 'none':
      return 'the assistant is not available in this view: it answers only to people signed in to Claude who have been given this page. To have a copy of your own where it answers, give Claude Code one line: install https://github.com/SimpleAutomationOrg/nano-cell';
    case 'not_granted':
      return 'the assistant was not allowed to use Claude in this view, so it cannot answer — reload the page and allow it when asked';
    case 'sampling_disabled':
      return 'the assistant is not available: Claude cannot be used from here by this account or organization';
    case 'not_declared': case 'capability_disabled': case 'capability_removed':
      return 'the assistant is not available in this view';
    case 'tools_unavailable':
      return 'the assistant cannot work in this view: it needs to read and change the application\'s files and run steps, and this view does not let it — open Microfactory in the Claude desktop app or at claude.ai';
    case 'images_unavailable':
      return 'pictures cannot be shown to the assistant in this view — send the message again without them';
    case 'image_rejected':
      return 'a picture could not be shown to the assistant (too large, or not a PNG, JPEG, WebP or GIF) — send the message again without it, or with another file';
    case 'rate_limited':
      return e?.reason === 'usage_limit'
        ? 'you have reached your Claude usage limit — the assistant can go on when it resets; what it did so far is kept'
        : 'Claude is busy with too many requests right now — wait a little and send the message again';
    case 'session_expired':
      return 'you are signed out of Claude — sign in again, then send the message again';
    case 'refused':
      return 'Claude declined to answer this — change what you ask and send it again';
    case 'empty_completion':
      return 'Claude gave no answer — ask again in simpler words, or for less at a time';
    case 'prompt_too_large':
      return 'the message and what it needs to read are too much for one request — send a shorter message, or ask for less at a time';
    case 'invalid_request': case 'transform_error': case 'queue_overflow':
      return `the chat could not make the request (${code}): ${str(e?.message) || 'no details'}`;
    default:                            // upstream_error, and any code this page does not know
      return 'interrupted: the connection to Claude failed — what was done so far is kept; send the message again to carry on';
  }
}

/**
 * The saved conversation as background for a model that has no memory of
 * it: viewer/chat.py `_history`, line for line. The latest part, if it is long.
 */
export function history(events, limit = HISTORY) {
  const lines = [];
  for (const e of events) {
    const text = str(e.text).trim();
    if (e.type === 'user') {
      const files = (Array.isArray(e.files) ? e.files : []).map(p => `\n  [attached: ${str(p)}]`).join('');
      const who = e.from ? `THE ${str(e.from).toUpperCase()} (handing you a task)` : 'USER';
      lines.push(`${who}: ${text}${files}`);
    }
    else if (e.type === 'note') lines.push(`  (${text})`);
    else if (e.type === 'text') lines.push(`YOU: ${text}`);
    else if (e.type === 'tool') lines.push(`  (you: ${text})`);
    else if (e.type === 'error') lines.push(`  (the turn ended with an error: ${text})`);
  }
  let body = lines.join('\n');
  if (!body) return '';
  const cut = body.length > limit;
  if (cut) {
    body = body.slice(-limit);
    body = body.slice(body.indexOf('\n') + 1);          // start at a whole line
  }
  return '[Background — your earlier conversation with the user about this application, as saved '
    + 'with it. You have no memory of it yourself, so read it and carry on from where it ends. '
    + 'Files you changed then are as you left them; check them rather than trusting this '
    + 'record.' + (cut ? ' Only the latest part is shown.' : '') + '\n\n' + body
    + '\n\nEnd of the earlier conversation. The user\'s new message follows.]\n\n';
}

// what a later pass is told about a tool call: its name and input, long texts shortened
function callLine(name, input) {
  const short = {};
  for (const [k, v] of Object.entries(input && typeof input === 'object' ? input : {}))
    short[k] = typeof v === 'string' && v.length > 160 ? `${v.slice(0, 120)}… (${v.length} characters)` : v;
  let json;
  try { json = JSON.stringify(short); } catch { json = '{…}'; }
  return `${name} ${json.length > 800 ? json.slice(0, 800) + '…' : json}`;
}
// the record of the turn's tool calls: the newest results whole while the
// budget lasts (they are what the next pass works from), older ones as a stub
function renderLog(log, budget) {
  const out = new Array(log.length);
  let left = budget;
  for (let i = log.length - 1; i >= 0; i--) {
    let result = log[i].result;
    const keep = Math.max(300, Math.min(result.length, left));
    if (result.length > keep) result = `${result.slice(0, keep)}\n[… cut: ${result.length} characters in all — call the tool again if you need the rest]`;
    left -= result.length;
    out[i] = `${i + 1}. ${log[i].call}\n${result}`;
  }
  return out.join('\n\n');
}

/**
 * The chat of the shareable edition.
 *   fs         viewer/page-fs.js
 *   getSample  () → Promise<sample | null>: the artifact's `sample` function, null where there is none
 *   runs       the engine's run queue, or a function returning it (see WIRING above)
 *   measure    (ids) → Promise<string>: measured geometry of the live scene; optional
 *   brief      ({ guides, hasMeasure, hasImages }) → the standing instructions (default: page-brief.js)
 *   hold       ms an events() call waits when there is nothing new
 *   maxPasses  how many times one message may ask Claude
 *   runWait    ms a run_steps call waits before answering "still running" (tests shorten it)
 *   now        not used: nothing in a conversation carries a time (kept for the engine's call)
 */
export function createPageChat({ fs, getSample, runs, measure, brief = standingBrief, now = Date.now, hold = 25000, maxPasses = 6, runWait } = {}) {
  void now;
  const loading = new Map();        // app -> Promise<conversation>
  const open = new Map();           // app -> conversation, once loaded
  const epochs = new Map();         // app -> epoch: bumped by "new chat" and by forget(), not kept over a reload

  const store = app => `applications/${app}/chats/assistant.json`;
  // an application is a folder name with an application.json in it (chat.py Chats.get)
  const isApp = app => typeof app === 'string' && app !== '' && app !== '.' && app !== '..'
    && !/[/\\%?#]/.test(app) && fs.exists(`applications/${app}/application.json`);

  async function load(app) {
    const conv = { app, events: [], epoch: epochs.get(app) ?? 0, turn: null, waiters: new Set(), saving: Promise.resolve(), gone: false };
    try {
      // an application made when the chat had several agents: the main one's conversation carries on (chat.py _adopt)
      const old = `applications/${app}/chats/lead-engineer.json`;
      if (!fs.exists(store(app)) && fs.exists(old)) { await fs.write(store(app), await fs.read(old)); await fs.remove(old); }
      const text = await fs.readText(store(app));
      const events = text ? JSON.parse(text)?.events : [];
      conv.events = (Array.isArray(events) ? events : []).map(e => tidyEvent(app, e)).filter(Boolean);
    } catch { conv.events = []; }       // a conversation that cannot be read starts empty
    // The page was reloaded (or closed) while the assistant was working —
    // the ordinary way a turn dies here. Say so, or the conversation would
    // end in the middle of a sentence. In memory, as chat.py does: it is
    // saved with the next event.
    const last = conv.events[conv.events.length - 1];
    if (last && !['done', 'error', 'note'].includes(last.type))
      conv.events.push({ type: 'error', text: 'interrupted: the page was reloaded while the assistant was working' }, { type: 'done' });
    open.set(app, conv);
    return conv;
  }
  async function get(app) {
    await fs.ready;
    if (!isApp(app)) return null;
    let p = loading.get(app);
    if (!p) loading.set(app, p = load(app));
    return p;
  }

  // the file is rewritten whole after every event, and removed when the
  // conversation is empty; one write at a time, in order. A chat that
  // cannot be saved still works.
  function save(conv) {
    const text = conv.events.length ? JSON.stringify({ events: conv.events }, null, 1) : null;
    conv.saving = conv.saving.then(() => {
      if (conv.gone) return undefined;
      return text === null ? fs.remove(store(conv.app)) : fs.write(store(conv.app), text);
    }).catch(() => {});
  }
  function wake(conv) {
    for (const fn of [...conv.waiters]) fn();
  }
  function add(conv, ev) {
    conv.events.push(ev);
    save(conv);
    wake(conv);
  }

  // ---- one turn ----
  // Returns the words of a failure, or null when the turn ended well.
  async function work(conv, turn, { earlier, text, context, files, model }) {
    const { signal } = turn.ctl;
    // only while this turn is the conversation's turn: a tool of a stopped turn that is still
    // finishing must not write after its `done` (the next load would take the turn for unfinished)
    const say = ev => { if (turn.live() && conv.turn === turn) add(conv, ev); };
    let sample = null;
    try { sample = await getSample?.(); } catch { sample = null; }
    if (signal.aborted) return 'stopped';
    if (!sample) return errorWords({ code: 'none' });
    let lim = null;
    try { lim = await sample.limits?.(); } catch { lim = null; }
    if (signal.aborted) return 'stopped';
    // without page tools the assistant can read nothing and do nothing: say that, rather than let it guess
    if (lim && !lim.tools) return errorWords({ code: 'tools_unavailable' });

    // pictures the user attached go along with the message, where this view sends pictures
    const pictures = [], sent = new Set();
    if (lim?.images) for (const path of files) {
      if (!PICTURE.test(path) || pictures.length >= (lim.images.maxCount ?? 1)) continue;
      const type = PICTURE_TYPE[path.split('.').pop().toLowerCase()];
      const bytes = await fs.read(path);
      if (!bytes || bytes.length > (lim.images.maxInputBytes ?? Infinity)) continue;
      if (Array.isArray(lim.images.mediaTypes) && !lim.images.mediaTypes.includes(type)) continue;
      pictures.push(new Blob([bytes], { type }));
      sent.add(path);
    }

    // the tools, each call noted for the next pass
    const log = [];
    let used = 0;
    let tools = buildTools({ fs, app: conv.app, runs, measure, emit: t => say({ type: 'tool', text: t }), ...(runWait ? { runWait } : {}) })
      .map(t => ({
        ...t,
        async execute(input, ctx) {
          // a call the platform starts after Stop does nothing (no file written, no run started)
          if (signal.aborted || conv.turn !== turn) throw new Error('stopped');
          used++;
          const entry = { call: callLine(t.name, input), result: '(no result: it was still running when the answer ended)' };
          log.push(entry);
          try { const out = await t.execute(input, ctx ?? {}); entry.result = str(out); return out; }
          catch (e) { entry.result = `Error: ${e?.message ?? e}`; throw e; }
        },
      }));
    // a view may take fewer tools than there are: the ones needed most, and never a way to change a file without undo
    if (lim?.tools?.maxCount > 0 && tools.length > lim.tools.maxCount) {
      if (lim.tools.maxCount < 4) return errorWords({ code: 'tools_unavailable' });
      const keep = new Set(NEED.filter(n => tools.some(t => t.name === n)).slice(0, lim.tools.maxCount));
      tools = tools.filter(t => keep.has(t.name));
    }

    const agent = await loadAgent(fs);
    // (the instructions name the tools that are SENT, not the ones there could be)
    const standing = brief({ guides: agent.guides, hasMeasure: tools.some(t => t.name === 'measure'), hasImages: !!lim?.images, tools: tools.map(t => t.name) });
    let prompt = context ? `[viewer: ${context}]\n${text}` : text;
    if (files.length) prompt += '\n\n[attached by the user, saved in the application\'s materials/ folder:\n' + files.map(p =>
      `  ${p} — ${sent.has(p) ? 'a picture, shown to you with this message' : PICTURE.test(p) ? 'a picture: you cannot see it here' : NOT_TEXT.test(p) ? 'not a text file: it cannot be read here' : 'read it with read_file'}`).join('\n') + ']';
    prompt = prompt.trim();
    let background = history(earlier);
    const tier = model && (!Array.isArray(lim?.modelTiers) || lim.modelTiers.includes(model)) ? model : '';
    const room = (lim?.maxPromptBytes ?? PROMPT_BYTES) - 2000;

    let answer = '', cutShort = false;
    for (let pass = 0; pass < maxPasses; pass++) {
      // what Claude reads: the instructions (never dropped), the record of the conversation, the message, and from
      // the second pass on what this turn has done. When it does not fit: less of the tool results, then no record.
      let budget = LOG_BUDGET, input;
      for (;;) {
        input = [{ role: 'user', content: standing }, { role: 'user', content: background + prompt }];
        if (pass > 0) input.push({ role: 'user', content:
          '[Continuing the SAME request: one answer allows only a few tool rounds, so you were stopped and are called again. '
          + 'The user has written nothing new and has not seen your tool results. Your tool calls so far on this request, with what they returned:\n\n'
          + (renderLog(log, budget) || '(none)')
          + '\n\nWhat you have written to the user so far:\n\n' + (answer || '(nothing)')
          + (cutShort ? '\n\n(That last text was cut off by the length limit of one answer: carry on exactly where it stops.)' : '')
          + `\n\nCarry on from here. Do not repeat finished work or what you have already said. When the whole request is finished, or you need the user's answer, end with ${DONE}.]` });
        if (input.reduce((n, m) => n + bytesOf(m.content), 0) <= room) break;
        if (pass > 0 && budget > 2000) budget = Math.floor(budget / 2);
        else if (background) background = '';
        else break;                     // the message itself is too long: the platform says so
      }
      used = 0;
      let seen = '', result;
      try {
        result = await new Promise((resolve, reject) => {
          // Stop ends the turn at once, whatever the call does with its signal
          const onAbort = () => reject({ code: 'cancelled', message: 'stopped' });
          if (signal.aborted) return onAbort();
          signal.addEventListener('abort', onAbort, { once: true });
          Promise.resolve().then(() => sample(input, {
            tools, signal, cache: false,                // with tools, an answer is never one stored earlier
            ...(tier ? { modelTier: tier } : {}),
            ...(pictures.length ? { images: pictures } : {}),
            onText: u => { if (typeof u?.text === 'string') seen = u.text; },
          })).then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
        });
      } catch (e) {
        if (!e || typeof e !== 'object' || e instanceof Error || typeof e.code !== 'string') throw e;     // not `sample` speaking: a bug of ours
        const stopped = signal.aborted || e.code === 'cancelled';
        // what was written before the failure stays (`refused` withdraws it)
        const kept = e.code === 'refused' ? '' : clean(typeof e.text === 'string' ? e.text : seen);
        if (kept) say({ type: 'text', text: kept });
        return stopped ? 'stopped' : errorWords(e);
      }
      const whole = str(result?.text);
      const shown = clean(whole);
      if (shown) { say({ type: 'text', text: shown }); answer += (answer ? '\n\n' : '') + shown; }
      // finished: it said so, or it asked the user something (the buttons are the end of an answer)
      if (whole.includes(DONE) || QUESTIONS.test(whole)) return null;
      // no tool used and no DONE: it has simply answered. Asking again would only spin —
      // unless the answer was cut short (the length or time limit of one call): then it goes on, like after a tool
      if (!used && !result?.truncated) return null;
      cutShort = result?.truncated === true;
    }
    return 'paused: this took more rounds than one message allows — send "continue" and the assistant carries on from here';
  }
  // the line that ends a request is the page's own convention: the user never sees it
  const clean = text => text.split(DONE).join('').replace(/[ \t]+$/gm, '').trim();

  async function run(conv, turn, message) {
    try {
      const failure = await work(conv, turn, message);
      if (failure && turn.live()) add(conv, { type: 'error', text: failure });
    } catch (e) {                       // never leave the chat stuck "running"
      if (turn.live()) add(conv, { type: 'error', text: turn.ctl.signal.aborted ? 'stopped' : `chat failed: ${e?.message ?? e}` });
    } finally {
      // in chat.py's order: no longer running, then `done`
      if (conv.turn === turn) conv.turn = null;
      if (turn.live()) { conv.events.push({ type: 'done' }); save(conv); }
      wake(conv);
    }
  }

  return {
    /** What the page needs to draw the chat: { name, hint, guides, models, models_ready }. A Promise (the guides are files). */
    async agent() {
      const a = await loadAgent(fs);
      return { name: a.name, hint: a.hint, guides: a.guides, models: MODELS.map(m => ({ ...m })), models_ready: true };
    },

    /**
     * The conversation from event `since` on; held up to `hold` ms when the
     * caller has it all. → { epoch, events, next, running, available: true },
     * or { error: 'no such application', status: 404 }.
     */
    async events(app, epoch, since) {
      let conv = await get(str(app));
      if (!conv) return { error: 'no such application', status: 404 };
      epoch = Number.isFinite(Number(epoch)) ? Math.trunc(Number(epoch)) : -1;
      since = Number.isFinite(Number(since)) ? Math.trunc(Number(since)) : 0;
      if (epoch === conv.epoch && since >= conv.events.length) {
        await new Promise(resolve => {
          const done = () => { clearTimeout(timer); conv.waiters.delete(done); resolve(undefined); };
          const timer = setTimeout(done, hold);
          conv.waiters.add(done);
        });
        conv = (await get(str(app))) ?? conv;          // forget() may have replaced it meanwhile
      }
      // What the page is told is in the store first. The page reloads itself
      // within a second of hearing that the turn is over (a file the
      // assistant changed is waiting to be shown): a `done` it had heard of
      // but that was not saved yet would come back as an unfinished turn, and
      // be marked "interrupted" though nothing was.
      // (the answer is made first, then waited for: events added meanwhile
      // are for the next call, which waits for them in its turn)
      if (epoch !== conv.epoch) since = 0;
      const answer = { epoch: conv.epoch, events: conv.events.slice(Math.max(0, since)), next: conv.events.length, running: conv.turn !== null, available: true };
      await conv.saving;
      return answer;
    },

    /**
     * A message from the user. Answers at once — a Promise of { ok: true } or
     * { error, status } — and the work goes on behind it, told through events().
     */
    async send({ app, text, context, files, model } = {}) {
      const conv = await get(str(app));
      if (!conv) return { error: 'no such application', status: 404 };
      text = str(text).trim();
      // only what the chat itself saved: applications/<x>/materials/<file>, and there
      files = (Array.isArray(files) ? files : []).filter(p => typeof p === 'string' && !/[\\%?#]/.test(p)
        && /^applications\/[^/]+\/materials\/[^/]+$/.test(p) && fs.exists(p)).slice(0, 20);
      context = str(context).slice(0, 400);
      model = MODELS.some(m => m.id === model) ? model : '';
      if (!text && !files.length) return { error: 'empty message', status: 409 };
      if (conv.turn) return { error: 'the agent is still working', status: 409 };
      const earlier = conv.events.slice();              // the conversation before this message
      const epoch = conv.epoch;
      const turn = conv.turn = { ctl: new AbortController(), live: () => !conv.gone && conv.epoch === epoch, done: null };
      add(conv, { type: 'user', text, files });
      turn.done = run(conv, turn, { earlier, text, context, files, model });
      return { ok: true };
    },

    /** Stop the turn that is running: it ends with the error "stopped", then done. */
    stop(app) {
      open.get(str(app))?.turn?.ctl.abort();
      return { ok: true };
    },

    /** "New chat": the conversation is emptied and its file removed; a turn still running is dropped without a word. A Promise. */
    async reset(app) {
      const conv = await get(str(app));
      if (!conv) return { ok: true };
      const turn = conv.turn;
      conv.turn = null;
      conv.events = [];
      conv.epoch += 1;                                  // tells the page to start over; the turn's events no longer count
      epochs.set(conv.app, conv.epoch);
      turn?.ctl.abort();
      save(conv);
      wake(conv);
      return { ok: true };
    },

    /**
     * The application's files were replaced under the chat (an import):
     * drop what is held of its conversation, so that it is read again from
     * the files. A turn still running is dropped. Resolves when nothing of
     * the old conversation is still being written.
     */
    forget(app) {
      app = str(app);
      const conv = open.get(app);
      loading.delete(app);
      open.delete(app);
      // the earlier versions kept for undo are of the files that were here before
      const cleared = app && !/[/\\%?#]/.test(app) && app !== '.' && app !== '..' ? Promise.resolve().then(() => forgetUndo(fs, app)).catch(() => {}) : Promise.resolve();
      if (!conv) return cleared;
      conv.gone = true;
      epochs.set(app, conv.epoch + 1);
      const turn = conv.turn;
      conv.turn = null;
      turn?.ctl.abort();
      wake(conv);
      return conv.saving;               // (the earlier versions go behind it: nothing waits for them)
    },

    /** Is any conversation being answered? (The page holds a reload meanwhile.) */
    running() {
      for (const conv of open.values()) if (conv.turn) return true;
      return false;
    },

    /** Resolves when no turn is running and every conversation is saved. */
    async whenIdle() {
      for (;;) {
        const turns = [...open.values()].filter(c => c.turn?.done).map(c => c.turn.done);
        if (!turns.length) break;
        await Promise.all(turns);
      }
      await Promise.all([...open.values()].map(c => c.saving));
    },
  };
}
