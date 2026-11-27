// The step list in the dock: one column — the loop's steps in order, and
// right below them the steps that are not in the loop. Rows are dragged to
// reorder the loop or to move a step in or out of it; the order is saved
// to the application's loop.ts by the server. The rules live in
// step-order.js; this file is the DOM.
import { sections, moveStep } from './step-order.js';

const MARK = { idle: '', running: '▶', done: '✓', failed: '✗', stopped: '■' };

/**
 * opts: { el, steps, loop: { name, steps }, onSelect(step), onRun(step),
 *         onSave(stepIds) -> Promise }
 * Returns { select(id), setState(id, state), selected() }.
 */
export function createStepsPanel({ el, steps, loop, onSelect, onRun, onSave }) {
  let selected = null;
  let order = [...(loop?.steps ?? [])];
  const state = new Map();           // step id -> 'running' | 'done' | 'failed' | 'stopped'
  let dragging = null;               // id of the row being dragged
  const marker = document.createElement('div');
  marker.className = 'steps-drop';

  function render() {
    marker.remove();
    el.innerHTML = '';
    const { loop: inLoop, free } = sections(steps, { steps: order });
    el.appendChild(section(true, `Loop · ${loop?.name ?? 'loop'}`, inLoop, 'drag a step here to put it in the loop'));
    el.appendChild(section(false, 'Not in the loop', free, 'every step is in the loop'));
  }

  function section(isLoop, title, list, emptyText) {
    const box = document.createElement('div');
    box.className = 'steps-sec' + (isLoop ? '' : ' steps-free');
    const head = document.createElement('div');
    head.className = 'steps-head';
    head.textContent = title;
    box.appendChild(head);
    list.forEach((s, i) => box.appendChild(row(s, isLoop, i)));
    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'steps-empty';
      empty.textContent = emptyText;
      box.appendChild(empty);
    }
    box.addEventListener('dragover', ev => over(ev, box));
    box.addEventListener('drop', ev => drop(ev, box, isLoop));
    return box;
  }

  function row(s, isLoop, i) {
    const r = document.createElement('div');
    const st = state.get(s.id) ?? 'idle';
    r.className = `step-row st-${st}` + (s.id === selected ? ' sel' : '');
    r.draggable = true;
    r.dataset.id = s.id;
    r.title = `${s.id}.ts${s.tool ? ` · ${s.tool}` : ''} — drag to reorder`;
    r.innerHTML = '<span class="grip">⠿</span><span class="num"></span><span class="name"></span>' +
      '<span class="mark"></span><button title="run this step">▶</button>';
    r.querySelector('.num').textContent = isLoop ? String(i + 1) : '·';
    r.querySelector('.name').textContent = s.name ?? s.id;
    r.querySelector('.mark').textContent = MARK[st];
    r.addEventListener('click', ev => { if (ev.target.tagName !== 'BUTTON') select(s.id); });
    r.querySelector('button').addEventListener('click', () => { select(s.id); onRun(s); });
    r.addEventListener('dragstart', ev => {
      dragging = s.id;
      ev.dataTransfer.effectAllowed = 'move';
      ev.dataTransfer.setData('text/plain', s.id);
      r.classList.add('dragging');
    });
    r.addEventListener('dragend', () => { dragging = null; marker.remove(); r.classList.remove('dragging'); });
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
    if (!dragging) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'move';
    const { before } = slot(ev, box);
    if (before) box.insertBefore(marker, before);
    else box.appendChild(marker);
  }
  async function drop(ev, box, isLoop) {
    if (!dragging) return;
    ev.preventDefault();
    const res = moveStep(order, dragging, isLoop, slot(ev, box).index);
    dragging = null;
    if (!res.changed) { render(); return; }
    const before = order;
    order = res.steps;
    render();
    try {
      await onSave(order);
    } catch (e) {
      order = before;                 // not saved: show what is on disk
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
