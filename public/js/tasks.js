// The Tasks tab: clean task rows grouped by when they're due, with a Today / Upcoming / All filter.
import { $, el, api, ymd } from './dom.js';

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

let data = { open: [], closed: [] };
let filter = 'today';
let known = null;
const fresh = new Set();

const dayOffset = (d, now) => Math.round((new Date(`${d}T00:00:00`) - new Date(`${ymd(now)}T00:00:00`)) / 864e5);
const dueAt = (t) => new Date(`${t.due_date}T${t.due_time ?? '23:59'}:00`);

function group(t, now) {
  if (!t.due_date) return 'nodate';
  if (dueAt(t) < now) return 'overdue';
  const days = dayOffset(t.due_date, now);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  return days <= 7 ? 'week' : 'later';
}

export function dueLabel(t, now = new Date()) {
  if (!t.due_date) return '';
  const d = new Date(`${t.due_date}T00:00:00`);
  const days = dayOffset(t.due_date, now);
  let day;
  if (days === 0) day = 'Today';
  else if (days === 1) day = 'Tomorrow';
  else if (days === -1) day = 'Yesterday';
  else if (days > 1 && days < 7) day = WD[d.getDay()];
  else day = `${WD[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]}${d.getFullYear() !== now.getFullYear() ? ` ${d.getFullYear()}` : ''}`;
  return t.due_time ? `${day} ${t.due_time}` : day;
}

const byWhen = (a, b) => (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999')
  || (a.due_time ?? '99').localeCompare(b.due_time ?? '99') || a.priority - b.priority || b.id - a.id;

async function setStatus(id, status) {
  await api(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
  await loadTasks();
}
async function setPriority(id, priority) {
  await api(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify({ priority }) });
  await loadTasks();
}

function chip(cls, text) { return text ? el('span', { className: `chip ${cls}`, textContent: text }) : null; }

// Clickable priority chip — tapping it cycles 1→2→3→4, which also teaches Vachan your priorities.
function priorityChip(t) {
  const why = t.priority_reason ? `${t.priority_reason}. ` : '';
  const b = el('button', { className: `chip pr p${t.priority}`, textContent: `P${t.priority}`, title: `${why}Click to change priority` });
  b.addEventListener('click', (e) => { e.stopPropagation(); setPriority(t.id, (t.priority % 4) + 1); });
  return b;
}

function taskRow(t, now) {
  const late = t.due_date && dueAt(t) < now;
  const check = el('button', { className: 'check', title: 'Mark done', textContent: '✓' });
  check.setAttribute('aria-label', `Mark "${t.title}" done`);
  check.addEventListener('click', () => setStatus(t.id, 'done'));
  const dismiss = el('button', { className: 'iconbtn', title: 'Dismiss', textContent: '×' });
  dismiss.setAttribute('aria-label', `Dismiss "${t.title}"`);
  dismiss.addEventListener('click', () => setStatus(t.id, 'dismissed'));

  const from = t.source_app ? t.source_app : t.source === 'voice' ? 'voice' : t.source === 'typed' ? 'typed' : '';
  const chips = [
    priorityChip(t),
    chip(`due ${late ? 'late' : ''}`, dueLabel(t, now)),
    chip('who', t.person),
    chip('', t.category),
    chip('', from),
  ].filter(Boolean);

  return el('div', { className: `task${fresh.has(t.id) ? ' fresh' : ''}` },
    check,
    el('div', { className: 'body' },
      el('div', { className: 'title', textContent: t.title }),
      t.details ? el('div', { className: 'det', textContent: t.details }) : null,
      t.unclear ? el('div', { className: 'warn', textContent: `⚠ ${t.unclear} · say the rest and Vachan fills it in` }) : null,
      t.priority_reason ? el('div', { className: 'whyp', textContent: `✦ ${t.priority_reason}` }) : null,
      el('div', { className: 'chips' }, ...chips)),
    el('div', { className: 'actions' }, dismiss));
}

function closedRow(t) {
  const how = t.status === 'done' ? `done ${t.done_by === 'voice' ? 'by voice' : t.done_by === 'phone' ? 'from phone' : 'by click'}`
    : t.done_by === 'brain' ? 'removed by Gemma' : 'dismissed';
  const reopen = el('button', { className: 'iconbtn', title: 'Reopen', textContent: '↺' });
  reopen.addEventListener('click', () => setStatus(t.id, 'open'));
  return el('div', { className: 'task closed' },
    el('div', { className: 'check', style: 'border:0;color:var(--ok)', textContent: t.status === 'done' ? '✓' : '–' }),
    el('div', { className: 'body' },
      el('div', { className: 'title', textContent: t.title }),
      el('div', { className: 'chips' }, chip('', how), chip('', dueLabel(t)))),
    el('div', { className: 'actions' }, reopen));
}

const GROUPS = [['overdue', 'Overdue'], ['today', 'Today'], ['tomorrow', 'Tomorrow'], ['week', 'Next 7 days'], ['later', 'Later'], ['nodate', 'No date']];
const SHOW = {
  today: new Set(['overdue', 'today']),
  upcoming: new Set(['tomorrow', 'week', 'later']),
  all: new Set(['overdue', 'today', 'tomorrow', 'week', 'later', 'nodate']),
};

export function renderTasks() {
  const now = new Date();
  const buckets = Object.fromEntries(GROUPS.map(([k]) => [k, []]));
  for (const t of data.open) buckets[group(t, now)].push(t);

  const blocks = [];
  let shown = 0;
  for (const [key, label] of GROUPS) {
    if (!SHOW[filter].has(key)) continue;
    const list = buckets[key].sort(byWhen);
    if (!list.length) continue;
    shown += list.length;
    blocks.push(el('div', { className: `group-h ${key}`, textContent: `${label} · ${list.length}` }));
    for (const t of list) blocks.push(taskRow(t, now));
  }
  if (!shown) {
    const msg = filter === 'today' ? 'Nothing due today.' : filter === 'upcoming' ? 'Nothing coming up.' : 'No open tasks yet.';
    const other = data.open.length;
    const hint = other && filter !== 'all'
      ? el('button', { className: 'btn', style: 'margin-top:10px', textContent: `See all ${other} open task${other > 1 ? 's' : ''}` })
      : el('div', { className: 'muted', style: 'margin-top:6px', textContent: 'Press Listen and say a task, or type one above.' });
    if (hint.tagName === 'BUTTON') hint.addEventListener('click', () => {
      for (const x of document.querySelectorAll('#task-filter .seg')) x.classList.toggle('on', x.dataset.filter === 'all');
      setTaskFilter('all');
    });
    blocks.push(el('div', { className: 'empty-state' }, el('div', { textContent: msg }), hint));
  }
  if (filter === 'all' && data.closed.length) {
    const det = el('details', { className: 'card' }, el('summary', { textContent: `Closed · ${data.closed.length} recent` }),
      el('div', { className: 'list', style: 'margin-top:10px' }, ...data.closed.map(closedRow)));
    blocks.push(det);
  }
  $('#tasks').replaceChildren(...blocks);

  const promises = data.open.filter((t) => t.kind === 'promise').length;
  const overdue = buckets.overdue.length;
  $('#task-counts').textContent = `${data.open.length} open · ${overdue} overdue · ${promises} promises`;
}

export function setTaskFilter(f) { filter = f; renderTasks(); }

export async function loadTasks() {
  data = await api('/api/tasks');
  const seen = new Map(data.open.map((t) => [t.id, t.updated_at]));
  if (known) for (const [id, u] of seen) {
    if (known.get(id) !== u) { fresh.add(id); setTimeout(() => { fresh.delete(id); renderTasks(); }, 6000); }
  }
  known = seen;
  renderTasks();
}

export function tasksData() { return data; }

export function initQuickAdd(getModelLabel) {
  const form = $('#quick');
  const input = $('#quick-text');
  const st = $('#quick-state');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.disabled = true;
    st.className = 'quick-state';
    st.textContent = `Reading with ${getModelLabel()}…`;
    try {
      const { applied } = await api('/api/tasks', { method: 'POST', body: JSON.stringify({ text }) });
      input.value = '';
      const done = applied.find((a) => a.op === 'complete');
      const skip = applied.find((a) => a.op === 'skip');
      st.textContent = done ? `Marked done` : applied.some((a) => a.op === 'add') ? 'Added' : skip ? `Not added: ${skip.reason}` : 'Nothing to add';
      await loadTasks();
    } catch (err) { st.className = 'quick-state err'; st.textContent = err.message; }
    finally { input.disabled = false; input.focus(); }
  });
}

setInterval(() => { if (!document.getElementById('view-tasks').hidden) renderTasks(); }, 60_000);
