import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleMcpRequest, type McpCtx } from '../bot/mcp.js';

function ctx(overrides?: Partial<McpCtx>): McpCtx {
  const channels = new Map<string, { send: (c: unknown) => Promise<unknown> }>();
  const client = { channels: { cache: channels } } as never;
  return {
    client,
    pendingAnswers: new Map(),
    registerPushQuestion: () => {},
    ...overrides,
  };
}

test('initialize returns protocol version + server info', async () => {
  const res = await handleMcpRequest(ctx(), { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) as {
    result?: { protocolVersion?: string; serverInfo?: { name?: string } };
  };
  assert.equal(res.result?.protocolVersion, '2025-03-26');
  assert.equal(res.result?.serverInfo?.name, 'bot-cmd-push');
});

test('ping returns ok', async () => {
  const res = await handleMcpRequest(ctx(), { jsonrpc: '2.0', id: 2, method: 'ping', params: {} }) as { result?: unknown };
  assert.deepEqual(res.result, {});
});

test('tools/list returns the three tools', async () => {
  const res = await handleMcpRequest(ctx(), { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }) as {
    result?: { tools?: { name: string }[] };
  };
  const names = res.result?.tools?.map((t) => t.name) ?? [];
  assert.deepEqual(names, ['push_message', 'ask_question', 'list_projects']);
});

test('tools/call list_projects returns a string', async () => {
  const res = await handleMcpRequest(ctx(), {
    jsonrpc: '2.0', id: 4, method: 'tools/call',
    params: { name: 'list_projects', arguments: {} },
  }) as { result?: { content?: { type: string; text: string }[]; isError?: boolean } };
  assert.equal(res.result?.isError, false);
  assert.equal(res.result?.content?.[0]?.type, 'text');
  assert.equal(typeof res.result?.content?.[0]?.text, 'string');
});

test('tools/call unknown tool returns isError true', async () => {
  const res = await handleMcpRequest(ctx(), {
    jsonrpc: '2.0', id: 5, method: 'tools/call',
    params: { name: 'nope', arguments: {} },
  }) as { result?: { isError?: boolean; content?: { text: string }[] } };
  assert.equal(res.result?.isError, true);
  assert.match(res.result?.content?.[0]?.text ?? '', /Unknown tool/);
});

test('tools/call push_message without message errors', async () => {
  const res = await handleMcpRequest(ctx(), {
    jsonrpc: '2.0', id: 6, method: 'tools/call',
    params: { name: 'push_message', arguments: { dir: '/tmp' } },
  }) as { result?: { isError?: boolean; content?: { text: string }[] } };
  assert.equal(res.result?.isError, true);
  assert.match(res.result?.content?.[0]?.text ?? '', /message is required/);
});

test('tools/call ask_question with no channel errors clearly', async () => {
  const res = await handleMcpRequest(ctx(), {
    jsonrpc: '2.0', id: 7, method: 'tools/call',
    params: { name: 'ask_question', arguments: { dir: '/tmp', question: 'Q', options: ['a'] } },
  }) as { result?: { isError?: boolean; content?: { text: string }[] } };
  assert.equal(res.result?.isError, true);
  assert.match(res.result?.content?.[0]?.text ?? '', /no channel bound/);
});

test('unknown method returns method-not-found error', async () => {
  const res = await handleMcpRequest(ctx(), { jsonrpc: '2.0', id: 8, method: 'bogus', params: {} }) as {
    error?: { code?: number; message?: string };
  };
  assert.equal(res.error?.code, -32601);
});
