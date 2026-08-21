import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadThroughline,
  saveThroughline,
  clearThroughline,
  throughlinePreamble,
  loadThroughlineSummary,
  compactThroughline,
  SUMMARY_LIMIT,
} from '../bot/threadline.js';

let dir: string;
let oldCwd: string;

beforeEach(() => {
  dir = mkdtempSync(join(realpathSync(tmpdir()), 'threadline-test-'));
  oldCwd = process.cwd();
  process.chdir(dir);
  mkdirSync('data', { recursive: true });
});

afterEach(() => {
  process.chdir(oldCwd);
  rmSync(dir, { recursive: true, force: true });
});

test('saveThroughline + loadThroughline round-trip', () => {
  saveThroughline('chan1', 'Project is about auth refactor.');
  const t = loadThroughline('chan1');
  assert.equal(t?.summary, 'Project is about auth refactor.');
  assert.ok(t?.updatedAt > 0);
});

test('throughlinePreamble wraps summary in a block', () => {
  saveThroughline('chan1', 'Auth refactor in progress.');
  assert.equal(
    throughlinePreamble('chan1'),
    '[Project conversation so far: Auth refactor in progress.]',
  );
  assert.equal(throughlinePreamble('missing'), '');
});

test('loadThroughlineSummary returns empty string when absent', () => {
  assert.equal(loadThroughlineSummary('nope'), '');
});

test('clearThroughline removes an entry', () => {
  saveThroughline('chan1', 'x');
  clearThroughline('chan1');
  assert.equal(loadThroughlineSummary('chan1'), '');
});

test('compactThroughline builds first entry', () => {
  const out = compactThroughline('', 'Fix the bug', 'Done, fixed it.');
  assert.ok(out.includes('Fix the bug'));
  assert.ok(out.includes('Done, fixed it.'));
  assert.ok(out.length <= SUMMARY_LIMIT);
});

test('compactThroughline appends latest exchange and trims to limit', () => {
  const prev = 'a'.repeat(200);
  const out = compactThroughline(prev, 'p', 'f');
  assert.ok(out.length <= SUMMARY_LIMIT);
  assert.ok(out.includes('Latest:'));
  // Old head preserved but trimmed
  assert.ok(out.includes('a'));
});

test('compactThroughline never exceeds SUMMARY_LIMIT', () => {
  let prev = '';
  for (let i = 0; i < 20; i++) {
    prev = compactThroughline(prev, `prompt ${i} `.repeat(100), `final ${i} `.repeat(100));
    assert.ok(prev.length <= SUMMARY_LIMIT, `iteration ${i}: ${prev.length}`);
  }
});

test('saveThroughline truncates summary to SUMMARY_LIMIT', () => {
  saveThroughline('chan1', 'x'.repeat(SUMMARY_LIMIT * 2));
  assert.ok(loadThroughline('chan1')!.summary.length <= SUMMARY_LIMIT);
});
