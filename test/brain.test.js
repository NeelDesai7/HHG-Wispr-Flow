import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cleanDueDate, cleanDueTime, dateForTime, dateLookup } from '../src/dates.js';

// brain.js opens the SQLite store on import; point it at a throwaway folder.
process.env.VACHAN_DATA_DIR = mkdtempSync(join(tmpdir(), 'vachan-test-'));
const { decide, similarity, passages, createItemStream, grounding, looksUnfinished, buildMessages } = await import('../src/brain.js');

const NOW = new Date('2026-10-09T22:30:00'); // a Friday, local time
const add = (over = {}) => ({
  evidence: 'main kal subah tak deck bhej dunga', title: 'Send Riya the deck', details: '', unclear: '',
  person: 'Riya', kind: 'promise', due_date: '2026-10-10', due_time: '09:00', due_in_minutes: 0,
  priority: 2, category: 'work', confidence: 0.9, ...over,
});
const voice = (open = []) => ({ open, mode: 'voice', now: NOW });

test('date lookup resolves every way a day is said, in all three languages', () => {
  const table = dateLookup(NOW);
  assert.match(table, /tomorrow · kal · कल \(future tense\) · उद्या → 2026-10-10 \(Saturday\)/);
  assert.match(table, /parso · परसों · परवा → 2026-10-11/);
  assert.match(table, /Monday · सोमवार → 2026-10-12/);
  // Said on a Friday, "Friday" means next week's, not today's.
  assert.match(table, /Friday · शुक्रवार → 2026-10-16 \(today is Friday/);
  assert.match(table, /Tuesday · मंगलवार · मंगळवार → 2026-10-13/);
  assert.match(table, /Fri 16 Oct = 2026-10-16/);
  assert.match(table, /this weekend .* → 2026-10-10/);
  assert.match(table, /next week .* → 2026-10-12/);
  assert.match(table, /end of this month .* → 2026-10-31/);
});

test('due dates outside a sane window are dropped', () => {
  assert.equal(cleanDueDate('2026-10-10', NOW), '2026-10-10');
  assert.equal(cleanDueDate('2026-02-31', NOW), null);
  assert.equal(cleanDueDate('2019-01-01', NOW), null);
  assert.equal(cleanDueDate('tomorrow', NOW), null);
  assert.equal(cleanDueTime('9:05'), '09:05');
  assert.equal(cleanDueTime('25:00'), null);
});

test('a time with no day is the next time that clock time comes round', () => {
  assert.equal(dateForTime('23:00', NOW), '2026-10-09');
  assert.equal(dateForTime('09:00', NOW), '2026-10-10');
});

test('"in 20 minutes" is turned into a clock time by the code, not the model', () => {
  const [d] = decide({ add: [add({ due_date: '', due_time: '', due_in_minutes: 20 })] }, voice());
  assert.equal(d.task.due_date, '2026-10-09');
  assert.equal(d.task.due_time, '22:50');
  const [late] = decide({ add: [add({ due_date: '', due_time: '', due_in_minutes: 120 })] }, voice());
  assert.deepEqual([late.task.due_date, late.task.due_time], ['2026-10-10', '00:30']);
});

test('"Friday" said on a Friday means next Friday unless "aaj"/"today" was said', () => {
  const said = (sourceText) => decide({ add: [add({ due_date: '2026-10-09', due_time: '16:15' })] }, { ...voice(), sourceText })[0].task.due_date;
  assert.equal(said('शुक्रवार को सवा चार बजे टीम मीटिंग है'), '2026-10-16');
  assert.equal(said('shukravar ko meeting hai'), '2026-10-16');
  assert.equal(said('aaj shukravar hai, 4:15 ko meeting'), '2026-10-09');
  assert.equal(said('meeting at 4:15 today'), '2026-10-09');
});

test('the day and time are kept out of titles and details', () => {
  const [d] = decide({ add: [add({ title: 'Fill appraisal form by end of this month', details: 'Due tomorrow' })] }, voice());
  assert.equal(d.task.title, 'Fill appraisal form');
  assert.equal(d.task.details, null);
  const [k] = decide({ add: [add({ title: 'Book the Friday flight', details: 'window seat, under ₹6,000' })] }, voice());
  assert.equal(k.task.title, 'Book the Friday flight');
  const [m] = decide({ add: [add({ title: 'Call Mom on Monday about the trip' })] }, voice());
  assert.equal(m.task.title, 'Call Mom on Monday about the trip', 'words after the day are kept');
  assert.equal(k.task.details, 'window seat, under ₹6,000');
});

test('a clean voice proposal becomes a task, details and unclear words included', () => {
  const [d] = decide({ add: [add({ details: 'CC the client', unclear: 'deck name cut off' })] }, voice());
  assert.equal(d.op, 'add');
  assert.equal(d.task.person, 'Riya');
  assert.equal(d.task.due_date, '2026-10-10');
  assert.equal(d.task.details, 'CC the client');
  assert.equal(d.task.unclear, 'deck name cut off');
});

test('low confidence and placeholder people are handled', () => {
  const ds = decide({
    add: [
      add({ confidence: 0.3, title: 'Vague idea about a trip' }),
      add({ title: 'Pay the electricity bill', person: 'speaker', due_date: 'next monday', due_time: '' }),
    ],
  }, voice());
  assert.deepEqual(ds.map((d) => d.op), ['skip', 'add']);
  assert.match(ds[0].reason, /low confidence/);
  assert.equal(ds[1].task.person, null);
  assert.equal(ds[1].task.due_date, null);
});

test('saying a task again merges anything new into it instead of adding a copy', () => {
  const open = [{ id: 7, title: 'Send the deck to Riya', kind: 'promise', person: 'Riya', due_date: null, due_time: null, details: null }];
  const [merged] = decide({ add: [add()] }, voice(open));
  assert.equal(merged.op, 'update');
  assert.equal(merged.id, 7);
  assert.deepEqual(merged.patch, { due_date: '2026-10-10', due_time: '09:00' });
  assert.ok(merged.merged);

  const known = [{ ...open[0], due_date: '2026-10-10', due_time: '09:00' }];
  const [dupe] = decide({ add: [add()] }, voice(known));
  assert.equal(dupe.op, 'skip');
  assert.equal(dupe.reason, 'duplicate of #7');
});

test('two adds of the same task in one reply keep one copy', () => {
  const ds = decide({ add: [add(), add({ title: 'Send the deck to Riya' })] }, voice());
  assert.deepEqual(ds.map((d) => d.op), ['add', 'skip']);
});

test('an update corrects an open task and clears its warning', () => {
  const open = [{ id: 7, title: 'Buy Raspberry Pi for the new project', person: null, due_date: null, due_time: null, details: null, unclear: 'board name unclear' }];
  const [u] = decide({
    update: [{ task_id: 7, evidence: 'not Raspberry the STM32', title: 'Buy STM32 board for the new project', details: '', unclear: '', person: '', due_date: '2026-10-10', due_time: '', due_in_minutes: 0, confidence: 0.9 }],
  }, voice(open));
  assert.equal(u.op, 'update');
  assert.equal(u.patch.title, 'Buy STM32 board for the new project');
  assert.equal(u.patch.due_date, '2026-10-10');
  assert.equal(u.patch.unclear, null);
});

test('an update that changes nothing is skipped', () => {
  const open = [{ id: 7, title: 'Call the bank', person: null, due_date: null, due_time: null, details: null }];
  const [u] = decide({ update: [{ task_id: 7, evidence: 'bank', title: 'Call the bank', details: '', unclear: '', person: '', due_date: '', due_time: '', due_in_minutes: 0, confidence: 0.9 }] }, voice(open));
  assert.equal(u.op, 'skip');
  assert.equal(u.reason, 'no change');
});

test('done only applies to a task that is actually open, and only once', () => {
  const open = [{ id: 3, title: 'Call the bank' }];
  const ds = decide({
    done: [
      { task_id: 3, evidence: 'bank ko call kar diya', confidence: 0.9 },
      { task_id: 3, evidence: 'haan ho gaya', confidence: 0.9 },
      { task_id: 99, evidence: 'done', confidence: 0.9 },
    ],
  }, voice(open));
  assert.deepEqual(ds.map((d) => d.op), ['complete', 'skip', 'skip']);
  const [typed] = decide({ done: [{ task_id: 3, evidence: 'x', confidence: 1 }] }, { open, mode: 'typed', now: NOW });
  assert.equal(typed.op, 'skip', 'typing a task never ticks one off');
});

test('a tick-off quoting the earlier context, not the new lines, is refused', () => {
  const open = [{ id: 2, title: 'Purchase STM32 for new project' }];
  const opts = { ...voice(open), sourceText: 'And add one more task That I have to make a presentation Of H' };
  const [d] = decide({ done: [{ task_id: 2, evidence: 'क्रिएट कार्ड बिल भर दिया है', confidence: 0.9 }] }, opts);
  assert.equal(d.op, 'skip');
  assert.equal(d.reason, 'evidence is not in the new lines');
  const ok = { ...voice(open), sourceText: 'okay STM32 wala order kar diya' };
  assert.equal(decide({ done: [{ task_id: 2, evidence: 'STM32 wala order kar diya', confidence: 0.9 }] }, ok)[0].op, 'complete');
});

test('Devanagari evidence is matched word for word', () => {
  assert.equal(grounding('क्रिएट कार्ड बिल भर दिया है', 'वेट मैने क्रिएट कार्ड बिल भर दिया है'), 1);
  assert.equal(grounding('क्रिएट कार्ड बिल भर दिया है', 'I have to make a presentation'), 0);
});

test('announcements are never tasks', () => {
  for (const title of ['Add another task', 'Add one more task', 'Remember another task', 'One more task', 'Next task', 'Add task of']) {
    assert.equal(decide({ add: [add({ title })] }, voice())[0].reason, 'announcement, not a task', title);
  }
  assert.equal(decide({ add: [add({ title: 'Review the task list with Riya' })] }, voice())[0].op, 'add');
  // "Add another task for the ESD project" is an announcement with a topic, not a task.
  for (const title of ['Add another task for the ESD project', 'Create a task about the invoice', 'Make a new task for Mom']) {
    assert.equal(decide({ add: [add({ title })] }, voice())[0].reason, 'announcement, not a task', title);
  }
  // but a real action that happens to mention "for" is kept
  assert.equal(decide({ add: [add({ title: 'Add milk to the shopping list' })] }, voice())[0].op, 'add');
  assert.equal(decide({ add: [add({ title: 'Make a presentation for the ESD review' })] }, voice())[0].op, 'add');
});

test('the rest of a sentence finishes the task made from its first half', () => {
  // "Reminding me to call" was read alone and became "Call"; now "Showroom" has arrived.
  const open = [
    { id: 9, title: 'Add one more task', kind: 'todo', person: null, due_date: null, due_time: null, details: null },
    { id: 10, title: 'Call', kind: 'todo', person: null, due_date: null, due_time: null, details: null },
  ];
  const opts = { ...voice(open), sourceText: 'And Add one more task Reminding me to call Showroom', removable: new Set([9, 10]) };
  const ds = decide({
    remove: [{ task_id: 9, reason: 'announcement, not a task', confidence: 0.9 }],
    add: [add({ title: 'Call the showroom', kind: 'reminder', person: '', due_date: '', due_time: '', evidence: 'Reminding me to call Showroom' })],
  }, opts);
  assert.deepEqual(ds.map((d) => d.op), ['remove', 'update']);
  assert.equal(ds[1].id, 10);
  assert.equal(ds[1].patch.title, 'Call the showroom');
  assert.equal(ds[1].patch.kind, 'reminder');
});

test('a plan item re-heard differently on the same day collapses into one task', () => {
  const open = [{ id: 5, title: 'Complete the MLCB project', kind: 'todo', person: null, due_date: '2026-10-13', due_time: null, details: null }];
  // Same Tuesday, shares "complete, MLCB" → same task; the fuller wording wins.
  const [d] = decide({ add: [add({ title: 'Complete the MLCV task on the MLCB project', due_date: '2026-10-13', person: '', due_time: '' })] }, voice(open));
  assert.equal(d.op, 'update');
  assert.equal(d.id, 5);
  assert.match(d.patch.title, /MLCV task/);
  // Different day with the same verb is a different task, not a merge.
  const [sep] = decide({ add: [add({ title: 'Complete the EDI project', due_date: '2026-10-12', person: '', due_time: '' })] }, voice(open));
  assert.equal(sep.op, 'add');
});

test('re-saying an existing task does not duplicate it, regardless of age', () => {
  const old = [{ id: 9, title: 'Pay the electricity bill', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', kind: 'todo', person: null, due_date: null, due_time: null, details: null }];
  const [d] = decide({ add: [add({ title: 'Pay the electricity bill', person: '', due_date: '', due_time: '' })] }, voice(old));
  assert.equal(d.op, 'skip');
  assert.match(d.reason, /duplicate of #9/);
});

test('a re-read that quotes the same words plus more replaces its first reading', () => {
  const open = [{ id: 11, title: 'Complete the ERI project', kind: 'todo', person: null, due_date: '2026-10-10', due_time: null, details: null, evidence: 'Completing the ERI project tomorrow' }];
  const opts = { ...voice(open), removable: new Set([11]), sourceText: 'And add another task of Completing the ERI project tomorrow Like not completing but At least Taking on the next task' };
  const [d] = decide({ add: [add({ title: 'Take on the next task for the ERI project', evidence: 'Completing the ERI project tomorrow Like not completing but At least Taking on the next task', person: '', due_time: '' })] }, opts);
  assert.equal(d.op, 'update');
  assert.equal(d.id, 11);
  assert.equal(d.patch.title, 'Take on the next task for the ERI project');
  // A different task said in the same breath quotes different words, so it stays separate.
  const riya = [{ id: 5, title: 'Call Riya about the deck', kind: 'todo', person: 'Riya', due_date: null, due_time: null, details: null, evidence: 'Riya ko deck ke baare mein call karna' }];
  const [r] = decide({ add: [add({ title: 'Send Riya the deck', evidence: 'aur usko deck bhej dena' })] }, { ...voice(riya), removable: new Set([5]), sourceText: 'Riya ko deck ke baare mein call karna aur usko deck bhej dena' });
  assert.equal(r.op, 'add');
});

test('placeholder titles wait for the rest of the sentence; "Remind me to" is trimmed', () => {
  const [p] = decide({ add: [add({ title: 'Tell Priya about something' })] }, voice());
  assert.equal(p.op, 'skip');
  assert.match(p.reason, /placeholder/);
  const [r] = decide({ add: [add({ title: 'Remind me to call Showroom', kind: 'reminder' })] }, voice());
  assert.equal(r.task.title, 'Call Showroom');
  assert.ok(looksUnfinished('Priya ko bol do main parso dopahar tak'));
});

test('a weekday that has already passed moves to its next one', () => {
  const sat = new Date('2026-10-10T00:10:00'); // just after midnight, so Friday was yesterday
  const [d] = decide({ add: [add({ due_date: '2026-10-09', due_time: '16:15' })] }, { open: [], mode: 'voice', now: sat, sourceText: 'शुक्रवार को सवा चार बजे टीम मीटिंग है' });
  assert.equal(d.task.due_date, '2026-10-16');
});

test('only tasks made from this same thought can be removed', () => {
  const open = [{ id: 3, title: 'Pay the electricity bill' }];
  const [d] = decide({ remove: [{ task_id: 3, reason: 'chit-chat', confidence: 0.95 }] }, { ...voice(open), removable: new Set() });
  assert.equal(d.op, 'skip');
  assert.match(d.reason, /can only remove a task made from this thought/);
});

test('a line that stops mid-sentence waits a little longer', () => {
  for (const t of ['And add another task of', 'And', 'Showroom', 'ओके तो मुझे', 'the next task is']) assert.ok(looksUnfinished(t), t);
  for (const t of ['Reminding me to call the showroom', 'ho gaya', 'deck bhej diya']) assert.ok(!looksUnfinished(t), t);
});

test('lines spoken in one breath are found again as one thought', async () => {
  const db = await import('../src/db.js');
  const base = Date.now() - 60_000;
  const say = (text, s, runId) => {
    const u = db.addUtterance({ text, lang: 'en-IN', saidAt: new Date(base + s * 1000).toISOString(), source: 'mic' });
    if (runId) db.startRun({ at: new Date().toISOString(), mode: 'voice', model: 'test', utteranceIds: [u.id] });
    return u;
  };
  say('pay the bill', 0, true); // a separate, earlier thought (gap > 6 s)
  say('And', 20, true);
  say('Add one more task', 22, true);
  say('Reminding me to call', 24, true);
  const showroom = say('Showroom', 26, false);
  const thought = db.sameThought(showroom, { gapMs: 6_000, spanMs: 45_000, maxLines: 12 });
  assert.deepEqual(thought.map((l) => l.text), ['And', 'Add one more task', 'Reminding me to call']);
});

test('typed tasks skip the confidence bar', () => {
  const [d] = decide({ add: [add({ confidence: 0.2 })] }, { open: [], mode: 'typed', now: NOW });
  assert.equal(d.op, 'add');
});

test('items are pulled out of the reply while it is still streaming', () => {
  const seen = [];
  const feed = createItemStream((kind, item) => seen.push([kind, item.task_id ?? item.title]));
  const reply = JSON.stringify({
    done: [{ task_id: 4, evidence: 'bill {paid} "today"', confidence: 0.9 }],
    update: [],
    add: [add({ title: 'Send "final" deck [v2]' }), add({ title: 'Call Aai' })],
  });
  // Feed it a few characters at a time, the way tokens arrive.
  const cuts = [];
  for (let i = 0; i < reply.length; i += 7) {
    feed(reply.slice(i, i + 7));
    cuts.push(seen.length);
  }
  assert.deepEqual(seen, [['done', 4], ['add', 'Send "final" deck [v2]'], ['add', 'Call Aai']]);
  assert.ok(cuts.indexOf(1) < cuts.indexOf(2), 'the first item arrives before the reply ends');
});

test('fragments Chrome split apart are joined back into one passage', () => {
  const at = (s) => new Date(NOW.getTime() + s * 1000).toISOString();
  const out = passages([
    { said_at: at(0), text: 'हाँ रिया मैं कल सुबह तक' },
    { said_at: at(3), text: 'deck bhej dunga' },
    { said_at: at(30), text: 'how was your weekend' },
  ]);
  assert.deepEqual(out, ['[22:30] हाँ रिया मैं कल सुबह तक deck bhej dunga', '[22:30] how was your weekend']);
});

test('the recogniser’s alternative guesses are shown to the model', () => {
  const lines = [{ said_at: NOW.toISOString(), text: 'call the bank about the credit guard', alts: JSON.stringify(['call the bank about the credit card']) }];
  const user = buildMessages({ now: NOW, lines, open: [], earlier: [], mode: 'voice' })[1].content;
  assert.match(user, /ALSO HEARD/);
  assert.match(user, /credit card/);
  // no section when there are no alternatives
  const plain = buildMessages({ now: NOW, lines: [{ said_at: NOW.toISOString(), text: 'buy milk' }], open: [], earlier: [], mode: 'voice' })[1].content;
  assert.doesNotMatch(plain, /ALSO HEARD/);
});

test('similarity ignores filler words and punctuation', () => {
  assert.ok(similarity('Send Riya the deck', 'send the deck to Riya!') >= 0.6);
  assert.ok(similarity('Call the bank', 'Buy medicines for Aai') < 0.2);
});
