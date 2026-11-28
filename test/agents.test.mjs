// The chat's agents are the Markdown files in agents/ (viewer/chat.py
// reads them). Each must say who it is, and may ask only for the extra
// tools the server is willing to grant.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url);
const loaded = JSON.parse(execFileSync('python3', ['-c', `
import json, chat
import os, shutil, tempfile
# a throwaway repository: the real agents, one empty application
tmp = tempfile.mkdtemp()
shutil.copytree('../agents', os.path.join(tmp, 'agents'))
os.makedirs(os.path.join(tmp, 'applications', 'demo'))
open(os.path.join(tmp, 'applications', 'demo', 'application.json'), 'w').write('{}')
chats = chat.Chats(tmp)
ids = [a['id'] for a in chats.agents()]
polled = [chats.get('demo', i).poll(-1, 0, timeout=0)['events'] for i in ids]
fresh = {'answers': chats.answers('demo'), 'busy': chats.busy('demo')}
# what is said is kept on disk, per application and agent, and comes back in a new server
c = chats.get('demo', ids[0]); c.agent = chats.get('demo', ids[0]).agent
c._add(type='user', text='hello', files=[]); c._add(type='text', text='hi there'); c._add(type='done')
c.session = 'session-1'; c._save_session()
d = chats.get('demo', ids[1]); d._add(type='user', text='work', files=[]); d._add(type='tool', text='reads x')
again = chat.Chats(tmp)
back = again.get('demo', ids[0])
cut = again.get('demo', ids[1]).events
store = os.path.join(tmp, 'applications', 'demo', 'chats', ids[0] + '.json')
kept = {'events': back.events, 'session': back.session, 'answers': again.answers('demo')[ids[0]], 'file': os.path.exists(store),
        'session_in_app': 'session-1' in open(store).read(), 'cut': [e['type'] for e in cut]}
back.agent = again.get('demo', ids[0]).agent; back.new()
cleared = {'file': os.path.exists(store), 'events': chat.Chats(tmp).get('demo', ids[0]).events, 'session': chat.Chats(tmp).get('demo', ids[0]).session}
unknown = [chats.get('demo', 'no-such-agent') is None, chats.get('no-such-app', ids[0]) is None, chats.get('../agents', ids[0]) is None]
shutil.rmtree(tmp)
print(json.dumps({'agents': chat.load_agents('..'), 'extra': sorted(chat.EXTRA_TOOLS), 'polled': polled, 'kept': kept, 'cleared': cleared,
  'answers': fresh['answers'], 'busy': fresh['busy'], 'unknown': unknown}))`],
  { cwd: new URL('viewer/', ROOT), encoding: 'utf8' }));

test('every agent file is a complete profile', () => {
  const files = readdirSync(new URL('agents/', ROOT)).filter(f => f.endsWith('.md'));
  assert.deepEqual(loaded.agents.map(a => a.id).sort(), files.map(f => f.slice(0, -3)).sort());
  assert.ok(files.length >= 1, 'no agents');
  for (const a of loaded.agents) {
    assert.ok(a.name && a.role && a.hint, `agents/${a.id}.md: needs name, role and hint in its header`);
    assert.match(a.initials, /^[A-Z0-9]{1,2}$/, `agents/${a.id}.md: initials`);
    assert.ok(a.brief.includes(a.name) && a.brief.length > 800, `agents/${a.id}.md: the description is missing or very short`);
  }
  assert.equal(new Set(loaded.agents.map(a => a.name)).size, loaded.agents.length, 'two agents share a name');
});

test('every agent has a conversation the page can follow (the server side of the chat starts)', () => {
  assert.equal(loaded.polled.length, loaded.agents.length);
  assert.ok(loaded.polled.every(ev => Array.isArray(ev) && ev.length === 0), 'a fresh conversation is empty');
  assert.deepEqual(Object.keys(loaded.answers).sort(), loaded.agents.map(a => a.id).sort());
  assert.ok(Object.values(loaded.answers).every(n => n === 0), 'no answers yet, so nothing unread');
  assert.deepEqual(loaded.busy, []);
  assert.deepEqual(loaded.unknown, [true, true, true], 'an unknown agent or application has no conversation');
});

test('conversations are kept on disk, per application and agent, and come back after a restart', () => {
  const k = loaded.kept;
  assert.deepEqual(k.events.map(e => e.type), ['user', 'text', 'done'], 'what was said did not come back');
  assert.equal(k.events[1].text, 'hi there');
  assert.equal(k.answers, 1, 'answers are counted from the saved conversation, so unread marks survive too');
  assert.ok(k.file, 'the conversation is a file in the application: chats/<agent>.json');
  assert.equal(k.session, 'session-1', 'the agent\'s own memory of the conversation (its CLI session) is found again');
  assert.ok(!k.session_in_app, 'the CLI session is local to this machine: it must not be written into the application');
  assert.deepEqual(k.cut, ['user', 'tool', 'error', 'done'], 'a conversation cut off by a restart must say so and end');
  assert.deepEqual(loaded.cleared, { file: false, events: [], session: null }, 'New forgets the conversation on disk as well');
});

test('an agent gets only the extra tools the server allows, and every one it asks for is one of those', () => {
  for (const a of loaded.agents) {
    const head = readFileSync(new URL(`agents/${a.id}.md`, ROOT), 'utf8').match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
    const asked = (head.match(/^tools:\s*(.*)$/m)?.[1] ?? '').split(',').map(s => s.trim()).filter(Boolean);
    for (const t of asked) assert.ok(loaded.extra.includes(t), `agents/${a.id}.md asks for '${t}', which the server does not grant (EXTRA_TOOLS in viewer/chat.py)`);
    assert.deepEqual(a.tools, asked);
  }
});

test('an agent without a session of its own gets the saved conversation as background — after an import, or when its session is gone', () => {
  // the real chat code, driven against a stand-in for the CLI that answers with the prompt it was given
  const out = JSON.parse(execFileSync('python3', ['-c', `
import json, os, shutil, stat, sys, tempfile, time
tmp = tempfile.mkdtemp()
fake = os.path.join(tmp, 'bin', 'claude'); os.makedirs(os.path.dirname(fake))
open(fake, 'w').write('''#!/usr/bin/env python3
import json, sys
a = sys.argv
if "--resume" in a and a[a.index("--resume") + 1] != "live":
    sys.stderr.write("No conversation found with session ID\\\\n"); sys.exit(1)
p = sys.stdin.read()
print(json.dumps({"type": "system", "session_id": "live"}))
print(json.dumps({"type": "assistant", "session_id": "live", "message": {"content": [{"type": "text", "text": ("RESUMED " if "--resume" in a else "FRESH ") + p}]}}))
print(json.dumps({"type": "result", "is_error": False, "session_id": "live"}))
''')
os.chmod(fake, os.stat(fake).st_mode | stat.S_IEXEC)
os.environ['PATH'] = os.path.dirname(fake) + os.pathsep + os.environ['PATH']
import chat
shutil.copytree('../agents', os.path.join(tmp, 'agents'))
app = os.path.join(tmp, 'applications', 'demo'); os.makedirs(os.path.join(app, 'chats'))
open(os.path.join(app, 'application.json'), 'w').write('{}')
aid = chat.load_agents(tmp)[0]['id']
# a conversation that came with the application (an import): events on disk, no session here
json.dump({'events': [{'type': 'user', 'text': 'put the tray at the front left', 'files': []},
                      {'type': 'tool', 'text': 'edits layout.json'}, {'type': 'text', 'text': 'Tray placed at x 0.4.'}, {'type': 'done'}]},
          open(os.path.join(app, 'chats', aid + '.json'), 'w'))
def say(c, text):
    assert c.send(text, 'application: demo') is None
    for _ in range(200):
        if not c.running(): break
        time.sleep(0.05)
    return [e for e in c.events if e['type'] in ('text', 'error')][-1]
chats = chat.Chats(tmp)
c = chats.get('demo', aid)
first = say(c, 'now move it 5 cm right')            # no session: must carry the background
second = say(c, 'and back')                         # its own session now: no background needed
stale = chat.Chats(tmp).get('demo', aid)            # a new server, and the session has since expired
stale.session = 'gone'; stale._save_session()
third = say(stale, 'where is the tray?')
shutil.rmtree(tmp)
print(json.dumps({'first': first, 'second': second, 'third': third, 'session': stale.session,
                  'errors': [e['text'] for e in stale.events if e['type'] == 'error']}))`],
    { cwd: new URL('viewer/', ROOT), encoding: 'utf8' }));
  assert.match(out.first.text, /^FRESH \[Background/, 'with no session, the saved conversation must come first');
  assert.match(out.first.text, /USER: put the tray at the front left[\s\S]*\(you: edits layout\.json\)[\s\S]*YOU: Tray placed at x 0\.4\./, 'what was said and done earlier is in the background');
  assert.match(out.first.text, /now move it 5 cm right$/, 'and the new message follows it');
  assert.match(out.second.text, /^RESUMED \[viewer: application: demo\]\nand back$/, 'with its own session the agent remembers: the conversation is not sent again');
  assert.match(out.third.text, /^FRESH \[Background[\s\S]*YOU: RESUMED[\s\S]*where is the tray\?$/, 'a session that is gone: start a new one, with the whole saved conversation');
  assert.equal(out.session, 'live', 'the new session is kept for the next message');
  assert.deepEqual(out.errors, [], 'the failed attempt to continue the old session must not show as an error');
});

test('handing work over: the Lead engineer starts colleagues itself, each with only its task, one after another', () => {
  const out = JSON.parse(execFileSync('python3', ['-c', `
import json, os, shutil, stat, sys, tempfile, time
tmp = tempfile.mkdtemp()
fake = os.path.join(tmp, 'bin', 'claude'); os.makedirs(os.path.dirname(fake))
# stands in for the CLI: plans with a handoff block when asked to PLAN, fails on BREAK, else echoes its prompt
open(fake, 'w').write('''#!/usr/bin/env python3
import json, sys, time
p = sys.stdin.read()
say = lambda t: print(json.dumps({"type": "assistant", "session_id": "s", "message": {"content": [{"type": "text", "text": t}]}}))
if "BREAK" in p:
    say("trying"); print(json.dumps({"type": "result", "is_error": True, "result": "tool exploded"})); sys.exit(0)
if "PLAN" in p:
    tasks = [{"to": "cad-designer", "task": "place the tray SECRETLESS"}, {"to": "programmer", "task": "write the pick step" + (" BREAK" if "PLANBAD" in p else "")},
             {"to": "accountant", "task": "cost it"}, {"to": "nobody", "task": "x"}]
    say("Handing over.\\\\n\\\\n\`\`\`handoff\\\\n" + json.dumps(tasks) + "\\\\n\`\`\`")
else:
    time.sleep(0.15); say("GOT " + p)
print(json.dumps({"type": "result", "is_error": False}))
''')
os.chmod(fake, os.stat(fake).st_mode | stat.S_IEXEC)
os.environ['PATH'] = os.path.dirname(fake) + os.pathsep + os.environ['PATH']
import chat
shutil.copytree('../agents', os.path.join(tmp, 'agents'))
app = os.path.join(tmp, 'applications', 'demo'); os.makedirs(app)
open(os.path.join(app, 'application.json'), 'w').write('{}')
chats = chat.Chats(tmp)
get = lambda i: chats.get('demo', i)
def settle(done):
    # wait for what this part of the test is about, then for everyone to be idle
    for _ in range(600):
        if done() and not chats.busy('demo'): return
        time.sleep(0.05)
    raise SystemExit('timed out waiting')
texts = lambda i: [e['text'] for e in get(i).events if e['type'] == 'text']
notes = lambda: [e['text'] for e in get('lead-engineer').events if e['type'] == 'note']
ev = lambda i: [(e['type'], e.get('from'), e.get('text', '')) for e in get(i).events if e['type'] != 'done']
lead = get('lead-engineer')
lead.send('the user secret is MANGO. PLAN the work', 'application: demo'); settle(lambda: len(notes()) == 6)
res = {'lead': ev('lead-engineer'), 'cad': ev('cad-designer'), 'prog': ev('programmer'), 'acc': ev('accountant'),
       'order': [e['to'] for e in lead.events if e['type'] == 'note']}
lead.send('what came back?', 'application: demo'); settle(lambda: len(texts('lead-engineer')) == 2)
res['report'] = [e['text'] for e in lead.events if e['type'] == 'text'][-1]
# a colleague that may not hand off: its block does nothing
get('programmer').send('PLAN something', 'application: demo'); settle(lambda: len(texts('programmer')) == 2); time.sleep(0.5)
res['prog_notes'] = [e for e in get('programmer').events if e['type'] == 'note']
res['cad_after'] = len(get('cad-designer').events)
# a task that fails stops the ones after it
get('accountant').new(); n_cad = len(get('cad-designer').events)
lead.send('PLANBAD', 'application: demo'); settle(lambda: 'did not finish' in (notes() or [''])[-1])
res['bad_notes'] = [e['text'] for e in lead.events if e['type'] == 'note'][-3:]
res['acc_untouched'] = get('accountant').events == []
shutil.rmtree(tmp)
print(json.dumps(res))`], { cwd: new URL('viewer/', ROOT), encoding: 'utf8' }));
  // the colleagues got their task, marked as coming from the Lead engineer, and nothing of the lead's conversation
  assert.deepEqual(out.cad[0].slice(0, 2), ['user', 'Lead engineer']);
  assert.equal(out.cad[0][2], 'place the tray SECRETLESS');
  assert.match(out.cad[1][2], /^GOT \[This task was handed to you by the Lead engineer, not typed by the user[\s\S]*place the tray SECRETLESS$/);
  for (const who of ['cad', 'prog', 'acc']) assert.ok(!JSON.stringify(out[who]).includes('MANGO'), `${who} was given the lead's conversation`);
  assert.equal(out.prog[0][2], 'write the pick step');
  assert.equal(out.acc[0][2], 'cost it');
  // in the lead's chat: who it was handed to and that they finished, in the order listed; an unknown agent is skipped
  assert.deepEqual(out.order, ['cad-designer', 'cad-designer', 'programmer', 'programmer', 'accountant', 'accountant']);
  assert.deepEqual(out.lead.filter(e => e[0] === 'note').map(e => e[2]).slice(0, 2), ['handed to the CAD designer', 'the CAD designer has finished']);
  // the results reach the lead with the user's next message
  assert.match(out.report, /^GOT \[Since your last message, the colleagues you handed work to have reported:[\s\S]*CAD designer — done with the task “place the tray SECRETLESS”\. Its reply:\nGOT[\s\S]*Accountant — done[\s\S]*what came back\?$/);
  // only an agent whose file says hands_off may do this
  assert.deepEqual(out.prog_notes, []);
  assert.equal(out.cad_after, 3, 'the Programmer\'s handoff block must not start anyone (the CAD designer still has its one task: message, reply, end)');
  // a failure stops the chain and says what was not started
  assert.deepEqual(out.bad_notes, ['the CAD designer has finished', 'handed to the Programmer', 'the Programmer did not finish (tool exploded); 1 later task not started']);
  assert.ok(out.acc_untouched, 'a task after a failed one was started');
});
