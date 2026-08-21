import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkMessage, sanitizeChannelName } from '../bot/text.js';

test('chunkMessage returns single chunk when under limit', () => {
  assert.deepEqual(chunkMessage('short', 10), ['short']);
});

test('chunkMessage splits long text at newlines when possible', () => {
  const text = 'line one\nline two\nline three';
  const chunks = chunkMessage(text, 10);
  assert.ok(chunks.length >= 2);
  assert.ok(chunks.every((c) => c.length <= 10), 'every chunk under limit');
  // Round-trips to the same text
  assert.equal(chunks.join(''), text);
});

test('chunkMessage hard-splits when no newline in window', () => {
  const text = 'a'.repeat(25);
  const chunks = chunkMessage(text, 10);
  assert.deepEqual(chunks, ['a'.repeat(10), 'a'.repeat(10), 'a'.repeat(5)]);
  assert.equal(chunks.join(''), text);
});

test('chunkMessage handles empty and exact-limit text', () => {
  assert.deepEqual(chunkMessage('', 10), ['']);
  assert.deepEqual(chunkMessage('1234567890', 10), ['1234567890']);
});

test('sanitizeChannelName lowercases and dashes spaces', () => {
  assert.equal(sanitizeChannelName('My Project'), 'my-project');
});

test('sanitizeChannelName strips specials and collapses dashes', () => {
  assert.equal(sanitizeChannelName('Hello, World!! (v2)'), 'hello-world-v2');
});

test('sanitizeChannelName trims leading/trailing dashes and caps at 100', () => {
  assert.equal(sanitizeChannelName('-foo-'), 'foo');
  assert.equal(sanitizeChannelName('a'.repeat(200)).length, 100);
});

test('sanitizeChannelName throws on empty result', () => {
  assert.throws(() => sanitizeChannelName('!!!'), /channel name invalid/);
  assert.throws(() => sanitizeChannelName('   '), /channel name invalid/);
});
