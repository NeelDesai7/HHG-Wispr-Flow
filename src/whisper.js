// On-device speech-to-text via whisper.cpp. A local whisper-server holds the model in memory and
// transcribes clips over loopback — fast, multilingual (Hindi, Marathi, English), and entirely on
// this machine. Audio is sent only to this local process and never written to disk here.
//
// In the desktop app, Electron starts and owns the whisper-server and passes its URL in
// WHISPER_URL, so its lifetime is tied to the app. Run standalone (plain `npm start`), this module
// starts it itself when the binary and model are present; otherwise callers fall back to Gemma.

import { spawn } from 'node:child_process';
import { request as httpRequest, get as httpGet } from 'node:http';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
// Prefer the GPU (CUDA) build when it's installed — it transcribes a clip in ~0.2 s vs ~5 s on CPU.
const BIN_CUDA = join(ROOT, 'vendor', 'whisper', 'bin-cuda', 'Release', 'whisper-server.exe');
const BIN_CPU = join(ROOT, 'vendor', 'whisper', 'bin', 'Release', 'whisper-server.exe');
const BIN = existsSync(BIN_CUDA) ? BIN_CUDA : BIN_CPU;
const GPU = BIN === BIN_CUDA;
const MODEL = join(ROOT, 'vendor', 'whisper', 'models', 'ggml-small.bin');

const EXTERNAL = !!process.env.WHISPER_URL; // set by the desktop app, which owns the process
const PORT = Number(process.env.WHISPER_PORT) || 5182;
const BASE = (process.env.WHISPER_URL || `http://127.0.0.1:${PORT}`).replace(/\/$/, '');

let proc = null;
let ready = false;

// Whether whisper can be used at all: either the desktop app manages it, or we have the files.
export function whisperAvailable() { return EXTERNAL || (existsSync(BIN) && existsSync(MODEL)); }

export function whisperState() {
  return { available: whisperAvailable(), running: EXTERNAL || !!proc, ready, model: 'ggml-small', gpu: GPU, url: BASE, managed: EXTERNAL ? 'app' : 'server' };
}

// Start the local whisper-server (standalone mode only). No-op when the app manages it.
export function startWhisper() {
  if (EXTERNAL || proc || !whisperAvailable()) { pollReady(); return; }
  proc = spawn(BIN, ['-m', MODEL, '--host', '127.0.0.1', '--port', String(PORT)], {
    cwd: dirname(BIN), stdio: 'ignore', windowsHide: true,
  });
  proc.on('exit', () => { proc = null; ready = false; });
  proc.on('error', () => { proc = null; ready = false; });
  pollReady();
}

export function stopWhisper() { try { proc?.kill(); } catch { /* */ } proc = null; ready = false; }

// Poll until the server answers, then mark ready (the model is loaded before it listens).
function pollReady(deadline = Date.now() + 60_000) {
  if (ready) return;
  const req = httpGet(`${BASE}/`, (res) => { res.resume(); ready = true; });
  req.on('error', () => { if (Date.now() < deadline) setTimeout(() => pollReady(deadline), 400); });
}

function whenReady(timeoutMs = 20_000) {
  if (ready) return Promise.resolve(true);
  return new Promise((resolve) => {
    const started = Date.now();
    const t = setInterval(() => {
      if (ready) { clearInterval(t); resolve(true); }
      else if (Date.now() - started > timeoutMs) { clearInterval(t); resolve(false); }
    }, 200);
  });
}

// Transcribe a 16 kHz mono WAV (Buffer) on-device. Returns { text, ms }.
export async function transcribeWhisper(wavBuffer) {
  if (!EXTERNAL && !proc) startWhisper();
  if (!ready && !(await whenReady())) { const e = new Error('whisper not ready'); e.notReady = true; throw e; }
  const t0 = Date.now();
  const { body, boundary } = buildMultipart({ response_format: 'json', temperature: '0', language: 'auto' }, wavBuffer);
  const text = await postInference(body, boundary);
  return { text, ms: Date.now() - t0 };
}

function buildMultipart(fields, file) {
  const boundary = '----vachan' + randomBytes(12).toString('hex');
  const CRLF = '\r\n';
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}${CRLF}Content-Disposition: form-data; name="${k}"${CRLF}${CRLF}${v}${CRLF}`));
  }
  parts.push(Buffer.from(`--${boundary}${CRLF}Content-Disposition: form-data; name="file"; filename="clip.wav"${CRLF}Content-Type: audio/wav${CRLF}${CRLF}`));
  parts.push(file);
  parts.push(Buffer.from(`${CRLF}--${boundary}--${CRLF}`));
  return { body: Buffer.concat(parts), boundary };
}

function postInference(body, boundary) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${BASE}/inference`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
    }, (res) => {
      let d = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`whisper HTTP ${res.statusCode}`));
        try { resolve(String(JSON.parse(d).text || '').trim()); } catch { resolve(d.trim()); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

process.on('exit', () => { try { proc?.kill(); } catch { /* */ } });
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { stopWhisper(); process.exit(0); });
