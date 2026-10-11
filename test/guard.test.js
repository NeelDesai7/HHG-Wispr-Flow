import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedHost, isSameOrigin, isLoopbackAddress } from '../src/guard.js';
import { isCloudModel, pickModel } from '../src/ollama.js';

test('only loopback host names on our port are accepted', () => {
  assert.ok(isAllowedHost('127.0.0.1:5181', 5181));
  assert.ok(isAllowedHost('localhost:5181', 5181));
  assert.ok(isAllowedHost('[::1]:5181', 5181));
  assert.ok(!isAllowedHost('evil.example:5181', 5181), 'DNS rebinding');
  assert.ok(!isAllowedHost('127.0.0.1.nip.io:5181', 5181));
  assert.ok(!isAllowedHost('localhost:80', 5181));
  assert.ok(!isAllowedHost('localhost', 5181));
  assert.ok(!isAllowedHost(undefined, 5181));
});

test('cross-site browser requests are refused, local tools are not', () => {
  const host = '127.0.0.1:5181';
  assert.ok(isSameOrigin({ host }), 'curl sends no Origin');
  assert.ok(isSameOrigin({ host, origin: 'http://127.0.0.1:5181', 'sec-fetch-site': 'same-origin' }));
  assert.ok(!isSameOrigin({ host, origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }));
  assert.ok(!isSameOrigin({ host, origin: 'null' }), 'sandboxed iframe or file://');
  assert.ok(!isSameOrigin({ host, 'sec-fetch-site': 'same-site' }));
});

test('loopback socket addresses', () => {
  assert.ok(isLoopbackAddress('127.0.0.1'));
  assert.ok(isLoopbackAddress('::ffff:127.0.0.1'));
  assert.ok(!isLoopbackAddress('192.168.1.20'));
});

test('Ollama cloud models are never used', () => {
  assert.ok(isCloudModel({ name: 'gpt-oss:120b-cloud' }));
  assert.ok(isCloudModel({ name: 'gemma4:31b-cloud' }));
  assert.ok(isCloudModel({ name: 'gemma4:e4b', remote_host: 'https://ollama.com:443' }));
  assert.ok(!isCloudModel({ name: 'gemma4:e4b' }));
});

test('model choice prefers the laptop-sized Gemma 4', () => {
  assert.equal(pickModel(['gemma4:31b', 'gemma4:e4b']), 'gemma4:e4b');
  assert.equal(pickModel(['gemma4:31b', 'gemma4:e4b'], 'gemma4:31b'), 'gemma4:31b');
  assert.equal(pickModel(['gemma4:e4b'], 'gemma4:missing'), 'gemma4:e4b');
  assert.equal(pickModel([]), null);
});
