import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoSchedule, toICS } from '../src/calendar.js';

const NOW = new Date('2026-10-12T10:00:00'); // a Monday morning
const task = (over) => ({ id: 1, title: 'Task', status: 'open', priority: 3, category: 'work', due_date: null, due_time: null, details: null, person: null, ...over });

test('timed tasks keep their time; timeless dated tasks get a suggested slot that day', () => {
  const slots = autoSchedule([
    task({ id: 1, title: 'Standup', due_date: '2026-10-12', due_time: '09:30' }),
    task({ id: 2, title: 'Write report', due_date: '2026-10-12' }),
  ], NOW);
  const standup = slots.find((s) => s.task.id === 1);
  const report = slots.find((s) => s.task.id === 2);
  assert.equal(standup.start, '09:30');
  assert.equal(standup.suggested, false);
  assert.equal(report.suggested, true);
  assert.equal(report.date, '2026-10-12');
  // suggested slot is in working hours and after "now" (10:00) for today
  assert.ok(report.start >= '10:00');
});

test('suggested slots do not overlap fixed ones', () => {
  const slots = autoSchedule([
    task({ id: 1, title: 'Call', due_date: '2026-10-12', due_time: '10:30' }),
    task({ id: 2, title: 'A', due_date: '2026-10-12' }),
    task({ id: 3, title: 'B', due_date: '2026-10-12' }),
  ], NOW);
  const times = slots.map((s) => [s.start, s.end]);
  for (let i = 0; i < times.length; i++) {
    for (let j = i + 1; j < times.length; j++) {
      assert.ok(times[i][1] <= times[j][0] || times[j][1] <= times[i][0], `overlap ${times[i]} ${times[j]}`);
    }
  }
});

test('an undated task lands on the next day with room', () => {
  const [slot] = autoSchedule([task({ id: 1, title: 'Someday thing' })], NOW);
  assert.equal(slot.suggested, true);
  assert.ok(slot.date >= '2026-10-12');
});

test('higher priority gets the earlier suggested slot', () => {
  const slots = autoSchedule([
    task({ id: 1, title: 'low', due_date: '2026-10-12', priority: 4 }),
    task({ id: 2, title: 'high', due_date: '2026-10-12', priority: 1 }),
  ], NOW);
  const low = slots.find((s) => s.task.id === 1);
  const high = slots.find((s) => s.task.id === 2);
  assert.ok(high.start < low.start);
});

test('ICS is well-formed: matched BEGIN/END, CRLF, a timed and an all-day event', () => {
  const slots = autoSchedule([
    task({ id: 1, title: 'Call the bank', due_date: '2026-10-12', due_time: '10:30', person: 'HDFC' }),
    task({ id: 2, title: 'Pay rent', due_date: '2026-10-13' }),
  ], NOW);
  const ics = toICS(slots, { now: NOW });
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /END:VCALENDAR\r\n$/);
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 2);
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, (ics.match(/END:VEVENT/g) || []).length);
  assert.match(ics, /DTSTART:20261012T103000/);          // the fixed-time task
  assert.match(ics, /DTSTART:20261013T/);                 // the auto-scheduled task gets a time too
  assert.match(ics, /SUMMARY:Call the bank/);
  assert.match(ics, /SUMMARY:◇ Pay rent/);                // suggested events are marked
  assert.match(ics, /BEGIN:VALARM/);
  assert.ok(ics.split('\r\n').every((l) => Buffer.from(l, 'utf8').length <= 75), 'all lines folded to <=75 octets');
});

test('special characters in a title are escaped', () => {
  const ics = toICS(autoSchedule([task({ id: 1, title: 'Email Priya; send notes, draft', due_date: '2026-10-12', due_time: '11:00' })], NOW), { now: NOW });
  assert.match(ics, /SUMMARY:Email Priya\\; send notes\\, draft/);
});
