import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleLine, laptopStatus } from '../src/win-notifications.js';

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

test('access and ready lines update status', () => {
  handleLine(JSON.stringify({ type: 'access', status: 'Allowed' }));
  assert.equal(laptopStatus().access, 'Allowed');
  handleLine(JSON.stringify({ type: 'ready', pid: 1 }));
  assert.equal(laptopStatus().running, true);
});

test('a notification line becomes a screened event sent to ingest', () => {
  let got = null;
  const fake = (events) => { got = events; return Promise.resolve({}); };
  const r = handleLine(JSON.stringify({
    type: 'notification', app: b64('WhatsApp'), title: b64('Mom'), body: b64('pick up milk on the way'), at: '2026-10-10T10:00:00Z',
  }), fake);
  assert.equal(r.event.app, 'WhatsApp');
  assert.equal(r.event.kind, 'notification');
  assert.equal(r.event.body, 'pick up milk on the way');
  assert.deepEqual(got, [r.event]);
});

test('empty notifications and junk lines are ignored', () => {
  assert.equal(handleLine('not json', () => {}), null);
  assert.equal(handleLine(JSON.stringify({ type: 'notification', app: b64('X'), title: '', body: '' }), () => {}), null);
});

test('an app name with no display falls back to “Windows”', () => {
  const r = handleLine(JSON.stringify({ type: 'notification', app: '', title: b64('Reminder'), body: b64('standup at 10'), at: '2026-10-10T10:00:00Z' }), () => {});
  assert.equal(r.event.app, 'Windows');
});
