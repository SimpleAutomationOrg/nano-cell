// The step list in the panel: a vertical list with one section per loop
// (its steps in order) and one for the steps in no loop. Rows are dragged
// to reorder them or to move them between sections; the order is saved to
// the application's loops.ts by the server. The rules live in
// step-order.js; this file is the DOM.
import { sections, moveStep } from './step-order.js';

const MARK = { idle: '', running: '▶', done: '✓', failed: '✗', stopped: '■' };

/**
 * opts: { el, steps, loops, onSelect(step), onRun(step), onSave(loop) -> Promise }
 * Returns { select(id), setState(id, state), selected() }.
 */
export function createStepsPanel({ el, steps, loops, onSelect, onRun, onSave }) {
  let selected = null;
  const state = new Map();           // step id -> 'running' | 'done' | 'failed' | 'stopped'
  let drag = null;                   // { id, from } while a row is being dragged
  const marker = document.createElement('div');
  marker.className = 'steps-drop';

  function render() {
    marker.remove();
    el.innerHTML = '';
    for (const sec of sections(steps, loops)) {
      const box = document.createElement('div');
      box.className = 'steps-sec' + (sec.loop === null ? ' steps-free' : '');
      box.dataset.loop = sec.loop ?? '';
      const head = document.createElement('div');
      head.className = 'steps-head';
      head.textContent = sec.loop === null ? sec.name : `Loop · ${sec.name}`;
      box.appendChild(head);
      sec.steps.forEach((s, i) => box.appendChild(row(s, sec.loop, i)));
      if (!sec.steps.length) {
        const empty = document.createElement('div');
        empty.className = 'steps-empty';
        empty.textContent = sec.loop === null ? 'every step is in a loop' : 'drag a step here';
        box.appendChild(empty);
      }
      box.addEventListener('dragover', ev => over(ev, box));
      box.addEventListener('drop', ev => drop(ev, box));
      el.appendChild(box);
    }
  }

  function row(s, loop, i) {
    const r = document.createElement('div');
    const st = state.get(s.id) ?? 'idle';
    r.className = `step-row st-${st}` + (s.id === selected ? ' sel' : '');
    r.draggable = true;
    r.dataset.id = s.id;
    r.title = `${s.id}.ts${s.tool ? ` · ${s.tool}` : ''} — drag to reorder`;
    r.innerHTML = '<span class="grip">⠿</span><span class="num"></span><span class="name"></span>' +
      '<span class="mark"></span><button title="run this step">▶</button>';
    r.querySelector('.num').textContent = loop === null ? '·' : String(i + 1);
    r.querySelector('.name').textContent = s.name ?? s.id;
    r.querySelector('.mark').textContent = MARK[st];
    r.addEventListener('click', ev => { if (ev.target.tagName !== 'BUTTON') select(s.id); });
    r.querySelector('button').addEventListener('click', () => { select(s.id); onRun(s); });
    r.addEventListener('dragstart', ev => {
      drag = { id: s.id, from: loop };
      ev.dataTransfer.effectAllowed = 'move';
      ev.dataTransfer.setData('text/plain', s.id);
      r.classList.add('dragging');
    });
    r.addEventListener('dragend', () => { drag = null; marker.remove(); r.classList.remove('dragging'); });
    return r;
  }

  // where in `box` a drop at this height lands: before the first row whose
  // middle is below the pointer, else at the end
  function slot(ev, box) {
    const rows = [...box.querySelectorAll('.step-row')];
    const i = rows.findIndex(r => { const b = r.getBoundingClientRect(); return ev.clientY < b.top + b.height / 2; });
    return { index: i < 0 ? rows.length : i, before: i < 0 ? null : rows[i] };
  }
  function over(ev, box) {
    if (!drag) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'move';
    const { before } = slot(ev, box);
    if (before) box.insertBefore(marker, before);
    else box.appendChild(marker);
  }
  async function drop(ev, box) {
    if (!drag) return;
    ev.preventDefault();
    const to = box.dataset.loop || null;
    const { index } = slot(ev, box);
    const res = moveStep(loops, drag.id, drag.from, to, index);
    drag = null;
    if (!res.changed.length) { render(); return; }
    const before = loops;
    loops = res.loops;
    render();
    try {
      for (const id of res.changed) await onSave(loops.find(l => l.id === id));
    } catch (e) {
      loops = before;                 // not saved: show what is on disk
      render();
      throw e;
    }
  }

  function select(id) {
    const s = steps.find(x => x.id === id);
    if (!s) return;
    selected = id;
    render();
    onSelect(s);
  }

  render();
  return {
    select,
    selected: () => selected,
    setState(id, st) { state.set(id, st); render(); },
  };
}
