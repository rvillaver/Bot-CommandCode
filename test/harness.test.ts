import { test } from 'node:test';
import assert from 'node:assert/strict';

// Smoke test: verify the test harness (tsx --test) is wired correctly.
test('test harness runs', () => {
  assert.equal(1 + 1, 2);
});

test('tsx resolves TS modules', async () => {
  const { YOLO_MODES } = await import('../bot/store.js');
  assert.deepEqual([...YOLO_MODES], ['auto-accept', 'dont-ask', 'bypass']);
});
