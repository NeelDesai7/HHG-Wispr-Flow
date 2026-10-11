// The Calendar tab. Default is a full month grid (like a wall calendar): every date on one
// screen, each task shown as a short pill with its time. A Week toggle gives the hour-by-hour
// view with the auto-scheduler's suggestions. Everything is served only from this laptop.
import { $, el, api, ymd } from './dom.js';

const DAY_MS = 864e5;
const WD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

let slots = [];
let tasks = [];
let feed = null;
let prefs = { dayStart: '08:00', dayEnd: '21:00', slotMinutes: 30 };
let view = 'month';
let monthAnchor = firstOfMonth(new Date());
let weekStart = mondayOf(new Date());
let built = false;

const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
function mondayOf(d) { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; }
function firstOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

export async function loadCalendar() {
  try {
    const [cal, t] = await Promise.all([api('/api/calendar'), api('/api/tasks')]);
    slots = cal.slots; feed = cal.feed; prefs = cal.prefs;
    tasks = t.open;
  } catch { /* keep last */ }
  if (built) renderCalendar();
}

async function setTime(id, body) { await api(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(body) }); await loadCalendar(); }

export function renderCalendar() {
  built = true;
  if (view === 'month') renderMonth(); else renderWeek();
  renderSync();
}

// ── month view ──────────────────────────────────────────

function monthPill(t) {
  const late = t.due_date && new Date(`${t.due_date}T${t.due_time ?? '23:59'}:00`) < new Date();
  const timed = t.due_time ? t.due_time : null;
  const pill = el('div', { className: `mpill p${t.priority}${late ? ' late' : ''}`, title: `${timed ? timed + ' · ' : ''}${t.title}${t.person ? ' · ' + t.person : ''}` },
    timed ? el('span', { className: 'mt', textContent: timed }) : null,
    el('span', { className: 'mtitle', textContent: t.title }));
  return pill;
}

function renderMonth() {
  const grid = $('#calgrid');
  grid.className = 'monthgrid';
  grid.style.gridTemplateRows = '';
  const today = ymd(new Date());
  const year = monthAnchor.getFullYear();
  const month = monthAnchor.getMonth();

  // Tasks on each date.
  const byDate = new Map();
  for (const t of tasks) {
    if (!t.due_date) continue;
    if (!byDate.has(t.due_date)) byDate.set(t.due_date, []);
    byDate.get(t.due_date).push(t);
  }
  for (const list of byDate.values()) list.sort((a, b) => (a.due_time ?? '99').localeCompare(b.due_time ?? '99') || a.priority - b.priority);

  const cells = WD.map((d) => el('div', { className: 'mhead', textContent: d }));

  const start = mondayOf(firstOfMonth(monthAnchor));
  const weeks = Math.ceil((((firstOfMonth(monthAnchor).getDay() + 6) % 7) + new Date(year, month + 1, 0).getDate()) / 7);
  const total = weeks * 7;
  for (let i = 0; i < total; i++) {
    const date = addDays(start, i);
    const key = ymd(date);
    const inMonth = date.getMonth() === month;
    const cell = el('div', { className: `mcell${inMonth ? '' : ' other'}${key === today ? ' today' : ''}` });
    cell.append(el('div', { className: 'mdate' }, el('span', { textContent: String(date.getDate()) })));
    const list = byDate.get(key) ?? [];
    const max = 4;
    for (const t of list.slice(0, max)) cell.append(monthPill(t));
    if (list.length > max) {
      const more = el('button', { className: 'mmore', textContent: `+${list.length - max} more` });
      more.addEventListener('click', () => openDay(date, list));
      cell.append(more);
    }
    if (list.length) cell.addEventListener('dblclick', () => openDay(date, list));
    cells.push(cell);
  }
  grid.style.setProperty('--weeks', weeks);
  grid.replaceChildren(...cells);

  $('#cal-range').textContent = `${MON[month]} ${year}`;
  closeDay();
}

function openDay(date, list) {
  closeDay();
  const pop = el('div', { className: 'daypop', id: 'daypop' },
    el('div', { className: 'daypop-h' },
      el('b', { textContent: `${WD[(date.getDay() + 6) % 7]} ${date.getDate()} ${MONS[date.getMonth()]}` }),
      (() => { const x = el('button', { className: 'iconbtn', textContent: '×' }); x.addEventListener('click', closeDay); return x; })()),
    ...list.map((t) => el('div', { className: 'daypop-row' },
      el('span', { className: `dot p${t.priority}` }),
      el('span', { className: 'dt', textContent: t.due_time ?? '—' }),
      el('span', { className: 'dttl', textContent: t.title }))));
  $('#view-calendar').append(pop);
}
function closeDay() { const p = $('#daypop'); if (p) p.remove(); }

// ── week view (hour grid with auto-schedule) ────────────

const dateOfWeek = (offset) => addDays(weekStart, offset);

function eventBlock(slot, col, startMin, slotMinutes) {
  const t = slot.task;
  const rowStart = 2 + (toMin(slot.start) - startMin) / slotMinutes;
  const rowEnd = 2 + (toMin(slot.end) - startMin) / slotMinutes;
  const block = el('div', { className: `ev p${t.priority} ${slot.suggested ? 'suggested' : 'fixed'}`, title: `${t.title} · ${slot.start}` });
  block.style.gridColumn = `${col}`;
  block.style.gridRow = `${rowStart} / ${rowEnd}`;
  block.append(el('div', { className: 'ev-time', textContent: slot.start }), el('div', { className: 'ev-title', textContent: t.title }));
  if (slot.suggested) {
    const ok = el('button', { className: 'ev-act', title: 'Keep this time', textContent: '✓' });
    ok.addEventListener('click', (e) => { e.stopPropagation(); setTime(t.id, { due_date: slot.date, due_time: slot.start }); });
    const clr = el('button', { className: 'ev-act', title: 'Remove suggestion', textContent: '×' });
    clr.addEventListener('click', (e) => { e.stopPropagation(); setTime(t.id, { due_date: t.due_date, due_time: null }); });
    block.append(el('div', { className: 'ev-acts' }, ok, clr));
  }
  return block;
}

function renderWeek() {
  const grid = $('#calgrid');
  grid.className = 'calgrid';
  const startMin = toMin(prefs.dayStart);
  const rows = (toMin(prefs.dayEnd) - startMin) / prefs.slotMinutes;
  const today = ymd(new Date());
  grid.style.gridTemplateRows = `auto repeat(${rows}, var(--slot-h, 22px))`;
  grid.style.setProperty('--weeks', '');
  const cells = [el('div', { className: 'cal-corner' })];
  for (let d = 0; d < 7; d++) {
    const date = dateOfWeek(d);
    cells.push(el('div', { className: `cal-dayhead${ymd(date) === today ? ' today' : ''}` }, el('b', { textContent: WD[d] }), ` ${date.getDate()}`));
  }
  for (let r = 0; r < rows; r++) {
    const min = startMin + r * prefs.slotMinutes;
    const tcell = el('div', { className: 'cal-time', textContent: min % 60 === 0 ? `${String(Math.floor(min / 60)).padStart(2, '0')}:00` : '' });
    tcell.style.gridRow = `${r + 2} / ${r + 3}`; tcell.style.gridColumn = '1';
    cells.push(tcell);
  }
  for (let d = 0; d < 7; d++) {
    const date = dateOfWeek(d);
    const col = el('div', { className: `cal-col${ymd(date) === today ? ' today' : ''}` });
    col.style.gridColumn = `${d + 2}`; col.style.gridRow = `2 / ${rows + 2}`;
    cells.push(col);
  }
  for (let d = 0; d < 7; d++) {
    const date = dateOfWeek(d);
    for (const slot of slots.filter((s) => s.date === ymd(date))) cells.push(eventBlock(slot, d + 2, startMin, prefs.slotMinutes));
  }
  grid.replaceChildren(...cells);
  const end = dateOfWeek(6);
  $('#cal-range').textContent = `${weekStart.getDate()} ${MONS[weekStart.getMonth()]} – ${end.getDate()} ${MONS[end.getMonth()]} ${end.getFullYear()}`;
  closeDay();
}

// ── sync panel ──────────────────────────────────────────

function renderSync() {
  const body = $('#sync-body');
  if (!feed) return;
  const u = new URL(feed.url);
  const webcal = `webcal://${u.host}${u.pathname}${u.search}`;
  body.replaceChildren(
    el('p', { className: 'muted', textContent: 'Your tasks as a live calendar, served only from this laptop. Subscribe to keep it updated, or download a one-time file. Nothing is uploaded.' }),
    el('div', { className: 'syncrow' }, el('input', { readOnly: true, value: feed.url, onclick() { this.select(); } }), copyBtn(feed.url)),
    el('div', { className: 'syncrow' },
      el('a', { className: 'btn', href: feed.download, download: 'vachan.ics', textContent: '⤓ Download .ics' }),
      el('a', { className: 'btn', href: webcal, textContent: 'Subscribe in calendar app' })),
    el('p', { className: 'muted', textContent: 'Outlook / Apple Calendar: subscribe to the URL. Windows Calendar: open the downloaded file. Google Calendar (cloud) can’t reach this laptop, so use the file.' }));
}

function copyBtn(text) {
  const b = el('button', { className: 'btn', textContent: 'Copy' });
  b.addEventListener('click', async () => { try { await navigator.clipboard.writeText(text); b.textContent = 'Copied'; setTimeout(() => (b.textContent = 'Copy'), 1500); } catch { /* */ } });
  return b;
}

// ── nav ─────────────────────────────────────────────────

export function initCalendar() {
  $('#cal-prev').addEventListener('click', () => { step(-1); });
  $('#cal-next').addEventListener('click', () => { step(1); });
  $('#cal-today').addEventListener('click', () => { monthAnchor = firstOfMonth(new Date()); weekStart = mondayOf(new Date()); renderCalendar(); });
  for (const b of document.querySelectorAll('#cal-view .seg')) b.addEventListener('click', () => {
    for (const x of document.querySelectorAll('#cal-view .seg')) x.classList.toggle('on', x === b);
    view = b.dataset.cal;
    renderCalendar();
  });
}

function step(dir) {
  if (view === 'month') monthAnchor = new Date(monthAnchor.getFullYear(), monthAnchor.getMonth() + dir, 1);
  else weekStart = new Date(weekStart.getTime() + dir * 7 * DAY_MS);
  renderCalendar();
}
