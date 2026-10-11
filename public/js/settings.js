// The Settings tab: what Vachan may read, how it schedules, the model status, speech languages,
// the opt-in assistant bridge, and the theme. Everything stays on this laptop.
import { $, el, api } from './dom.js';
import { LANGS } from './ears.js';
import { health, installLang, langState, refreshLangStates, autoListenOn, setAutoListen } from './app.js';

let settings = null;
let feed = null;
let habits = [];

async function save(patch) {
  settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify(patch) });
  render();
}

function toggle(on, onClick, danger = false) {
  const b = el('button', { className: `toggle${on ? ' on' : ''}${danger ? ' danger' : ''}`, type: 'button' });
  b.setAttribute('role', 'switch');
  b.setAttribute('aria-checked', String(on));
  b.addEventListener('click', onClick);
  return b;
}

function row(title, sub, control, subClass = '') {
  return el('div', { className: 'setrow' },
    el('div', { className: 'label' }, el('b', { textContent: title }), sub ? el('div', { className: `sub ${subClass}`, textContent: sub }) : null),
    control);
}

function groupCard(title, ...rows) {
  return el('div', { className: 'setgroup' }, el('h3', { textContent: title }), ...rows.filter(Boolean));
}

function statusRow(title, cls, text, control) {
  return el('div', { className: 'setrow' },
    el('div', { className: 'label' }, el('b', { textContent: title }),
      el('div', { className: `sub statline ${cls}` }, el('span', { className: 'd' }), el('span', { textContent: text }))),
    control || null);
}

// ── theme (local only) ──────────────────────────────────
function getTheme() { try { return localStorage.getItem('vachan.theme') || 'auto'; } catch { return 'auto'; } }
function applyTheme(t) {
  try { localStorage.setItem('vachan.theme', t); } catch { /* */ }
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
}

function themeRow() {
  const cur = getTheme();
  const seg = el('div', { className: 'segmented' });
  for (const t of ['auto', 'light', 'dark']) {
    const b = el('button', { className: `seg${cur === t ? ' on' : ''}`, textContent: t[0].toUpperCase() + t.slice(1) });
    b.addEventListener('click', () => { applyTheme(t); render(); });
    seg.append(b);
  }
  return row('Appearance', 'Auto follows your system light/dark setting.', seg);
}

function render() {
  if (!settings) return;
  const h = health();
  const o = h?.ollama;
  const blocks = [];

  // Always-on listening — the whole point is that the user never has to press Listen.
  const al = autoListenOn();
  blocks.push(groupCard('Listening',
    row('Always listen when Vachan is open',
      al
        ? 'On — Vachan starts listening by itself whenever this tab is open, so you never press Listen. Audio stays in Chrome on this laptop; only the recognised words are kept.'
        : 'Off — Vachan listens only while you hold the Listen button on. Turn on so it captures your commitments automatically.',
      toggle(al, () => { setAutoListen(!al); render(); }),
      al ? '' : 'warnish'),
    row('Works only while this tab is open',
      'A browser tab can’t listen in the background once it’s closed. Keep Vachan pinned in a tab, and it’ll quietly catch everything. True listen-while-closed needs the native app.',
      el('span'))));

  // What Vachan keeps private — protections ON by default, each can be turned off to allow it through.
  const protect = (key, title, onSub, offSub) => row(
    title,
    settings[key] ? onSub : offSub,
    toggle(settings[key], () => save({ [key]: !settings[key] }), !settings[key]),
    settings[key] ? '' : 'warnish');
  blocks.push(groupCard('What stays private',
    protect('hideOtp', 'Don’t share my OTPs & codes', 'On — one-time codes and verification codes are withheld and never read.', 'OFF — one-time codes will be read. Turn back on to protect them.'),
    protect('hidePasswords', 'Don’t share my passwords & PINs', 'On — passwords, PINs and recovery phrases are withheld.', 'OFF — passwords and PINs will be read. Turn back on to protect them.'),
    protect('hideKeys', 'Don’t share my keys & tokens', 'On — API keys and access tokens are withheld.', 'OFF — keys and tokens will be read. Turn back on to protect them.'),
    protect('maskCards', 'Mask my card numbers', 'On — card numbers become “card ending 1234”.', 'OFF — full card numbers will be kept. Turn back on to protect them.')));

  // This laptop's own notifications (Windows).
  const lap = h?.laptop;
  let lapSub;
  if (lap && !lap.supported) lapSub = 'Only available on Windows.';
  else if (!settings.laptopNotifications) lapSub = 'Off — your desktop notifications are not read.';
  else if (lap?.access === 'Denied') lapSub = 'Blocked — allow Vachan under Windows Settings → Privacy → Notifications, then toggle again.';
  else if (lap?.running) lapSub = `On — notifications from your desktop apps (Slack, Teams, Outlook, WhatsApp…) become tasks. Secrets are withheld, text is forgotten.${lap.read ? ` ${lap.read} read so far.` : ''}`;
  else lapSub = 'Starting… Windows may ask you to allow Vachan to read notifications — choose Yes.';
  const lapToggle = toggle(!!settings.laptopNotifications, () => save({ laptopNotifications: !settings.laptopNotifications }));
  if (lap && !lap.supported) lapToggle.disabled = true;
  blocks.push(groupCard('This laptop',
    row('Read this laptop’s notifications', lapSub, lapToggle, settings.laptopNotifications && lap?.access === 'Denied' ? 'warnish' : '')));

  // What the phone sensor forwards.
  blocks.push(groupCard('Phone capture',
    row('Read app notifications', 'The phone sensor forwards notifications from your apps.', toggle(settings.readNotifications, () => save({ readNotifications: !settings.readNotifications }))),
    row('Read messages you send', 'Promises you type in chat apps become tasks. Password fields are never read.', toggle(settings.readMessages, () => save({ readMessages: !settings.readMessages })))));

  // Model
  if (o) {
    const modelCtl = el('a', { className: 'btn ghost', href: 'https://ollama.com/library/gemma4', target: '_blank', rel: 'noreferrer', textContent: 'gemma4' });
    blocks.push(groupCard('On-device model (Gemma via Ollama)',
      statusRow('Ollama', o.reachable ? 'ok' : 'bad', o.reachable ? `Running on ${o.url.replace('http://', '')} · v${o.version}` : 'Not running — start the Ollama app', o.reachable ? null : null),
      statusRow('Gemma 4', o.model ? 'ok' : 'warn', o.model ? `${o.model} loaded` : 'Not pulled — run: ollama pull gemma4:e4b', o.model ? null : modelCtl),
      statusRow('Network exposure', o.exposedOnNetwork ? 'warn' : 'ok', o.exposedOnNetwork ? `OLLAMA_HOST=${o.ollamaHost} exposes it to your network` : 'Listening on this laptop only'),
      o.cloudModelsIgnored?.length ? statusRow('Cloud models', 'ok', `Ignoring ${o.cloudModelsIgnored.length} Ollama cloud model(s) — Vachan only uses local ones`) : null));
  }

  // On-device speech-to-text (whisper), the always-on transcriber in the desktop app.
  const w = h?.whisper;
  if (w) {
    blocks.push(groupCard('On-device speech-to-text',
      statusRow('Transcriber',
        w.ready ? 'ok' : (w.available ? 'warn' : ''),
        w.ready
          ? `whisper ${w.model}${w.gpu ? ' · GPU (near-instant)' : ' · CPU'} — ready, runs entirely on this laptop`
          : (w.available ? `whisper ${w.model} — loading the model…` : 'Not installed'))));
  }

  // Scheduling
  const timeInput = (key) => {
    const i = el('input', { className: 'time', type: 'time', value: settings[key] });
    i.addEventListener('change', () => save({ [key]: i.value }));
    return i;
  };
  blocks.push(groupCard('Auto-scheduling',
    row('Working hours', 'Vachan suggests times for timeless tasks inside this window.', el('div', { className: 'row' }, timeInput('workStart'), el('span', { textContent: '→' }), timeInput('workEnd')))));

  // Calendar sync
  if (feed) {
    blocks.push(groupCard('Calendar sync',
      el('div', { className: 'setrow' },
        el('div', { className: 'label' }, el('b', { textContent: 'Your task calendar' }),
          el('div', { className: 'sub', textContent: 'Subscribe from a desktop calendar app, or download the file. Served only from this laptop.' })),
        el('div', { className: 'row' },
          el('a', { className: 'btn', href: feed.download, download: 'vachan.ics', textContent: '⤓ Download .ics' })))));
  }

  // Speech & languages
  const langRows = LANGS.map((l) => {
    const s = langState(l.code);
    let ctl; let sub = 'On-device recognition, in Chrome.';
    if (s === 'available') ctl = el('span', { className: 'chip who', textContent: 'ready' });
    else if (s === 'fallback') {
      ctl = el('span', { className: 'chip who', textContent: 'via Hindi' });
      sub = 'Chrome has no on-device Marathi pack, so Vachan listens with the Hindi recogniser (both Devanagari) and Gemma reads it as Marathi.';
    } else if (s === 'downloadable' || s === 'downloading') {
      const b = el('button', { className: 'btn', textContent: s === 'downloading' ? 'Downloading…' : 'Install' });
      b.addEventListener('click', async () => { b.disabled = true; b.textContent = 'Downloading…'; await installLang(l.code); render(); });
      ctl = b;
    } else { ctl = el('span', { className: 'chip', textContent: 'not offered' }); sub = 'This browser has no on-device model for this language.'; }
    return row(l.label, sub, ctl);
  });
  blocks.push(groupCard('Speech & languages', ...langRows,
    row('How speech works', 'Recognition runs inside Chrome with processLocally = true. If a language has no on-device pack, Vachan won’t listen in it rather than send audio to the cloud.', el('span'))));

  // Assistant bridge (MCP)
  blocks.push(groupCard('Connect Claude / ChatGPT (MCP)',
    row('Assistant bridge',
      settings.assistantBridge ? 'ON — you’ve allowed a local MCP server to expose your task list read-only.' : 'Off — your tasks are not shared with any assistant.',
      toggle(settings.assistantBridge, () => save({ assistantBridge: !settings.assistantBridge }))),
    el('div', { className: 'setrow' }, el('div', { className: 'label' },
      el('div', { className: 'sub', textContent: 'When on, a local Model Context Protocol server lets Claude or ChatGPT read your tasks (read-only, on this machine). It stays off until you enable it, and no data leaves the laptop unless you point an assistant at it.' })))));

  // Habits — what Vachan has learned about your priorities.
  const habitRows = habits.length
    ? habits.map((h) => row(h.label, `${h.reason} (from ${h.observations} tasks)`,
      el('span', { className: `chip ${h.effect === 'more important' ? 'who' : ''}`, textContent: h.effect === 'more important' ? '↑ more important' : '↓ less important' })))
    : [el('div', { className: 'setrow' }, el('div', { className: 'label' }, el('div', { className: 'sub', textContent: 'Nothing learned yet. As you finish, skip or re-prioritise tasks, Vachan learns which kinds matter to you and nudges new tasks’ priority to match. Tap a task’s P badge to set its priority — that teaches it fastest.' })))];
  blocks.push(groupCard('What Vachan has learned (habits)', ...habitRows));

  // Appearance
  blocks.push(groupCard('Appearance', themeRow()));

  $('#settings').replaceChildren(...blocks);
}

export async function loadSettings() {
  try { settings = await api('/api/settings'); } catch { settings = settings || {}; }
  try { feed = (await api('/api/calendar')).feed; } catch { /* */ }
  try { habits = (await api('/api/habits')).learned; } catch { habits = []; }
  await refreshLangStates();
  render();
}

export function initSettings() {
  applyTheme(getTheme());
}
