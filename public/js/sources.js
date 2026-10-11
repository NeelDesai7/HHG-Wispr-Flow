// The Sources tab: the tasks Vachan derived, grouped by the person or the app they came from,
// plus the phone feed (per-app counts, read→decide→forget) and a paste box to try it.
import { $, el, api } from './dom.js';
import { dueLabel } from './tasks.js';

let feed = { apps: [], totals: { read: 0, tasked: 0, withheld: 0, apps: 0 } };
let pairing = null;
let group = 'person';

export function phoneChip() { return feed.totals; }

// ── derived task list, grouped by provenance ────────────

function chip(cls, text) { return text ? el('span', { className: `chip ${cls}`, textContent: text }) : null; }

function derivedRow(t) {
  return el('div', { className: 'task' },
    el('div', { className: 'check', style: 'border:0;color:var(--muted)', textContent: '•' }),
    el('div', { className: 'body' },
      el('div', { className: 'title', textContent: t.title }),
      t.details ? el('div', { className: 'det', textContent: t.details }) : null,
      el('div', { className: 'chips' },
        chip('due', dueLabel(t)),
        t.kind ? chip('', t.kind) : null,
        t.status !== 'open' ? chip('', t.status === 'done' ? 'done' : 'dropped') : null)));
}

function groupKey(t) {
  if (group === 'person') return t.person || '';
  return t.source_app || (t.source === 'voice' ? 'Spoken out loud' : t.source === 'typed' ? 'Typed by you' : 'Other');
}
const groupNote = (key) => group === 'person'
  ? (key ? `what you've committed with ${key}` : 'no particular person')
  : `tasks derived from ${key}`;

export async function renderDerived() {
  let tasks = [];
  try { tasks = (await api('/api/tasks')).open; } catch { /* */ }
  const groups = new Map();
  for (const t of tasks) {
    const k = groupKey(t);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  // Named groups first (bigger first), unnamed/"just you" last.
  const order = [...groups.entries()].sort((a, b) => {
    if (!a[0] && b[0]) return 1;
    if (a[0] && !b[0]) return -1;
    return b[1].length - a[1].length;
  });

  const blocks = [];
  for (const [key, list] of order) {
    blocks.push(el('div', { className: 'src-group-h' },
      el('span', { textContent: group === 'person' ? (key || 'Just you') : key }),
      el('span', { className: 'from', textContent: `· ${groupNote(key)}` })));
    for (const t of list) blocks.push(derivedRow(t));
  }
  if (!order.length) blocks.push(el('div', { className: 'empty-state', textContent: 'No tasks yet. They’ll appear here grouped by who or which app they came from.' }));
  $('#derived').replaceChildren(...blocks);
  $('#src-summary').textContent = `${tasks.length} open · grouped by ${group === 'person' ? 'person' : 'app'}`;
}

export function setSrcGroup(g) { group = g; renderDerived(); }

// ── phone feed ──────────────────────────────────────────

export async function loadSources() {
  try { feed = await api('/api/sources'); } catch { /* */ }
  renderFeed();
}

export async function loadPairing() {
  try { pairing = await api('/api/pairing'); } catch { pairing = null; }
  renderFeed();
}

function renderFeed() {
  const { apps, totals } = feed;
  $('#phone-forget').textContent = totals.read
    ? `${totals.read} read · ${totals.tasked} tasks · ${totals.withheld} withheld, then forgotten`
    : '';
  const rows = apps.map((a) => el('tr', {},
    el('td', { textContent: a.app }),
    el('td', { className: 'r', textContent: [`${a.read} read`, a.tasked ? `${a.tasked}→tasks` : null, a.withheld ? `${a.withheld} withheld` : null].filter(Boolean).join(' · ') })));
  $('#sources').replaceChildren(...rows);

  $('#phone-note').textContent = totals.read
    ? 'Raw notifications are read, turned into tasks, then forgotten — only these counts and the tasks remain.'
    : 'Notifications and messages from your phone become tasks here. Connect your phone (Settings → Phone) or try it below.';
}

// ── try box ─────────────────────────────────────────────

function parseLine(line) {
  const [head, ...rest] = line.split('|');
  if (!rest.length) return { app: 'Pasted', kind: 'notification', body: line.trim() };
  const after = rest.join('|').trim();
  const [maybeTitle, ...msg] = after.split(':');
  return msg.length
    ? { app: head.trim() || 'Pasted', kind: 'notification', title: maybeTitle.trim(), body: msg.join(':').trim() }
    : { app: head.trim() || 'Pasted', kind: 'notification', body: after };
}

export function initTryBox() {
  const btn = $('#try-send');
  const area = $('#try-text');
  const st = $('#try-state');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const events = area.value.split('\n').map((l) => l.trim()).filter(Boolean).map(parseLine);
    if (!events.length) return;
    if (!pairing) { try { pairing = await api('/api/pairing'); } catch { /* */ } }
    btn.disabled = true;
    st.className = 'quick-state';
    st.textContent = 'Feeding…';
    try {
      const r = await fetch('/api/ingest', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pairing?.token}` }, body: JSON.stringify({ events }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.statusText);
      st.textContent = `${d.read} read · ${d.tasked} → tasks · ${d.withheld} withheld`;
      area.value = '';
      loadSources();
      renderDerived();
    } catch (err) { st.className = 'quick-state err'; st.textContent = err.message; }
    finally { btn.disabled = false; }
  });
}
