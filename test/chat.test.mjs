// The chat: ONE agent, described in guides/agent.md, with a guide for each
// kind of work in guides/ (viewer/chat.py reads them); one conversation per
// application, kept on disk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url);
const py = (code, ...args) => JSON.parse(execFileSync('python3', ['-c', code, ...args], { cwd: new URL('viewer/', ROOT), encoding: 'utf8' }));

// a stand-in for the CLI: answers with the prompt it was given; an unknown session cannot be resumed
const FAKE_CLI = `
import json, os, shutil, stat, sys, tempfile, time
tmp = tempfile.mkdtemp()
fake = os.path.join(tmp, 'bin', 'claude'); os.makedirs(os.path.dirname(fake))
open(fake, 'w').write('''#!/usr/bin/env python3
import json, sys
a = sys.argv
if "--version" in a:
    print("9.9.9 (fake)"); sys.exit(0)
if "--resume" in a and a[a.index("--resume") + 1] != "live":
    sys.stderr.write("No conversation found with session ID\\\\n"); sys.exit(1)
p = sys.stdin.read()
which = {"fable": "claude-fable-5", "opus": "claude-opus-4-8", "sonnet": "claude-sonnet-4-6", "haiku": "claude-haiku-4-5-20251001"}
print(json.dumps({"type": "system", "session_id": "live", "model": which.get(a[a.index("--model") + 1] if "--model" in a else "", "claude-fable-5")}), flush=True)
m = ("[" + a[a.index("--model") + 1] + "] ") if "--model" in a else ""
print(json.dumps({"type": "assistant", "session_id": "live", "message": {"content": [{"type": "text", "text": m + ("RESUMED " if "--resume" in a else "FRESH ") + p}]}}))
print(json.dumps({"type": "result", "is_error": False, "session_id": "live"}))
''')
os.chmod(fake, os.stat(fake).st_mode | stat.S_IEXEC)
os.environ['PATH'] = os.path.dirname(fake) + os.pathsep + os.environ['PATH']
import chat
shutil.copytree('../guides', os.path.join(tmp, 'guides'))
app = os.path.join(tmp, 'applications', 'demo'); os.makedirs(os.path.join(app, 'chats'))
open(os.path.join(app, 'application.json'), 'w').write('{}')
def say(c, text):
    assert c.send(text, 'application: demo') is None
    for _ in range(200):
        if not c.running(): break
        time.sleep(0.05)
    return [e for e in c.events if e['type'] in ('text', 'error')][-1]
`;

const loaded = py(`
import json, chat
a = chat.load_agent('..')
print(json.dumps({'agent': a, 'extra': sorted(chat.EXTRA_TOOLS), 'guides': chat.load_guides('..')}))`);

test('one agent, and a guide for each kind of work that it is told to read first', () => {
  const a = loaded.agent;
  assert.ok(a.name && a.hint, 'guides/agent.md needs a name and an opening hint in its header');
  assert.ok(a.brief.length > 2000, 'the agent\'s description is missing or very short');
  // every guide file is listed, with what it is for, in their order
  const files = readdirSync(new URL('guides/', ROOT)).filter(f => f.endsWith('.md') && f !== 'agent.md').map(f => `guides/${f}`);
  assert.deepEqual(loaded.guides.map(g => g.file).sort(), files.sort());
  assert.deepEqual(loaded.guides.map(g => g.title), ['Planning', 'Geometry', 'Steps', 'Buying', 'Costing']);
  for (const g of loaded.guides) {
    assert.ok(g.title && g.when, `${g.file}: needs title and when in its header`);
    assert.ok(a.brief.includes(`- ${g.file} — ${g.title}: ${g.when}`), `${g.file} is not offered to the agent`);
    assert.ok(readFileSync(new URL(g.file, ROOT), 'utf8').length > 600, `${g.file} says very little`);
  }
  assert.match(a.brief, /read the one that fits BEFORE starting work of that kind/);
  // the guides are read when needed, not pasted into every message
  assert.ok(!a.brief.includes('M6\n  clearance bores') && !a.brief.includes('counterbored'), 'a guide\'s text was put into the standing instructions');
  // the several-agents chat is gone
  assert.ok(!existsSync(new URL('agents/', ROOT)), 'agents/ is back: there is one agent, in guides/agent.md');
  assert.ok(!/handoff|colleague/i.test(a.brief), 'the agent is told about colleagues it no longer has');
});

test('the agent gets only the extra tools the server allows, and every one it asks for is one of those', () => {
  const head = readFileSync(new URL('guides/agent.md', ROOT), 'utf8').match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
  const asked = (head.match(/^tools:\s*(.*)$/m)?.[1] ?? '').split(',').map(s => s.trim()).filter(Boolean);
  for (const t of asked) assert.ok(loaded.extra.includes(t), `guides/agent.md asks for '${t}', which the server does not grant (EXTRA_TOOLS in viewer/chat.py)`);
  assert.deepEqual(loaded.agent.tools, asked);
});

test('one conversation per application, kept on disk, coming back after a restart', () => {
  const out = py(FAKE_CLI + `
other = os.path.join(tmp, 'applications', 'other'); os.makedirs(other)
open(os.path.join(other, 'application.json'), 'w').write('{}')
chats = chat.Chats(tmp)
c = chats.get('demo')
fresh = c.poll(-1, 0, timeout=0)['events']
first = say(c, 'hello')
second = say(c, 'again')
store = os.path.join(app, 'chats', 'assistant.json')
again = chat.Chats(tmp)
back = again.get('demo')
kept = {'types': [e['type'] for e in back.events], 'session': back.session, 'file': os.path.exists(store),
        'session_in_app': 'live' in open(store).read(), 'other': list(again.get('other').events),
        'same_object': again.get('demo') is back}
# a conversation cut off by a restart says so
d = again.get('other'); d._add(type='user', text='work', files=[]); d._add(type='tool', text='reads x')
cut = [e['type'] for e in chat.Chats(tmp).get('other').events]
back.new()
cleared = {'file': os.path.exists(store), 'events': chat.Chats(tmp).get('demo').events, 'session': chat.Chats(tmp).get('demo').session}
unknown = [chats.get('no-such-app') is None, chats.get('../guides') is None, chats.get('') is None]
info = chats.agent()
shutil.rmtree(tmp)
print(json.dumps({'fresh': fresh, 'first': first['text'], 'second': second['text'], 'kept': kept, 'cut': cut, 'cleared': cleared, 'unknown': unknown, 'info': info}))`);
  assert.deepEqual(out.fresh, [], 'a new conversation is empty');
  assert.match(out.first, /^FRESH \[viewer: application: demo\]\nhello$/, 'a first message starts a session; there is nothing earlier to hand over');
  assert.match(out.second, /^RESUMED \[viewer: application: demo\]\nagain$/, 'the next message continues that session');
  assert.deepEqual(out.kept.types, ['user', 'text', 'done', 'user', 'text', 'done'], 'what was said did not come back');
  assert.ok(out.kept.file, 'the conversation is a file in the application: chats/assistant.json');
  assert.equal(out.kept.session, 'live', 'the agent\'s own memory of the conversation (its CLI session) is found again');
  assert.ok(!out.kept.session_in_app, 'the CLI session is local to this machine: it must not be written into the application');
  assert.deepEqual(out.kept.other, [], 'another application has its own conversation');
  assert.ok(out.kept.same_object);
  assert.deepEqual(out.cut, ['user', 'tool', 'error', 'done'], 'a conversation cut off by a restart must say so and end');
  assert.deepEqual(out.cleared, { file: false, events: [], session: null }, 'New forgets the conversation on disk as well');
  assert.deepEqual(out.unknown, [true, true, true], 'an unknown application has no conversation');
  assert.deepEqual(Object.keys(out.info).sort(), ['guides', 'hint', 'models', 'models_ready', 'name'], 'the page is told who answers, never the instructions');
});

test('without a session of its own the agent gets the saved conversation as background — after an import, or when its session is gone', () => {
  const out = py(FAKE_CLI + `
# a conversation that came with the application (an import): events on disk, no session here
json.dump({'events': [{'type': 'user', 'text': 'put the tray at the front left', 'files': []},
                      {'type': 'tool', 'text': 'edits layout.json'}, {'type': 'text', 'text': 'Tray placed at x 0.4.'}, {'type': 'done'}]},
          open(os.path.join(app, 'chats', 'assistant.json'), 'w'))
c = chat.Chats(tmp).get('demo')
first = say(c, 'now move it 5 cm right')            # no session: must carry the background
second = say(c, 'and back')                         # its own session now: no background needed
stale = chat.Chats(tmp).get('demo')                 # a new server, and the session has since expired
stale.session = 'gone'; stale._save_session()
third = say(stale, 'where is the tray?')
shutil.rmtree(tmp)
print(json.dumps({'first': first, 'second': second, 'third': third, 'session': stale.session,
                  'errors': [e['text'] for e in stale.events if e['type'] == 'error']}))`);
  assert.match(out.first.text, /^FRESH \[Background/, 'with no session, the saved conversation must come first');
  assert.match(out.first.text, /USER: put the tray at the front left[\s\S]*\(you: edits layout\.json\)[\s\S]*YOU: Tray placed at x 0\.4\./, 'what was said and done earlier is in the background');
  assert.match(out.first.text, /now move it 5 cm right$/, 'and the new message follows it');
  assert.match(out.second.text, /^RESUMED \[viewer: application: demo\]\nand back$/, 'with its own session the agent remembers: the conversation is not sent again');
  assert.match(out.third.text, /^FRESH \[Background[\s\S]*YOU: RESUMED[\s\S]*where is the tray\?$/, 'a session that is gone: start a new one, with the whole saved conversation');
  assert.equal(out.session, 'live', 'the new session is kept for the next message');
  assert.deepEqual(out.errors, [], 'the failed attempt to continue the old session must not show as an error');
});

test('an application from the several-agents chat keeps its main conversation as the one conversation', () => {
  const out = py(FAKE_CLI + `
json.dump({'events': [{'type': 'user', 'text': 'plan it', 'files': []}, {'type': 'text', 'text': 'The plan.'}, {'type': 'note', 'text': 'handed to the Programmer'}, {'type': 'done'}]},
          open(os.path.join(app, 'chats', 'lead-engineer.json'), 'w'))
json.dump({'events': [{'type': 'user', 'text': 'write it', 'from': 'Lead engineer', 'files': []}, {'type': 'done'}]}, open(os.path.join(app, 'chats', 'programmer.json'), 'w'))
json.dump({'demo/lead-engineer': 'live', 'demo/programmer': 'p'}, open(os.path.join(tmp, '.chat-sessions.json'), 'w'))
c = chat.Chats(tmp).get('demo')
res = {'events': [e['type'] for e in c.events], 'session': c.session, 'files': sorted(os.listdir(os.path.join(app, 'chats'))),
       'reply': say(c, 'carry on')['text']}
shutil.rmtree(tmp)
print(json.dumps(res))`);
  assert.deepEqual(out.events, ['user', 'text', 'note', 'done'], 'the Lead engineer\'s conversation became the conversation');
  assert.deepEqual(out.files, ['assistant.json', 'programmer.json'], 'the other agents\' files stay as a record');
  assert.equal(out.session, 'live', 'and its session with it, so the agent still remembers');
  assert.match(out.reply, /^RESUMED /);
});

test('the model chosen in the chat is the one the agent runs on; an unknown one is not passed on', () => {
  const out = py(FAKE_CLI + `
c = chat.Chats(tmp).get('demo')
def ask(text, model):
    assert c.send(text, 'application: demo', (), model) is None
    for _ in range(200):
        if not c.running(): break
        time.sleep(0.05)
    return [e for e in c.events if e['type'] == 'text'][-1]['text']
all = chat.Chats(tmp)
first = all.agent()
for _ in range(200):
    offer = all.agent()
    if offer['models_ready']: break
    time.sleep(0.05)
print(json.dumps({'first': first['models'], 'models': offer['models'], 'kept': json.load(open(os.path.join(tmp, '.chat-models.json'))),
                  'default': ask('one', ''), 'sonnet': ask('two', 'sonnet'),
                  'bad': ask('three', 'sonnet; rm -rf'), 'back': ask('four', ''),
                  'names': [chat.model_label(m) for m in ['claude-haiku-4-5-20251001', 'claude-fable-5', 'claude-sonnet-4-6[1m]', 'claude-3-5-sonnet-20241022', 'some-other-name', '']]}))`);
  assert.deepEqual(out.models.map(m => m.id), ['', 'fable', 'opus', 'sonnet', 'haiku']);
  assert.ok(out.models.every(m => m.label && m.note));
  // before the exact models are known the options carry the family's name; then the model's name and number
  assert.deepEqual(out.first.map(m => m.label), ['Default', 'Fable', 'Opus', 'Sonnet', 'Haiku']);
  assert.deepEqual(out.models.map(m => m.label), ['Default (Fable 5)', 'Fable 5', 'Opus 4.8', 'Sonnet 4.6', 'Haiku 4.5']);
  assert.deepEqual(out.models.map(m => m.model), ['Fable 5', 'Fable 5', 'Opus 4.8', 'Sonnet 4.6', 'Haiku 4.5']);
  assert.equal(out.kept.cli, '9.9.9 (fake)', 'what was found out is kept for this version of the CLI');
  assert.equal(out.kept.models.sonnet, 'claude-sonnet-4-6');
  assert.deepEqual(out.names, ['Haiku 4.5', 'Fable 5', 'Sonnet 4.6', 'Sonnet 3.5', 'some-other-name', '']);
  assert.ok(!out.default.startsWith('['), 'no model chosen: the CLI decides');
  assert.ok(out.sonnet.startsWith('[sonnet] '), out.sonnet.slice(0, 40));
  assert.ok(!out.bad.startsWith('['), 'a model the server does not offer was passed to the CLI');
  assert.ok(!out.back.startsWith('['), 'the earlier choice must not stick to the next message');
});

test('a run the agent asks for is handed to the open viewer, and its result comes back; no viewer, no run; a job nobody vouches for is given out again', () => {
  const out = py(`
import json, threading, time, runs
r = runs.Runs()
runs.LISTEN_FOR = 0.5
runs.VOUCH_FOR = 0.6
got = {}
# nobody has the application open: the request says so instead of waiting its whole time
t0 = time.time(); got['closed'] = r.request('demo', {'steps': ['a']}, timeout=11); got['closed_s'] = time.time() - t0
# a page is listening: it takes the job, runs it, answers
def page(name, answer, key=None):
    job = r.next('demo', name, timeout=5)
    got[key or 'job_' + name] = job
    if job and answer: r.result(job['id'], {'ok': True, 'ran': job['steps']})
    return job
threading.Thread(target=page, args=('p1', True)).start()
time.sleep(0.2)
got['done'] = r.request('demo', {'steps': ['a', 'b'], 'loop': False}, timeout=10)

# a job that went to a dropped connection (taken, never vouched for): given again — even to the same page
box = {}
threading.Thread(target=lambda: box.update(res=r.request('demo', {'steps': ['c']}, timeout=10))).start()
time.sleep(0.2)
lost = page('p2', False, 'lost')
time.sleep(0.2)
got['second_asked_meanwhile'] = r.request('demo', {'steps': ['d']}, timeout=10)
got['too_soon'] = r.next('demo', 'p9', timeout=0.1)          # p2 is still vouched for
time.sleep(0.6)
again = page('p2', False, 'again')

# a page that is working on it keeps it: another page of the same application gets nothing
for _ in range(4):
    time.sleep(0.3); r.alive(again['id'], 'p2')
got['other_tab'] = r.next('demo', 'p3', timeout=0.2)
got['not_its_job'] = r.alive(again['id'], 'p3')
r.result(again['id'], {'ok': True, 'ran': ['c']})
time.sleep(0.3)
got['redelivered'] = box.get('res')
got['finished_is_gone'] = r.next('demo', 'p3', timeout=0.3)
print(json.dumps(got))`);
  assert.equal(out.closed.ok, false);
  assert.match(out.closed.error, /not open in the viewer/);
  assert.ok(out.closed_s < 10.5, 'it must not wait its whole time for a viewer that is not there');
  assert.deepEqual(out.job_p1.steps, ['a', 'b']);
  assert.deepEqual(out.done, { ok: true, ran: ['a', 'b'] });
  assert.match(out.second_asked_meanwhile.error, /another run/);
  assert.equal(out.too_soon, null, 'a job just taken is not handed to someone else at once');
  assert.deepEqual([out.lost.steps, out.again.steps], [['c'], ['c']]);
  assert.equal(out.lost.id, out.again.id, 'the job that went nowhere is the one given again');
  assert.equal(out.other_tab, null, 'a second tab must not run the job the first is working on');
  assert.equal(out.not_its_job, false);
  assert.deepEqual(out.redelivered, { ok: true, ran: ['c'] });
  assert.equal(out.finished_is_gone, null, 'a finished job is not handed out again');
});
