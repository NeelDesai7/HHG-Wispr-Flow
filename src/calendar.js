// The calendar: turns tasks into time slots (auto-scheduling the ones without a time) and into
// an iCalendar feed the device's calendar app can subscribe to or import. Everything is computed
// from the local tasks; nothing leaves the laptop.
import { ymd, hm, addDays } from './dates.js';

const pad = (n) => String(n).padStart(2, '0');
const toMin = (t) => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};
const toHM = (min) => `${pad(Math.floor(min / 60) % 24)}:${pad(min % 60)}`;

export const DEFAULTS = { dayStart: '08:00', dayEnd: '21:00', slotMinutes: 30 };

// Gives every open task a place on the calendar. Tasks with a time keep it (a fixed block).
// Tasks with a day but no time get a suggested slot in the first free gap of that day's working
// hours. Tasks with no day at all get a suggested slot on the next day that still has room,
// starting today. Returns [{ task, date, start, end, suggested }], sorted by day then start.
export function autoSchedule(tasks, now = new Date(), prefs = {}) {
  const { dayStart, dayEnd, slotMinutes } = { ...DEFAULTS, ...prefs };
  const open = tasks.filter((t) => t.status === 'open');
  const startMin = toMin(dayStart);
  const endMin = toMin(dayEnd);
  const today = ymd(now);
  const nowMin = now.getHours() * 60 + now.getMinutes();

  // Busy intervals per day, seeded with the fixed-time tasks, so suggestions don't overlap them.
  const busy = new Map();
  const markBusy = (date, s, e) => {
    if (!busy.has(date)) busy.set(date, []);
    busy.get(date).push([s, e]);
  };
  const placed = [];
  const needsSlot = [];

  for (const t of open) {
    if (t.due_date && t.due_time) {
      const s = toMin(t.due_time);
      const e = Math.min(s + slotMinutes, 24 * 60);
      markBusy(t.due_date, s, e);
      placed.push({ task: t, date: t.due_date, start: t.due_time, end: toHM(e), suggested: false });
    } else {
      needsSlot.push(t);
    }
  }

  // Higher priority and earlier-dated tasks get the better (earlier) slots.
  needsSlot.sort((a, b) => (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999') || a.priority - b.priority || a.id - b.id);

  const firstFreeSlot = (date) => {
    const floor = date === today ? Math.max(startMin, Math.ceil((nowMin + 1) / slotMinutes) * slotMinutes) : startMin;
    const intervals = (busy.get(date) ?? []).slice().sort((a, b) => a[0] - b[0]);
    for (let s = floor; s + slotMinutes <= endMin; s += slotMinutes) {
      const e = s + slotMinutes;
      if (!intervals.some(([bs, be]) => s < be && e > bs)) return s;
    }
    return null;
  };

  for (const t of needsSlot) {
    let date = t.due_date;
    let s = null;
    if (date) {
      s = firstFreeSlot(date);
      if (s == null) s = endMin - slotMinutes; // day is full: pin to the end rather than drop it
    } else {
      for (let i = 0; i < 14 && s == null; i++) {
        date = ymd(addDays(now, i));
        s = firstFreeSlot(date);
      }
      if (s == null) {
        date = today;
        s = endMin - slotMinutes;
      }
    }
    const e = s + slotMinutes;
    markBusy(date, s, e);
    placed.push({ task: t, date, start: toHM(s), end: toHM(e), suggested: true });
  }

  return placed.sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
}

// ── iCalendar (RFC 5545) ─────────────────────────────────

const esc = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

// Content lines are folded at 75 octets, continued with a leading space.
function fold(line) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const parts = [];
  let i = 0;
  while (i < bytes.length) {
    const take = Math.min(i === 0 ? 75 : 74, bytes.length - i);
    parts.push((i === 0 ? '' : ' ') + bytes.subarray(i, i + take).toString('utf8'));
    i += take;
  }
  return parts.join('\r\n');
}

const stamp = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
const localDT = (date, time) => `${date.replace(/-/g, '')}T${time.replace(':', '')}00`;

// `slots` is autoSchedule output; suggested slots become events too, so the device calendar shows
// the whole plan. `PRIORITY` maps 1→1 (high) … 4→9 (low); a VALARM fires 10 min before timed tasks.
export function toICS(slots, { now = new Date(), name = 'Vachan', includeSuggested = true } = {}) {
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Vachan//Tasks//EN', 'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH', `X-WR-CALNAME:${esc(name)}`, 'X-WR-TIMEZONE:local',
  ];
  const dtstamp = stamp(now);
  for (const slot of slots) {
    if (slot.suggested && !includeSuggested) continue;
    const t = slot.task;
    // Every slot has a time (auto-scheduled when the task had none), so events are always timed.
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:vachan-task-${t.id}@vachan.local`);
    lines.push(`DTSTAMP:${dtstamp}`);
    lines.push(`DTSTART:${localDT(slot.date, slot.start)}`);
    lines.push(`DTEND:${localDT(slot.date, slot.end)}`);
    lines.push(fold(`SUMMARY:${slot.suggested ? '◇ ' : ''}${esc(t.title)}`));
    const desc = [t.details, t.person && `With: ${t.person}`, slot.suggested && '(suggested time — change it in Vachan)']
      .filter(Boolean).join('\\n');
    if (desc) lines.push(fold(`DESCRIPTION:${esc(desc)}`));
    if (t.category) lines.push(`CATEGORIES:${esc(String(t.category).toUpperCase())}`);
    lines.push(`PRIORITY:${t.priority <= 1 ? 1 : t.priority === 2 ? 3 : t.priority === 3 ? 5 : 9}`);
    lines.push(`STATUS:${t.status === 'done' ? 'COMPLETED' : 'CONFIRMED'}`);
    if (!slot.suggested) {
      lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${esc(t.title)}`, 'TRIGGER:-PT10M', 'END:VALARM');
    }
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}
