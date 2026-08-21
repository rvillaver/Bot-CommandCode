/**
 * bot-cmd-push MCP server — a minimal streamable-HTTP MCP endpoint served by the
 * bot's own bridge at /mcp. Lets agents inside a `cmd` session call Discord push
 * tools directly (structured, gateable via cmd's permissions engine), while the
 * CLI path (scripts/cli.mjs) keeps working for scripts/cron/CI.
 *
 * Protocol: MCP JSON-RPC over HTTP POST. Implements initialize, ping,
 * tools/list, tools/call. The ask_question tool blocks until the bot's button
 * handler resolves the answer (registered in ctx.pendingAnswers).
 */
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Client } from 'discord.js';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import { loadStore } from './store.js';

/** Discord channel the bot can send to. */
type SendableChannel = { send: (content: string | { content: string; components?: unknown[] }) => Promise<unknown> };

const PROTOCOL_VERSION = '2025-03-26';
const QUESTION_TTL_MS = 10 * 60 * 1000;

export interface McpCtx {
  client: Client;
  /** pushId → resolver for a pending ask; the bot's button handler calls it with the chosen label. */
  pendingAnswers: Map<string, (answer: string) => void>;
  /** Register the push-question state (options + channel) the button handler looks up. */
  registerPushQuestion: (pushId: string, options: string[], channelId: string) => void;
}

/** Resolve dir/projectId/channelId → a sendable Discord channel, or throw. */
export function resolveChannel(
  client: Client,
  channelId?: string,
  projectId?: string,
  dir?: string,
): SendableChannel {
  let cid = channelId;
  if (!cid) {
    const store = loadStore();
    if (projectId) {
      for (const [chan, pid] of Object.entries(store.bindings)) {
        if (pid === projectId) { cid = chan; break; }
      }
    } else if (dir) {
      let incoming: string;
      try { incoming = realpathSync(dir); } catch { incoming = resolve(dir); }
      for (const [chan, pid] of Object.entries(store.bindings)) {
        const p = store.projects[pid];
        if (!p) continue;
        let pdir: string;
        try { pdir = realpathSync(p.dir); } catch { pdir = resolve(p.dir); }
        if (pdir === incoming) { cid = chan; break; }
      }
    }
  }
  if (!cid) {
    throw new Error(
      `no channel bound for ${projectId ? `project ${projectId}` : `dir ${dir ?? '(none)'}`} — ` +
      'register it with `bot-commandcode projects add <id> --dir <path>` and bind a channel',
    );
  }
  const channel = client.channels.cache.get(cid) as SendableChannel | undefined;
  if (!channel) {
    throw new Error(`channel ${cid} not in cache — bot may need to reconnect to see it`);
  }
  return channel;
}

/** Tool definitions exposed to the MCP client. */
const TOOLS = [
  {
    name: 'push_message',
    description: 'Post a message into a Discord channel bound to a project directory.',
    inputSchema: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: 'Project directory (defaults to the caller cwd).' },
        projectId: { type: 'string', description: 'Registered project id (alternative to dir).' },
        channelId: { type: 'string', description: 'Explicit Discord channel id.' },
        message: { type: 'string', description: 'The message text to post.' },
      },
      required: ['message'],
    },
  },
  {
    name: 'ask_question',
    description: 'Post a question with button options to a Discord channel and block until the user clicks one. Returns the chosen option label.',
    inputSchema: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: 'Project directory (defaults to the caller cwd).' },
        projectId: { type: 'string', description: 'Registered project id (alternative to dir).' },
        channelId: { type: 'string', description: 'Explicit Discord channel id.' },
        question: { type: 'string', description: 'The question text.' },
        options: { type: 'array', items: { type: 'string' }, description: 'Up to 5 button labels.' },
      },
      required: ['question', 'options'],
    },
  },
  {
    name: 'list_projects',
    description: 'List registered projects and their bound Discord channels.',
    inputSchema: { type: 'object', properties: {} },
  },
];

function jsonrpc(id: unknown, result?: unknown, error?: { code: number; message: string }) {
  return { jsonrpc: '2.0', id, ...(error ? { error } : { result }) };
}

/**
 * Handle a single MCP JSON-RPC request. Returns the JSON-RPC response object.
 */
export async function handleMcpRequest(
  ctx: McpCtx,
  req: { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> },
): Promise<unknown> {
  const { id = null, method, params = {} } = req;

  if (method === 'initialize') {
    return jsonrpc(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'bot-cmd-push', version: '0.1.0' },
    });
  }

  if (method === 'ping') {
    return jsonrpc(id, {});
  }

  if (method === 'tools/list') {
    return jsonrpc(id, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    const { name, arguments: args = {} } = params as { name?: string; arguments?: Record<string, unknown> };
    try {
      const text = await callTool(ctx, name ?? '', args);
      return jsonrpc(id, { content: [{ type: 'text', text }], isError: false });
    } catch (e) {
      return jsonrpc(id, { content: [{ type: 'text', text: (e as Error).message }], isError: true });
    }
  }

  return jsonrpc(id, undefined, { code: -32601, message: `Method not found: ${method}` });
}

async function callTool(ctx: McpCtx, name: string, args: Record<string, unknown>): Promise<string> {
  if (name === 'push_message') {
    const dir = (args.dir as string) ?? '';
    const projectId = args.projectId as string | undefined;
    const channelId = args.channelId as string | undefined;
    const message = (args.message as string) ?? '';
    if (!message) throw new Error('message is required');
    const channel = resolveChannel(ctx.client, channelId, projectId, dir || undefined);
    await channel.send(message);
    return 'Posted to Discord.';
  }

  if (name === 'ask_question') {
    const dir = (args.dir as string) ?? '';
    const projectId = args.projectId as string | undefined;
    const channelId = args.channelId as string | undefined;
    const question = (args.question as string) ?? '';
    const options = (args.options as string[] | undefined) ?? [];
    if (!question) throw new Error('question is required');
    if (!options.length) throw new Error('at least one option is required');
    const cleanOptions = options.slice(0, 5);

    const channel = resolveChannel(ctx.client, channelId, projectId, dir || undefined);
    const pushId = Date.now().toString();

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      cleanOptions.map((label, i) =>
        new ButtonBuilder()
          .setCustomId(`push:${pushId}:${i}`)
          .setLabel(label)
          .setStyle(ButtonStyle.Primary),
      ),
    );
    await channel.send({ content: question, components: [row] });
    // Register the question state the button handler looks up (options + channel).
    const cid = (channel as { id?: string }).id ?? '';
    ctx.registerPushQuestion(pushId, cleanOptions, cid);

    // Wait for the user's button click (the bot's interaction handler resolves
    // ctx.pendingAnswers.get(pushId)). Time out after 10 min like the CLI.
    const answer = await new Promise<string>((resolveAnswer, reject) => {
      const timer = setTimeout(() => {
        ctx.pendingAnswers.delete(pushId);
        reject(new Error('timed out waiting for answer'));
      }, QUESTION_TTL_MS);
      ctx.pendingAnswers.set(pushId, (label) => {
        clearTimeout(timer);
        ctx.pendingAnswers.delete(pushId);
        resolveAnswer(label);
      });
    });

    return `Answer: ${answer}`;
  }

  if (name === 'list_projects') {
    const store = loadStore();
    const lines = Object.entries(store.bindings).map(([chan, pid]) => {
      const p = store.projects[pid];
      return `${pid} → ${p?.dir ?? '?'} (channel ${chan})`;
    });
    return lines.length ? lines.join('\n') : '(no projects registered)';
  }

  throw new Error(`Unknown tool: ${name}`);
}
