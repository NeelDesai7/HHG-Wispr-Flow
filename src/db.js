// Local store: a single SQLite file under data/. Text only — there is no table for audio.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// VACHAN_DATA_DIR lets tests use a throwaway folder.
const DATA_DIR = process.env.VACHAN_DATA_DIR || fileURLToPath(new URL('../data/', import.meta.url));
mkdirSync(DATA_DIR, { recursive: true });
export const DB_FILE = join(DATA_DIR, 'vachan.db');

const db = new DatabaseSync(DB_FILE);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS utterances (
    id      INTEGER PRIMARY KEY,
    said_at TEXT NOT NULL,              -- ISO time the words were spoken
    lang    TEXT NOT NULL,              -- BCP 47 tag the recogniser ran in
    text    TEXT NOT NULL,
    source  TEXT NOT NULL DEFAULT 'mic' -- mic | typed
  );
  CREATE INDEX IF NOT EXISTS utterances_said_at ON utterances (said_at);

  -- One row per time Gemma read some lines: what it proposed and what Vachan did with it.
  CREATE TABLE IF NOT EXISTS runs (
    id            INTEGER PRIMARY KEY,
    at            TEXT NOT NULL,
    mode          TEXT NOT NULL,        -- voice | typed
    model         TEXT,
    utterance_ids TEXT NOT NULL,        -- JSON array
    ms            INTEGER,
    stats         TEXT,                 -- JSON: tokens and timings from Ollama
    proposed      TEXT,                 -- JSON: the model's actions, unedited
    applied       TEXT,                 -- JSON: what was added, completed or skipped, and why
    error         TEXT
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id            INTEGER PRIMARY KEY,
    title         TEXT NOT NULL,
    person        TEXT,                 -- who it's for or with
    kind          TEXT NOT NULL,        -- promise | request | todo | reminder
    category      TEXT NOT NULL,
    priority      INTEGER NOT NULL,     -- 1 (highest) … 4
    due_date      TEXT,                 -- YYYY-MM-DD, local
    due_time      TEXT,                 -- HH:MM, local
    status        TEXT NOT NULL DEFAULT 'open', -- open | done | dismissed
    source        TEXT NOT NULL,        -- voice | typed
    evidence      TEXT,                 -- the words that created it
    confidence    REAL,
    run_id        INTEGER,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    done_at       TEXT,
    done_by       TEXT,                 -- voice | click
    done_evidence TEXT
  );
  CREATE INDEX IF NOT EXISTS tasks_status ON tasks (status);

  -- App-event ledger: tallies per app, never the content. Raw notifications and messages are
  -- read, turned into tasks, and forgotten; only these counts and the task evidence remain.
  CREATE TABLE IF NOT EXISTS sources (
    app        TEXT PRIMARY KEY,
    kind       TEXT,                    -- notification | message
    read       INTEGER NOT NULL DEFAULT 0,  -- events seen
    tasked     INTEGER NOT NULL DEFAULT 0,  -- events that produced a task
    withheld   INTEGER NOT NULL DEFAULT 0,  -- dropped before the model (secrets, empty)
    last_at    TEXT,
    last_reason TEXT                     -- why the most recent withhold happened; never content
  );
`);

const hasColumn = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);

// Step 2 added run_id to utterances: NULL = waiting for the brain, 0 = recorded before it existed.
if (!hasColumn('utterances', 'run_id')) {
  db.exec('ALTER TABLE utterances ADD COLUMN run_id INTEGER; UPDATE utterances SET run_id = 0;');
}
// The recogniser's other guesses for a line, so Gemma can pick the right words (JSON array).
if (!hasColumn('utterances', 'alts')) db.exec('ALTER TABLE utterances ADD COLUMN alts TEXT');
// Step 2.1: extra specifics the title couldn't hold, and words the recogniser cut off.
if (!hasColumn('tasks', 'details')) db.exec('ALTER TABLE tasks ADD COLUMN details TEXT');
if (!hasColumn('tasks', 'unclear')) db.exec('ALTER TABLE tasks ADD COLUMN unclear TEXT');
// Step 4: which app a phone-derived task came from (provenance; the raw message is still forgotten).
if (!hasColumn('tasks', 'source_app')) db.exec('ALTER TABLE tasks ADD COLUMN source_app TEXT');
// Step 5 (habits): what Gemma first assigned vs the learned adjustment, and why.
if (!hasColumn('tasks', 'base_priority')) db.exec('ALTER TABLE tasks ADD COLUMN base_priority INTEGER');
if (!hasColumn('tasks', 'priority_reason')) db.exec('ALTER TABLE tasks ADD COLUMN priority_reason TEXT');

const q = {
  insertUtt: db.prepare('INSERT INTO utterances (said_at, lang, text, source, alts) VALUES (?, ?, ?, ?, ?) RETURNING *'),
  recentUtt: db.prepare('SELECT * FROM utterances ORDER BY said_at DESC, id DESC LIMIT ?'),
  removeUtt: db.prepare('DELETE FROM utterances WHERE id = ?'),
  countUtt: db.prepare('SELECT COUNT(*) AS n FROM utterances'),
  pending: db.prepare("SELECT * FROM utterances WHERE run_id IS NULL AND source = 'mic' ORDER BY said_at, id LIMIT ?"),
  countPending: db.prepare("SELECT COUNT(*) AS n FROM utterances WHERE run_id IS NULL AND source = 'mic'"),
  before: db.prepare(`SELECT * FROM (SELECT * FROM utterances WHERE id < ? AND source = 'mic' ORDER BY id DESC LIMIT ?) ORDER BY id`),
  readBefore: db.prepare(`SELECT * FROM utterances WHERE id < ? AND source = 'mic' AND run_id > 0 ORDER BY id DESC LIMIT ?`),
  runApplied: db.prepare('SELECT id, applied FROM runs WHERE id = ?'),
  getTask: db.prepare('SELECT * FROM tasks WHERE id = ?'),
  markUtt: db.prepare('UPDATE utterances SET run_id = ? WHERE id = ?'),
  unmarkUtt: db.prepare('UPDATE utterances SET run_id = NULL WHERE run_id = ?'),

  insertRun: db.prepare(`INSERT INTO runs (at, mode, model, utterance_ids, applied)
                         VALUES (?, ?, ?, ?, '[]') RETURNING id`),
  finishRun: db.prepare('UPDATE runs SET ms = ?, stats = ?, proposed = ?, applied = ?, error = ? WHERE id = ?'),
  deleteRun: db.prepare('DELETE FROM runs WHERE id = ?'),
  recentRuns: db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT ?'),

  insertTask: db.prepare(`INSERT INTO tasks (title, details, unclear, person, kind, category, priority, base_priority, priority_reason, due_date, due_time,
                            source, evidence, confidence, run_id, created_at, updated_at)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`),
  openTasks: db.prepare("SELECT * FROM tasks WHERE status = 'open' ORDER BY created_at DESC LIMIT ?"),
  closedTasks: db.prepare("SELECT * FROM tasks WHERE status != 'open' ORDER BY updated_at DESC LIMIT ?"),
  setStatus: db.prepare(`UPDATE tasks SET status = ?, done_at = ?, done_by = ?, done_evidence = ?, updated_at = ?
                         WHERE id = ? RETURNING *`),
  bumpSource: db.prepare(`
    INSERT INTO sources (app, kind, read, tasked, withheld, last_at, last_reason)
    VALUES (@app, @kind, @read, @tasked, @withheld, @at, @reason)
    ON CONFLICT(app) DO UPDATE SET
      kind = excluded.kind,
      read = read + @read,
      tasked = tasked + @tasked,
      withheld = withheld + @withheld,
      last_at = @at,
      last_reason = CASE WHEN @reason IS NOT NULL THEN @reason ELSE last_reason END`),
  listSources: db.prepare('SELECT * FROM sources ORDER BY read DESC, app LIMIT ?'),
  sourceTotals: db.prepare('SELECT COALESCE(SUM(read),0) AS read, COALESCE(SUM(tasked),0) AS tasked, COALESCE(SUM(withheld),0) AS withheld, COUNT(*) AS apps FROM sources'),

  people: db.prepare(`SELECT person, COUNT(*) AS n FROM tasks WHERE person IS NOT NULL AND person != '' AND status != 'dismissed'
                      GROUP BY person ORDER BY n DESC LIMIT ?`),
};

// Columns an update from the brain may change.
const EDITABLE = ['title', 'details', 'unclear', 'person', 'kind', 'due_date', 'due_time', 'priority'];

export function tx(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ── utterances ──────────────────────────────────────────

export function addUtterance({ saidAt, lang, text, source, alts }) {
  const row = q.insertUtt.get(saidAt, lang, text, source, alts?.length ? JSON.stringify(alts) : null);
  return { ...row, alts: alts ?? [] };
}

export function listUtterances(limit = 200) {
  return q.recentUtt.all(Math.min(Math.max(limit, 1), 1000));
}

export function deleteUtterance(id) {
  return q.removeUtt.run(id).changes > 0;
}

export function countUtterances() {
  return q.countUtt.get().n;
}

export function pendingUtterances(limit = 25) {
  return q.pending.all(limit);
}

export function countPending() {
  return q.countPending.get().n;
}

export function utterancesBefore(id, n) {
  return q.before.all(id, n);
}

// The lines just before `first` that belong to the same stretch of speech: each within
// `gapMs` of the next, all within `spanMs` of `first`. Already read once, oldest first.
export function sameThought(first, { gapMs, spanMs, maxLines }) {
  const out = [];
  let next = new Date(first.said_at).getTime();
  const start = next;
  for (const l of q.readBefore.all(first.id, maxLines)) {
    const at = new Date(l.said_at).getTime();
    if (next - at > gapMs || start - at > spanMs) break;
    out.unshift(l);
    next = at;
  }
  return out;
}

// What earlier runs did to the board, so a re-read can correct it.
export function runEffects(runIds) {
  const effects = [];
  for (const id of new Set(runIds)) {
    const row = q.runApplied.get(id);
    for (const a of row ? JSON.parse(row.applied || '[]') : []) {
      if (a.op === 'add' || a.op === 'complete' || a.op === 'update' || a.op === 'remove') {
        const task = q.getTask.get(a.id);
        if (task) effects.push({ op: a.op, task });
      }
    }
  }
  return effects;
}

// ── runs ────────────────────────────────────────────────

// A run is opened before the model starts, so tasks it streams out can point at it,
// and its lines leave the queue straight away.
export function startRun({ at, mode, model, utteranceIds }) {
  return tx(() => {
    const { id } = q.insertRun.get(at, mode, model ?? null, JSON.stringify(utteranceIds));
    for (const u of utteranceIds) q.markUtt.run(id, u);
    return id;
  });
}

export function finishRun(id, { ms, stats, proposed, applied, error }) {
  q.finishRun.run(
    ms ?? null, stats ? JSON.stringify(stats) : null, proposed ? JSON.stringify(proposed) : null,
    JSON.stringify(applied ?? []), error ?? null, id,
  );
}

// Ollama went away before anything was applied: forget the run and put its lines back in the queue.
export function abortRun(id) {
  tx(() => {
    q.unmarkUtt.run(id);
    q.deleteRun.run(id);
  });
}

const parse = (s) => (s == null ? null : JSON.parse(s));

export function listRuns(limit = 50) {
  return q.recentRuns.all(limit).map((r) => ({
    ...r,
    utterance_ids: parse(r.utterance_ids),
    stats: parse(r.stats),
    proposed: parse(r.proposed),
    applied: parse(r.applied),
  }));
}

// ── tasks ───────────────────────────────────────────────

export function addTask(t, runId) {
  const now = new Date().toISOString();
  return q.insertTask.get(
    t.title, t.details ?? null, t.unclear ?? null, t.person, t.kind, t.category,
    t.priority, t.base_priority ?? t.priority, t.priority_reason ?? null, t.due_date, t.due_time,
    t.source, t.evidence, t.confidence, runId ?? null, now, now,
  );
}

// Everything the habits engine learns from: resolved tasks (done/dismissed) and manual priority
// edits (priority differs from what Gemma first assigned). Dropped tasks and the user's own
// corrections are the signal.
export function habitRows() {
  return db.prepare(`
    SELECT category, person, kind, source, priority, base_priority, status, done_by,
           created_at, done_at, updated_at
    FROM tasks
    WHERE status != 'open' OR (base_priority IS NOT NULL AND priority != base_priority)
    ORDER BY updated_at DESC LIMIT 600`).all();
}

// Records which app a phone-derived task came from (just the app name, never the message).
const tagSourceStmt = db.prepare('UPDATE tasks SET source_app = ? WHERE id = ?');
export function tagSourceApp(id, app) {
  if (app) tagSourceStmt.run(String(app).slice(0, 60), id);
}

export function updateTask(id, patch) {
  const cols = EDITABLE.filter((c) => c in patch);
  if (!cols.length) return null;
  const sql = `UPDATE tasks SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ? RETURNING *`;
  return db.prepare(sql).get(...cols.map((c) => patch[c]), new Date().toISOString(), id) ?? null;
}

// Names you've mentioned, most frequent first; Chrome uses them to hear those names better.
// Records one app event's outcome as counts only. `reason` is a withhold reason, never content.
export function bumpSource({ app, kind, read = 0, tasked = 0, withheld = 0, reason = null, at = new Date().toISOString() }) {
  q.bumpSource.run({ app: app || 'unknown', kind: kind ?? null, read, tasked, withheld, reason, at });
}

export function sources(limit = 60) {
  return { apps: q.listSources.all(limit), totals: q.sourceTotals.get() };
}

export function people(limit = 40) {
  return q.people.all(limit).map((r) => r.person);
}

const TOPIC_STOP = new Set(['the', 'and', 'for', 'with', 'from', 'this', 'that', 'your', 'complete', 'send', 'make',
  'call', 'buy', 'pay', 'get', 'book', 'task', 'project', 'report', 'meeting', 'tomorrow', 'today', 'remind',
  'add', 'remember', 'order', 'start', 'gather', 'fill', 'visit', 'develop', 'increase', 'purchase', 'submit',
  'attend', 'drop', 'study', 'finish', 'create', 'bring', 'pick', 'take', 'note', 'put', 'build', 'next', 'another']);
// Dismissed tasks (cleared junk) don't train the vocabulary.
const topicsStmt = db.prepare("SELECT title, details FROM tasks WHERE status != 'dismissed' ORDER BY updated_at DESC LIMIT 80");

// Distinctive terms from recent tasks — acronyms (EDI, STM32) and proper names — so the model
// and the recogniser keep spelling the user's own projects consistently. This is what makes
// Vachan adapt to how the user talks, from their own task history.
export function topics(limit = 24) {
  const freq = new Map();
  for (const row of topicsStmt.all()) {
    const toks = `${row.title ?? ''} ${row.details ?? ''}`.match(/[A-Za-z][A-Za-z0-9]*[0-9][A-Za-z0-9]*|[A-Z]{2,6}\b|[A-Z][a-z]{2,}/g) || [];
    for (const tok of toks) {
      if (TOPIC_STOP.has(tok.toLowerCase())) continue;
      freq.set(tok, (freq.get(tok) ?? 0) + 1);
    }
  }
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([t]) => t);
}

export function openTasks(limit = 40) {
  return q.openTasks.all(limit);
}

export function listTasks() {
  return { open: q.openTasks.all(500), closed: q.closedTasks.all(30) };
}

// done_by / done_evidence record who closed a task and why, for done and dismissed alike.
export function setTaskStatus(id, status, { by = null, evidence = null } = {}) {
  const now = new Date().toISOString();
  const closed = status !== 'open';
  return q.setStatus.get(status, status === 'done' ? now : null, closed ? by : null, closed ? evidence : null, now, id) ?? null;
}
