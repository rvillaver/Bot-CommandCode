import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Client, Guild, TextChannel } from 'discord.js';

/** Handlers the bot registers — the bridge stays UI-agnostic (SPEC §2: its sole job is to relay). */
export interface BridgeHandlers {
  /** A question set arrived from a cmd child (ask_user_question). Keyed by session id. */
  onQuestion: (payload: { sessionId: string; questions: unknown[] }) => void;
  /** A file was written to the out drop-point by a cmd child. */
  onFileReady: (payload: { path: string }) => void;
}

/**
 * Local control bridge bound to 127.0.0.1 only (SPEC §2, §4).
 * - POST /question  — mod→bot: intercepted ask_user_question
 * - POST /file      — mod→bot: a file landed in the out drop-point
 * - POST /create-channel — CLI→bot: create a channel named after a project folder
 */
export function startBridge(port: number, client: Client, handlers: BridgeHandlers): void {
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
    reason: reason ?? 'cmd-relay project',
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
