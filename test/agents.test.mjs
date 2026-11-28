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
