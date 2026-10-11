// Runs the Windows notification sensor and feeds each notification into the same pipeline as the
// phone: screen for secrets → Gemma makes a task → forget the text. Windows only, opt-in.
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { ingestEvents } from './brain.js';

const SCRIPT = fileURLToPath(new URL('./sensors/win-notifications.ps1', import.meta.url));
const b64 = (s) => (s ? Buffer.from(s, 'base64').toString('utf8') : '');

export const laptop = {
  supported: process.platform === 'win32',
  running: false,
  access: null, // 'Allowed' | 'Denied' | null
  read: 0,
  lastAt: null,
  error: null,
};

let child = null;
let stopped = false;
let restarts = 0;
let onChange = () => {};

export function onLaptopChange(fn) { onChange = fn; }

// Turns one JSON line from the sensor into an action. Exported for tests.
export function handleLine(line, ingest = ingestEvents) {
  let msg;
  try { msg = JSON.parse(line); } catch { return null; }
  if (msg.type === 'access') { laptop.access = msg.status; onChange(); return { access: msg.status }; }
  if (msg.type === 'ready') { laptop.running = true; laptop.error = null; restarts = 0; onChange(); return { ready: true }; }
  if (msg.type === 'error') { laptop.error = msg.reason; onChange(); return { error: msg.reason }; }
  if (msg.type !== 'notification') return null;
  const app = b64(msg.app).trim();
  const event = { app: app || 'Windows', kind: 'notification', title: b64(msg.title), body: b64(msg.body), at: msg.at };
  if (!event.title && !event.body) return null;
  laptop.read += 1;
  laptop.lastAt = new Date().toISOString();
  Promise.resolve(ingest([event])).catch((err) => {
    if (!err.deferred) console.error('laptop ingest:', err.message);
  });
  onChange();
  return { event };
}

export function startLaptopNotifications() {
  if (!laptop.supported || child) return;
  stopped = false;
  const launch = () => {
    const args = ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-ParentPid', String(process.pid)];
    if (process.env.VACHAN_LAPTOP_EMIT_EXISTING) args.push('-EmitExisting'); // test aid only
    child = spawn('powershell.exe', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    readline.createInterface({ input: child.stdout }).on('line', (l) => handleLine(l));
    child.stderr.on('data', (d) => { laptop.error = String(d).trim().slice(0, 200); });
    child.on('exit', (code) => {
      child = null;
      laptop.running = false;
      if (code === 2) laptop.access = laptop.access || 'Denied';
      onChange();
      if (!stopped && restarts++ < 5) setTimeout(launch, 3000 * restarts);
    });
  };
  launch();
}

export function stopLaptopNotifications() {
  stopped = true;
  laptop.running = false;
  if (child) { child.kill(); child = null; }
  onChange();
}

export function laptopStatus() {
  return { ...laptop };
}
