// The log: every line heard or typed, interleaved with each Gemma run and what it did.
import { $, el, api, hms } from './dom.js';

let lines = [];
let runs = [];
let freshLine = null;
const openRuns = new Set(); // run rows the user expanded

const dayFmt = new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });

export async function loadLog() {
  [lines, runs] = await Promise.all([api('/api/utterances'), api('/api/runs')]);
  renderLog();
}

export function noteFreshLine(id) {
  freshLine = id;
}

async function forget(id) {
  await api(`/api/utterances/${id}`, { method: 'DELETE' });
  await loadLog();
}

function lineRow(l) {
  const x = el('button', { type: 'button', className: 'icon forget', textContent: '×', title: 'Forget this line' });
  x.setAttribute('aria-label', 'Forget this line');
  x.addEventListener('click', () => forget(l.id));
  const status = l.source === 'typed' ? '' : l.run_id == null ? 'queued' : l.run_id === 0 ? '—' : `run ${l.run_id}`;
  return el('tr', { className: l.id === freshLine ? 'fresh' : '' },
    el('td', { className: 't', textContent: hms(new Date(l.said_at)) }),
    el('td', { className: 'l', textContent: l.source === 'typed' ? 'typed' : l.lang }),
    el('td', { className: 'txt', textContent: l.text }),
    el('td', { className: `s ${l.run_id == null && l.source !== 'typed' ? 'queued' : ''}`, textContent: status }),
    el('td', { className: 'x' }, x),
  );
}

function summary(r) {
  if (r.error && !r.applied?.length) return `error: ${r.error}`;
  const n = (op) => (r.applied ?? []).filter((a) => a.op === op).length;
  const parts = [];
  if (n('add')) parts.push(`+${n('add')} task${n('add') > 1 ? 's' : ''}`);
  if (n('update')) parts.push(`~${n('update')} updated`);
  if (n('remove')) parts.push(`✗${n('remove')} removed`);
  if (n('complete')) parts.push(`✓${n('complete')} done`);
  if (n('skip')) parts.push(`${n('skip')} skipped`);
  return parts.length ? parts.join(' · ') : 'no tasks';
}

function appliedLine(a) {
  if (a.op === 'add') {
    const due = a.due_date ? ` · ${a.due_date}${a.due_time ? ` ${a.due_time}` : ''}` : '';
    const unclear = a.unclear ? ` · ⚠ ${a.unclear}` : '';
    return `+ #${a.id} ${a.title}${a.person ? ` · ${a.person}` : ''}${due} · P${a.priority}${a.confidence != null ? ` · conf ${a.confidence}` : ''}${unclear}`;
  }
  if (a.op === 'update') {
    const changes = Object.entries(a.patch ?? {}).map(([k, v]) => `${k}=${v ?? '∅'}`).join(', ');
    const why = a.refined ? ' (rest of the sentence arrived)' : a.merged ? ' (said again; merged)' : '';
    return `~ #${a.id} ${a.title}: ${changes}${why}`;
  }
  if (a.op === 'remove') return `✗ #${a.id} ${a.title}: removed, ${a.reason}`;
  if (a.op === 'complete') return `✓ #${a.id} ${a.title}${a.evidence ? `  ← “${a.evidence}”` : ''}`;
  return `– ${a.kind ? `${a.kind} ` : ''}${a.title || '(untitled)'}: ${a.reason}`;
}

function runRows(r) {
  const s = r.stats;
  const sec = (ms) => `${(ms / 1000).toFixed(1)} s`;
  const timing = s
    ? [
      s.spokeToBoardMs != null ? `spoke→board ${sec(s.spokeToBoardMs)}` : null,
      s.firstApplyMs != null ? `first change ${sec(s.firstApplyMs)}` : null,
      `run ${sec(r.ms)}`,
      `in ${s.promptTokens ?? '?'} tok ${s.promptMs ?? '?'} ms`,
      `out ${s.outTokens ?? '?'} tok`,
    ].filter(Boolean).join(' · ')
    : `${r.ms ?? 0} ms`;
  const fresh = r.utterance_ids.length;
  const what = r.mode === 'typed' ? 'typed task'
    : r.mode === 'app' ? 'phone event'
      : `${fresh} line${fresh > 1 ? 's' : ''}${s?.reread ? ` + ${s.reread} re-read` : ''}`;
  const expanded = openRuns.has(r.id);
  const toggle = el('button', { type: 'button', className: 'icon', textContent: expanded ? '▾' : '▸', title: 'Show what Gemma proposed' });
  toggle.addEventListener('click', () => {
    if (expanded) openRuns.delete(r.id);
    else openRuns.add(r.id);
    renderLog();
  });
  const rows = [el('tr', { className: `run ${r.error ? 'err' : ''}` },
    el('td', { className: 't', textContent: hms(new Date(r.at)) }),
    el('td', { className: 'l', textContent: 'gemma' }),
    el('td', { className: 'txt' }, `run ${r.id} · ${what} → `, el('b', { textContent: summary(r) }), el('span', { className: 'dim', textContent: ` · ${timing}` })),
    el('td', { className: 's', textContent: r.model ?? '—' }),
    el('td', { className: 'x' }, toggle),
  )];
  if (expanded) {
    const body = [
      ...(r.applied ?? []).map(appliedLine),
      r.error ? `error: ${r.error}` : null,
      '',
      'model proposed:',
      JSON.stringify(r.proposed, null, 1) ?? 'null',
    ].filter((x) => x !== null).join('\n');
    rows.push(el('tr', { className: 'rundetail' }, el('td', { colSpan: 5 }, el('pre', { textContent: body }))));
  }
  return rows;
}

export function renderLog() {
  const items = [
    ...lines.map((l) => ({ at: l.said_at, line: l })),
    ...runs.map((r) => ({ at: r.at, run: r })),
  ].sort((a, b) => b.at.localeCompare(a.at));

  const rows = [];
  let lastDay = null;
  for (const it of items) {
    const day = dayFmt.format(new Date(it.at));
    if (day !== lastDay) {
      rows.push(el('tr', { className: 'day' }, el('td', { colSpan: 5, textContent: day.toUpperCase() })));
      lastDay = day;
    }
    if (it.line) rows.push(lineRow(it.line));
    else rows.push(...runRows(it.run));
  }
  $('#lines').replaceChildren(...rows);
  const empty = $('#empty');
  empty.textContent = 'Nothing heard yet. Press Listen and speak a task.';
  empty.hidden = items.length > 0;
}

export function lineCount() {
  return lines.length;
}
