// Vachan hub. Binds to loopback only; src/guard.js holds the rules every request must pass.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { extname, resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { HOST, PORT, checkRequest, SECURITY_HEADERS } from './src/guard.js';
import * as db from './src/db.js';
import { ollamaStatus } from './src/ollama.js';
import { brain, events, startBrain, noteUtterance, noteActivity, addTyped, ingestEvents, ask, relearnHabits, habitsLearned, transcribe } from './src/brain.js';
import { autoSchedule, toICS } from './src/calendar.js';
import { getSettings, setSettings } from './src/settings.js';
import { whisperAvailable, whisperState, startWhisper, transcribeWhisper } from './src/whisper.js';
import { ensureReady, setupState, setupEvents } from './src/setup.js';

// The model the first-run setup installs and the brain then uses.
const SETUP_MODEL = process.env.VACHAN_MODEL || 'gemma4:e4b';
import { startLaptopNotifications, stopLaptopNotifications, laptopStatus, onLaptopChange } from './src/win-notifications.js';

function reconcileLaptopSensor() {
  if (getSettings().laptopNotifications && laptopStatus().supported) startLaptopNotifications();
  else stopLaptopNotifications();
}

const calPrefs = () => {
  const s = getSettings();
  return { dayStart: s.workStart, dayEnd: s.workEnd, slotMinutes: 30 };
};

// ── always-on desktop capture ───────────────────────────
// The desktop app (desktop/main.cjs) runs a hidden window that streams clips of speech here. We
// transcribe each on-device and feed it into the same pipeline as a spoken utterance, so opening
// the app is all the user ever does. Audio is held in memory only and dropped after transcription.
const DESKTOP = process.env.VACHAN_DESKTOP === '1';
const listen = { paused: false, lastHeardAt: null, lastError: null, clips: 0 };
// Which transcriber the always-on mic uses: whisper on-device when ready, else Gemma audio.
const captureEngine = () => (whisperState().ready ? 'whisper-small' : (whisperAvailable() ? 'whisper-loading' : 'gemma-audio'));

// Transcriptions run one at a time; if clips pile up on a slow engine, drop the excess instead of
// letting a backlog grow unbounded. A fast engine (whisper, next step) keeps the queue empty.
const CAP_MAX_PENDING = 3;
let capPending = 0;
let capChain = Promise.resolve();
const listenState = () => ({ desktop: DESKTOP, paused: listen.paused, lastHeardAt: listen.lastHeardAt, lastError: listen.lastError, engine: captureEngine(), clips: listen.clips });
function serialCapture(job) {
  capPending++;
  const prev = capChain;
  let release;
  capChain = new Promise((r) => { release = r; });
  return (async () => {
    try { await prev; return await job(); }
    finally { capPending--; release(); }
  })();
}

// Pairing token for the phone sensor. Generated once, kept in the data dir, reused across
// restarts so the phone stays paired. A request to /api/ingest must carry it.
const TOKEN_FILE = join(dirname(db.DB_FILE), 'pair.token');
const PAIR_TOKEN = loadToken();
function loadToken() {
  try {
    const t = readFileSync(TOKEN_FILE, 'utf8').trim();
    if (t.length >= 24) return t;
  } catch { /* first run */ }
  const t = randomBytes(24).toString('base64url');
  mkdirSync(dirname(TOKEN_FILE), { recursive: true });
  writeFileSync(TOKEN_FILE, t, { mode: 0o600 });
  return t;
}
function tokenOk(req) {
  const m = /^Bearer\s+(.+)$/.exec(req.headers.authorization || '');
  if (!m) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(PAIR_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

const PUBLIC = fileURLToPath(new URL('./public/', import.meta.url));
const MAX_BODY = 64 * 1024; // JSON text only; audio is neither accepted nor small enough to fit
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const server = createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  const isApi = (req.url || '').startsWith('/api/');
  const refusal = checkRequest(req, isApi);
  if (refusal) return send(res, 403, { error: refusal });

  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (isApi) return await api(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' });
    if (url.pathname === '/calendar.ics') return serveCalendar(res, url);
    return await serveStatic(res, url.pathname);
  } catch (err) {
    if (!err.status) console.error(err);
    send(res, err.status || 500, { error: err.status ? err.message : 'internal error' });
  }
});

async function api(req, res, url) {
  res.setHeader('Cache-Control', 'no-store');
  const route = `${req.method} ${url.pathname}`;
  const id = Number(/^\/api\/\w+\/(\d+)$/.exec(url.pathname)?.[1]);

  if (route === 'GET /api/health') return send(res, 200, await health());
  if (route === 'GET /api/events') return openEvents(req, res);

  // First-run setup (Ollama + the Gemma model). GET the status; POST to (re)try the auto-install.
  if (route === 'GET /api/setup') return send(res, 200, setupState());
  if (route === 'POST /api/setup/retry') { await readJson(req); ensureReady(SETUP_MODEL, true); return send(res, 202, setupState()); }

  if (route === 'GET /api/utterances') {
    return send(res, 200, db.listUtterances(Number(url.searchParams.get('limit')) || 200));
  }
  if (route === 'POST /api/utterances') {
    const line = db.addUtterance(parseUtterance(await readJson(req)));
    broadcast('utterance');
    noteUtterance(line);
    return send(res, 201, line);
  }
  // "Still talking" ping from the page while interim words are on screen. It carries no text.
  if (route === 'POST /api/activity') {
    await readJson(req);
    noteActivity();
    return send(res, 200, { ok: true });
  }
  // Names and project terms Chrome's recogniser should listen out for.
  if (route === 'GET /api/vocab') return send(res, 200, { phrases: [...new Set([...db.people(), ...db.topics()])] });

  // App events from the phone sensor: notifications and messages you sent. Token-gated.
  // Each event is screened, read for a task, then forgotten — the raw text is never stored.
  if (route === 'POST /api/ingest') {
    if (!tokenOk(req)) return send(res, 401, { error: 'pairing token required' });
    const body = await readJson(req);
    const list = Array.isArray(body.events) ? body.events : [body];
    if (list.length > 50) throw httpError(413, 'send at most 50 events per batch');
    try {
      const summary = await ingestEvents(list.map(parseEvent));
      return send(res, 200, summary);
    } catch (err) {
      if (err.deferred) return send(res, 503, { error: 'model not ready; retry shortly', retryAfterMs: 15000 });
      throw err;
    }
  }
  // What the phone sensor reports, as counts per app — never content. For the Sources panel.
  if (route === 'GET /api/sources') return send(res, 200, db.sources());
  // Pairing details for the Connect panel. Same-origin only (the guard enforces that for /api).
  if (route === 'GET /api/pairing') {
    return send(res, 200, { token: PAIR_TOKEN, port: PORT, adb: `adb reverse tcp:${PORT} tcp:${PORT}` });
  }

  if (req.method === 'DELETE' && url.pathname.startsWith('/api/utterances/') && id) {
    const gone = db.deleteUtterance(id);
    if (gone) broadcast('utterance');
    return send(res, gone ? 200 : 404, gone ? { deleted: id } : { error: 'not found' });
  }

  if (route === 'GET /api/tasks') return send(res, 200, db.listTasks());
  if (route === 'POST /api/tasks') {
    const body = await readJson(req);
    const raw = typeof body.text === 'string' ? body.text.trim() : '';
    if (!raw || raw.length > 500) throw httpError(400, 'text must be 1–500 characters');
    return send(res, 201, await addTyped(raw));
  }
  if (req.method === 'PATCH' && url.pathname.startsWith('/api/tasks/') && id) {
    const body = await readJson(req);
    // Change status (tick off / dismiss / reopen), or edit scheduling fields (accept a suggested time).
    if ('status' in body) {
      if (!['open', 'done', 'dismissed'].includes(body.status)) throw httpError(400, 'status must be open, done or dismissed');
      const task = db.setTaskStatus(id, body.status, { by: 'click' });
      if (!task) return send(res, 404, { error: 'not found' });
      relearnHabits();
      broadcast('tasks');
      return send(res, 200, task);
    }
    const patch = parseSchedulePatch(body);
    if (!Object.keys(patch).length) throw httpError(400, 'nothing to update');
    const task = db.updateTask(id, patch);
    if (!task) return send(res, 404, { error: 'not found' });
    relearnHabits(); // a hand-edited priority is a strong habit signal
    broadcast('tasks');
    return send(res, 200, task);
  }

  if (route === 'GET /api/runs') return send(res, 200, db.listRuns(Number(url.searchParams.get('limit')) || 50));

  // What Vachan has learned about the user's priorities, for the Habits panel.
  if (route === 'GET /api/habits') return send(res, 200, { learned: habitsLearned() });

  // Settings: what Vachan may read, scheduling hours, and the opt-in assistant bridge.
  if (route === 'GET /api/settings') return send(res, 200, getSettings());
  if (req.method === 'PUT' && url.pathname === '/api/settings') {
    const next = setSettings(await readJson(req));
    reconcileLaptopSensor();
    broadcast('tasks'); // working-hours change reschedules the calendar
    return send(res, 200, next);
  }

  // High-accuracy speech: a clip is transcribed by Gemma on-device (better for Hindi/Marathi).
  // The audio is held in memory, sent only to local Ollama, and never written to disk.
  if (route === 'POST /api/transcribe') {
    const body = await readJson(req, MAX_AUDIO_BODY);
    const audio = typeof body.audio === 'string' ? body.audio : '';
    if (!audio || audio.length > MAX_AUDIO_BODY) throw httpError(400, 'audio (base64 WAV) required');
    try {
      const r = await transcribe(audio);
      return send(res, 200, { text: r.text, ms: r.ms });
    } catch (err) {
      if (err.offline) return send(res, 503, { error: err.message });
      throw err;
    }
  }

  // Always-on capture from the desktop app's hidden window: a clip of speech, transcribed
  // on-device, then fed straight into the task pipeline. Audio stays in memory and is dropped.
  if (route === 'POST /api/capture') {
    const body = await readJson(req, MAX_AUDIO_BODY);
    const audio = typeof body.audio === 'string' ? body.audio : '';
    if (!audio || audio.length > MAX_AUDIO_BODY) throw httpError(400, 'audio (base64 WAV) required');
    if (listen.paused) return send(res, 200, { skipped: 'paused' });
    if (capPending >= CAP_MAX_PENDING) return send(res, 202, { dropped: true }); // transcriber is behind
    listen.lastHeardAt = new Date().toISOString();
    listen.lastError = null;
    broadcast('capture', { at: listen.lastHeardAt });
    try {
      const result = await serialCapture(async () => {
        // On-device transcription: whisper when it's up, otherwise fall back to Gemma audio.
        let r;
        if (whisperAvailable()) {
          try { r = await transcribeWhisper(Buffer.from(audio, 'base64')); }
          catch (e) { if (e.notReady) r = await transcribe(audio); else throw e; }
        } else {
          r = await transcribe(audio);
        }
        const text = (r.text || '').trim();
        if (!text) return { text: '', ms: r.ms, engine: captureEngine() };
        let saidAt = new Date(body.saidAt);
        if (Number.isNaN(saidAt.getTime()) || Math.abs(saidAt - Date.now()) > 864e5) saidAt = new Date();
        const line = db.addUtterance({ text, lang: 'und', saidAt: saidAt.toISOString(), source: 'mic', alts: [] });
        listen.clips++;
        broadcast('utterance');
        noteUtterance(line);
        return { text: line.text, ms: r.ms, engine: captureEngine() };
      });
      return send(res, result.text ? 201 : 200, result);
    } catch (err) {
      if (err.offline) { listen.lastError = 'model offline'; broadcast('listen', listenState()); return send(res, 503, { error: err.message }); }
      throw err;
    }
  }
  // Pause / resume the always-on microphone (the Pause button in the UI).
  if (route === 'POST /api/listen') {
    const body = await readJson(req);
    if (typeof body.paused === 'boolean') { listen.paused = body.paused; broadcast('listen', listenState()); }
    return send(res, 200, listenState());
  }
  // The hidden listener reports a capture problem (usually the OS microphone permission).
  if (route === 'POST /api/listen/error') {
    const body = await readJson(req);
    listen.lastError = typeof body.error === 'string' ? body.error.slice(0, 60) : 'error';
    broadcast('listen', listenState());
    return send(res, 200, { ok: true });
  }

  // Ask a question about your own tasks; Gemma answers on-device from the task list.
  if (route === 'POST /api/ask') {
    const body = await readJson(req);
    const q = typeof body.question === 'string' ? body.question.trim() : '';
    if (!q || q.length > 500) throw httpError(400, 'question must be 1–500 characters');
    try {
      return send(res, 200, await ask(q));
    } catch (err) {
      if (err.offline) return send(res, 503, { error: err.message });
      throw err;
    }
  }

  // The in-app calendar: open tasks placed on a timeline, timeless ones auto-scheduled.
  if (route === 'GET /api/calendar') {
    const { open, closed } = db.listTasks();
    const forCal = open;
    return send(res, 200, {
      slots: autoSchedule(forCal, new Date(), calPrefs()),
      prefs: calPrefs(),
      feed: { url: `http://${HOST}:${PORT}/calendar.ics?key=${PAIR_TOKEN}`, download: `/calendar.ics?key=${PAIR_TOKEN}&download=1` },
    });
  }

  return send(res, 404, { error: 'not found' });
}

async function health() {
  return {
    server: { bound: `${HOST}:${PORT}`, pid: process.pid, node: process.version },
    privacy: {
      audio: 'never stored — the always-on mic is transcribed on-device (whisper.cpp) in memory and dropped; in a plain browser, Chrome recognises speech on-device. Audio never touches disk or the network.',
      maxBodyBytes: MAX_BODY,
      outbound: ['Ollama on this computer'],
      npmDependencies: 0,
    },
    ollama: await ollamaStatus(),
    brain,
    capture: listenState(),
    whisper: whisperAvailable() ? whisperState() : null,
    setup: setupState(),
    phone: { ...db.sources().totals, forgetsRawEvents: true },
    laptop: laptopStatus(),
    store: { file: db.DB_FILE, utterances: db.countUtterances() },
  };
}

// ── live updates (Server-Sent Events, same origin only) ─

const clients = new Set();

function openEvents(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive' });
  res.write('retry: 2000\n\n');
  clients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(ping);
    clients.delete(res);
  });
}

function broadcast(type, data = {}) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.write(msg);
}

events.on('change', ({ type, ...data }) => {
  if (type === 'tasks') relearnHabits(); // a completion / dismissal / re-prioritise is a habit signal
  broadcast(type, data);
});
onLaptopChange(() => broadcast('laptop'));
// First-run setup progress (installing Ollama / pulling the model) → the setup screen.
setupEvents.on('change', (s) => { broadcast('setup', s); if (s.ready) broadcast('brain'); });

// ── request helpers ─────────────────────────────────────

function parseUtterance(body) {
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text || text.length > 4000) throw httpError(400, 'text must be 1–4000 characters');
  const lang = /^[a-z]{2,3}(-[A-Z]{2})?$/.test(body.lang) ? body.lang : 'und';
  let saidAt = new Date(body.saidAt);
  if (Number.isNaN(saidAt.getTime()) || Math.abs(saidAt - Date.now()) > 864e5) saidAt = new Date();
  const alts = Array.isArray(body.alts)
    ? body.alts.filter((a) => typeof a === 'string' && a.trim() && a !== text).map((a) => a.trim().slice(0, 300)).slice(0, 3)
    : [];
  return { text, lang, saidAt: saidAt.toISOString(), source: 'mic', alts };
}

function tokenEquals(given) {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(PAIR_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

// The iCalendar feed a desktop calendar app subscribes to or imports. Loopback only, key-gated.
function serveCalendar(res, url) {
  if (!tokenEquals(url.searchParams.get('key'))) return send(res, 401, { error: 'calendar key required' });
  const { open, closed } = db.listTasks();
  const forCal = open;
  const ics = toICS(autoSchedule(forCal, new Date(), calPrefs()), { now: new Date() });
  const headers = { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'no-store' };
  if (url.searchParams.get('download')) headers['Content-Disposition'] = 'attachment; filename="vachan.ics"';
  res.writeHead(200, headers);
  res.end(ics);
}

function parseSchedulePatch(body) {
  const patch = {};
  if ('due_date' in body) {
    if (body.due_date === null) patch.due_date = null;
    else if (typeof body.due_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.due_date)) patch.due_date = body.due_date;
    else throw httpError(400, 'due_date must be YYYY-MM-DD or null');
  }
  if ('due_time' in body) {
    if (body.due_time === null) patch.due_time = null;
    else if (typeof body.due_time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(body.due_time)) patch.due_time = body.due_time;
    else throw httpError(400, 'due_time must be HH:MM or null');
  }
  if (typeof body.title === 'string' && body.title.trim()) patch.title = body.title.trim().slice(0, 140);
  if (typeof body.details === 'string') patch.details = body.details.trim().slice(0, 300) || null;
  if (Number.isInteger(body.priority) && body.priority >= 1 && body.priority <= 4) patch.priority = body.priority;
  return patch;
}

const EVENT_KINDS = new Set(['notification', 'message']);
function parseEvent(e) {
  const app = typeof e?.app === 'string' ? e.app.slice(0, 60) : '';
  const title = typeof e?.title === 'string' ? e.title.slice(0, 1000) : '';
  const body = typeof e?.body === 'string' ? e.body.slice(0, 2000) : '';
  if (!title && !body) throw httpError(400, 'each event needs a title or body');
  const kind = EVENT_KINDS.has(e?.kind) ? e.kind : 'notification';
  let at = new Date(e?.at);
  if (Number.isNaN(at.getTime()) || Math.abs(at - Date.now()) > 7 * 864e5) at = new Date();
  return { app, kind, title, body, at: at.toISOString() };
}

// A short clip of speech, base64-encoded in JSON, for on-device Gemma transcription. It never
// touches disk — it is read into memory, handed to local Ollama, and dropped.
const MAX_AUDIO_BODY = 12 * 1024 * 1024; // ~ up to a minute of 16 kHz mono WAV, base64

function readJson(req, maxBytes = MAX_BODY) {
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) {
    return Promise.reject(httpError(415, 'only application/json is accepted'));
  }
  if (Number(req.headers['content-length']) > maxBytes) return Promise.reject(httpError(413, 'body too large'));
  return new Promise((ok, fail) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size <= maxBytes) chunks.push(c);
    });
    req.on('end', () => {
      if (size > maxBytes) return fail(httpError(413, 'body too large'));
      try {
        ok(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        fail(httpError(400, 'invalid JSON'));
      }
    });
    req.on('error', fail);
  });
}

async function serveStatic(res, pathname) {
  let rel;
  try {
    rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  } catch {
    return send(res, 400, { error: 'bad path' });
  }
  const file = resolve(PUBLIC, rel);
  const type = TYPES[extname(file)];
  if (!file.startsWith(PUBLIC) || !type) return send(res, 404, { error: 'not found' });
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch {
    send(res, 404, { error: 'not found' });
  }
}

function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${PORT} is busy. Start with PORT=<other> npm start.`);
  else console.error(err);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`Vachan on http://${HOST}:${PORT}  (loopback only, not reachable from your network)`);
  startBrain();
  if (whisperAvailable()) startWhisper(); // warm the on-device transcriber so the first clip is fast
  // Make the on-device brain present: the installed desktop app may auto-install Ollama + the model;
  // run standalone it only reports what's missing. When it finishes, the brain picks the model up.
  ensureReady(SETUP_MODEL, DESKTOP);
  reconcileLaptopSensor();
});
