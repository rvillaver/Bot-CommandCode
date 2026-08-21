import { test } from 'node:test';
import assert from 'node:assert/strict';
import relayMod from '../mods/relay.js';

test('mod default export is a function', () => {
  assert.equal(typeof relayMod, 'function');
});

test('mod registers hooks and blocks ask_user_question', async () => {
  let hooks: { beforeToolCall?: (i: unknown) => Promise<unknown> } = {};
  const cmd = {
    cwd: '/tmp/proj',
    hooks(arg: typeof hooks) { hooks = arg; },
  } as never;

  relayMod(cmd as never);

  assert.equal(typeof hooks.beforeToolCall, 'function');

  // beforeToolCall on ask_user_question blocks and forwards to the bridge.
  const result = await hooks.beforeToolCall!({
    toolName: 'ask_user_question',
    input: { questions: [{ question: 'Q', options: [{ label: 'A' }] }] },
    state: { sessionId: 'sess-1' },
  });
  assert.equal((result as { block?: boolean }).block, true);
  assert.match((result as { additionalContext?: string }).additionalContext ?? '', /user's answer/);

  // Non-question tools are untouched.
  const other = await hooks.beforeToolCall!({
    toolName: 'read_file',
    input: { file_path: '/tmp/proj/a.txt' },
    state: {},
  });
  assert.equal(other, undefined);
});
