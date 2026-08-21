import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCmd, type RelayEvent } from '../bot/relay.js';
import { realpathSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * E2E integration harness: spawn the REAL `cmd -p` binary (headless, JSON
 * output, with the relay mod), run a read-only prompt, and assert that
 * `runCmd`'s NDJSON parsing dispatches the events the bot's UI consumes.
 *
 * This exercises the real thing (the relay the bot runs) — not a fake cmd.
 * Read-only prompt so no permissions/yolo needed.
 */

// Locate the real cmd binary (absolute — the test runner's PATH may differ).
// Prefer a resolved absolute path; fall back to the CMD_BINARY env override only
// if it's absolute, else the bare name (hoping PATH has it).
const CMD_CANDIDATES = ['/opt/homebrew/bin/cmd', '/usr/local/bin/cmd', '/usr/bin/cmd'];
const envBinary = process.env.CMD_BINARY;
const CMD_BINARY = envBinary?.startsWith('/')
  ? envBinary
  : CMD_CANDIDATES.find((p) => existsSync(p)) ?? 'cmd';
// A clean scratch dir to run in (avoids touching the repo's own data/).
const RUN_DIR = join(realpathSync(tmpdir()), `e2e-${process.pid}`);

// Ensure the scratch run dir exists before any test spawns into it.
mkdirSync(RUN_DIR, { recursive: true });
process.on('exit', () => rmSync(RUN_DIR, { recursive: true, force: true }));

test('E2E: real cmd -p streams text_delta events through runCmd', { timeout: 120_000 }, async () => {
  const events: RelayEvent[] = [];
  const textDeltas: string[] = [];

  const exit = await new Promise<{ exitCode: number | null; gotResult: boolean; stderrTail: string }>((resolve) => {
    const config = { cmdBinary: CMD_BINARY, relayPort: 1, cwd: RUN_DIR } as never;
    const opts = {
      prompt: 'Reply with exactly: E2E_OK',
      project: { dir: RUN_DIR, permissionMode: 'default' as const, tools: [] },
    } as never;
    runCmd(config, opts, {
      onLine: (line: RelayEvent) => {
        events.push(line);
        if (line.type === 'event' && line.event?.type === 'text_delta') {
          const d = (line.event as { delta?: string }).delta;
          if (d) textDeltas.push(d);
        }
      },
      onExit: resolve,
    } as never);
  });

  // The relay should have parsed the run to a success result.
  assert.equal(exit.exitCode, 0, `cmd exited non-zero: ${exit.stderrTail}`);
  assert.equal(exit.gotResult, true);

  const result = events.find((e) => e.type === 'result') as { type: 'result'; finalText: string } | undefined;
  assert.ok(result, 'expected a result line');
  assert.ok(result.finalText.includes('E2E_OK'), `finalText was: ${result.finalText}`);
  assert.ok(textDeltas.length > 0, 'expected text_delta events');
});

test('E2E: real cmd -p with the relay mod still loads (mod path resolves)', { timeout: 60_000 }, async () => {
  const events: RelayEvent[] = [];
  const exit = await new Promise<{ exitCode: number | null; gotResult: boolean }>((resolve) => {
    const config = { cmdBinary: CMD_BINARY, relayPort: 1, cwd: RUN_DIR } as never;
    const opts = {
      prompt: 'Reply with exactly: MOD_OK',
      project: { dir: RUN_DIR, permissionMode: 'default' as const },
    } as never;
    runCmd(config, opts, { onLine: (l: RelayEvent) => events.push(l), onExit: resolve } as never);
  });
  assert.equal(exit.gotResult, true);
  const result = events.find((e) => e.type === 'result') as { type: 'result'; finalText: string } | undefined;
  assert.ok(result);
  assert.ok(result.finalText.includes('MOD_OK'));
});
