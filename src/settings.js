// User settings, persisted next to the database. These are the switches the Settings tab exposes:
// what Vachan may read, how it schedules, and whether the opt-in Claude/ChatGPT bridge is allowed.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DB_FILE } from './db.js';

const FILE = join(dirname(DB_FILE), 'settings.json');

export const DEFAULTS = {
  // Protections, ON by default. Each one hides a kind of sensitive content before anything is read.
  // The user can turn a protection off to let that kind through — it is never off to begin with.
  hideOtp: true, // one-time codes, verification / login codes
  hidePasswords: true, // passwords, PINs, CVV, recovery phrases
  hideKeys: true, // API keys and tokens
  maskCards: true, // mask card numbers in captured text
  // Which phone signals the sensor should forward (the Android app reads these once it's paired).
  readNotifications: true,
  readMessages: true,
  // Read THIS laptop's own notifications (Windows). Off until the user turns it on — it captures
  // notifications from all desktop apps, so it's a deliberate opt-in.
  laptopNotifications: false,
  // Auto-scheduling working hours.
  workStart: '08:00',
  workEnd: '21:00',
  // Opt-in bridge so Claude/ChatGPT (via the local MCP server) can read your tasks. Off by default.
  assistantBridge: false,
};

const isHM = (v) => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);

function sanitize(patch) {
  const out = {};
  for (const k of ['hideOtp', 'hidePasswords', 'hideKeys', 'maskCards', 'readNotifications', 'readMessages', 'laptopNotifications', 'assistantBridge']) {
    if (typeof patch[k] === 'boolean') out[k] = patch[k];
  }
  if (isHM(patch.workStart)) out.workStart = patch.workStart;
  if (isHM(patch.workEnd)) out.workEnd = patch.workEnd;
  // Working hours must be in order; ignore an inverted pair.
  if (out.workStart && out.workEnd && out.workStart >= out.workEnd) {
    delete out.workStart;
    delete out.workEnd;
  }
  return out;
}

let cache = (() => {
  try {
    const saved = JSON.parse(readFileSync(FILE, 'utf8'));
    // Migrate the old single "captureSecrets" switch to the per-kind protections.
    if (typeof saved.captureSecrets === 'boolean') {
      const protect = !saved.captureSecrets;
      saved.hideOtp ??= protect;
      saved.hidePasswords ??= protect;
      saved.hideKeys ??= protect;
      delete saved.captureSecrets;
    }
    return { ...DEFAULTS, ...saved };
  } catch {
    return { ...DEFAULTS };
  }
})();

export function getSettings() {
  return { ...cache };
}

export function setSettings(patch) {
  cache = { ...cache, ...sanitize(patch || {}) };
  try {
    writeFileSync(FILE, JSON.stringify(cache, null, 2), { mode: 0o600 });
  } catch (err) {
    console.error('settings write failed:', err.message);
  }
  return getSettings();
}
