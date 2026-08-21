import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync, lstatSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  attachDir,
  outDir,
  OUT_LINK,
  ensureOutDir,
  collectOutFiles,
  hashFile,
  alreadyPosted,
  markPosted,
  clearPosted,
  MAX_UPLOAD_BYTES,
} from '../bot/files.js';

let dir: string;
let oldCwd: string;

beforeEach(() => {
  dir = mkdtempSync(join(realpathSync(tmpdir()), 'files-test-'));
  oldCwd = process.cwd();
  process.chdir(dir);
  mkdirSync('data', { recursive: true });
});

afterEach(() => {
  process.chdir(oldCwd);
  rmSync(dir, { recursive: true, force: true });
});

test('attachDir/outDir live under data/transfer/<projectId>', () => {
  assert.equal(attachDir('p1'), resolve(dir, 'data', 'transfer', 'p1', 'attachments'));
  assert.equal(outDir('p1'), resolve(dir, 'data', 'transfer', 'p1', 'out'));
});

test('ensureOutDir creates real dir + .cmd-relay/out symlink in project', () => {
  const proj = join(dir, 'proj');
  mkdirSync(proj, { recursive: true });
  ensureOutDir('p1', proj);
  const real = outDir('p1');
  const link = resolve(proj, OUT_LINK);
  assert.ok(existsSync(real), 'real out dir exists');
  assert.ok(lstatSync(link).isSymbolicLink(), 'link is a symlink');
});

test('ensureOutDir recreates a stale symlink', () => {
  const proj = join(dir, 'proj');
  mkdirSync(proj, { recursive: true });
  const stale = join(dir, 'stale-target');
  mkdirSync(stale, { recursive: true });
  mkdirSync(resolve(proj, '.cmd-relay'), { recursive: true });
  symlinkSync(stale, resolve(proj, OUT_LINK), 'dir');
  ensureOutDir('p1', proj);
  const link = resolve(proj, OUT_LINK);
  assert.ok(lstatSync(link).isSymbolicLink());
  assert.equal(realpathSync(link), outDir('p1'));
});

test('collectOutFiles lists files, skips dotfiles, empty when no dir', () => {
  assert.deepEqual(collectOutFiles('missing'), []);
  const out = outDir('p1');
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'a.txt'), 'a');
  writeFileSync(join(out, '.hidden'), 'h');
  const files = collectOutFiles('p1');
  assert.deepEqual(files.map((f) => f.name), ['a.txt']);
  assert.ok(files[0].path.startsWith(out));
});

test('hashFile is content-addressed sha256', () => {
  const f = join(dir, 'f.txt');
  writeFileSync(f, 'hello');
  const h1 = hashFile(f);
  writeFileSync(f, 'hello'); // same bytes
  assert.equal(hashFile(f), h1);
  writeFileSync(f, 'hello!'); // changed
  assert.notEqual(hashFile(f), h1);
});

test('alreadyPosted/markPosted/clearPosted dedup cycle', () => {
  const f = join(dir, 'f.txt');
  writeFileSync(f, 'content');
  assert.equal(alreadyPosted('chan1', f), false);
  markPosted('chan1', f, 'f.txt');
  assert.equal(alreadyPosted('chan1', f), true);
  // different channel: not posted
  assert.equal(alreadyPosted('chan2', f), false);
  clearPosted('chan1');
  assert.equal(alreadyPosted('chan1', f), false);
});

test('markPosted evicts oldest beyond cap', () => {
  const files = [];
  for (let i = 0; i < 120; i++) {
    const f = join(dir, `f${i}.txt`);
    writeFileSync(f, `content${i}`);
    files.push(f);
    markPosted('big', f, `f${i}.txt`);
  }
  // Cap is 100 — the first 20 should be evicted.
  assert.equal(alreadyPosted('big', files[0]), false);
  assert.equal(alreadyPosted('big', files[119]), true);
});

test('MAX_UPLOAD_BYTES is 25MB', () => {
  assert.equal(MAX_UPLOAD_BYTES, 25 * 1024 * 1024);
});
