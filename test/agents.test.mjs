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
