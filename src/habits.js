// Habits: Vachan learns which kinds of tasks THIS user actually treats as important, from how
// they act — what they finish quickly, what they let slip or dismiss, and where they bump the
// priority up or down by hand. That learned profile nudges the priority of new tasks, on top of
// what Gemma assigns from the words. Everything is computed on-device from the task history.
import * as db from './db.js';

const FAST_MS = 36 * 3600 * 1000; // "acted on quickly" window
const MIN_OBS = 3; // don't adjust a feature until there's a little evidence
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

let cache = null;

// Builds, per feature value (a category, a person, a kind), a score and a priority nudge.
export function computeProfile(rows = db.habitRows()) {
  const stats = new Map();
  const bump = (key, f) => {
    if (!stats.has(key)) stats.set(key, { n: 0, done: 0, fast: 0, skipped: 0, edits: 0, bumpSum: 0 });
    f(stats.get(key));
  };
  for (const r of rows) {
    const feats = [`category:${r.category}`, r.person ? `person:${r.person}` : null, `kind:${r.kind}`].filter(Boolean);
    const resolved = r.status === 'done' || (r.status === 'dismissed' && r.done_by !== 'brain');
    const fast = r.status === 'done' && r.done_at && r.created_at && (new Date(r.done_at) - new Date(r.created_at) <= FAST_MS);
    const edited = r.base_priority != null && r.priority !== r.base_priority;
    for (const key of feats) bump(key, (s) => {
      if (resolved) { s.n++; if (r.status === 'done') s.done++; if (fast) s.fast++; if (r.status === 'dismissed') s.skipped++; }
      if (edited) { s.edits++; s.bumpSum += r.base_priority - r.priority; } // >0 = user made it more urgent
    });
  }

  const profile = new Map();
  for (const [key, s] of stats) {
    // Skip the catch-all defaults — "todo" and "other" aren't real preferences.
    if (key === 'kind:todo' || key === 'category:other') continue;
    const obs = s.n + s.edits;
    if (obs < MIN_OBS) continue;
    const actRate = s.n ? s.fast / s.n : 0;
    const skipRate = s.n ? s.skipped / s.n : 0;
    const manual = s.edits ? clamp(s.bumpSum / s.edits, -2, 2) : 0;
    const score = actRate - skipRate + 0.4 * manual;
    // Raise when the user acts fast / bumps up. Lower only when they genuinely engage with a kind
    // (some completions) yet mostly skip or lower it — so a burst of cleanup dismissals, which has
    // no completions, is NOT read as "you don't care about this".
    const delta = score >= 0.5 ? -1 : (score <= -0.35 && (s.done >= 1 || manual <= -0.5)) ? 1 : 0;
    if (!delta) continue;
    profile.set(key, { delta, obs, reason: reasonFor(key, delta, { actRate, skipRate, manual }) });
  }
  return profile;
}

function label(key) {
  const [kind, value] = key.split(':');
  if (kind === 'category') return `${value[0].toUpperCase()}${value.slice(1)} tasks`;
  if (kind === 'person') return `Tasks with ${value}`;
  return `${value[0].toUpperCase()}${value.slice(1)}s`; // promise→Promises, etc.
}

function reasonFor(key, delta, { actRate, skipRate, manual }) {
  const name = label(key).toLowerCase();
  if (delta < 0) {
    if (manual > 0.3) return `you usually bump ${name} up`;
    if (actRate >= 0.5) return `you act on ${name} quickly`;
    return `you treat ${name} as important`;
  }
  if (manual < -0.3) return `you usually lower ${name}`;
  if (skipRate >= 0.4) return `you often skip ${name}`;
  return `you rarely act on ${name}`;
}

export function refresh() { cache = computeProfile(); return cache; }
function profile() { if (!cache) refresh(); return cache; }

// Applies a learned profile to a new task. Pure — pass a profile (for tests), or use adjust().
export function adjustWith(prof, task) {
  const base = clamp(task.priority ?? 3, 1, 4);
  const keys = [`category:${task.category}`, task.person ? `person:${task.person}` : null, `kind:${task.kind}`].filter(Boolean);
  let best = null;
  for (const k of keys) {
    const p = prof.get(k);
    if (p && (!best || Math.abs(p.delta) > Math.abs(best.delta) || (Math.abs(p.delta) === Math.abs(best.delta) && p.obs > best.obs))) best = p;
  }
  if (!best) return { priority: base, base_priority: base, priority_reason: null };
  const priority = clamp(base + best.delta, 1, 4);
  if (priority === base) return { priority: base, base_priority: base, priority_reason: null };
  return { priority, base_priority: base, priority_reason: `${best.delta < 0 ? 'Raised' : 'Lowered'}: ${best.reason}` };
}

// The learned nudge for a new task, using the live profile.
export function adjust(task) { return adjustWith(profile(), task); }

// What has been learned, for the Settings "Habits" panel. Sorted strongest first.
export function learned() {
  const prof = profile();
  return [...prof.entries()]
    .map(([key, p]) => ({ label: label(key), effect: p.delta < 0 ? 'more important' : 'less important', reason: p.reason, observations: p.obs }))
    .sort((a, b) => (a.effect === b.effect ? b.observations - a.observations : a.effect === 'more important' ? -1 : 1));
}
