// Dialogs drawn in the page: a question with a text field, a choice
// between buttons, a message. The browser's own prompt(), confirm() and
// alert() open nothing when the page runs as an installed app (an artifact
// frame answers them at once with null / false), so the viewer never uses
// them.

function open(message, build) {
  return new Promise(resolve => {
    const veil = document.createElement('div');
    veil.className = 'dlg-veil';
    const box = document.createElement('div');
    box.className = 'dlg';
    box.setAttribute('role', 'dialog');
    const text = document.createElement('div');
    text.className = 'dlg-text';
    text.textContent = message;
    box.appendChild(text);
    const done = value => { document.removeEventListener('keydown', onKey, true); veil.remove(); resolve(value); };
    const onKey = ev => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); done(null); } };
    document.addEventListener('keydown', onKey, true);
    veil.addEventListener('pointerdown', ev => { if (ev.target === veil) done(null); });
    build(box, done);
    veil.appendChild(box);
    document.body.appendChild(veil);
    (box.querySelector('input') ?? box.querySelector('button.primary') ?? box.querySelector('button'))?.focus();
  });
}

const row = box => { const r = document.createElement('div'); r.className = 'dlg-row'; box.appendChild(r); return r; };
const button = (label, primary) => {
  const b = document.createElement('button');
  b.type = 'button'; b.textContent = label;
  if (primary) b.className = 'primary';
  return b;
};

/** A question answered by typing. Resolves the text, or null if dismissed. */
export function ask(message, { placeholder = '', value = '', ok = 'OK' } = {}) {
  return open(message, (box, done) => {
    const input = document.createElement('input');
    input.type = 'text'; input.placeholder = placeholder; input.value = value;
    box.appendChild(input);
    const r = row(box), cancel = button('Cancel'), go = button(ok, true);
    cancel.onclick = () => done(null);
    go.onclick = () => done(input.value);
    input.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); done(input.value); } });
    r.append(cancel, go);
  });
}

/** A choice: options = [{ label, value, primary? }]. Resolves the picked value, or null if dismissed. */
export function choose(message, options) {
  return open(message, (box, done) => {
    const r = row(box);
    for (const o of options) { const b = button(o.label, o.primary); b.onclick = () => done(o.value); r.appendChild(b); }
  });
}

/** A message to read. Resolves when closed. */
export function tell(message) {
  return choose(message, [{ label: 'OK', value: true, primary: true }]);
}
