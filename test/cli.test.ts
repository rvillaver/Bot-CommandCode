import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, realpathSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// The CLI is a .mjs file — test it by spawning it with various args.
const CLI = new URL('../bin/bot-commandcode.mjs', import.meta.url).pathname;

let dir: string;
let oldCwd: string;

beforeEach(() => {
  dir = mkdtempSync(join(realpathSync(tmpdir()), 'cli-test-'));
  oldCwd = process.cwd();
  process.chdir(dir);
  mkdirSync('data', { recursive: true });
});

afterEach(() => {
  process.chdir(oldCwd);
  rmSync(dir, { recursive: true, force: true });
});

function runCli(...args: string[]): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, RELAY_PORT: '1', CMD_RELAY_DATA_DIR: dir },
  });
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

test('projects list with no projects prints "(no projects)"', () => {
  const { code, stdout } = runCli('projects', 'list');
  assert.equal(code, 0);
  assert.equal(stdout.trim(), '(no projects)');
});

test('projects add rejects missing --dir', () => {
  const { code, stderr } = runCli('projects', 'add', 'demo');
  assert.equal(code, 1);
  assert.match(stderr, /--dir is required/);
});

test('projects add rejects non-existent dir', () => {
  const { code, stderr } = runCli('projects', 'add', 'demo', '--dir', '/no/such/dir');
  assert.equal(code, 1);
  assert.match(stderr, /directory does not exist/);
});

test('projects add rejects invalid --permission-mode', () => {
  const { code, stderr } = runCli('projects', 'add', 'demo', '--dir', dir, '--permission-mode', 'nonsense');
  assert.equal(code, 1);
  assert.match(stderr, /invalid --permission-mode/);
  assert.match(stderr, /default\|auto-accept\|plan\|dont-ask\|bypass/);
});

test('projects add accepts valid --permission-mode bypass', () => {
  const { code, stdout } = runCli('projects', 'add', 'demo', '--dir', dir, '--permission-mode', 'bypass', '--no-channel');
  assert.equal(code, 0);
  assert.match(stdout, /project demo -> /);
});

test('projects add normalizes legacy --permission-mode standard', () => {
  const { code } = runCli('projects', 'add', 'demo', '--dir', dir, '--permission-mode', 'standard', '--no-channel');
  assert.equal(code, 0);
  const stored = JSON.parse(readFileSync(join(dir, 'projects.json'), 'utf8'));
  assert.equal(stored['demo'].permissionMode, 'default');
});

test('bind requires channel + project', () => {
  const { code, stderr } = runCli('bind');
  assert.equal(code, 1);
  assert.match(stderr, /usage: bot-commandcode bind/);
});

test('push with no message prints usage error', () => {
  const { code, stderr } = runCli('push');
  assert.equal(code, 1);
  assert.match(stderr, /usage: bot-commandcode push/);
});

test('push to unreachable bridge fails cleanly', () => {
  // RELAY_PORT=1 -> connection refused on 127.0.0.1:1
  const { code, stderr } = runCli('push', 'hello');
  assert.equal(code, 1);
  assert.match(stderr, /bot bridge unreachable/);
});

test('ask with no options prints usage error', () => {
  const { code, stderr } = runCli('ask', 'just-a-question');
  assert.equal(code, 1);
  assert.match(stderr, /usage: bot-commandcode ask/);
});

test('unknown command prints usage', () => {
  const { code, stdout } = runCli('frobnicate');
  assert.equal(code, 1);
  assert.match(stdout, /Usage:/);
});
