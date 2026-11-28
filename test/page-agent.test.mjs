// The assistant of the shareable edition (viewer/page-agent.js with its
// tools, viewer/page-tools.js, and its standing instructions,
// viewer/page-brief.js): what a turn does, what it may touch, how it ends,
// and what is kept of it. `sample` is a stand-in that behaves like the
// artifact's: it runs the tools it is given with { signal }, joins the
// text of its rounds with a blank line, rejects with plain { code }
// objects and stops when the signal aborts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createPageFs } from '../viewer/page-fs.js';
import { createMemoryStore } from '../viewer/page-store.js';
import { createPageChat, errorWords, history, MODELS } from '../viewer/page-agent.js';
import { buildTools, pathRule, runText, capText, MAX_RESULT } from '../viewer/page-tools.js';
import { brief, front, loadGuides, DONE } from '../viewer/page-brief.js';

const enc = s => new TextEncoder().encode(s);
const bytes = s => enc(s).length;
const sha = b => createHash('sha256').update(b).digest('hex');

// ---- a small workspace: two applications, the guides, the step API, the robot ----
const STEP = `import type { CellAPI, Ctx, Entry } from 'microfactory';
export const name = 'Pick';
export const tool = 'cup';
export const entry: Entry = { joints_deg: [0, 0, 0, 0, 0, 0] };
export default async function (cell: CellAPI, ctx: Ctx): Promise<void> {
  await cell.waitMs(1);
}
`;
const MANIFEST = JSON.stringify({ format: 1, name: 'Demo', loop: { name: 'One cycle', steps: ['pick'] } }, null, 1) + '\n';
const LAYOUT = JSON.stringify({ fixtures: [{ id: 'holder', item: 'holder', pose: { xyz_m: [0.1, 0.2, 0], rpy: [0, 0, 0] } }] }, null, 1) + '\n';
const BIG = Array.from({ length: 4000 }, (_, i) => `line ${i + 1}: ${'żółw '.repeat(4)}`).join('\n') + '\n';
const GLB = Uint8Array.from({ length: 300 }, (_, i) => i % 256);
const guide = (order, title, when) => `---\norder: ${order}\ntitle: ${title}\nwhen: ${when}\n---\n\n# ${title}\n`;
const FILES = {
  'applications/demo/application.json': MANIFEST,
  'applications/demo/layout.json': LAYOUT,
  'applications/demo/steps/pick.ts': STEP,
  'applications/demo/items/holder/item.json': '{"name": "Holder"}\n',
  'applications/demo/notes/big.md': BIG,
  'applications/other/application.json': '{"name": "Other"}\n',
  'applications/other/notes/plan.md': 'secret plan\n',
  'guides/agent.md': '---\nname: Assistant\nhint: Describe the task.\ntools: WebSearch\n---\n\nYou are the engineer.\n',
  'guides/steps.md': guide(3, 'Steps', 'writing or changing a step'),
  'guides/planning.md': guide(1, 'Planning', 'turning a goal into a plan'),
  'guides/zz.md': '# no header\n',
  'recipes/suction-pick-place.md': '# Recipe\n',
  'viewer/cell.d.ts': 'export interface CellAPI {}\n',
  'viewer/app.js': '// the engine\n',
  'cell_fr3/robot.json': '{"arm": "fr3"}\n',
};
function makeFs(more = {}) {
  const files = Object.entries({ ...FILES, ...more }).map(([path, text]) => ({ path, sha: sha(enc(text)), size: bytes(text), text }));
  files.push({ path: 'applications/demo/items/holder/holder.glb', sha: sha(GLB), size: GLB.length, bin: 'ws/b/0.txt' });
  return createPageFs({ pack: { version: 't', files }, loadBin: async () => GLB, store: createMemoryStore() });
}

// ---- `sample`, as the platform's behaves ----
// `script` holds one function per call: it is handed { say, tool } and may
// throw a { code } object. say(text) writes a round's text; tool(name,
// input) runs the page's tool and returns what Claude would be given.
function fakeSample(script, { limits } = {}) {
  const calls = [];
  const sample = (input, options = {}) => new Promise((resolve, reject) => {
    const bad = message => reject({ code: 'invalid_request', message });
    if (!Array.isArray(input) || !input.length || input[0].role !== 'user' || input.at(-1).role !== 'user') return bad('turns must start and end with a user turn');
    if (input.some(m => !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string' || !m.content)) return bad('a turn with another role or empty content');
    if (options.tools && options.cache !== undefined && options.cache !== false) return bad('cache passed with tools');
    if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) return bad('signal is not an AbortSignal');
    for (const t of options.tools ?? []) {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(t.name) || typeof t.execute !== 'function') return bad(`tool ${t.name}`);
      if (!t.description || bytes(t.description) > 1024) return bad(`tool ${t.name}: description`);
      if (t.inputSchema && (t.inputSchema.type !== 'object' || bytes(JSON.stringify(t.inputSchema)) > 4096)) return bad(`tool ${t.name}: inputSchema`);
    }
    if (input.reduce((n, m) => n + bytes(m.content), 0) > 262144) return reject({ code: 'prompt_too_large', message: 'over 256 KiB' });
    if (options.signal?.aborted) return reject({ code: 'cancelled', message: 'aborted' });
    const step = script[calls.length];
    calls.push({ input, options });
    let text = '', settled = false;
    const toolCtl = new AbortController();
    options.signal?.addEventListener('abort', () => {
      toolCtl.abort();
      if (settled) return;
      settled = true;
      reject({ code: 'cancelled', message: 'aborted', ...(text ? { text } : {}) });
    });
    const api = {
      say(t) {
        text += (text ? '\n\n' : '') + t;
        const whole = text;
        queueMicrotask(() => { if (!settled) options.onText?.({ text: whole, delta: t }); });
      },
      async tool(name, args) {
        const t = (options.tools ?? []).find(x => x.name === name);
        if (!t) return `Error: no tool ${name}`;
        try {
          const out = await t.execute(args, { signal: toolCtl.signal });
          const result = typeof out === 'string' ? out : JSON.stringify(out);
          assert.ok(bytes(result) <= 32768, `${name} returned ${bytes(result)} bytes: more than the platform takes`);
          return result;
        } catch (e) { return `Error: ${e.message}`; }
      },
    };
    Promise.resolve().then(() => (step ?? (a => a.say('…')))(api, input, options)).then(() => {
      if (settled) return;
      settled = true;
      toolCtl.abort();
      if (text.trim()) resolve({ text, truncated: false, modelTierApplied: options.modelTier ?? 'default' });
      else reject({ code: 'empty_completion', message: 'no text' });
    }, e => { if (!settled) { settled = true; toolCtl.abort(); reject(e); } });
  });
  sample.limits = async () => limits ?? { maxPromptBytes: 262144, tools: { maxCount: 16 } };
  sample.calls = calls;
  return sample;
}

// the run queue of the page engine, stood in for
function fakeRuns(answer = { ok: true, ran: ['pick'], seconds: 1.5, log: ['▶ pick', '✓ pick'], parts_moved: [], held: null, io: { vacuum: false }, tool: 'cup', joints_deg: [0, 0, 0, 0, 0, 0], stale: false }) {
  const runs = { jobs: [], record: null, request: async job => { runs.jobs.push(job); return typeof answer === 'function' ? answer(job) : answer; }, last: () => runs.record };
  return runs;
}
function setup(script, { files, limits, sample, ...more } = {}) {
  const fs = makeFs(files);
  const s = sample === undefined ? fakeSample(script, { limits }) : sample;
  const runs = more.runs ?? fakeRuns();
  const chat = createPageChat({ fs, getSample: async () => s, hold: 40, ...more, runs: () => runs });      // the getter form: the engine comes later
  return { fs, chat, sample: s, runs };
}
const CONTEXT = 'application: demo; step selected: pick; last status line: "ready"';
async function ask(chat, text, more = {}) {
  assert.deepEqual(await chat.send({ app: 'demo', text, context: CONTEXT, files: [], model: '', ...more }), { ok: true });
  await chat.whenIdle();
  return (await chat.events('demo', -1, 0)).events;
}
const stored = async fs => fs.readText('applications/demo/chats/assistant.json');

// ---- the standing instructions ----
test('the standing instructions carry chat.py\'s questions paragraph word for word, the guide list, and stay small', async () => {
  const fs = makeFs();
  await fs.ready;
  const guides = await loadGuides(fs);
  assert.deepEqual(guides, [
    { file: 'guides/planning.md', title: 'Planning', when: 'turning a goal into a plan' },
    { file: 'guides/steps.md', title: 'Steps', when: 'writing or changing a step' },
    { file: 'guides/zz.md', title: 'zz', when: '' },
  ], 'every guide but agent.md, by its order, then by name');
  assert.deepEqual(front('---\nname: "A: b"\nx\n---\nbody'), { meta: { name: 'A: b' }, body: 'body' });
  const text = brief({ guides, hasMeasure: true, hasImages: false });
  // the paragraph in chat.py, with its line continuations joined as Python joins them
  const py = readFileSync(new URL('../viewer/chat.py', import.meta.url), 'utf8').replace(/\\\n/g, '');
  const from = py.indexOf('When you need the user to decide'), to = py.indexOf('sensibly decide yourself.') + 'sensibly decide yourself.'.length;
  assert.ok(from > 0 && to > from);
  assert.ok(text.includes(py.slice(from, to)), 'the questions block is described exactly as in the installed app: the page turns it into buttons');
  assert.ok(text.endsWith('- guides/planning.md — Planning: turning a goal into a plan\n- guides/steps.md — Steps: writing or changing a step\n- guides/zz.md — zz: '));
  assert.ok(brief({ guides: [] }).endsWith('- (none)'));
  assert.ok(bytes(brief({ guides: [], hasMeasure: true, hasImages: true })) < 7000, 'it is sent with every request');
  assert.ok(text.includes(DONE) && text.includes('measure,') && !brief({ guides }).includes('measure,'), 'it names the tools that are there');
  assert.match(text, /cannot see pictures/);
  assert.match(brief({ guides, hasImages: true }), /shown to you with that message/);
  for (const gone of ['check.sh', 'node scripts', 'CLAUDE.md', 'commit'])
    assert.ok(!text.replace('or ./scripts/check.sh, to search the web', '').includes(gone), `nothing of the command line is left in it: ${gone}`);
});

test('the chat says who answers and which tiers there are, with nothing left to find out', async () => {
  const { chat } = setup([]);
  const a = await chat.agent();
  assert.deepEqual(Object.keys(a).sort(), ['guides', 'hint', 'models', 'models_ready', 'name']);
  assert.equal(a.name, 'Assistant');
  assert.equal(a.hint, 'Describe the task.');
  assert.equal(a.models_ready, true);
  assert.deepEqual(a.models.map(m => m.id), ['', 'quick', 'complex']);
  assert.equal(a.guides[0].file, 'guides/planning.md');
});

// ---- a turn ----
test('a turn reads, writes a step, runs it and finishes; the conversation is stored as chat.py would store it', async () => {
  const NEW = STEP.replace("'Pick'", "'Place'");
  const { fs, chat, sample, runs } = setup([async ({ say, tool }) => {
    say('I will read the step first.');
    assert.match(await tool('read_file', { path: 'steps/pick.ts' }), /^1\timport type/);
    assert.match(await tool('write_file', { path: 'applications/demo/steps/place.ts', content: NEW }), /^saved applications\/demo\/steps\/place\.ts \(\d+ bytes\) — a new file$/);
    assert.match(await tool('run_steps', { steps: ['place'] }), /^DONE: pick \(1\.5 s\)/);
    say(`The step runs. Żółw.\n${DONE}`);
  }]);
  const events = await ask(chat, 'write a place step');
  const expected = [
    { type: 'user', text: 'write a place step', files: [] },
    { type: 'tool', text: 'reads applications/demo/steps/pick.ts' },
    { type: 'tool', text: 'writes applications/demo/steps/place.ts' },
    { type: 'tool', text: 'runs place' },
    { type: 'text', text: 'I will read the step first.\n\nThe step runs. Żółw.' },
    { type: 'done' },
  ];
  assert.deepEqual(events, expected, 'tool lines as they happen, the pass\'s text once, without the DONE line');
  assert.equal(await fs.readText('applications/demo/steps/place.ts'), NEW);
  assert.equal(fs.origin('applications/demo/steps/place.ts'), 'yours');
  assert.deepEqual(runs.jobs, [{ app: 'demo', steps: ['place'], loop: false, keep: false, reset: true, shot: false, fast: true, timeout: 300 }]);
  // the file, byte for byte what viewer/chat.py writes: json.dump(obj, ensure_ascii=False, indent=1)
  const python = execFileSync('python3', ['-c', 'import json,sys; sys.stdout.buffer.write(json.dumps({"events": json.load(sys.stdin)}, ensure_ascii=False, indent=1).encode())'],
    { input: JSON.stringify(expected) }).toString('utf8');
  assert.equal(await stored(fs), python);
  // what Claude was sent
  assert.equal(sample.calls.length, 1, 'finished in one call: not asked again');
  const { input, options } = sample.calls[0];
  assert.deepEqual(input.map(m => m.role), ['user', 'user']);
  assert.ok(input[0].content.startsWith('You are the assistant inside Microfactory'), 'the standing instructions lead');
  assert.equal(input[1].content, `[viewer: ${CONTEXT}]\nwrite a place step`);
  assert.equal(options.cache, false);
  assert.equal('modelTier' in options, false, 'the default tier is not named');
  assert.deepEqual(options.tools.map(t => t.name), ['read_file', 'list_files', 'write_file', 'edit_file', 'run_steps', 'undo']);
  assert.equal(chat.running(), false);
});

test('the model picker\'s choice becomes the tier, and measure is a tool only when the page can measure', async () => {
  const measured = [];
  const { chat, sample } = setup([async ({ say, tool }) => {
    say(await tool('measure', { ids: ['holder', 7] }) + `\n${DONE}`);
  }], { measure: async ids => { measured.push(ids); return 'holder: at x 100.0 y 200.0 z 0.0'; } });
  const events = await ask(chat, 'where is the holder', { model: 'complex' });
  assert.equal(sample.calls[0].options.modelTier, 'complex');
  assert.ok(sample.calls[0].options.tools.some(t => t.name === 'measure'));
  assert.ok(sample.calls[0].input[0].content.includes('run_steps, measure, undo'));
  assert.deepEqual(measured, [['holder', '7']]);
  assert.deepEqual(events.slice(1), [{ type: 'tool', text: 'measures holder, 7' }, { type: 'text', text: 'holder: at x 100.0 y 200.0 z 0.0' }, { type: 'done' }]);
  await ask(chat, 'again', { model: 'opus' });
  assert.equal('modelTier' in sample.calls[1].options, false, 'an id that is not a tier is the default');
});

// ---- what may be read and written ----
test('the path rule: the open application, guides, recipes, the step API and the robot are read; only the open application\'s text files are written', () => {
  const read = p => pathRule('demo', p, 'read'), write = p => pathRule('demo', p, 'write');
  for (const [given, full] of [
    ['applications/demo/layout.json', 'applications/demo/layout.json'], ['steps/pick.ts', 'applications/demo/steps/pick.ts'],
    ['/applications/demo/notes/', 'applications/demo/notes'], ['guides/steps.md', 'guides/steps.md'], ['recipes', 'recipes'],
    ['viewer/cell.d.ts', 'viewer/cell.d.ts'], ['cell_fr3/robot.json', 'cell_fr3/robot.json'], ['materials/photo.png', 'applications/demo/materials/photo.png'],
  ]) assert.deepEqual(read(given), { ok: true, path: full }, given);
  for (const bad of ['applications/other/notes/plan.md', 'applications', 'viewer/app.js', '../x', 'steps/../../other/x.md', 'a//b', 'steps\\pick.ts',
    'steps/pick.ts?x', 'ma%74erials/x.md', 'notes/a#b.md', '', '   ', '/', undefined, 7])
    assert.equal(read(bad).ok, false, `read ${bad}`);
  assert.match(read('applications/other/notes/plan.md').why, /another application.*ask the user to open "other"/);
  for (const [given, full] of [['steps/new.ts', 'applications/demo/steps/new.ts'], ['applications/demo/notes/plan.md', 'applications/demo/notes/plan.md'],
    ['layout.json', 'applications/demo/layout.json'], ['print/part.model.mjs', 'applications/demo/print/part.model.mjs'], ['notes/list.txt', 'applications/demo/notes/list.txt']])
    assert.deepEqual(write(given), { ok: true, path: full }, given);
  for (const bad of ['guides/steps.md', 'recipes/new.md', 'viewer/cell.d.ts', 'cell_fr3/robot.json', 'applications/other/notes/plan.md', 'applications/demo',
    'chats/assistant.json', 'runs/last-failure.json', 'materials/note.md', 'items/holder/holder.glb', 'items/holder/holder.collision.stl', 'print/part.step',
    'notes/shot.png', 'steps/pick.js', 'steps/../../other/application.json', 'ma%74erials/x.md', 'applications/demo/chats%2Fassistant.json', 'notes/x.md?y.md'])
    assert.equal(write(bad).ok, false, `write ${bad}`);
  assert.match(write('guides/steps.md').why, /only text files of the open application/);
  assert.match(write('chats/assistant.json').why, /kept by the page/);
  assert.match(write('items/holder/holder.glb').why, /only text files can/);
});

test('a tool refuses a path with words to act on, and nothing outside the open application is ever written', async () => {
  const out = {};
  const { fs, chat } = setup([async ({ say, tool }) => {
    out.other = await tool('read_file', { path: 'applications/other/notes/plan.md' });
    out.engine = await tool('read_file', { path: 'viewer/app.js' });
    out.mesh = await tool('read_file', { path: 'items/holder/holder.glb' });
    out.missing = await tool('read_file', { path: 'steps/nope.ts' });
    out.folder = await tool('read_file', { path: 'steps' });
    for (const path of ['guides/steps.md', 'applications/other/application.json', 'cell_fr3/robot.json', 'viewer/cell.d.ts', 'recipes/mine.md',
      '../other/notes/x.md', 'chats/assistant.json', 'materials/x.md', 'items/holder/holder.glb', 'applications/demo/../other/notes/y.md'])
      out[path] = [await tool('write_file', { path, content: '{}' }), await tool('edit_file', { path, old_text: 'a', new_text: 'b' }), await tool('undo', { path })];
    out.noContent = await tool('write_file', { path: 'notes/a.md' });
    out.nothing = await tool('nothing', {});
    say('done');
  }]);
  await fs.ready;
  const before = fs.list('');
  const events = await ask(chat, 'try everything');
  assert.match(out.other, /^Error: .*another application/);
  assert.match(out.engine, /^Error: .*only viewer\/cell\.d\.ts/);
  assert.match(out.mesh, /not a text file \(300 bytes\)/);
  assert.match(out.missing, /^Error: there is no file applications\/demo\/steps\/nope\.ts/);
  assert.match(out.folder, /^Error: .*is a folder: use list_files/);
  for (const [path, results] of Object.entries(out)) if (Array.isArray(results))
    for (const r of results) assert.match(r, /^Error: /, `${path}: ${r}`);
  assert.match(out.noContent, /^Error: "content" must be the text/);
  // the files are exactly as they were, but for the conversation itself
  assert.deepEqual(fs.list('').filter(p => p !== 'applications/demo/chats/assistant.json'), before);
  for (const p of before) assert.equal(fs.origin(p), 'base', p);
  assert.deepEqual(events.filter(e => e.type === 'tool').map(e => e.text),
    ['reads applications/demo/items/holder/holder.glb'], 'a refused call leaves no "writes …" line');
});

test('a file is checked before it is saved: JSON parses, a step exports what the viewer needs, the loop names steps that exist', async () => {
  const out = {};
  const { fs, chat } = setup([async ({ say, tool }) => {
    out.json = await tool('write_file', { path: 'layout.json', content: '{\n "fixtures": [\n}' });
    out.step = await tool('write_file', { path: 'steps/bad.ts', content: "export const name = 'x';\nexport default async function () {}\n" });
    out.relative = await tool('write_file', { path: 'steps/rel.ts', content: STEP.replace("'microfactory'", "'../../../viewer/cell.js'") });
    out.loop = await tool('edit_file', { path: 'application.json', old_text: '"pick"', new_text: '"pick", "ghost"' });
    out.loopShape = await tool('write_file', { path: 'application.json', content: '{"loop": "pick"}' });
    out.goodStep = await tool('write_file', { path: 'steps/ghost.ts', content: STEP });
    out.goodLoop = await tool('edit_file', { path: 'application.json', old_text: '"pick"', new_text: '"pick", "ghost"' });
    out.layout = await tool('edit_file', { path: 'layout.json', old_text: '0.1,', new_text: '0.15,' });
    out.notFound = await tool('edit_file', { path: 'layout.json', old_text: 'nowhere', new_text: 'x' });
    out.twice = await tool('edit_file', { path: 'layout.json', old_text: '0', new_text: '1' });
    out.all = await tool('edit_file', { path: 'notes/n.md', old_text: 'a', new_text: 'b' });
    say('checked');
  }]);
  await ask(chat, 'break things');
  assert.match(out.json, /^Error: applications\/demo\/layout\.json was NOT saved: it is not valid JSON/);
  assert.match(out.step, /^Error: .*was NOT saved: a step must export name, tool, entry and a default async function; missing: tool, entry$/);
  assert.match(out.relative, /^Error: .*never by a relative path/);
  assert.match(out.loop, /^Error: .*the loop names "ghost", and there is no such step file — steps\/ has: pick\. Write the step first\./);
  assert.match(out.loopShape, /^Error: .*"loop" must be/);
  assert.match(out.goodStep, /^saved /);
  assert.match(out.goodLoop, /^saved applications\/demo\/application\.json .*\nThe 3D scene shows this only after the page reloads/s);
  assert.match(out.layout, /only after the page reloads/);
  assert.match(out.notFound, /^Error: old_text was not found/);
  assert.match(out.twice, /^Error: old_text occurs \d+ times/);
  assert.match(out.all, /^Error: there is no file .*create it with write_file/);
  assert.equal(JSON.parse(await fs.readText('applications/demo/layout.json')).fixtures[0].pose.xyz_m[0], 0.15);
  assert.deepEqual(JSON.parse(await fs.readText('applications/demo/application.json')).loop.steps, ['pick', 'ghost']);
  assert.equal(fs.exists('applications/demo/steps/bad.ts'), false, 'a refused file is not there');
});

test('undo puts a file back change by change, removes one it created, and a shipped file ends as shipped', async () => {
  const out = [];
  const { fs, chat } = setup([
    async ({ say, tool }) => {
      await tool('edit_file', { path: 'layout.json', old_text: '0.1,', new_text: '0.3,' });
      await tool('edit_file', { path: 'layout.json', old_text: '0.3,', new_text: '0.4,' });
      await tool('write_file', { path: 'notes/plan.md', content: 'first\n' });
      say(`changed ${DONE}`);
    },
    async ({ say, tool }) => {
      out.push(await tool('undo', { path: 'layout.json' }));
      out.push(await fs.readText('applications/demo/layout.json'));
      out.push(await tool('undo', { path: 'applications/demo/layout.json' }));
      out.push(await tool('undo', { path: 'layout.json' }));
      out.push(await tool('undo', { path: 'notes/plan.md' }));
      say(`undone ${DONE}`);
    },
  ]);
  await ask(chat, 'change');
  assert.equal(fs.origin('applications/demo/layout.json'), 'changed');
  const events = await ask(chat, 'undo it all');             // the previous versions outlive the message
  assert.match(out[0], /^restored applications\/demo\/layout\.json/);
  assert.ok(out[1].includes('0.3,'), 'one change back');
  assert.match(out[2], /^restored/);
  assert.match(out[3], /^Error: nothing to undo for applications\/demo\/layout\.json/);
  assert.match(out[4], /it did not exist before, so it was removed/);
  assert.equal(await fs.readText('applications/demo/layout.json'), LAYOUT);
  assert.equal(fs.origin('applications/demo/layout.json'), 'base', 'back to the pack: no change of the user\'s is left');
  assert.equal(fs.exists('applications/demo/notes/plan.md'), false);
  assert.deepEqual(events.filter(e => e.type === 'tool').slice(-3).map(e => e.text),
    ['undoes applications/demo/layout.json', 'undoes applications/demo/layout.json', 'undoes applications/demo/notes/plan.md']);
});

test('a result is never more than 30 000 bytes: a long file comes in pieces that say how to get the next', async () => {
  const fs = makeFs();
  await fs.ready;
  const lines = [];
  const tools = Object.fromEntries(buildTools({ fs, app: 'demo', emit: t => lines.push(t) }).map(t => [t.name, t]));
  let offset = 1, text = '', calls = 0;
  for (;;) {
    const part = await tools.read_file.execute({ path: 'notes/big.md', offset }, {});
    calls++;
    assert.ok(bytes(part) <= MAX_RESULT, `${bytes(part)} bytes`);
    const m = /\[lines (\d+)-(\d+) of 4000(?: — call read_file with "offset": (\d+) for the rest)?\]$/.exec(part);
    assert.ok(m, part.slice(-120));
    assert.equal(Number(m[1]), offset);
    text += part.slice(0, part.lastIndexOf('[lines')).replace(/^\d+\t/gm, '');
    if (!m[3]) break;
    offset = Number(m[3]);
  }
  assert.equal(text, BIG, 'the pieces are the file');
  assert.ok(calls > 3);
  assert.match(await tools.read_file.execute({ path: 'notes/big.md', offset: 10, limit: 2 }, {}), /^10\tline 10: .*\n11\tline 11: .*\n\[lines 10-11 of 4000 — call read_file with "offset": 12 for the rest\]$/);
  assert.equal(await tools.read_file.execute({ path: 'cell_fr3/robot.json' }, {}), '1\t{"arm": "fr3"}\n', 'a short file comes whole, with nothing added');
  // one endless line (a JSON file written without line breaks)
  await fs.write('applications/demo/notes/flat.json', JSON.stringify({ a: 'x'.repeat(90000) }));
  const flat = await tools.read_file.execute({ path: 'notes/flat.json' }, {});
  assert.ok(bytes(flat) <= MAX_RESULT);
  assert.match(flat, /\[line 1 is \d+ bytes long: only its start is shown\]/);
  // a search with a great many matches, and any other long text
  const found = await tools.list_files.execute({ path: 'notes', pattern: 'line' }, {});
  assert.ok(bytes(found) <= MAX_RESULT);
  assert.match(found, /the first 100 matches/);
  const cut = capText('a\n'.repeat(40000), 'ask for less');
  assert.ok(bytes(cut) <= MAX_RESULT);
  assert.match(cut, /\[cut here: the whole result is 80000 bytes — ask for less\]$/);
  assert.ok(bytes(capText('ż'.repeat(40000))) <= MAX_RESULT, 'counted in bytes, cut between characters');
  assert.deepEqual(lines.slice(-1), ['searches line']);
});

test('list_files shows what an application has and finds text in it', async () => {
  const fs = makeFs();
  await fs.ready;
  await fs.write('applications/demo/notes/plan.md', 'use the cup\n');
  const said = [];
  const list = buildTools({ fs, app: 'demo', emit: t => said.push(t) }).find(t => t.name === 'list_files');
  const all = await list.execute({}, {});
  assert.ok(all.includes('applications/demo/steps/pick.ts  ' + bytes(STEP) + '  base'));
  assert.ok(all.includes('applications/demo/notes/plan.md  12  yours'));
  assert.ok(all.includes('applications/demo/items/holder/holder.glb  300  base  (not text)'));
  assert.ok(!all.includes('applications/other'), 'another application is not listed');
  assert.equal(await list.execute({ path: 'steps', glob: '*.ts' }, {}), `applications/demo/steps/pick.ts  ${bytes(STEP)}  base`);
  assert.equal(await list.execute({ path: 'guides', pattern: 'order: 3' }, {}), 'guides/steps.md:2: order: 3');
  assert.equal(await list.execute({ pattern: '/CUP$/i', glob: '*.md' }, {}), 'applications/demo/notes/plan.md:1: use the cup');
  assert.match(await list.execute({ pattern: 'no such text anywhere' }, {}), /^nothing matches/);
  await assert.rejects(() => list.execute({ path: 'applications/other' }, {}), /another application/);
  await assert.rejects(() => list.execute({ path: 'nope' }, {}), /there is no folder applications\/demo\/nope in this application — it has: items, notes, steps/);
  await assert.rejects(() => list.execute({ pattern: '/(/' }, {}), /not a regular expression/);
  assert.deepEqual(said.slice(0, 3), ['lists applications/demo', 'lists applications/demo/steps (*.ts)', 'searches order: 3']);
});

test('every tool is described within what the platform takes', () => {
  const tools = buildTools({ fs: makeFs(), app: 'demo', measure: async () => '' });
  assert.deepEqual(tools.map(t => t.name), ['read_file', 'list_files', 'write_file', 'edit_file', 'run_steps', 'measure', 'undo']);
  for (const t of tools) {
    assert.ok(bytes(t.description) <= 1024, `${t.name}: description of ${bytes(t.description)} bytes`);
    assert.ok(bytes(JSON.stringify(t.inputSchema)) <= 4096, t.name);
    assert.equal(t.inputSchema.type, 'object');
  }
});

// ---- runs ----
test('a run comes back as scripts/run-step.mjs prints it', () => {
  const res = {
    ok: false, step: 'pick', error: 'moveTip rejected: link5 would hit holder — add "holder" to ignore', ran: ['pick', 'place'], seconds: 3.2,
    log: ['▶ pick', '✗ moveTip rejected'], parts_moved: [{ id: 'case_1', moved_mm: 12.5, from_m: [0.1, 0.2, 0.03], to_m: [0.1125, 0.2, 0.03] }],
    held: 'case_1', io: { vacuum: true }, tool: 'cup', joints_deg: [1, 2, 3, 4, 5, 6.25], stale: false,
  };
  assert.equal(runText(res), [
    'FAILED at pick: moveTip rejected: link5 would hit holder — add "holder" to ignore   (running: pick, place)',
    '', 'log:', '  ▶ pick', '  ✗ moveTip rejected', '',
    'tool on the arm: cup; holding: case_1; io: {"vacuum":true}',
    'joints (deg): [1,2,3,4,5,6.25]', '',
    'parts no longer where the layout put them (table frame, mm):',
    '  case_1: moved 12.5 mm, now at x 112.5 y 200.0 z 30.0 (was x 100.0 y 200.0 z 30.0)',
  ].join('\n'));
  assert.equal(runText({ ok: true, ran: ['pick'], seconds: 1.5, log: [], parts_moved: [], held: null, io: {}, tool: 'cup', joints_deg: [0] }),
    'DONE: pick (1.5 s)\n\ntool on the arm: cup; holding: nothing; io: {}\njoints (deg): [0]\n\nno part moved');
  assert.equal(runText({ ok: false, error: 'no such step: nope — this application has: pick' }), 'NOT RUN: no such step: nope — this application has: pick');
  assert.match(runText({ ...res, stale: true }), /^NOTE: files changed since the viewer loaded this application.*OLD ones/s);
  assert.match(runText({ ...res, when: '2026-11-27T10:00:00.000Z' }), /^recorded 2026-11-27T10:00:00\.000Z — the last run that failed in the viewer\n\nFAILED at pick/);
  const long = runText({ ...res, log: Array.from({ length: 200 }, (_, i) => `line ${i} ${'x'.repeat(300)}`) });
  assert.ok(bytes(long) <= MAX_RESULT);
  assert.match(long, /log \(the last 60 of 200 lines\):/);
  assert.match(long, /line 199 /, 'the end of the log is what is kept');
});

test('a run that outlasts a tool call answers "still running", and wait picks its result up', async () => {
  let finish;
  const runs = fakeRuns(() => new Promise(res => { finish = res; }));
  const fs = makeFs();
  const said = [];
  const run = buildTools({ fs, app: 'demo', runs, emit: t => said.push(t), runWait: 30 }).find(t => t.name === 'run_steps');
  await assert.rejects(() => run.execute({ wait: true }, {}), /no run is going/);
  await assert.rejects(() => run.execute({}, {}), /give either "steps".*or "loop": true/);
  await assert.rejects(() => run.execute({ steps: ['pick'], loop: true }, {}), /give either/);
  assert.equal(await run.execute({ loop: true, keep: true }, {}), 'still running (the loop) — call run_steps with { "wait": true } to get the result');
  assert.deepEqual(runs.jobs, [{ app: 'demo', steps: [], loop: true, keep: true, reset: false, shot: false, fast: true, timeout: 300 }]);
  await assert.rejects(() => run.execute({ steps: ['pick'] }, {}), /still going: call run_steps with \{ "wait": true \}/);
  assert.match(await run.execute({ wait: true }, {}), /^still running \(the loop\)/);
  // the tools of a later turn find the same run: it belongs to the run queue, not to the call
  const later = buildTools({ fs, app: 'demo', runs: () => runs, emit: t => said.push(t), runWait: 5000 }).find(t => t.name === 'run_steps');
  const waiting = later.execute({ wait: true }, {});
  finish({ ok: true, ran: ['pick'], seconds: 200, log: [], parts_moved: [], held: null, io: {}, tool: 'cup', joints_deg: [0] });
  assert.match(await waiting, /^DONE: pick \(200 s\)/);
  await assert.rejects(() => later.execute({ wait: true }, {}), /no run is going/, 'a result is handed over once');
  assert.deepEqual(said, ['runs the loop', 'waits for the run of the loop', 'waits for the run of the loop']);
  // a refusal, a queue that throws, the record of the last failure, and no queue yet
  const refuse = buildTools({ fs, app: 'demo', runs: fakeRuns({ ok: false, error: 'another run was asked for and has not finished' }) }).find(t => t.name === 'run_steps');
  assert.equal(await refuse.execute({ steps: 'steps/pick.ts' }, {}), 'NOT RUN: another run was asked for and has not finished');
  const broken = buildTools({ fs, app: 'demo', runs: { request: async () => { throw new Error('queue closed'); }, last: () => null } }).find(t => t.name === 'run_steps');
  assert.equal(await broken.execute({ loop: true }, {}), 'NOT RUN: the run could not be made: queue closed');
  assert.equal(await broken.execute({ last_failure: true }, {}), "no failed run is recorded for 'demo' (a record is kept when a run fails in the viewer)");
  runs.record = { ok: false, step: 'pick', error: 'found nothing to land on', ran: ['pick'], when: '2026-11-27T10:00:00.000Z', log: [], parts_moved: [], held: null, io: {}, tool: 'cup', joints_deg: [0] };
  assert.match(await run.execute({ last_failure: true }, {}), /^recorded 2026-11-27T10:00:00\.000Z — the last run that failed in the viewer\n\nFAILED at pick: found nothing to land on/);
  const early = buildTools({ fs, app: 'demo', runs: () => undefined }).find(t => t.name === 'run_steps');
  await assert.rejects(() => early.execute({ loop: true }, {}), /not ready to take a run yet/);
});

// ---- several passes ----
test('a turn asks again while the last pass used a tool and did not say DONE, carrying what it did', async () => {
  const { chat, sample } = setup([
    async ({ say, tool }) => { say('Reading.'); await tool('read_file', { path: 'layout.json' }); say('Now the step.'); },
    async ({ say, tool }) => { await tool('write_file', { path: 'notes/plan.md', content: 'x'.repeat(500) }); say('Written.'); },
    async ({ say }) => { say(`All finished.\n\n${DONE}`); },
    async ({ say }) => { say('never asked'); },
  ]);
  const events = await ask(chat, 'do the work');
  assert.equal(sample.calls.length, 3);
  assert.deepEqual(events.slice(1), [
    { type: 'tool', text: 'reads applications/demo/layout.json' },
    { type: 'text', text: 'Reading.\n\nNow the step.' },
    { type: 'tool', text: 'writes applications/demo/notes/plan.md' },
    { type: 'text', text: 'Written.' },
    { type: 'text', text: 'All finished.' },
    { type: 'done' },
  ], 'one text per pass');
  const second = sample.calls[1].input, third = sample.calls[2].input;
  assert.deepEqual(second.map(m => m.role), ['user', 'user', 'user']);
  assert.equal(second[0].content, sample.calls[0].input[0].content, 'the instructions lead every pass');
  assert.equal(second[1].content, sample.calls[0].input[1].content, 'then the message, unchanged');
  assert.match(second[2].content, /^\[Continuing the SAME request/);
  assert.ok(second[2].content.includes('1. read_file {"path":"layout.json"}\n1\t{\n2\t "fixtures": ['), 'its own call, and what came back');
  assert.ok(second[2].content.includes('What you have written to the user so far:\n\nReading.\n\nNow the step.'));
  assert.ok(third[2].content.includes('2. write_file {"path":"notes/plan.md","content":"' + 'x'.repeat(120) + '… (500 characters)"}\nsaved applications/demo/notes/plan.md (500 bytes) — a new file'),
    'a long input is shortened in the record');
  assert.ok(third[2].content.includes('Reading.\n\nNow the step.\n\nWritten.'));
});

test('a turn stops asking: after an answer without tools, after a questions block, and at the limit of passes', async () => {
  // no tool, no DONE: it has simply answered
  let s = setup([async ({ say }) => say('Just an answer.'), async ({ say }) => say('never')]);
  assert.deepEqual((await ask(s.chat, 'hi')).slice(1), [{ type: 'text', text: 'Just an answer.' }, { type: 'done' }]);
  assert.equal(s.sample.calls.length, 1);
  // it asked the user: the buttons are the end of the answer, even after tools and without DONE
  const block = 'Which one?\n\n```questions\n[{"question": "Which?", "options": [{"label": "A"}, {"label": "B"}]}]\n```';
  s = setup([async ({ say, tool }) => { await tool('read_file', { path: 'layout.json' }); say(block + `\n${DONE}`); }, async ({ say }) => say('never')]);
  const asked = await ask(s.chat, 'choose');
  assert.equal(s.sample.calls.length, 1);
  assert.equal(asked.at(-2).text, block, 'the block reaches the page as written, last in the message');
  s = setup([async ({ say, tool }) => { await tool('read_file', { path: 'layout.json' }); say(block); }, async ({ say }) => say('never')]);
  await ask(s.chat, 'choose');
  assert.equal(s.sample.calls.length, 1);
  // it never says DONE and never stops using tools: the page stops it, and says how to go on
  const busy = async ({ say, tool }) => { await tool('list_files', {}); say('Still working.'); };
  s = setup([busy, busy, busy, busy, busy], { maxPasses: 3 });
  const events = await ask(s.chat, 'work forever');
  assert.equal(s.sample.calls.length, 3);
  assert.deepEqual(events.slice(-2), [{ type: 'error', text: 'paused: this took more rounds than one message allows — send "continue" and the assistant carries on from here' }, { type: 'done' }]);
});

test('the record of earlier passes shrinks to fit one request, and the instructions and the message are never dropped', async () => {
  const big = async ({ say, tool }) => { for (let i = 0; i < 6; i++) await tool('read_file', { path: 'notes/big.md', offset: 1 + i }); say('More.'); };
  const { chat, sample } = setup([big, big, big, async ({ say }) => say(DONE + ' Done.')], { limits: { maxPromptBytes: 100000, tools: { maxCount: 16 } } });
  const events = await ask(chat, 'read a lot');
  assert.equal(events.at(-2).text, 'Done.');
  for (const { input } of sample.calls) {
    assert.ok(input.reduce((n, m) => n + bytes(m.content), 0) <= 100000);
    assert.ok(input[0].content.startsWith('You are the assistant'));
    assert.ok(input[1].content.endsWith('read a lot'));
  }
  const last = sample.calls[3].input[2].content;
  assert.match(last, /18\. read_file \{"path":"notes\/big\.md","offset":6\}\n6\tline 6:/, 'the newest result is there');
  assert.match(last, /1\. read_file .*\n1\tline 1:.*\n[\s\S]*?\[… cut: \d+ characters in all — call the tool again if you need the rest\]/, 'older ones are stubs');
});

// ---- stopping, and failing ----
test('Stop ends the turn at once with "stopped", and the tool that was running is told', async () => {
  let toolStopped = false, started;
  const begun = new Promise(res => { started = res; });
  const runs = fakeRuns(() => new Promise(() => {}));            // a run that never ends
  const { chat, sample } = setup([async ({ say, tool }) => {
    say('Running it.');
    started();
    const out = await tool('run_steps', { loop: true });
    toolStopped = /^still running/.test(out);
    say('never said');
  }], { runs, runWait: 60000 });
  assert.deepEqual(await chat.send({ app: 'demo', text: 'run the loop', context: CONTEXT }), { ok: true });
  await begun;
  await new Promise(res => setTimeout(res, 10));
  assert.equal(chat.running(), true);
  assert.equal((await chat.events('demo', -1, 0)).running, true);
  assert.deepEqual(await chat.send({ app: 'demo', text: 'and another' }), { error: 'the agent is still working', status: 409 });
  assert.deepEqual(chat.stop('demo'), { ok: true });
  await chat.whenIdle();
  const r = await chat.events('demo', -1, 0);
  assert.equal(r.running, false);
  assert.deepEqual(r.events, [
    { type: 'user', text: 'run the loop', files: [] },
    { type: 'tool', text: 'runs the loop' },
    { type: 'text', text: 'Running it.' },
    { type: 'error', text: 'stopped' },
    { type: 'done' },
  ], 'what it had said stays; then stopped, then done — as the installed app ends a stopped turn');
  await new Promise(res => setTimeout(res, 10));
  assert.equal(toolStopped, true, 'the waiting tool saw its signal and let go');
  assert.equal(sample.calls.length, 1);
  assert.deepEqual(chat.stop('demo'), { ok: true }, 'stopping nothing is fine');
  assert.deepEqual(chat.stop('nope'), { ok: true });
});

test('each way a request can fail is said in plain words, once, and the page never asks again by itself', async () => {
  const cases = [
    [{ code: 'not_granted', message: 'x' }, /was not allowed to use Claude in this view/],
    [{ code: 'sampling_disabled', message: 'x' }, /Claude cannot be used from here by this account or organization/],
    [{ code: 'not_declared', message: 'x' }, /^the assistant is not available in this view$/],
    [{ code: 'capability_disabled', message: 'x' }, /^the assistant is not available in this view$/],
    [{ code: 'capability_removed', message: 'x' }, /^the assistant is not available in this view$/],
    [{ code: 'tools_unavailable', message: 'x' }, /cannot work in this view: it needs to read and change the application's files and run steps/],
    [{ code: 'images_unavailable', message: 'x' }, /pictures cannot be shown to the assistant/],
    [{ code: 'image_rejected', message: 'x' }, /a picture could not be shown/],
    [{ code: 'rate_limited', message: 'x', reason: 'usage_limit' }, /you have reached your Claude usage limit/],
    [{ code: 'rate_limited', message: 'x' }, /too many requests right now — wait a little/],
    [{ code: 'session_expired', message: 'x' }, /signed out of Claude — sign in again/],
    [{ code: 'refused', message: 'x' }, /Claude declined to answer this — change what you ask/],
    [{ code: 'empty_completion', message: 'x' }, /Claude gave no answer/],
    [{ code: 'prompt_too_large', message: 'x' }, /too much for one request/],
    [{ code: 'invalid_request', message: 'tool 3: bad schema' }, /^the chat could not make the request \(invalid_request\): tool 3: bad schema$/],
    [{ code: 'upstream_error', message: 'x' }, /^interrupted: the connection to Claude failed/],
    [{ code: 'something_new', message: 'x' }, /^interrupted: the connection to Claude failed/],
  ];
  for (const [error, words] of cases) {
    const { chat, sample } = setup([async () => { throw error; }, async ({ say }) => say('never')]);
    const events = await ask(chat, 'hello');
    assert.equal(events.length, 3, error.code);
    assert.equal(events[1].type, 'error');
    assert.match(events[1].text, words, error.code);
    assert.equal(events[1].text, errorWords(error));
    assert.deepEqual(events[2], { type: 'done' });
    assert.equal(sample.calls.length, 1, `${error.code}: not retried`);
    assert.ok(!/\bx\b|undefined|\[object/.test(events[1].text));
  }
});

test('what was written before a failure stays, except when Claude withdraws it; a failure in a later pass ends the turn there', async () => {
  let s = setup([async ({ say, tool }) => { say('Half an answer'); await tool('list_files', {}); throw { code: 'upstream_error', message: 'x', text: 'Half an answer' }; }]);
  assert.deepEqual((await ask(s.chat, 'go')).slice(1), [
    { type: 'tool', text: 'lists applications/demo' }, { type: 'text', text: 'Half an answer' },
    { type: 'error', text: errorWords({ code: 'upstream_error' }) }, { type: 'done' }]);
  s = setup([async ({ say }) => { say('Something it takes back'); await new Promise(r => setTimeout(r, 5)); throw { code: 'refused', message: 'x' }; }]);
  assert.deepEqual((await ask(s.chat, 'go')).slice(1), [{ type: 'error', text: errorWords({ code: 'refused' }) }, { type: 'done' }]);
  s = setup([
    async ({ say, tool }) => { await tool('list_files', {}); say('First pass.'); },
    async () => { throw { code: 'rate_limited', message: 'x', reason: 'usage_limit' }; },
    async ({ say }) => say('never'),
  ]);
  const events = await ask(s.chat, 'go');
  assert.deepEqual(events.slice(2), [{ type: 'text', text: 'First pass.' }, { type: 'error', text: errorWords({ code: 'rate_limited', reason: 'usage_limit' }) }, { type: 'done' }]);
  assert.equal(s.sample.calls.length, 2);
  // a bug of the page's own is still an ended turn, never a chat stuck "working"
  s = setup([], { brief: () => { throw new Error('no brief'); } });
  assert.deepEqual((await ask(s.chat, 'go')).slice(1), [{ type: 'error', text: 'chat failed: no brief' }, { type: 'done' }]);
  assert.equal(s.chat.running(), false);
});

test('where there is no assistant, or it cannot use the page\'s tools, the turn says so and asks nothing', async () => {
  let s = setup([], { sample: null });
  assert.deepEqual(await ask(s.chat, 'hello'), [
    { type: 'user', text: 'hello', files: [] },
    { type: 'error', text: 'the assistant is not available in this view: it answers only to people signed in to Claude who have been given this page. To have a copy of your own where it answers, give Claude Code one line: install https://github.com/SimpleAutomationOrg/nano-cell' },
    { type: 'done' }]);
  s = setup([], { getSample: async () => { throw new Error('no runtime'); } });
  assert.match((await ask(s.chat, 'hello'))[1].text, /^the assistant is not available in this view/);
  s = setup([async ({ say }) => say('never')], { limits: { maxPromptBytes: 262144 } });
  assert.match((await ask(s.chat, 'hello'))[1].text, /^the assistant cannot work in this view/);
  assert.equal(s.sample.calls.length, 0, 'nothing was spent on a request that could do nothing');
  // a view that takes fewer tools gets the ones needed most — and never a way to change a file without the way back
  s = setup([async ({ say }) => say('ok')], { limits: { maxPromptBytes: 262144, tools: { maxCount: 4 } } });
  await ask(s.chat, 'hello');
  assert.deepEqual(s.sample.calls[0].options.tools.map(t => t.name), ['read_file', 'write_file', 'edit_file', 'undo']);
  // …and is told of the tools it was sent, not of the ones there could be
  const told = /only through your tools: ([^.]*)\./.exec(s.sample.calls[0].input[0].content)[1];
  assert.equal(told, 'read_file, write_file, edit_file, undo');
  s = setup([async ({ say }) => say('ok')], { limits: { maxPromptBytes: 262144, tools: { maxCount: 5 } }, measure: async () => '' });
  await ask(s.chat, 'hello');
  assert.deepEqual(s.sample.calls[0].options.tools.map(t => t.name), ['read_file', 'write_file', 'edit_file', 'run_steps', 'undo']);
  // fewer than reading, writing and undoing need is no assistant: said, and nothing asked
  s = setup([async ({ say }) => say('never')], { limits: { maxPromptBytes: 262144, tools: { maxCount: 3 } } });
  assert.match((await ask(s.chat, 'hello'))[1].text, /^the assistant cannot work in this view/);
  assert.equal(s.sample.calls.length, 0);
});

// ---- the conversation: kept, repaired, handed over ----
test('a conversation found unfinished is closed as interrupted, and an old one is carried over', async () => {
  const half = [{ type: 'user', text: 'write it', files: [] }, { type: 'tool', text: 'reads applications/demo/layout.json' }, 'junk', { text: 'no type' }];
  let s = setup([async ({ say }) => say('Carrying on.')], { files: { 'applications/demo/chats/assistant.json': JSON.stringify({ events: half, agent: 'lead-engineer' }) } });
  const r = await s.chat.events('demo', -1, 0);
  assert.deepEqual(r, {
    epoch: 0, next: 4, running: false, available: true,
    events: [half[0], half[1], { type: 'error', text: 'interrupted: the page was reloaded while the assistant was working' }, { type: 'done' }],
  });
  await ask(s.chat, 'go on');
  assert.deepEqual(JSON.parse(await stored(s.fs)), { events: [...r.events, { type: 'user', text: 'go on', files: [] }, { type: 'text', text: 'Carrying on.' }, { type: 'done' }] });
  assert.ok(s.sample.calls[0].input[1].content.includes('  (the turn ended with an error: interrupted: the page was reloaded while the assistant was working)'));
  // finished ones are left as they are; a file that cannot be read starts empty
  const whole = [{ type: 'user', text: 'a', files: [] }, { type: 'text', text: 'b' }, { type: 'done' }];
  s = setup([], { files: { 'applications/demo/chats/assistant.json': JSON.stringify({ events: whole }) } });
  assert.deepEqual((await s.chat.events('demo', -1, 0)).events, whole);
  s = setup([], { files: { 'applications/demo/chats/assistant.json': '{"events": [' } });
  assert.deepEqual((await s.chat.events('demo', -1, 0)).events, []);
  // from when the chat had several agents: the main one's conversation takes the name, once
  s = setup([], { files: { 'applications/demo/chats/lead-engineer.json': JSON.stringify({ events: whole }) } });
  assert.deepEqual((await s.chat.events('demo', -1, 0)).events, whole);
  assert.equal(s.fs.exists('applications/demo/chats/lead-engineer.json'), false);
  assert.equal(s.fs.exists('applications/demo/chats/assistant.json'), true);
});

test('the page hears of nothing that is not saved yet: a reload the moment the turn is over finds it finished, not interrupted', async () => {
  // The page reloads itself as soon as it hears `running: false` when the assistant changed a file. With a store
  // that takes its time (IndexedDB), what it has at that instant must already be the whole conversation.
  const files = Object.entries(FILES).map(([path, text]) => ({ path, sha: sha(enc(text)), size: bytes(text), text }));
  const pack = { version: 't', files };
  const inner = createMemoryStore();
  const slow = { ...inner, set: async (k, v) => { await new Promise(res => setTimeout(res, 8)); return inner.set(k, v); } };
  const fs = createPageFs({ pack, loadBin: async () => GLB, store: slow });
  const sample = fakeSample([async ({ say, tool }) => { await tool('read_file', { path: 'layout.json' }); await tool('list_files', {}); await tool('write_file', { path: 'notes/a.md', content: 'a' }); say(`Done.\n${DONE}`); }]);
  const chat = createPageChat({ fs, getSample: async () => sample, hold: 40, runs: () => fakeRuns() });
  assert.deepEqual(await chat.send({ app: 'demo', text: 'go', context: CONTEXT, files: [], model: '' }), { ok: true });
  const heard = [];
  let at = null;
  for (let n = 0, next = 0, running = true; n < 500 && running; n++) {
    const r = await chat.events('demo', 0, next);
    heard.push(...r.events); next = r.next; running = r.running;
    // every answer, not only the last: the page may be reloaded by the user at any of them
    const kept = (await inner.get('applications/demo/chats/assistant.json'))?.bytes;
    assert.deepEqual(kept ? JSON.parse(new TextDecoder().decode(kept)).events.slice(0, heard.length) : [], heard, 'the page was told of an event that was not in the store');
    if (!running) { at = createMemoryStore(); for (const k of await inner.keys()) await at.set(k, await inner.get(k)); }
  }
  assert.deepEqual(heard.map(e => e.type), ['user', 'tool', 'tool', 'tool', 'text', 'done']);
  // the page after the reload: another file system and another chat over what the store held at that instant
  const again = createPageChat({ fs: createPageFs({ pack, loadBin: async () => GLB, store: at }), getSample: async () => sample, hold: 40, runs: () => fakeRuns() });
  assert.deepEqual(await again.events('demo', -1, 0), { epoch: 0, events: heard, next: heard.length, running: false, available: true });
});

test('the next message carries the conversation so far as a record, as chat.py hands it to an agent without a session', async () => {
  const { chat, sample } = setup([
    async ({ say, tool }) => { await tool('read_file', { path: 'layout.json' }); say(`The holder is at x 100.\n${DONE}`); },
    async ({ say }) => say('Yes.'),
  ]);
  await ask(chat, 'where is the holder?');
  await ask(chat, 'sure?', { context: '' });
  assert.equal(sample.calls[1].input[1].content,
    '[Background — your earlier conversation with the user about this application, as saved with it. You have no memory of it yourself, '
    + 'so read it and carry on from where it ends. Files you changed then are as you left them; check them rather than trusting this record.\n\n'
    + 'USER: where is the holder?\n  (you: reads applications/demo/layout.json)\nYOU: The holder is at x 100.'
    + '\n\nEnd of the earlier conversation. The user\'s new message follows.]\n\nsure?');
  assert.equal(history([]), '');
  const long = history(Array.from({ length: 3000 }, (_, i) => ({ type: 'text', text: `answer ${i}` })));
  assert.ok(long.length < 24600);
  assert.match(long, /record\. Only the latest part is shown\.\n\nYOU: answer \d+\n/);
  assert.match(history([{ type: 'user', text: 'see', files: ['applications/demo/materials/a.png'], from: 'lead engineer' }, { type: 'note', text: 'handed over' }, { type: 'done' }]),
    /THE LEAD ENGINEER \(handing you a task\): see\n {2}\[attached: applications\/demo\/materials\/a\.png\]\n {2}\(handed over\)\n\nEnd/);
});

test('attached files are listed with the message, and pictures go along where the view sends pictures', async () => {
  const PNG = Uint8Array.from([137, 80, 78, 71, 1, 2, 3]);
  const limits = { maxPromptBytes: 262144, tools: { maxCount: 16 }, images: { maxCount: 1, maxInputBytes: 1000, mediaTypes: ['image/png', 'image/jpeg'] } };
  const files = ['applications/demo/materials/photo.png', 'applications/demo/materials/second.png', 'applications/demo/materials/notes.txt',
    'applications/demo/materials/part.step', 'applications/demo/materials/missing.png', 'applications/demo/layout.json', '../x', 7];
  for (const withImages of [true, false]) {
    const s = setup([async ({ say }) => say('I see it.')], { limits: withImages ? limits : undefined });
    for (const p of files.slice(0, 2)) await s.fs.write(p, PNG);
    await s.fs.write(files[2], 'M3 screws');
    await s.fs.write(files[3], 'ISO-10303-21;');
    const events = await ask(s.chat, '', { files });
    assert.deepEqual(events[0], { type: 'user', text: '', files: files.slice(0, 4) }, 'only files the chat saved in materials/, and there');
    const { input, options } = s.sample.calls[0];
    assert.equal(input[1].content, `[viewer: ${CONTEXT}]\n\n\n[attached by the user, saved in the application's materials/ folder:\n`
      + `  applications/demo/materials/photo.png — ${withImages ? 'a picture, shown to you with this message' : 'a picture: you cannot see it here'}\n`
      + '  applications/demo/materials/second.png — a picture: you cannot see it here\n'
      + '  applications/demo/materials/notes.txt — read it with read_file\n'
      + '  applications/demo/materials/part.step — not a text file: it cannot be read here]');
    if (withImages) {
      assert.equal(options.images.length, 1, 'no more than the view takes');
      assert.ok(options.images[0] instanceof Blob);
      assert.equal(options.images[0].type, 'image/png');
      assert.deepEqual(new Uint8Array(await options.images[0].arrayBuffer()), PNG);
      assert.match(input[0].content, /shown to you with that message/);
    } else {
      assert.equal('images' in options, false);
      assert.match(input[0].content, /You cannot see pictures in this view/);
    }
  }
});

test('events are held while there is nothing new, cut at `since`, and start over when the conversation does', async () => {
  let release;
  const { fs, chat } = setup([async ({ say }) => { await new Promise(res => { release = res; }); say('Answer.'); }, async ({ say }) => say('Second.')]);
  assert.deepEqual(await chat.events('nope', -1, 0), { error: 'no such application', status: 404 });
  assert.deepEqual(await chat.events('../demo', -1, 0), { error: 'no such application', status: 404 });
  assert.deepEqual(await chat.send({ app: 'nope', text: 'hi' }), { error: 'no such application', status: 404 });
  assert.deepEqual(await chat.send({ app: 'demo', text: '  ', files: [] }), { error: 'empty message', status: 409 });
  assert.deepEqual(await chat.events('demo', -1, 0), { epoch: 0, events: [], next: 0, running: false, available: true }, 'the first call is answered at once');
  let t = Date.now();
  assert.deepEqual(await chat.events('demo', 0, 0), { epoch: 0, events: [], next: 0, running: false, available: true });
  assert.ok(Date.now() - t >= 30, 'nothing new: held, not answered at once (the page asks again without a pause)');
  // a poll that is waiting is answered as soon as something happens
  t = Date.now();
  const waiting = chat.events('demo', 0, 0);
  await chat.send({ app: 'demo', text: 'hello' });
  assert.deepEqual(await waiting, { epoch: 0, events: [{ type: 'user', text: 'hello', files: [] }], next: 1, running: true, available: true });
  while (!release) await new Promise(res => setTimeout(res, 2));
  release();
  await chat.whenIdle();
  assert.deepEqual(await chat.events('demo', 0, 1), { epoch: 0, events: [{ type: 'text', text: 'Answer.' }, { type: 'done' }], next: 3, running: false, available: true });
  assert.equal((await chat.events('demo', 5, 3)).events.length, 3, 'another epoch: from the start');
  assert.equal((await chat.events('demo', 'x', 'y')).events.length, 3);
  // "new chat": emptied, the file gone, the page told to start over
  assert.ok(fs.exists('applications/demo/chats/assistant.json'));
  assert.deepEqual(await chat.reset('demo'), { ok: true });
  await chat.whenIdle();
  assert.deepEqual(await chat.events('demo', 0, 3), { epoch: 1, events: [], next: 0, running: false, available: true });
  assert.equal(fs.exists('applications/demo/chats/assistant.json'), false, 'an empty conversation has no file');
  assert.deepEqual(await chat.reset('nope'), { ok: true });
});

test('a new chat or replaced files drop a turn that is still running, without a word from it', async () => {
  let release;
  const slow = async ({ say }) => { await new Promise(res => { release = res; }); say('Too late.'); };
  let s = setup([slow, async ({ say }) => say('Fresh.')]);
  await s.chat.send({ app: 'demo', text: 'first' });
  while (!release) await new Promise(res => setTimeout(res, 2));
  await s.chat.reset('demo');
  assert.equal(s.chat.running(), false);
  release();
  await new Promise(res => setTimeout(res, 10));
  assert.deepEqual((await s.chat.events('demo', -1, 0)).events, [], 'the dropped turn adds nothing, not even done');
  assert.deepEqual(await ask(s.chat, 'second'), [{ type: 'user', text: 'second', files: [] }, { type: 'text', text: 'Fresh.' }, { type: 'done' }]);

  // an import replaced the application: the conversation is read again from the files
  release = null;
  s = setup([slow]);
  await s.chat.send({ app: 'demo', text: 'first' });
  while (!release) await new Promise(res => setTimeout(res, 2));
  const waiting = s.chat.events('demo', 0, 1);
  const imported = [{ type: 'user', text: 'from the import', files: [] }, { type: 'text', text: 'kept with it' }, { type: 'done' }];
  await s.chat.forget('demo');
  await s.fs.write('applications/demo/chats/assistant.json', JSON.stringify({ events: imported }, null, 1));
  release();
  assert.deepEqual(await waiting, { epoch: 1, events: imported, next: 3, running: false, available: true }, 'a waiting poll is answered with the new conversation');
  await new Promise(res => setTimeout(res, 10));
  assert.deepEqual(JSON.parse(await stored(s.fs)).events, imported, 'the old turn wrote nothing over it');
  assert.equal(s.chat.running(), false);
  await s.chat.forget('never-opened');
});

test('the tiers offered are the platform\'s, and the default is the empty id the page already sends', () => {
  assert.deepEqual(MODELS.map(m => [m.id, m.label]), [['', 'Default'], ['quick', 'Quick'], ['complex', 'Complex']]);
  for (const m of MODELS) assert.deepEqual(Object.keys(m), ['id', 'label', 'model', 'note']);
});

// ---- what the review of the first version found ----
// an application the page can load: a robot it names, an item it lists and places
const LOADS = {
  'applications/demo/application.json': JSON.stringify({ format: 1, name: 'Demo', robot: 'cell_fr3', grippers: [], items: ['holder'], loop: { name: 'One cycle', steps: ['pick'] } }, null, 1) + '\n',
  'applications/demo/items/holder/item.json': '{"kind": "fixture", "name": "Holder"}\n',
};
const toolsOf = (fs, more = {}) => Object.fromEntries(buildTools({ fs, app: 'demo', ...more }).map(t => [t.name, t]));
// what viewer/app.js answers a run with while a reload is waiting for the turn to end: `stale` whatever the file was
const STALE_RUN = { ok: true, ran: ['pick'], seconds: 1, log: [], parts_moved: [], held: null, io: {}, tool: 'cup', joints_deg: [0], stale: true };

test('a run after a step was written is not said to have used old files; after a change to the layout it is', async () => {
  const fs = makeFs(LOADS);
  const t = toolsOf(fs, { runs: fakeRuns(STALE_RUN) });
  assert.match(await t.write_file.execute({ path: 'steps/pick.ts', content: STEP + '// changed\n' }, {}), /^saved /);
  assert.match(await t.run_steps.execute({ steps: ['pick'] }, {}), /^DONE: pick/, 'a step is read fresh on every run: nothing was old');
  assert.match(await t.edit_file.execute({ path: 'layout.json', old_text: '0.1,', new_text: '0.3,' }, {}), /only after the page reloads/);
  assert.match(await t.run_steps.execute({ steps: ['pick'] }, {}), /^NOTE: files changed since the viewer loaded this application.*OLD ones/s);
  // the tools of the next message, on the same page: the scene is still the old one
  assert.match(await toolsOf(fs, { runs: fakeRuns(STALE_RUN) }).run_steps.execute({ loop: true }, {}), /^NOTE: /);
  // another page load (another file system): nothing was changed there
  assert.match(await toolsOf(makeFs(LOADS), { runs: fakeRuns(STALE_RUN) }).run_steps.execute({ loop: true }, {}), /^DONE: /);
});

test('a file the application would no longer load with is not saved — and one that already does not load can be mended', async () => {
  const fs = makeFs(LOADS);
  const t = toolsOf(fs);
  const twice = JSON.stringify({ fixtures: [{ id: 'holder', item: 'holder' }, { id: 'holder', item: 'holder' }] });
  await assert.rejects(() => t.write_file.execute({ path: 'layout.json', content: twice }, {}), /layout\.json was NOT saved: the application would no longer load with it — .*the id 'holder' is used twice/);
  await assert.rejects(() => t.write_file.execute({ path: 'layout.json', content: '{"fixtures": [{"id": "a", "item": "ghost"}]}' }, {}), /NOT saved.*places 'a' as the item 'ghost', which is not in "items"/);
  await assert.rejects(() => t.write_file.execute({ path: 'layout.json', content: '{"tool_rack": {"stands": [{"name": "S1", "fixture_id": "nope"}]}}' }, {}), /NOT saved.*unknown fixture 'nope'/);
  await assert.rejects(() => t.edit_file.execute({ path: 'application.json', old_text: '"holder"', new_text: '"holder", "ghost"' }, {}), /application\.json was NOT saved: the application would no longer load/);
  await assert.rejects(() => t.write_file.execute({ path: 'items/holder/item.json', content: '{"kind": "part"}' }, {}), /NOT saved.*listed under fixtures, but items\/holder is a part/);
  assert.equal(await fs.readText('applications/demo/layout.json'), LAYOUT, 'nothing refused was written');
  assert.equal(fs.list('.undo').length, 0, 'and nothing was kept for undo');
  assert.match(await t.write_file.execute({ path: 'layout.json', content: '{"fixtures": [{"id": "h2", "item": "holder"}]}' }, {}), /^saved [^\n]*\nThe 3D scene[^\n]*$/);

  // an application that came in broken (an import, a change made by hand): each file may be mended in turn
  const broken = makeFs({ ...LOADS, 'applications/demo/layout.json': twice });
  const b = toolsOf(broken);
  const said = await b.write_file.execute({ path: 'layout.json', content: '{"fixtures": [{"id": "a", "item": "ghost"}]}' }, {});
  assert.match(said, /^saved .*\nNOTE: the application still does not load: .*'ghost'/s);
  assert.doesNotMatch(await b.write_file.execute({ path: 'layout.json', content: LAYOUT }, {}), /NOTE/);
});

test('two changes to one file sent in the same round both land, and undo takes them back one by one', async () => {
  const fs = makeFs({ 'applications/demo/notes/x.md': 'alpha\nbeta\ngamma\n' });
  const t = toolsOf(fs);
  const path = 'applications/demo/notes/x.md';
  const out = await Promise.all([
    t.edit_file.execute({ path: 'notes/x.md', old_text: 'alpha', new_text: 'ALPHA' }, {}),
    t.edit_file.execute({ path: 'notes/x.md', old_text: 'gamma', new_text: 'GAMMA' }, {}),
  ]);
  assert.deepEqual(out, [`saved ${path} (17 bytes)`, `saved ${path} (17 bytes)`]);
  assert.equal(await fs.readText(path), 'ALPHA\nbeta\nGAMMA\n', 'the second edit read what the first one wrote');
  await t.undo.execute({ path }, {});
  assert.equal(await fs.readText(path), 'ALPHA\nbeta\ngamma\n');
  await t.undo.execute({ path }, {});
  assert.equal(await fs.readText(path), 'alpha\nbeta\ngamma\n');
  // two writes of one new file: one of them made it, the other replaced it — and says so
  const made = await Promise.all([t.write_file.execute({ path: 'notes/new.md', content: 'one' }, {}), t.write_file.execute({ path: 'notes/new.md', content: 'two' }, {})]);
  assert.deepEqual(made.map(m => / — a new file$/.test(m)), [true, false]);
  assert.equal(await fs.readText('applications/demo/notes/new.md'), 'two');
  // a write, an edit of it and an undo, all at once: in the order they were sent
  await Promise.all([
    t.write_file.execute({ path: 'notes/y.md', content: 'one two' }, {}),
    t.edit_file.execute({ path: 'notes/y.md', old_text: 'two', new_text: 'three' }, {}),
    t.undo.execute({ path: 'notes/y.md' }, {}),
  ]);
  assert.equal(await fs.readText('applications/demo/notes/y.md'), 'one two');
});

test('a new step and the manifest that names it, sent in one round, are both saved — in either order', async () => {
  for (const stepFirst of [true, false]) {
    const fs = makeFs();
    const t = toolsOf(fs);
    const manifest = JSON.stringify({ format: 1, name: 'Demo', loop: { name: 'One cycle', steps: ['pick', 'place'] } });
    const calls = [
      () => t.write_file.execute({ path: 'steps/place.ts', content: STEP }, {}),
      () => t.write_file.execute({ path: 'application.json', content: manifest }, {}),
    ];
    const out = await Promise.all((stepFirst ? calls : calls.reverse()).map(c => c()));
    for (const o of out) assert.match(o, /^saved /, `step first: ${stepFirst}`);
    assert.deepEqual(JSON.parse(await fs.readText('applications/demo/application.json')).loop.steps, ['pick', 'place']);
    // a step that is in no call at all is still refused, as before
    await assert.rejects(() => t.write_file.execute({ path: 'application.json', content: manifest.replace('place', 'ghost') }, {}), /the loop names "ghost"/);
  }
});

test('undo outlives the page reload that follows a change, and the file as it was before the assistant is never pushed out', async () => {
  const store = createMemoryStore();
  const files = Object.entries(FILES).map(([path, text]) => ({ path, sha: sha(enc(text)), size: bytes(text), text }));
  const page = () => createPageFs({ pack: { version: 't', files }, loadBin: async () => GLB, store });
  let fs = page();
  let t = toolsOf(fs);
  await t.edit_file.execute({ path: 'layout.json', old_text: '0.1,', new_text: '0.3,' }, {});
  await t.write_file.execute({ path: 'steps/place.ts', content: STEP }, {});
  // the page reloads when the answer ends: a new file system over what the browser kept, new tools, a new chat
  fs = page(); await fs.ready;
  const out = {};
  const chat = createPageChat({ fs, getSample: async () => fakeSample([async ({ say, tool }) => {
    out.layout = await tool('undo', { path: 'layout.json' });
    out.step = await tool('undo', { path: 'steps/place.ts' });
    out.again = await tool('undo', { path: 'layout.json' });
    say(`undone ${DONE}`);
  }]), hold: 40, runs: () => fakeRuns() });
  await ask(chat, 'undo that');
  assert.match(out.layout, /^restored applications\/demo\/layout\.json/);
  assert.match(out.step, /it did not exist before, so it was removed/);
  assert.match(out.again, /^Error: nothing to undo for applications\/demo\/layout\.json: no earlier version of it is kept/);
  assert.equal(await fs.readText('applications/demo/layout.json'), LAYOUT);
  assert.equal(fs.origin('applications/demo/layout.json'), 'base');
  assert.equal(fs.exists('applications/demo/steps/place.ts'), false);
  assert.deepEqual(fs.list('.undo'), [], 'a version put back is not kept');

  // fourteen changes to one file: the last ones can be undone one by one, and then the original
  t = toolsOf(fs);
  for (let i = 1; i <= 14; i++) await t.write_file.execute({ path: 'notes/plan.md', content: `version ${i}\n` }, {});
  assert.equal(fs.list('.undo/demo/notes/plan.md').length, 10);
  const seen = [];
  for (let i = 0; i < 9; i++) { await t.undo.execute({ path: 'notes/plan.md' }, {}); seen.push(await fs.readText('applications/demo/notes/plan.md')); }
  assert.deepEqual(seen, [13, 12, 11, 10, 9, 8, 7, 6, 5].map(i => `version ${i}\n`));
  assert.match(await t.undo.execute({ path: 'notes/plan.md' }, {}), /did not exist before/);
  assert.equal(fs.exists('applications/demo/notes/plan.md'), false, 'back to before the assistant touched it');

  // none of it is the application's: an export does not take it, and files replaced by an import have no earlier versions
  await t.write_file.execute({ path: 'notes/plan.md', content: 'x' }, {});
  assert.ok(fs.list('.undo').length && !fs.list('applications/demo').some(p => p.includes('.undo')));
  await chat.forget('demo');
  await new Promise(res => setTimeout(res, 10));
  assert.deepEqual(fs.list('.undo'), []);
});

test('a file cannot be put under a file: the manifest stays readable', async () => {
  const fs = makeFs();
  const t = toolsOf(fs);
  await assert.rejects(() => t.write_file.execute({ path: 'application.json/n.md', content: 'x' }, {}), /NOT saved: applications\/demo\/application\.json is a file, so nothing can be put under it/);
  await assert.rejects(() => t.write_file.execute({ path: 'steps/pick.ts/deep/n.txt', content: 'x' }, {}), /steps\/pick\.ts is a file/);
  assert.equal(fs.isDir('applications/demo/application.json'), false);
  assert.match(await t.read_file.execute({ path: 'application.json' }, {}), /"name": "Demo"/);
});

test('a run that ended unread is handed over with the next run, not dropped — and "keep" does not carry on from a failure nobody saw', async () => {
  const done = { ok: true, ran: ['b'], seconds: 1, log: [], parts_moved: [], held: null, io: {}, tool: 'cup', joints_deg: [0] };
  const failed = { ...done, ok: false, step: 'a', ran: ['a'], error: 'link5 would hit holder' };
  let finish;
  const answers = [() => new Promise(res => { finish = res; }), () => done, () => done];
  const runs = fakeRuns(() => answers.shift()());
  const fs = makeFs();
  const said = [];
  const run = toolsOf(fs, { runs, runWait: 20, emit: x => said.push(x) }).run_steps;
  assert.match(await run.execute({ steps: ['a'] }, {}), /^still running \(a\)/);
  finish(failed);
  await new Promise(res => setTimeout(res, 5));
  // carrying on from the scene it left would be blind: nothing runs, the failure is read first
  const held = await run.execute({ steps: ['b'], keep: true }, {});
  assert.match(held, /^The run of a you started earlier has ended, and you had not read its result:\n\nFAILED at a: link5 would hit holder/);
  assert.match(held, /Nothing was run now/);
  assert.equal(runs.jobs.length, 1);
  assert.match(await run.execute({ steps: ['b'], keep: true }, {}), /^DONE: b/, 'it was handed over once');

  // without keep the scene is reset: the new run goes ahead, with the unread result before its own
  let finish2;
  answers.unshift(() => new Promise(res => { finish2 = res; }));
  assert.match(await run.execute({ steps: ['a'] }, {}), /^still running/);
  finish2(failed);
  await new Promise(res => setTimeout(res, 5));
  const both = await run.execute({ steps: ['b'] }, {});
  assert.match(both, /^The run of a you started earlier has ended.*FAILED at a: link5 would hit holder.*---- the run you asked for now \(b\) ----\n\nDONE: b/s);
  assert.ok(bytes(both) <= MAX_RESULT);
  assert.deepEqual(said, ['runs a', 'runs b', 'runs a', 'runs b']);
});

test('nothing is written to the conversation after its turn has ended, and a tool called after Stop does nothing', async () => {
  let late, begun;
  const started = new Promise(res => { begun = res; });
  const lateDone = new Promise(res => { late = res; });
  const { fs, chat } = setup([async ({ tool }) => {
    begun();
    await new Promise(res => setTimeout(res, 40));            // Stop comes meanwhile; the platform still runs the call
    const out = [await tool('write_file', { path: 'notes/late.md', content: 'x' }), await tool('read_file', { path: 'layout.json' }), await tool('run_steps', { loop: true })];
    late(out);
  }]);
  await chat.send({ app: 'demo', text: 'go', context: CONTEXT });
  await started;
  chat.stop('demo');
  await chat.whenIdle();
  assert.deepEqual(await lateDone, ['Error: stopped', 'Error: stopped', 'Error: stopped']);
  await chat.whenIdle();
  const want = [{ type: 'user', text: 'go', files: [] }, { type: 'error', text: 'stopped' }, { type: 'done' }];
  assert.deepEqual((await chat.events('demo', -1, 0)).events, want);
  assert.deepEqual(JSON.parse(await stored(fs)).events, want, 'the stored conversation ends with done');
  assert.equal(fs.exists('applications/demo/notes/late.md'), false);
  // so the next page load does not take the finished turn for one that was interrupted
  const next = createPageChat({ fs, getSample: async () => null, hold: 40 });
  assert.deepEqual((await next.events('demo', -1, 0)).events, want);
});

test('an answer cut short by the length limit is carried on, not ended in the middle of a sentence', async () => {
  const replies = [{ text: 'The plan has three parts. First, the tray is cut he', truncated: true }, { text: `re and then placed.\n${DONE}`, truncated: false }];
  const calls = [];
  const sample = async (input, options) => { calls.push({ input, options }); return { ...replies[calls.length - 1], modelTierApplied: 'default' }; };
  sample.limits = async () => ({ maxPromptBytes: 262144, tools: { maxCount: 16 } });
  let s = setup([], { sample });
  assert.deepEqual(await ask(s.chat, 'explain the plan'), [
    { type: 'user', text: 'explain the plan', files: [] },
    { type: 'text', text: 'The plan has three parts. First, the tray is cut he' },
    { type: 'text', text: 're and then placed.' },
    { type: 'done' },
  ]);
  assert.equal(calls.length, 2);
  assert.match(calls[1].input[2].content, /cut off by the length limit of one answer: carry on exactly where it stops/);
  // cut short every time: it ends with the line that says the answer is not whole — never silently
  const always = async () => ({ text: 'and so on and', truncated: true, modelTierApplied: 'default' });
  always.limits = sample.limits;
  s = setup([], { sample: always, maxPasses: 2 });
  const events = await ask(s.chat, 'explain');
  assert.deepEqual(events.slice(-2), [{ type: 'error', text: 'paused: this took more rounds than one message allows — send "continue" and the assistant carries on from here' }, { type: 'done' }]);
});

test('a conversation that came in a file is taken as data: only the events there are, text as text, only this application\'s attachments', async () => {
  const foreign = [
    { type: 'user', text: 'look', files: 5 },
    { type: 'text' },
    { type: 'user', text: 7, files: ['applications/demo/materials/a.png', 'applications/other/materials/b.png', 'viewer/app.js', 'applications/demo/materials/x/../../layout.json', { path: 'x' }, 'applications/demo/materials/c.svg'], extra: { any: 'thing' } },
    { type: 'script', text: 'x' },
    { type: 'tool', text: ['reads', 'x'] },
    { type: 'note', text: 'handed over' },
    { type: 'done', text: 'x' },
  ];
  const s = setup([async ({ say }) => say(`Fine. ${DONE}`)], { files: { 'applications/demo/chats/assistant.json': JSON.stringify({ events: foreign }) } });
  const r = await s.chat.events('demo', -1, 0);
  assert.deepEqual(r.events, [
    { type: 'user', text: 'look', files: [] },
    { type: 'text', text: '' },
    { type: 'user', text: '7', files: ['applications/demo/materials/a.png', 'applications/demo/materials/c.svg'] },
    { type: 'tool', text: 'reads,x' },
    { type: 'note', text: 'handed over' },
    { type: 'done' },
  ]);
  // every later message works: the record handed to Claude is made from them
  const events = await ask(s.chat, 'carry on');
  assert.deepEqual(events.slice(-3), [{ type: 'user', text: 'carry on', files: [] }, { type: 'text', text: 'Fine.' }, { type: 'done' }]);
  assert.match(s.sample.calls[0].input[1].content, /USER: 7\n  \[attached: applications\/demo\/materials\/a\.png\]/);
  // and the record itself does not trip over what it is given
  assert.match(history([{ type: 'user', text: 'a', files: 5 }, { type: 'text' }, { type: 'user', files: [3] }]), /USER: a\nYOU: \nUSER: \n  \[attached: 3\]/);
});
