import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, realpathSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCmd, type RelayEvent, type RunHandle } from '../bot/relay.js';

// Build a fake `cmd` binary (executable with shebang) that emits fixed NDJSON
// lines, to test runCmd's NDJSON parsing + dispatch without a real cmd / model.
const FAKE_CMD = join(realpathSync(tmpdir()), 'fake-cmd.mjs');

let dir: string;
let oldCwd: string;

beforeEach(() => {
  dir = mkdtempSync(join(realpathSync(tmpdir()), 'relay-test-'));
  oldCwd = process.cwd();
  process.chdir(dir);
  mkdirSync('data', { recursive: true });
});

afterEach(() => {
  process.chdir(oldCwd);
  rmSync(dir, { recursive: true, force: true });
});

function writeFakeCmd(lines: string[]): void {
  writeFileSync(FAKE_CMD, `#!/usr/bin/env node
const lines = ${JSON.stringify(lines)};
for (const l of lines) process.stdout.write(l + '\\n');
`);
  // chmod +x so it can be spawned directly as the "cmd" binary.
  chmodSync(FAKE_CMD, 0o755);
}

function configFor(): { cmdBinary: string; relayPort: number } {
  return { cmdBinary: FAKE_CMD, relayPort: 1 };
}

test('runCmd parses NDJSON lines and reports a result', async () => {
  writeFakeCmd([
    JSON.stringify({ type: 'event', event: { type: 'text_delta', delta: 'Hello' } }),
    JSON.stringify({ type: 'result', subtype: 'success', finalText: 'Hello world', sessionId: 'sess-1' }),
  ]);

  const events: RelayEvent[] = [];
  const exit = await new Promise<{ exitCode: number | null; gotResult: boolean; stderrTail: string }>((resolve) => {
    const config = configFor() as never;
    const opts = {
      prompt: 'hi',
      project: { dir, permissionMode: 'default' as const },
    } as never;
    runCmd(config, opts, {
      onLine: (line: RelayEvent) => events.push(line),
      onExit: resolve,
    } as never);
  });

  assert.equal(exit.exitCode, 0);
  assert.equal(exit.gotResult, true);
  assert.equal(events.length, 2);
  assert.equal((events[0] as { type: 'event'; event: { type?: string } }).event.type, 'text_delta');
  assert.equal((events[1] as { type: 'result'; finalText: string }).finalText, 'Hello world');
  assert.equal((events[1] as { type: 'result'; sessionId: string }).sessionId, 'sess-1');
});

test('runCmd ignores non-JSON lines (forward-compatible)', async () => {
  writeFakeCmd(['not json', JSON.stringify({ type: 'result', subtype: 'success', finalText: 'ok' })]);

  const events: RelayEvent[] = [];
  const exit = await new Promise<{ exitCode: number | null; gotResult: boolean }>((resolve) => {
    const config = configFor() as never;
    const opts = { prompt: 'hi', project: { dir, permissionMode: 'default' as const } } as never;
    runCmd(config, opts, {
      onLine: (line: RelayEvent) => events.push(line),
      onExit: resolve,
    } as never);
  });

  assert.equal(exit.gotResult, true);
  assert.equal(events.length, 1);
});

test('runCmd maps yolo modes to --yolo flag (no crash)', async () => {
  // We can't easily assert the spawned args, but we can assert a bypass-mode
  // run still parses output correctly (--yolo path doesn't break spawning).
  writeFakeCmd([JSON.stringify({ type: 'result', subtype: 'success', finalText: 'done' })]);
  const events: RelayEvent[] = [];
  const exit = await new Promise<{ gotResult: boolean }>((resolve) => {
    const config = configFor() as never;
    const opts = { prompt: 'hi', project: { dir, permissionMode: 'bypass' as const } } as never;
    runCmd(config, opts, { onLine: (l: RelayEvent) => events.push(l), onExit: resolve } as never);
  });
  assert.equal(exit.gotResult, true);
  assert.equal(events.length, 1);
});

test('runHandle.kill() is safe when child already exited', async () => {
  writeFakeCmd([JSON.stringify({ type: 'result', subtype: 'success', finalText: 'done' })]);
  let handle: RunHandle | undefined;
  await new Promise<void>((resolve) => {
    const config = configFor() as never;
    const opts = { prompt: 'hi', project: { dir, permissionMode: 'default' as const } } as never;
    handle = runCmd(config, opts, { onLine: () => {}, onExit: () => resolve() } as never);
  });
  assert.ok(handle);
  handle!.kill(); // should not throw
  assert.equal(handle!.killed(), true);
});
