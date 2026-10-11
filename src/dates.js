// Dates are this laptop's local time. The model never does date arithmetic: it picks a
// date from a lookup table we build, and the code checks what it picked.

const WEEKDAY = {
  en: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
  hi: ['रविवार', 'सोमवार', 'मंगलवार', 'बुधवार', 'गुरुवार', 'शुक्रवार', 'शनिवार'],
  mr: ['रविवार', 'सोमवार', 'मंगळवार', 'बुधवार', 'गुरुवार', 'शुक्रवार', 'शनिवार'],
};

const RELATIVE = [
  [0, 'today · aaj · आज'],
  [1, 'tomorrow · kal · कल (future tense) · उद्या'],
  [2, 'day after tomorrow · parso · परसों · परवा'],
  [-1, 'yesterday · कल (past tense) · काल'],
];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad = (n) => String(n).padStart(2, '0');

export const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
export const weekday = (d) => WEEKDAY.en[d.getDay()];

export function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

const dayNames = (wd) => (WEEKDAY.mr[wd] === WEEKDAY.hi[wd]
  ? `${WEEKDAY.en[wd]} · ${WEEKDAY.hi[wd]}`
  : `${WEEKDAY.en[wd]} · ${WEEKDAY.hi[wd]} · ${WEEKDAY.mr[wd]}`);

// Every way a day gets said, already resolved to a date, so the model only has to look up.
export function dateLookup(now = new Date(), days = 14) {
  const rows = RELATIVE.map(([i, words]) => {
    const d = addDays(now, i);
    return `${words} → ${ymd(d)} (${WEEKDAY.en[d.getDay()]})`;
  });

  rows.push('a weekday said alone, or "next"/"this coming" weekday, means its next date AFTER today:');
  for (let i = 1; i <= 7; i++) {
    const d = addDays(now, i);
    const note = i === 7 ? ` (today is ${WEEKDAY.en[now.getDay()]}; only "today"/"aaj" means ${ymd(now)})` : '';
    rows.push(`  ${dayNames(d.getDay())} → ${ymd(d)}${note}`);
  }

  const untilDay = (target) => (target - now.getDay() + 7) % 7;
  const weekend = addDays(now, now.getDay() === 0 ? 0 : untilDay(6));
  const nextWeek = addDays(now, untilDay(1) || 7);
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  rows.push(
    `this weekend · is weekend · ya weekend → ${ymd(weekend)}`,
    `next week · agle hafte · पुढच्या आठवड्यात → ${ymd(nextWeek)} (Monday)`,
    `end of this month · mahine ke end tak · महिनाअखेर → ${ymd(monthEnd)}`,
    'a day of the month said alone ("15 tarikh", "the 20th") is this month\'s if still ahead, otherwise next month\'s.',
  );

  const cal = [];
  for (let i = 0; i < days; i++) {
    const d = addDays(now, i);
    cal.push(`${WEEKDAY.en[d.getDay()].slice(0, 3)} ${d.getDate()} ${MON[d.getMonth()]} = ${ymd(d)}`);
  }
  rows.push(`calendar: ${cal.join(', ')}`);
  return rows.join('\n');
}

// For "in 20 minutes" / "do ghante mein": the model gives minutes, the code does the clock maths.
export function afterMinutes(minutes, now = new Date()) {
  const d = new Date(now.getTime() + minutes * 60_000);
  return { due_date: ymd(d), due_time: hm(d) };
}

// Accepts YYYY-MM-DD from a week ago up to ~13 months ahead; anything else becomes null.
export function cleanDueDate(s, now = new Date()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return null;
  const d = new Date(`${s}T00:00:00`);
  if (Number.isNaN(d.getTime()) || ymd(d) !== s) return null; // rejects 2026-02-31
  const days = Math.round((d - new Date(`${ymd(now)}T00:00:00`)) / 864e5);
  return days >= -7 && days <= 400 ? s : null;
}

export function cleanDueTime(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s || '');
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? `${pad(h)}:${pad(min)}` : null;
}

// A time with no day ("call mom at 6") means the next time that clock time comes round.
export function dateForTime(time, now = new Date()) {
  return time > hm(now) ? ymd(now) : ymd(addDays(now, 1));
}
