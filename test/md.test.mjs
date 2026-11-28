// The markdown of an agent's reply, as the chat shows it (viewer/md.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rich, inline } from '../viewer/md.js';

test('a table becomes a table: a header, a row per line, links and bold inside the cells', () => {
  const html = rich([
    'The list, short form:',
    '',
    '| item | pick | price |',
    '|---|---|---:|',
    '| Solder pot | **TOAUTO FT-50**, 50 mm — [Amazon](https://www.amazon.com/TOAUTO-200-450%E2%84%83/dp/B08G4NDJY4) | ~$26–36 |',
    '| — alternatives | Aven 17100-150 ($23.35) | |',
    '',
    'My pick is the TOAUTO.',
  ].join('\n'));
  assert.match(html, /^<p>The list, short form:<\/p><div class="md-table"><table><thead><tr><th>item<\/th><th>pick<\/th><th style="text-align:right">price<\/th>/);
  assert.equal(html.match(/<tr>/g).length, 3);
  assert.match(html, /<b>TOAUTO FT-50<\/b>, 50 mm — <a href="https:\/\/www\.amazon\.com\/TOAUTO-200-450%E2%84%83\/dp\/B08G4NDJY4" target="_blank" rel="noopener noreferrer">Amazon<\/a>/);
  assert.match(html, /<td>Aven 17100-150 \(\$23\.35\)<\/td><td style="text-align:right"><\/td><\/tr>/);   // an empty cell is still a cell
  assert.match(html, /<\/table><\/div><p>My pick is the TOAUTO\.<\/p>$/);
  assert.ok(!html.includes('|'), 'no pipe is left on show');
});

test('a | inside code or written \\| does not split a cell; a short row is filled out', () => {
  const html = rich('| a | b |\n|---|---|\n| `x | y` | p \\| q |\n| only |');
  assert.match(html, /<td><code>x \| y<\/code><\/td><td>p \| q<\/td>/);
  assert.match(html, /<td>only<\/td><td><\/td>/);
});

test('inline: code, bold, italic, links, bare URLs — and names with underscores left alone', () => {
  assert.equal(inline('use `a*b*c` and **bold** and *it* here'), 'use <code>a*b*c</code> and <b>bold</b> and <i>it</i> here');
  assert.equal(inline('lip_centre_flange_m and 2 * 3 * 4'), 'lip_centre_flange_m and 2 * 3 * 4');
  assert.equal(inline('see https://example.com/a_b_c.'),
    'see <a href="https://example.com/a_b_c" target="_blank" rel="noopener noreferrer">https://example.com/a_b_c</a>.');
  assert.match(inline('[wiki](https://en.wikipedia.org/wiki/Flux_(metallurgy)) ok'), /href="https:\/\/en\.wikipedia\.org\/wiki\/Flux_\(metallurgy\)"[^>]*>wiki<\/a> ok$/);
});

test('nothing a message says becomes markup of its own', () => {
  assert.equal(rich('<img src=x onerror=alert(1)>'), '<p>&lt;img src=x onerror=alert(1)&gt;</p>');
  assert.equal(inline('[x](javascript:alert(1))'), '[x](javascript:alert(1))');
  assert.ok(!inline('[x](https://a.b/"onmouseover="x)').includes('"onmouseover'));
  assert.equal(rich('```\n<b>&</b>\n```'), '<pre><code>&lt;b&gt;&amp;&lt;/b&gt;</code></pre>');
});

test('headings, lists inside lists, numbered lists, quotes, rules, and line breaks kept in a paragraph', () => {
  assert.equal(rich('## Plan\n- one\n  - inner\n- two\n\n3. three\n4. four'),
    '<h2>Plan</h2><ul><li>one<ul><li>inner</li></ul></li><li>two</li></ul><ol start="3"><li>three</li><li>four</li></ol>');
  assert.equal(rich('first\nsecond\n\n---\n> said'), '<p>first<br>second</p><hr><blockquote><p>said</p></blockquote>');
  assert.equal(rich('```js\nconst a = 1;\n```\nafter'), '<pre><code>const a = 1;</code></pre><p>after</p>');
});
