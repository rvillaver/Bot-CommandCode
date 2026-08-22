import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { startBridge } from '../bot/bridge.js';

/** A minimal discord.js Client mock — the bridge only needs guilds.cache.first(). */
function mockClient() {
  return {
    guilds: {
      cache: new Map([
        ['guild1', {
          channels: {
            create: async (opts: { name: string }) => ({ id: 'chan-1', name: opts.name }),
          },
        }],
      ]),
    },
  };
}

async function freePort(): Promise<number> {
  const srv = http.createServer();
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const port = (srv.address() as AddressInfo).port;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

async function withBridge(handlers: Parameters<typeof startBridge>[2], fn: (port: number) => Promise<void>) {
  const client = mockClient() as never;
  const port = await freePort();
  const bridge = startBridge(port, client, handlers);
  // Give the server a tick to bind.
  await new Promise((resolve) => setTimeout(resolve, 50));
  try {
    await fn(port);
  } finally {
    await bridge.close();
  }
}

function post(port: number, path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(async (res) => {
      resolve({ status: res.status, json: (await res.json()) as Record<string, unknown> });
    }).catch(reject);
  });
}

test('/push returns 400 when message and question are both absent', async () => {
  await withBridge({ onQuestion: () => {}, onFileReady: () => {}, onPush: async () => {} }, async (port) => {
    const res = await post(port, '/push', {});
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'one of message, or question + callback required');
  });
});

test('/push returns 400 when question lacks callback', async () => {
  await withBridge({ onQuestion: () => {}, onFileReady: () => {}, onPush: async () => {} }, async (port) => {
    const res = await post(port, '/push', { dir: '/tmp', question: { text: 'Q', options: [{ label: 'A' }] } });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'callback required when question is provided');
  });
});

test('/push returns 400 when no target (channel/project/dir)', async () => {
  await withBridge({ onQuestion: () => {}, onFileReady: () => {}, onPush: async () => {} }, async (port) => {
    const res = await post(port, '/push', { message: 'hello' });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'one of channelId, projectId, or dir required');
  });
});

test('/push invokes onPush and returns ok:true', async () => {
  let received: unknown;
  await withBridge({
    onQuestion: () => {},
    onFileReady: () => {},
    onPush: async (p) => { received = p; },
  }, async (port) => {
    const res = await post(port, '/push', { dir: '/tmp', message: 'hello' });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
  });
  const r = received as { dir?: string; message?: string };
  assert.equal(r.dir, '/tmp');
  assert.equal(r.message, 'hello');
});

test('/push propagates onPush errors as 422', async () => {
  await withBridge({
    onQuestion: () => {},
    onFileReady: () => {},
    onPush: async () => { throw new Error('no channel bound'); },
  }, async (port) => {
    const res = await post(port, '/push', { dir: '/tmp', message: 'hi' });
    assert.equal(res.status, 422);
    assert.equal(res.json.ok, false);
    assert.equal(res.json.error, 'no channel bound');
  });
});

test('/question invokes onQuestion with sessionId + questions', async () => {
  let received: unknown;
  await withBridge({
    onQuestion: (p) => { received = p; },
    onFileReady: () => {},
    onPush: async () => {},
  }, async (port) => {
    const res = await post(port, '/question', { sessionId: 's1', questions: [{ question: 'Q' }] });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
  });
  assert.deepEqual(received, { sessionId: 's1', questions: [{ question: 'Q' }] });
});

test('/file invokes onFileReady with path', async () => {
  let received: unknown;
  await withBridge({
    onQuestion: () => {},
    onFileReady: (p) => { received = p; },
    onPush: async () => {},
  }, async (port) => {
    const res = await post(port, '/file', { path: '/tmp/a.txt' });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
  });
  assert.deepEqual(received, { path: '/tmp/a.txt' });
});

test('unknown route returns 404', async () => {
  await withBridge({ onQuestion: () => {}, onFileReady: () => {}, onPush: async () => {} }, async (port) => {
    const res = await post(port, '/nope', {});
    assert.equal(res.status, 404);
    assert.equal(res.json.ok, false);
  });
});

test('/mcp routes to onMcp(body, signal) and returns its response', async () => {
  let receivedBody: unknown;
  let receivedSignal: AbortSignal | undefined;
  await withBridge(
    {
      onQuestion: () => {},
      onFileReady: () => {},
      onPush: async () => {},
      onMcp: async (body, signal) => {
        receivedBody = body;
        receivedSignal = signal;
        return { jsonrpc: '2.0', id: 1, result: { ok: true } };
      },
    },
    async (port) => {
      const res = await post(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
      assert.equal(res.status, 200);
      assert.equal(res.json.jsonrpc, '2.0');
      assert.deepEqual(res.json, { jsonrpc: '2.0', id: 1, result: { ok: true } });
    },
  );
  assert.deepEqual(receivedBody, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.ok(receivedSignal instanceof AbortSignal);
});

test('/mcp aborts onMcp signal when the HTTP caller disconnects mid-ask', async () => {
  let capturedSignal: AbortSignal | undefined;
  // onMcp blocks on a promise that only rejects when its signal fires — simulates an
  // ask_question waiting on a human button click. The bridge must abort it on disconnect.
  const onMcp = async (_body: unknown, signal: AbortSignal) => {
    capturedSignal = signal;
    return new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('caller disconnected')), { once: true });
    });
  };
  const port = await freePort();
  const bridge = startBridge(
    port,
    mockClient() as never,
    { onQuestion: () => {}, onFileReady: () => {}, onPush: async () => {}, onMcp },
  );
  await new Promise((resolve) => setTimeout(resolve, 50));

  // Issue a POST but DON'T await the response (the hook blocks on purpose).
  const req = http.request({ port, path: '/mcp', method: 'POST' });
  req.on('error', () => { /* client-side ECONNRESET is expected after destroy() — we only
                              test that the server aborted onMcp's signal, not the response */ });
  req.write('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ask_question"}}');
  req.end();
  await new Promise((resolve) => setTimeout(resolve, 50)); // let onMcp start
  assert.ok(capturedSignal, 'onMcp should have received a signal');
  assert.equal(capturedSignal!.aborted, false, 'signal not yet aborted');

  req.destroy(); // client side disconnect
  await new Promise((resolve) => setTimeout(resolve, 100)); // let 'close' -> ac.abort()
  assert.equal(capturedSignal!.aborted, true, 'signal should abort on caller disconnect');
  await bridge.close();
});
