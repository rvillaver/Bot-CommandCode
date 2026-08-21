import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadStore,
  projectForChannel,
  projectIdForChannel,
  saveProject,
  deleteProject,
  unbindProject,
  unbindChannel,
  isDMChannel,
  YOLO_MODES,
} from '../bot/store.js';

let dir: string;
let oldCwd: string;

beforeEach(() => {
  dir = mkdtempSync(join(realpathSync(tmpdir()), 'store-test-'));
  oldCwd = process.cwd();
  process.chdir(dir);
  mkdirSync('data', { recursive: true });
});

afterEach(() => {
  process.chdir(oldCwd);
  rmSync(dir, { recursive: true, force: true });
});

test('YOLO_MODES lists bypass-capable modes', () => {
  assert.deepEqual([...YOLO_MODES], ['auto-accept', 'dont-ask', 'bypass']);
});

test('loadStore returns empty registry when files are absent', () => {
  const store = loadStore();
  assert.deepEqual(store.projects, {});
  assert.deepEqual(store.bindings, {});
});

test('saveProject + loadStore round-trips a project', () => {
  saveProject('demo', { dir: '/tmp/demo', permissionMode: 'bypass' });
  const store = loadStore();
  assert.equal(store.projects['demo'].dir, '/tmp/demo');
  assert.equal(store.projects['demo'].permissionMode, 'bypass');
});

test('projectForChannel resolves bound channel to project', () => {
  writeFileSync('data/projects.json', JSON.stringify({ demo: { dir: '/tmp/demo' } }));
  writeFileSync('data/bindings.json', JSON.stringify({ '123': 'demo' }));
  const store = loadStore();
  assert.equal(projectIdForChannel(store, '123'), 'demo');
  assert.equal(projectForChannel(store, '123')?.dir, '/tmp/demo');
  assert.equal(projectForChannel(store, 'nope'), undefined);
});

test('deleteProject removes project + unbinds channels', () => {
  writeFileSync('data/projects.json', JSON.stringify({ a: { dir: '/a' }, b: { dir: '/b' } }));
  writeFileSync('data/bindings.json', JSON.stringify({ '1': 'a', '2': 'b', '3': 'a' }));
  const removed = deleteProject('a');
  assert.deepEqual(removed.sort(), ['1', '3']);
  const store = loadStore();
  assert.equal(store.projects['a'], undefined);
  assert.equal(store.bindings['1'], undefined);
  assert.equal(store.bindings['3'], undefined);
  assert.equal(store.bindings['2'], 'b');
});

test('deleteProject on missing project returns []', () => {
  writeFileSync('data/projects.json', JSON.stringify({}));
  assert.deepEqual(deleteProject('nope'), []);
});

test('unbindProject unbinds every channel pointing at a project', () => {
  writeFileSync('data/projects.json', JSON.stringify({ a: { dir: '/a' } }));
  writeFileSync('data/bindings.json', JSON.stringify({ '1': 'a', '2': 'a', '3': 'b' }));
  assert.deepEqual(unbindProject('a').sort(), ['1', '2']);
  const store = loadStore();
  assert.equal(store.bindings['1'], undefined);
  assert.equal(store.bindings['2'], undefined);
  assert.equal(store.bindings['3'], 'b');
});

test('unbindChannel removes one binding and returns its project', () => {
  writeFileSync('data/projects.json', JSON.stringify({ a: { dir: '/a' } }));
  writeFileSync('data/bindings.json', JSON.stringify({ '1': 'a' }));
  assert.equal(unbindChannel('1'), 'a');
  assert.equal(unbindChannel('1'), undefined); // second call: already gone
  assert.equal(unbindChannel('nope'), undefined);
});

test('isDMChannel discriminates DM vs guild channels', () => {
  const dm = { type: 1 } as never; // ChannelType.DM === 1
  const guild = { type: 0 } as never; // ChannelType.GuildText === 0
  assert.equal(isDMChannel(dm), true);
  assert.equal(isDMChannel(guild), false);
});
