import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = { ...process.env };
});

afterEach(() => {
  // Restore env
  for (const k of Object.keys(process.env)) {
    if (!(k in saved)) delete process.env[k];
  }
  Object.assign(process.env, saved);
});

test('loadConfig parses default values', async () => {
  // .env must not interfere — point dotenv at nothing
  process.env.DOTENV_CONFIG_PATH = '/dev/null';
  process.env.DISCORD_TOKEN = 'MT-test-token';
  delete process.env.RELAY_PORT;
  delete process.env.ALLOWED_CHANNEL_IDS;
  delete process.env.COMMAND_PREFIX;
  delete process.env.CMD_BINARY;
  delete process.env.PROJECT_DIR;
  const { loadConfig } = await import('../bot/config.js');
  const cfg = loadConfig();
  assert.equal(cfg.discordToken, 'MT-test-token');
  assert.equal(cfg.relayPort, 8787);
  assert.equal(cfg.projectDir, '');
  assert.deepEqual(cfg.allowedChannelIds, []);
  assert.equal(cfg.commandPrefix, '');
  assert.equal(cfg.cmdBinary, 'cmd');
});

test('loadConfig parses non-default env values', async () => {
  process.env.DOTENV_CONFIG_PATH = '/dev/null';
  process.env.DISCORD_TOKEN = 'MT-test';
  process.env.RELAY_PORT = '9999';
  process.env.ALLOWED_CHANNEL_IDS = '111, 222 ,333';
  process.env.COMMAND_PREFIX = '!';
  process.env.CMD_BINARY = '/usr/bin/cmd';
  process.env.PROJECT_DIR = '/tmp/proj';
  const { loadConfig } = await import('../bot/config.js');
  const cfg = loadConfig();
  assert.equal(cfg.relayPort, 9999);
  assert.deepEqual(cfg.allowedChannelIds, ['111', '222', '333']);
  assert.equal(cfg.commandPrefix, '!');
  assert.equal(cfg.cmdBinary, '/usr/bin/cmd');
  assert.equal(cfg.projectDir, '/tmp/proj');
});

test('loadConfig exits with guide when DISCORD_TOKEN is missing', async () => {
  process.env.DOTENV_CONFIG_PATH = '/dev/null';
  delete process.env.DISCORD_TOKEN;
  // requireEnv calls process.exit(1) — capture that + the stderr message.
  const oldExit = process.exit;
  let exitCode: number | undefined;
  process.exit = ((code?: number) => { exitCode = code; throw new Error(`exit(${code})`); }) as never;
  const errs: string[] = [];
  const oldErr = console.error;
  console.error = (...a: unknown[]) => { errs.push(a.join(' ')); };
  try {
    const { loadConfig } = await import('../bot/config.js');
    assert.throws(() => loadConfig(), /exit\(1\)/);
  } finally {
    process.exit = oldExit;
    console.error = oldErr;
  }
  assert.equal(exitCode, 1);
  assert.ok(errs.join('\n').includes('DISCORD_TOKEN'), 'guide mentions DISCORD_TOKEN');
  assert.ok(errs.join('\n').includes('discord.com/developers/applications'), 'guide links to dev portal');
});
