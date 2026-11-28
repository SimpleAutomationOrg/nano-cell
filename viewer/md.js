// The markdown an agent writes in the chat, as HTML.
//
// An agent's replies are markdown: paragraphs, headings, lists, tables,
// links, code. This turns one message into HTML for the chat log. It covers
// what agents actually write, not the whole of markdown; anything it does
// not know stays as the text that was written. Everything is escaped before
// any tag is added, and a link is only made for http(s) and mailto, so a
// message can never put markup of its own in the page.
// Pure (no DOM): chat.js draws it, the tests cover it.

const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---- inside a line: `code`, [links](url), bare URLs, **bold**, *italic*, ~~struck~~ ----
const HOLD = '\u0000';                                   // marks a finished piece while the rest is worked on
const URL_BODY = String.raw`[^\s<>()]+(?:\([^\s<>()]*\)[^\s<>()]*)*`;      // may hold (one level of) brackets
const LINK = new RegExp(String.raw`\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)${URL_BODY})\)`, 'g');
const BARE = new RegExp(String.raw`https?:\/\/${URL_BODY}`, 'g');
const anchor = (url, html) => `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${html}</a>`;

function emphasis(text) {
  return esc(text)
    .replace(/\*\*([^\s*](?:[^\n]*?[^\s*])?)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^\w*])\*([^\s*](?:[^*\n]*[^\s*])?)\*(?![\w*])/g, '$1<i>$2</i>')
    .replace(/(^|[^\w_])_([^\s_](?:[^_\n]*[^\s_])?)_(?![\w_])/g, '$1<i>$2</i>')
    .replace(/~~([^~\n]+)~~/g, '<s>$1</s>');
}

/** One line of text (no block structure) as HTML. */
export function inline(text) {
  const held = [];
  const hold = html => `${HOLD}${held.push(html) - 1}${HOLD}`;
  const out = text.replaceAll(HOLD, '')
    .replace(/`([^`\n]+)`/g, (_, code) => hold(`<code>${esc(code)}</code>`))
    .replace(LINK, (_, label, url) => hold(anchor(url, emphasis(label))))
    .replace(BARE, url => {
      const tail = /[.,;:!?'"]+$/.exec(url)?.[0] ?? '';   // the full stop after a URL is the sentence's
      const u = tail ? url.slice(0, -tail.length) : url;
      return hold(anchor(u, esc(u))) + tail;
    });
  // a label may itself hold `code`: put pieces back until none is left
  let html = emphasis(out);
  for (let n = 0; n < 3 && html.includes(HOLD); n++) html = html.replace(/\u0000(\d+)\u0000/g, (_, i) => held[+i]);
  return html;
}

// ---- blocks ----
const FENCE = /^\s*```/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

// the cells of a table row; a | inside `code` or written \| is not a divider
function cells(line) {
  const out = [];
  let cell = '', code = false;
  const s = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && s[i + 1] === '|') { cell += '|'; i++; }
    else if (c === '`') { code = !code; cell += c; }
    else if (c === '|' && !code) { out.push(cell.trim()); cell = ''; }
    else cell += c;
  }
  out.push(cell.trim());
  return out;
}
const isTable = (lines, i) => lines[i].includes('|') && i + 1 < lines.length
  && lines[i + 1].includes('-') && lines[i + 1].includes('|') && TABLE_RULE.test(lines[i + 1]);

function table(head, rule, rows) {
  const align = cells(rule).map(c => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : ''));
  const cell = (tag, c, i) => `<${tag}${align[i] ? ` style="text-align:${align[i]}"` : ''}>${inline(c ?? '')}</${tag}>`;
  const n = head.length;
  return '<div class="md-table"><table><thead><tr>' + head.map((c, i) => cell('th', c, i)).join('') + '</tr></thead><tbody>'
    + rows.map(r => '<tr>' + Array.from({ length: n }, (_, i) => cell('td', r[i], i)).join('') + '</tr>').join('')
    + '</tbody></table></div>';
}

// a list, with lists inside it by indentation
function list(items) {
  const base = Math.min(...items.map(it => it.indent));
  const tag = /\d/.test(items[0].mark) ? 'ol' : 'ul';
  const start = tag === 'ol' && parseInt(items[0].mark) !== 1 ? ` start="${parseInt(items[0].mark)}"` : '';
  let html = `<${tag}${start}>`;
  for (let i = 0; i < items.length;) {
    let j = i + 1;
    while (j < items.length && items[j].indent > base + 1) j++;
    html += `<li>${items[i].lines.map(inline).join('<br>')}${j > i + 1 ? list(items.slice(i + 1, j)) : ''}</li>`;
    i = j;
  }
  return html + `</${tag}>`;
}

/** An agent's message (markdown) as HTML. */
export function rich(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  const starts = i => FENCE.test(lines[i]) || HEADING.test(lines[i]) || RULE.test(lines[i]) || ITEM.test(lines[i])
    || QUOTE.test(lines[i]) || isTable(lines, i);
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (FENCE.test(line)) {                                // code, as written (to the end if it is never closed)
      const body = [];
      for (i++; i < lines.length && !FENCE.test(lines[i]); i++) body.push(lines[i]);
      i++;
      out.push(`<pre><code>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }
    const h = HEADING.exec(line);
    if (h) { out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }
    if (RULE.test(line)) { out.push('<hr>'); i++; continue; }
    if (isTable(lines, i)) {
      const head = cells(line), rule = lines[i + 1], rows = [];
      for (i += 2; i < lines.length && lines[i].trim() && lines[i].includes('|'); i++) rows.push(cells(lines[i]));
      out.push(table(head, rule, rows));
      continue;
    }
    if (ITEM.test(line)) {
      const items = [];
      for (; i < lines.length; i++) {
        const m = ITEM.exec(lines[i]);
        const numbered = mk => /\d/.test(mk);
        // bullets after numbers (or the other way) at the list's own level: another list
        if (m && items.length && m[1].length <= items[0].indent && numbered(m[2]) !== numbered(items[0].mark)) break;
        if (m && !RULE.test(lines[i])) items.push({ indent: m[1].replace(/\t/g, '  ').length, mark: m[2], lines: [m[3]] });
        else if (lines[i].trim() && /^\s/.test(lines[i])) items.at(-1).lines.push(lines[i].trim());   // an item going on
        else if (!lines[i].trim() && i + 1 < lines.length && ITEM.test(lines[i + 1])) continue;       // a gap between items
        else break;
      }
      out.push(list(items));
      continue;
    }
    if (QUOTE.test(line)) {
      const body = [];
      for (; i < lines.length && QUOTE.test(lines[i]); i++) body.push(QUOTE.exec(lines[i])[1]);
      out.push(`<blockquote>${rich(body.join('\n'))}</blockquote>`);
      continue;
    }
    const para = [];                                       // a paragraph: its line breaks are kept
    for (; i < lines.length && lines[i].trim() && !(para.length && starts(i)); i++) para.push(lines[i].trim());
    out.push(`<p>${para.map(inline).join('<br>')}</p>`);
  }
  return out.join('');
}
