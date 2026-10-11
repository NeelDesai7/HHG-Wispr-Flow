import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeProfile, adjustWith } from '../src/habits.js';

const base = '2026-10-01T09:00:00Z';
const soon = '2026-10-01T12:00:00Z'; // 3h later = fast
const row = (o) => ({ category: 'other', person: null, kind: 'todo', source: 'voice', priority: 3, base_priority: 3, status: 'done', done_by: 'click', created_at: base, done_at: soon, updated_at: soon, ...o });

test('a category the user finishes quickly becomes more important', () => {
  const prof = computeProfile(Array.from({ length: 4 }, () => row({ category: 'health' })));
  const p = prof.get('category:health');
  assert.ok(p && p.delta === -1);
  const r = adjustWith(prof, { priority: 3, category: 'health', kind: 'todo' });
  assert.equal(r.priority, 2);
  assert.match(r.priority_reason, /^Raised/);
});

test('a category the user engages with but mostly skips becomes less important', () => {
  const rows = [row({ category: 'errands' }), ...Array.from({ length: 3 }, () => row({ category: 'errands', status: 'dismissed', done_at: null }))];
  const prof = computeProfile(rows);
  const p = prof.get('category:errands');
  assert.ok(p && p.delta === 1);
  assert.equal(adjustWith(prof, { priority: 3, category: 'errands', kind: 'todo' }).priority, 4);
});

test('pure cleanup dismissals (no completions) are not read as deprioritising', () => {
  const prof = computeProfile(Array.from({ length: 6 }, () => row({ category: 'errands', status: 'dismissed', done_by: 'click', done_at: null })));
  assert.equal(prof.get('category:errands'), undefined);
});

test('generic defaults (todo, other) are never learned as preferences', () => {
  const prof = computeProfile([
    ...Array.from({ length: 5 }, () => row({ category: 'other', kind: 'todo' })),
  ]);
  assert.equal(prof.get('category:other'), undefined);
  assert.equal(prof.get('kind:todo'), undefined);
});

test('hand-raising the priority teaches Vachan', () => {
  const prof = computeProfile(Array.from({ length: 4 }, () => row({ category: 'finance', priority: 1, base_priority: 3 })));
  assert.equal(prof.get('category:finance')?.delta, -1);
});

test('brain-removed (deduped) tasks are not treated as the user skipping', () => {
  const prof = computeProfile(Array.from({ length: 5 }, () => row({ category: 'work', status: 'dismissed', done_by: 'brain', done_at: null })));
  assert.equal(prof.get('category:work'), undefined);
});

test('too little evidence means no adjustment', () => {
  const prof = computeProfile([row({ category: 'health' }), row({ category: 'health' })]);
  assert.equal(prof.get('category:health'), undefined);
  const r = adjustWith(prof, { priority: 2, category: 'health', kind: 'todo' });
  assert.deepEqual([r.priority, r.priority_reason], [2, null]);
});

test('already-top priority cannot go below 1', () => {
  const prof = computeProfile(Array.from({ length: 4 }, () => row({ category: 'health' })));
  const r = adjustWith(prof, { priority: 1, category: 'health', kind: 'todo' });
  assert.equal(r.priority, 1);
  assert.equal(r.priority_reason, null);
});
