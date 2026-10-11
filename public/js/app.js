import { $, el, api } from './dom.js';
import { LANGS, speechSupport, languageState, installLanguage, createEars, planFor, viaLabel } from './ears.js';
import { loadTasks, setTaskFilter, initQuickAdd } from './tasks.js';
import { loadCalendar, renderCalendar, initCalendar } from './calendar.js';
import { loadSources, loadPairing, initTryBox, renderDerived, setSrcGroup, phoneChip } from './sources.js';
import { loadLog, noteFreshLine } from './log.js';
import { initAsk } from './ask.js';
import { loadSettings, initSettings } from './settings.js';

const TITLES = { tasks: 'Tasks', calendar: 'Calendar', sources: 'Sources', ask: 'Ask', settings: 'Settings' };

function readAutoListen() {
  try { return localStorage.getItem('vachan.autolisten') !== '0'; } catch { return true; } // default ON
}

const state = {
  view: 'tasks',
  health: null,
  healthError: null,
  speech: speechSupport(),
  langStates: {},
  phrases: [],
  ear: 'idle',
  earError: null,
  autoListen: readAutoListen(), // always-on by default; the user never has to press Listen
  paused: false, // set when the user taps the button to silence it for this visit
};

// ── view routing ────────────────────────────────────────

function setView(v) {
  state.view = v;
  for (const section of document.querySelectorAll('.view')) section.hidden = section.id !== `view-${v}`;
  for (const item of document.querySelectorAll('.navitem')) item.classList.toggle('on', item.dataset.tab === v);
  $('#view-title').textContent = TITLES[v];
  try { localStorage.setItem('vachan.view', v); } catch { /* */ }
  refreshView();
}

function refreshView() {
  if (state.view === 'tasks') loadTasks();
  else if (state.view === 'calendar') loadCalendar().then(renderCalendar);
  else if (state.view === 'sources') { loadSources(); renderDerived(); loadLog(); loadPairing(); }
  else if (state.view === 'settings') loadSettings();
}

// ── server state ────────────────────────────────────────

async function refreshHealth() {
  try {
    state.health = await api('/api/health');
    state.healthError = null;
  } catch (err) {
    state.healthError = err.message;
  }
  renderStatus();
  renderControls();
  renderSetup(state.health?.setup);
}

async function refreshVocab() {
  try { state.phrases = (await api('/api/vocab')).phrases; } catch { state.phrases = []; }
}

function connectEvents() {
  const es = new EventSource('/api/events');
  const onTasks = () => {
    if (state.view === 'tasks') loadTasks();
    if (state.view === 'calendar') loadCalendar();
    if (state.view === 'sources') renderDerived();
    refreshVocab();
  };
  es.addEventListener('tasks', onTasks);
  es.addEventListener('run', () => { onTasks(); if (state.view === 'sources') loadLog(); });
  es.addEventListener('utterance', () => { if (state.view === 'sources') loadLog(); });
  es.addEventListener('sources', () => { if (state.view === 'sources') loadSources(); refreshHealth(); });
  es.addEventListener('laptop', () => { refreshHealth(); if (state.view === 'settings') loadSettings(); if (state.view === 'sources') loadSources(); });
  es.addEventListener('brain', () => { refreshHealth(); if (state.view === 'settings') loadSettings(); });
  // Always-on background mic (desktop app): keep the indicator and Pause/Resume button in sync.
  es.addEventListener('setup', (e) => { try { renderSetup(JSON.parse(e.data)); } catch { /* */ } });
  es.addEventListener('listen', (e) => { try { if (state.health) state.health.capture = { ...state.health.capture, ...JSON.parse(e.data) }; } catch { /* */ } renderControls(); });
  es.addEventListener('capture', (e) => { try { if (state.health?.capture) state.health.capture.lastHeardAt = JSON.parse(e.data).at; } catch { /* */ } renderControls(); if (state.view === 'sources') loadLog(); });
  es.addEventListener('open', () => { refreshHealth(); refreshView(); });
}

// ── listening (works from any tab) ──────────────────────

const ERROR_HINTS = {
  'not-allowed': 'Microphone blocked. Allow it from the icon left of the address bar.',
  'service-not-allowed': 'Chrome refused speech recognition for this page.',
  'language-not-supported': 'No on-device pack for this language. Install it in Settings.',
  'audio-capture': 'No microphone found.',
  network: 'Chrome tried the network. Stopped — Vachan only allows on-device recognition.',
  'restart-loop': 'Recognition keeps stopping. Check the microphone and try again.',
};

let lastPing = 0;
function pingActivity() {
  const now = Date.now();
  if (now - lastPing < 1000) return;
  lastPing = now;
  api('/api/activity', { method: 'POST', body: '{}' }).catch(() => {});
}

const ears = createEars({
  onState(s) { state.ear = s; if (s === 'listening') state.earError = null; renderControls(); },
  onInterim(text) { $('#interim').textContent = text; if (text) pingActivity(); },
  getPhrases: () => state.phrases,
  async onFinal(text, lang, alts = []) {
    try {
      const line = await api('/api/utterances', { method: 'POST', body: JSON.stringify({ text, lang, saidAt: new Date().toISOString(), alts }) });
      noteFreshLine(line.id);
      if (state.view === 'sources') loadLog();
    } catch (err) { state.earError = `Couldn't save: ${err.message}`; renderControls(); }
  },
  onError(code, message) { state.earError = ERROR_HINTS[code] || `${code}${message ? `: ${message}` : ''}`; renderControls(); },
});

function currentLang() { return $('#lang').value; }

// Starts the on-device recogniser in the chosen language (Marathi via Hindi when needed).
async function startListening() {
  const lang = currentLang();
  const plan = await planFor(lang);
  state.langStates[lang] = plan.state;
  if (!plan.usable) {
    state.earError = plan.state === 'unavailable'
      ? `${lang} has no on-device recogniser in this browser, and no related language to fall back to. Pick another language.`
      : `${lang} needs its on-device pack. Install it in Settings → Speech.`;
    renderControls();
    return false;
  }
  state.earError = null;
  state.recLang = plan.recognizerLang;
  ears.start(lang, plan.recognizerLang);
  renderControls();
  return true;
}

// True when a desktop app is doing the listening in its hidden window; then this page just
// reflects and controls it, rather than running browser speech itself.
function isDesktop() { return !!state.health?.capture?.desktop; }

// The button is Pause/Resume. In the desktop app it pauses the always-on background mic; in a
// plain browser it pauses this tab's own always-on recogniser.
async function toggleListening() {
  if (isDesktop()) {
    const paused = !!state.health?.capture?.paused;
    try {
      const s = await api('/api/listen', { method: 'POST', body: JSON.stringify({ paused: !paused }) });
      if (state.health) state.health.capture = { ...state.health.capture, ...s };
    } catch (err) { state.earError = err.message; }
    renderControls();
    return;
  }
  if (ears.listening) { state.paused = true; return ears.stop(); }
  state.paused = false;
  await startListening();
}

// Always-on: Vachan starts listening by itself when it's open, so the user never presses anything.
// The browser needs the microphone allowed once; after that this resumes automatically every visit.
async function tryAutoListen() {
  if (isDesktop()) return; // the desktop app's hidden window is already listening
  if (!state.autoListen || state.paused || !state.speech.ok || ears.listening) return;
  let perm = 'prompt';
  try { perm = (await navigator.permissions.query({ name: 'microphone' })).state; } catch { /* some browsers lack this */ }
  if (perm === 'denied') {
    state.earError = 'Vachan listens automatically, but the microphone is blocked. Allow it from the icon left of the address bar.';
    renderControls();
    return;
  }
  await startListening(); // if the mic hasn't been granted yet, this surfaces the one-time prompt
}

export function setAutoListen(on) {
  state.autoListen = on;
  try { localStorage.setItem('vachan.autolisten', on ? '1' : '0'); } catch { /* */ }
  if (on) { state.paused = false; tryAutoListen(); }
  else if (ears.listening) ears.stop();
  renderControls();
}
export function autoListenOn() { return state.autoListen; }

export async function installLang(lang) {
  try { await installLanguage(lang); } catch { /* */ }
  state.langStates[lang] = await languageState(lang);
  return state.langStates[lang];
}
export function langState(lang) { return state.langStates[lang]; }
export async function refreshLangStates() {
  const entries = await Promise.all(LANGS.map(async (l) => [l.code, (await planFor(l.code)).state]));
  state.langStates = Object.fromEntries(entries);
  return state.langStates;
}

// ── rendering ───────────────────────────────────────────

function capErrorText(err) {
  if (/not-?allowed|denied/i.test(err)) return 'Microphone blocked. Allow Vachan in Windows Settings → Privacy → Microphone, then it listens on its own.';
  if (/notfound|audio-capture/i.test(err)) return 'No microphone found. Plug one in and Vachan will start listening.';
  return `Couldn’t use the microphone (${err}).`;
}
function heardAgo(iso) {
  if (!iso) return '';
  const secs = (Date.now() - Date.parse(iso)) / 1000;
  return secs >= 0 && secs < 8 ? ' · heard you just now' : '';
}

function renderControls() {
  const btn = $('#listen');
  const es = $('#ear-state');

  // Desktop app: the button pauses/resumes the always-on background mic; no browser speech here.
  if (isDesktop()) {
    const cap = state.health.capture;
    btn.disabled = false;
    btn.setAttribute('aria-pressed', String(!cap.paused));
    $('#listen-label').textContent = cap.paused ? 'Resume' : 'Pause';
    if (cap.lastError) { es.className = 'ear-note'; es.textContent = capErrorText(cap.lastError); }
    else if (cap.paused) { es.className = 'ear-note'; es.textContent = 'Paused · tap Resume and Vachan listens again'; }
    else { es.className = 'ear-note live'; es.textContent = `Listening in the background · on-device${heardAgo(cap.lastHeardAt)}`; }
    return;
  }

  const on = ears.listening;
  btn.setAttribute('aria-pressed', String(on));
  btn.disabled = !state.speech.ok;
  // Always-on, so the button just pauses/resumes — the user never has to start it themselves.
  $('#listen-label').textContent = on ? 'Pause' : (state.paused ? 'Resume' : 'Listen');
  if (state.earError) { es.className = 'ear-note'; es.textContent = state.earError; }
  else if (on && state.ear === 'listening') { const via = viaLabel(currentLang(), state.recLang); es.className = 'ear-note live'; es.textContent = `Listening · ${currentLang()}${via ? ` ${via}` : ''} · on-device`; }
  else if (state.paused) { es.className = 'ear-note'; es.textContent = 'Paused · tap Resume to listen again'; }
  else { es.className = 'ear-note'; es.textContent = ''; }
}

// The first-run setup screen: shown only while the on-device brain is being installed or is missing.
const SETUP_ACTIVE = new Set(['installing-ollama', 'starting-ollama', 'pulling-model', 'warming', 'need-ollama', 'need-model', 'error']);
const SETUP_TITLES = {
  'installing-ollama': 'Installing the on-device engine',
  'starting-ollama': 'Starting the engine',
  'pulling-model': 'Downloading the Gemma model',
  warming: 'Warming up',
  'need-ollama': 'Ollama isn’t running',
  'need-model': 'The model isn’t installed yet',
  error: 'Setup hit a snag',
};
function renderSetup(s) {
  const overlay = $('#setup-overlay');
  if (!s || !SETUP_ACTIVE.has(s.phase)) { overlay.hidden = true; return; }
  overlay.hidden = false;
  $('#setup-title').textContent = SETUP_TITLES[s.phase] || 'Setting up Vachan…';
  $('#setup-detail').textContent = s.phase === 'error' ? (s.error || 'Something went wrong.') : (s.detail || '');
  const bar = $('#setup-bar'); const fill = $('#setup-bar-fill');
  if (s.phase === 'error') { bar.classList.remove('indeterminate'); fill.style.width = '0%'; }
  else if (typeof s.pct === 'number') { bar.classList.remove('indeterminate'); fill.style.width = `${Math.round(s.pct * 100)}%`; }
  else { bar.classList.add('indeterminate'); fill.style.width = ''; }
  $('#setup-retry').hidden = !['error', 'need-ollama', 'need-model'].includes(s.phase);
}

function statLine(cls, text) {
  return el('div', { className: `stat ${cls}` }, el('span', { className: 'd' }), el('span', { textContent: text }));
}

function renderStatus() {
  const h = state.health;
  const rows = [];
  if (state.healthError) rows.push(statLine('bad', 'Server unreachable'));
  else if (h) {
    const b = h.brain;
    rows.push(b.state === 'ready'
      ? statLine('ok', `Gemma ready · ${b.model}`)
      : statLine(b.state === 'offline' ? 'bad' : 'warn', `Gemma ${b.state === 'offline' ? 'offline' : 'loading…'}`));
    const p = phoneChip();
    rows.push(statLine(p.read ? 'ok' : '', p.read ? `Phone · ${p.tasked} tasks from ${p.read} events` : 'Phone not connected'));
    const lap = h.laptop;
    if (lap?.running) rows.push(statLine('ok', `Laptop notifications on${lap.read ? ` · ${lap.read} read` : ''}`));
    rows.push(statLine('ok', 'Nothing leaves this laptop'));
  }
  $('#side-status').replaceChildren(...rows);
  $('#privacy-pill').textContent = state.healthError ? 'Server down' : (h?.brain.state === 'offline' ? 'Model offline' : 'On-device');
  $('#privacy-pill').style.color = state.healthError || h?.brain.state === 'offline' ? 'var(--danger)' : 'var(--ok)';
  $('#privacy-pill').style.background = state.healthError || h?.brain.state === 'offline' ? 'var(--danger-weak)' : 'var(--ok-weak)';
}

export function health() { return state.health; }
export function speechState() { return state.speech; }

function tick() {
  // nothing periodic beyond health; kept for future clock use
}

// ── boot ────────────────────────────────────────────────

function boot() {
  const select = $('#lang');
  select.replaceChildren(...LANGS.map((l) => el('option', { value: l.code, textContent: l.label })));
  try { const saved = localStorage.getItem('vachan.lang'); if (saved && LANGS.some((l) => l.code === saved)) select.value = saved; } catch { /* */ }
  select.addEventListener('change', async () => {
    try { localStorage.setItem('vachan.lang', select.value); } catch { /* */ }
    state.earError = null;
    if (ears.listening) {
      const plan = await planFor(select.value);
      if (plan.usable) { state.recLang = plan.recognizerLang; ears.switchLang(select.value, plan.recognizerLang); }
      else { ears.stop(); state.earError = `${select.value} isn't available on-device. Pick another language.`; }
    }
    renderControls();
  });
  $('#listen').addEventListener('click', toggleListening);
  $('#setup-retry').addEventListener('click', () => { api('/api/setup/retry', { method: 'POST', body: '{}' }).catch(() => {}); });

  for (const item of document.querySelectorAll('.navitem')) item.addEventListener('click', () => setView(item.dataset.tab));

  initQuickAdd(() => state.health?.brain?.state === 'ready' ? state.health.brain.model : 'Vachan');
  initCalendar();
  initTryBox();
  for (const b of document.querySelectorAll('#src-group .seg')) b.addEventListener('click', () => {
    for (const x of document.querySelectorAll('#src-group .seg')) x.classList.toggle('on', x === b);
    setSrcGroup(b.dataset.group);
  });
  for (const b of document.querySelectorAll('#task-filter .seg')) b.addEventListener('click', () => {
    for (const x of document.querySelectorAll('#task-filter .seg')) x.classList.toggle('on', x === b);
    setTaskFilter(b.dataset.filter);
  });
  initAsk();
  initSettings();

  renderControls();
  refreshHealth();
  refreshVocab();
  refreshLangStates();
  connectEvents();
  setInterval(refreshHealth, 15_000);

  let start = 'tasks';
  try { const s = localStorage.getItem('vachan.view'); if (s && TITLES[s]) start = s; } catch { /* */ }
  setView(start);

  // Always-on: begin listening on its own, so opening Vachan is all the user ever does.
  tryAutoListen();
  // Chrome suspends a background tab's recogniser; when the tab comes back, pick listening up again.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tryAutoListen(); });
}

boot();
