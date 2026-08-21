import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
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
  const srv = createServer();
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
