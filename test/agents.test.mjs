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
chats = chat.Chats('..')
ids = [a['id'] for a in chats.agents()]
polled = [chats.get(i).poll(-1, 0, timeout=0)['events'] for i in ids]
print(json.dumps({'agents': chat.load_agents('..'), 'extra': sorted(chat.EXTRA_TOOLS),
  'polled': polled, 'answers': chats.answers(), 'busy': chats.busy(), 'unknown': chats.get('no-such-agent') is None}))`],
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
  assert.ok(loaded.unknown, 'an unknown agent has no conversation');
});

test('an agent gets only the extra tools the server allows, and every one it asks for is one of those', () => {
  for (const a of loaded.agents) {
    const head = readFileSync(new URL(`agents/${a.id}.md`, ROOT), 'utf8').match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
    const asked = (head.match(/^tools:\s*(.*)$/m)?.[1] ?? '').split(',').map(s => s.trim()).filter(Boolean);
    for (const t of asked) assert.ok(loaded.extra.includes(t), `agents/${a.id}.md asks for '${t}', which the server does not grant (EXTRA_TOOLS in viewer/chat.py)`);
    assert.deepEqual(a.tools, asked);
  }
});
