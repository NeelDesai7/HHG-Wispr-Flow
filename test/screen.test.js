import { test } from 'node:test';
import assert from 'node:assert/strict';
import { screen, maskCards } from '../src/screen.js';

test('one-time codes and verification messages are withheld', () => {
  assert.equal(screen({ app: 'Messages', body: '482913 is your OTP for HDFC. Do not share.' }).withheld, 'one-time code');
  assert.equal(screen({ app: 'Messages', body: 'Your verification code is 55021' }).withheld, 'one-time code');
  assert.equal(screen({ app: 'Google', body: 'G-739204 is your Google verification code' }).withheld, 'one-time code');
});

test('passwords, PINs and tokens are withheld', () => {
  assert.equal(screen({ app: 'Mail', body: 'your temporary password is hunter2please' }).withheld, 'password or PIN');
  assert.equal(screen({ app: 'Slack', body: 'token sk-abcdefabcdefabcdef1234' }).withheld, 'key or token');
  assert.equal(screen({ app: '1Password', title: 'Unlock', body: 'anything' }).withheld, 'password manager');
});

test('ordinary messages pass, with card numbers masked', () => {
  const r = screen({ app: 'WhatsApp', kind: 'notification', title: 'Mom', body: 'can you pick up medicines on your way back?' });
  assert.ok(r.event);
  assert.equal(r.event.app, 'WhatsApp');
  assert.equal(r.event.body, 'can you pick up medicines on your way back?');

  const card = screen({ app: 'Notes', body: 'card 4111 1111 1111 1111 exp 03/27' });
  assert.match(card.event.body, /card ending 1111/);
  assert.doesNotMatch(card.event.body, /4111 1111/);
});

test('empty events are withheld; text is clamped', () => {
  assert.equal(screen({ app: 'X', title: '', body: '   ' }).withheld, 'empty');
  const long = screen({ app: 'X', body: 'a'.repeat(900) });
  assert.ok(long.event.body.length <= 400);
});

test('maskCards leaves non-card digit runs alone', () => {
  assert.equal(maskCards('order 12345 shipped'), 'order 12345 shipped');
  assert.equal(maskCards('ref 1234567890123 pending'), 'ref 1234567890123 pending'); // fails Luhn
});
