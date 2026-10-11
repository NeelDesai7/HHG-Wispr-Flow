// First-run setup: make sure the on-device brain (Ollama + the Gemma model) is present, installing
// it automatically so a fresh machine needs nothing but Vachan. Everything is fetched from the
// official Ollama source and runs on this computer; no task data is involved here.

import { EventEmitter } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { OLLAMA_URL } from './ollama.js';

export const setupEvents = new EventEmitter();

const OLLAMA_INSTALLER = 'https://ollama.com/download/OllamaSetup.exe';
const OLLAMA_EXE = join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe');

const state = {
  phase: 'checking',   // checking | installing-ollama | starting-ollama | pulling-model | warming | ready | need-ollama | need-model | error
  detail: 'Checking the on-device model…',
  pct: null,           // 0..1 for the active download, else null
  error: null,
  ready: false,
  model: null,
};
let running = false;

export function setupState() { return { ...state }; }

function set(phase, detail, pct = null) {
  state.phase = phase;
  state.detail = detail;
  state.pct = pct;
  state.ready = phase === 'ready';
  if (phase !== 'error') state.error = null;
  setupEvents.emit('change', setupState());
}

// ── probes ──────────────────────────────────────────────
async function reachable() {
  try {
    const res = await fetch(new URL('/api/version', OLLAMA_URL), { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch { return false; }
}
async function hasModel(model) {
  try {
    const res = await fetch(new URL('/api/tags', OLLAMA_URL), { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return false;
    const { models = [] } = await res.json();
    return models.some((m) => m.name === model || m.name === `${model}:latest`);
  } catch { return false; }
}
function ollamaInstalled() {
  if (existsSync(OLLAMA_EXE)) return true;
  try { return spawnSync('where', ['ollama'], { windowsHide: true }).status === 0; } catch { return false; }
}

// ── actions ─────────────────────────────────────────────
async function download(url, dest, onPct) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`download failed (${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  const file = createWriteStream(dest);
  let got = 0;
  try {
    for await (const chunk of res.body) {
      got += chunk.length;
      if (!file.write(chunk)) await new Promise((r) => file.once('drain', r));
      if (total) onPct?.(got / total);
    }
  } finally { await new Promise((r) => file.end(r)); }
}

function runInstaller(path) {
  // OllamaSetup.exe is an Inno Setup installer — these flags make it silent and non-blocking.
  return new Promise((resolve, reject) => {
    const p = spawn(path, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'], { windowsHide: true });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`Ollama installer exited ${code}`))));
    p.on('error', reject);
  });
}

function startOllama() {
  const exe = existsSync(OLLAMA_EXE) ? OLLAMA_EXE : 'ollama';
  try { spawn(exe, ['serve'], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch { /* */ }
}

async function waitReachable(timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await reachable()) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function pullModel(model) {
  const res = await fetch(new URL('/api/pull', OLLAMA_URL), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, stream: true }),
  });
  if (!res.ok || !res.body) throw new Error(`pull failed (${res.status})`);
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const m = JSON.parse(line);
      if (m.error) throw new Error(m.error);
      const pct = m.total ? (m.completed || 0) / m.total : null;
      const gb = m.total ? ` · ${((m.completed || 0) / 1e9).toFixed(1)}/${(m.total / 1e9).toFixed(1)} GB` : '';
      set('pulling-model', `Downloading the Gemma model${gb}`, pct);
    }
  }
}

// ── orchestration ───────────────────────────────────────
// auto = allowed to install/download (the desktop app). When false, we only report what's missing.
export async function ensureReady(model, auto) {
  if (running) return;
  running = true;
  state.model = model;
  try {
    set('checking', 'Checking the on-device model…');
    if (await reachable()) {
      if (await hasModel(model)) { set('ready', 'Ready'); return; }
      if (!auto) { set('need-model', `The model ${model} isn’t installed. Run: ollama pull ${model}`); return; }
      set('pulling-model', 'Downloading the Gemma model…', 0);
      await pullModel(model);
      set('ready', 'Ready');
      return;
    }
    // Ollama isn't answering.
    if (!auto) { set('need-ollama', 'Ollama isn’t running. Start the Ollama app.'); return; }
    if (!ollamaInstalled()) {
      set('installing-ollama', 'Downloading Ollama…', 0);
      const dir = join(process.env.LOCALAPPDATA || process.env.TEMP || '.', 'Vachan', 'setup');
      mkdirSync(dir, { recursive: true });
      const exe = join(dir, 'OllamaSetup.exe');
      await download(OLLAMA_INSTALLER, exe, (p) => set('installing-ollama', 'Downloading Ollama…', p));
      set('installing-ollama', 'Installing Ollama…', null);
      await runInstaller(exe);
    }
    set('starting-ollama', 'Starting Ollama…');
    if (!(await waitReachable(8000))) { startOllama(); if (!(await waitReachable(45000))) throw new Error('Ollama did not start'); }
    if (!(await hasModel(model))) { set('pulling-model', 'Downloading the Gemma model…', 0); await pullModel(model); }
    set('ready', 'Ready');
  } catch (err) {
    state.error = err.message;
    set('error', err.message);
  } finally {
    running = false;
  }
}
