import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Client, Guild, TextChannel } from 'discord.js';

/** Handlers the bot registers — the bridge stays UI-agnostic (SPEC §2: its sole job is to relay). */
export interface BridgeHandlers {
  /** A question set arrived from a cmd child (ask_user_question). Keyed by session id. */
  onQuestion: (payload: { sessionId: string; questions: unknown[] }) => void;
  /** A file was written to the out drop-point by a cmd child. */
  onFileReady: (payload: { path: string }) => void;
  /** An external workload pushed a message (not via cmd). Resolves dir/projectId/channelId → channel. */
  onPush: (payload: {
    channelId?: string;
    projectId?: string;
    dir?: string;
    message?: string;
    question?: { text: string; options: { label: string }[] };
    callback?: string;
  }) => void;
  /** An MCP JSON-RPC request arrived at /mcp. Returns the JSON-RPC response.
   * The signal aborts when the HTTP caller disconnects mid-tool-call (e.g. an MCP ask
   * that's still waiting on a human button click) so pending state can be cleaned up. */
  onMcp?: (body: unknown, signal: AbortSignal) => Promise<unknown>;
}

/**
 * Local control bridge bound to 127.0.0.1 only (SPEC §2, §4).
 * - POST /question  — mod→bot: intercepted ask_user_question
 * - POST /file      — mod→bot: a file landed in the out drop-point
 * - POST /create-channel — CLI→bot: create a channel named after a project folder
 * - POST /push      — external workload→bot: inject a message or interactive question into a Discord channel
 */
export interface Bridge {
  /** Close the HTTP server (used by tests and shutdown paths). */
  close: () => Promise<void>;
}

export function startBridge(port: number, client: Client, handlers: BridgeHandlers): Bridge {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // CORS not needed (local); just parse the path.
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const body = await readBody(req);

    if (req.method === 'POST' && url.pathname === '/create-channel') {
      const { name, reason } = body as { name?: string; reason?: string };
      if (!name) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'name required' }));
        return;
      }

      try {
        const channel = await createChannel(client, name, reason);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, channelId: channel.id, channelName: channel.name }));
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: (e as Error).message }));
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/question') {
      const { sessionId, questions } = body as { sessionId?: string; questions?: unknown[] };
      if (!sessionId || !Array.isArray(questions) || questions.length === 0) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'sessionId + questions[] required' }));
        return;
      }
      handlers.onQuestion({ sessionId, questions });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/file') {
      const { path } = body as { path?: string };
      if (!path) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'path required' }));
        return;
      }
      handlers.onFileReady({ path });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/push') {
      const { channelId, projectId, dir, message, question, callback } = body as {
        channelId?: string; projectId?: string; dir?: string;
        message?: string;
        question?: { text: string; options: { label: string }[] };
        callback?: string;
      };
      if (!message && !question) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'one of message, or question + callback required' }));
        return;
      }
      if (question && !callback) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'callback required when question is provided' }));
        return;
      }
      if (!channelId && !projectId && !dir) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'one of channelId, projectId, or dir required' }));
        return;
      }
      // Await the handler so a failure to resolve the channel is surfaced to the
      // caller (the CLI), instead of silently dropping the message.
      try {
        await handlers.onPush({ channelId, projectId, dir, message, question, callback });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(422, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: (e as Error).message }));
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/mcp') {
      // Abandon the MCP tool call cleanly if the HTTP caller disconnects mid-flight
      // (e.g. its transport died while waiting on a human button click). This is the
      // done-gate's "reconnect / pass control back" path: a late click degrades to the
      // existing "question expired" UX instead of resolving into a dead socket.
      // NOTE: listen on `res` (not `req`) — by now readBody() has already consumed the
      // request stream, so req's 'close' never re-fires on disconnect. res 'close' fires
      // on connection termination regardless of request-body state.
      const ac = new AbortController();
      res.on('close', () => ac.abort());
      try {
        const response = handlers.onMcp
          ? await handlers.onMcp(body, ac.signal)
          : { jsonrpc: '2.0', id: (body as { id?: unknown })?.id ?? null, error: { code: -32601, message: 'Method not found' } };
        if (res.writableEnded) return;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(response));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (res.writableEnded) return;
        try {
          res.writeHead((e as { code?: number })?.code === 422 ? 422 : 500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: (body as { id?: unknown })?.id ?? null, error: { code: -32603, message: msg } }));
        } catch { /* client already gone — nothing to write to */ }
      }
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'not found' }));
  });

  // Listen with a retry on EADDRINUSE (a killed process's socket may linger briefly).
  // Use a single server instance — calling listen() again after a failed listen is safe.
  const tryListen = () => {
    server.listen(port, '127.0.0.1', () => {
      console.log(`Bridge listening on 127.0.0.1:${port}`);
    });
  };
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Bridge port ${port} in use, retrying in 2s…`);
      setTimeout(tryListen, 2000);
    } else {
      console.error('Bridge error:', err.message);
    }
  });
  tryListen();

  return {
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  let body = '';
  for await (const chunk of req) body += chunk;
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    return {};
  }
}

async function createChannel(client: Client, name: string, reason?: string): Promise<TextChannel> {
  const guild = client.guilds.cache.first();
  if (!guild) throw new Error('Bot is not in any guild');
  const channel = await guild.channels.create({
    name: sanitizeChannelName(name),
    reason: reason ?? 'bot-commandcode project',
  });
  return channel as TextChannel;
}

/** Discord channel names: lowercase, no spaces (spaces → dashes), strip specials, max 100 chars. */
function sanitizeChannelName(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
  if (!slug) throw new Error('channel name invalid after sanitization');
  return slug;
}

export type { Guild };
