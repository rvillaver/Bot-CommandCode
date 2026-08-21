import {
  Client,
  ChannelType,
  GatewayIntentBits,
  Events,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type Message,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { REST, Routes } from 'discord.js';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { loadConfig } from './config.js';
import { runCmd, type RelayEvent, type RunHandle } from './relay.js';
import {
  loadStore,
  projectForChannel,
  projectIdForChannel,
  unbindChannel,
  deleteProject,
  saveProject,
  isDMChannel,
  type ProjectConfig,
} from './store.js';
import { startBridge } from './bridge.js';
import { downloadAttachment, collectOutFiles, ensureOutDir, alreadyPosted, markPosted, clearPosted, outDir, MAX_UPLOAD_BYTES } from './files.js';
import { shouldFork } from './session.js';
import { throughlinePreamble, saveThroughline, clearThroughline, loadThroughlineSummary, compactThroughline } from './threadline.js';
import { chunkMessage, sanitizeChannelName } from './text.js';
import { handleMcpRequest, type McpCtx } from './mcp.js';

const config = loadConfig();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
});

/** Per-channel queue: prompts are serialized, one cmd child per channel at a time. */
const channelQueues = new Map<string, string[]>();
/** Per-channel session ids (channelId → cmd session id), persisted to data/sessions.json. */
const sessions = new Map<string, string>();
/** Active cmd child handles per channel — /stop kills these. */
const activeRuns = new Map<string, RunHandle>();
/** Pending ask_user_question sets, keyed by session id (bridge → bot). Expiry ~10 min. */
const pendingQuestions = new Map<string, { questions: unknown[]; channelId: string; expiresAt: number }>();
const QUESTION_TTL_MS = 10 * 60 * 1000;
/** Pending push-question callbacks keyed by pushId (external workload two-way Q&A). Expiry ~10 min. */
const pendingPushCallbacks = new Map<string, { callback: string; options: string[]; channelId: string; expiresAt: number }>();
/** Pending MCP ask_question resolvers (pushId → resolve(answer)). Set by bot/mcp.ts. */
const mcpPendingAnswers = new Map<string, (answer: string) => void>();

function loadSessions(): void {
  try {
    const raw = JSON.parse(readFileSync('data/sessions.json', 'utf8')) as Record<string, string>;
    for (const [k, v] of Object.entries(raw)) sessions.set(k, v);
    console.log(`Loaded ${sessions.size} session(s) from data/sessions.json`);
  } catch {
    // No sessions file yet — fine.
  }
}

function saveSessions(): void {
  mkdirSync('data', { recursive: true });
  writeFileSync('data/sessions.json', JSON.stringify(Object.fromEntries(sessions), null, 2));
}

function isAllowed(channel: Message['channel']): boolean {
  if (config.allowedChannelIds.length === 0) return true;
  if (channel.isDMBased()) return false;
  return config.allowedChannelIds.includes(channel.id);
}

/** A channel we can send messages to — excludes partial/group-DM channels. */
type SendableChannel = Exclude<Message['channel'], { type: ChannelType.GroupDM }> & { send: (content: string) => Promise<unknown> };

function isTextChannel(channel: Message['channel']): channel is SendableChannel {
  return channel.type !== ChannelType.GroupDM && !channel.partial && 'send' in channel;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

client.on(Events.ClientReady, (c) => void onReady(c));

/** Everything that must (re)run whenever the client becomes ready — also after a watchdog reconnect. */
async function onReady(c: Client): Promise<void> {
  if (!c.user) return;
  console.log(`Logged in as ${c.user.tag}`);
  console.log('Guilds visible:', c.guilds.cache.size);
  for (const g of c.guilds.cache.values()) {
    console.log(`  - ${g.name} (${g.id}) channels: ${g.channels.cache.size}`);
  }
  loadSessions();
  await registerSlashCommands(c);

  // DM capability probe: send a DM to the first guild owner (or first member).
  try {
    const guild = c.guilds.cache.first();
    if (guild) {
      const owner = await guild.fetchOwner();
      const dm = await owner.createDM();
      await dm.send('✅ Bot online — DM relay ready. Send a message here!');
      console.log(`DM probe sent to ${owner.user.username}`);
    }
  } catch (e) {
    console.error('DM probe failed:', errMsg(e));
  }

  // Channel-create capability probe.
  try {
    const guild = c.guilds.cache.first();
    if (guild) {
      const created = await guild.channels.create({
        name: 'bot-commandcode-probe',
        reason: 'Permission check',
      });
      console.log(`Channel create OK: #${created.name} (${created.id})`);
      await created.delete('Permission check');
      console.log('Channel delete OK');
    }
  } catch (e) {
    console.error('Channel create/delete FAILED:', errMsg(e));
  }
}

/** Register guild slash commands via REST (instant updates, per SPEC §6.6). */
async function registerSlashCommands(c: Client): Promise<void> {
  if (!c.user) return;
  const commands = [
    { name: 'stop', description: 'Kill the running turn for this channel' },
    { name: 'clear', description: 'Forget the channel\u2019s session (start fresh next turn)' },
    { name: 'status', description: 'Show session id, queue length, and current state for this channel' },
  ];
  const rest = new REST().setToken(config.discordToken);
  try {
    for (const guild of c.guilds.cache.values()) {
      await rest.put(Routes.applicationGuildCommands(c.user.id, guild.id), { body: commands });
    }
    console.log(`Registered ${commands.length} slash command(s) in ${c.guilds.cache.size} guild(s)`);
  } catch (e) {
    console.error('Slash command registration failed:', errMsg(e));
  }
}

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === 'stop') {
      await handleStop(interaction);
    } else if (interaction.commandName === 'status') {
      await handleStatus(interaction);
    }
    return;
  }

  // External workload push-question button: push:<pushId>:<optIndex>
  if (interaction.isButton()) {
    const pushMatch = /^push:(\d+):(\d+)$/.exec(interaction.customId);
    if (pushMatch) {
      const pushId = pushMatch[1];
      const optIndex = Number(pushMatch[2]);
      const channel = interaction.channel;

      // MCP path: an in-cmd agent asked via MCP — resolve its pending promise.
      const mcpResolver = mcpPendingAnswers.get(pushId);
      if (mcpResolver) {
        const mcpPending = pendingPushCallbacks.get(pushId);
        const label = mcpPending?.options[optIndex] ?? '';
        if (!label || !mcpPending) {
          await interaction.reply({ content: 'Invalid option.', ephemeral: true });
          return;
        }
        if (!channel || channel.id !== mcpPending.channelId) {
          await interaction.reply({ content: 'This button belongs to another channel.', ephemeral: true });
          return;
        }
        console.log(`[push][mcp] button clicked: pushId=${pushId} answer="${label}"`);
        mcpResolver(label);
        mcpPendingAnswers.delete(pushId);
        pendingPushCallbacks.delete(pushId);
        await interaction.update({ content: `Answered: ${label}`, components: [] });
        return;
      }

      const pending = pendingPushCallbacks.get(pushId);
      if (!pending || Date.now() > pending.expiresAt) {
        await interaction.reply({ content: 'This question has expired.', ephemeral: true });
        return;
      }
      const label = pending.options[optIndex] ?? '';
      console.log(`[push] button clicked: pushId=${pushId} answer="${label}"`);
      if (!channel || channel.id !== pending.channelId) {
        await interaction.reply({ content: 'This button belongs to another channel.', ephemeral: true });
        return;
      }
      try {
        const res = await fetch(pending.callback, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ answer: label }),
        });
        if (res.ok) {
          console.log(`[push] answer "${label}" forwarded to callback: ${pending.callback}`);
          await interaction.update({ content: `Answered: ${label}`, components: [] });
          pendingPushCallbacks.delete(pushId);
        } else {
          await interaction.reply({ content: `Callback failed (HTTP ${res.status})`, ephemeral: true });
        }
      } catch (e) {
        await interaction.reply({ content: `Callback failed: ${errMsg(e)}`, ephemeral: true });
      }
      return;
    }
  }

  // Question button: q:<channelId>:<qIndex>:<optIndex>
  if (interaction.isButton()) {
    const m = /^q:(\d+):(\d+):(\d+)$/.exec(interaction.customId);
    if (!m) return;
    const channelId = m[1];
    const qIndex = Number(m[2]);
    const optIndex = Number(m[3]);
    const channel = interaction.channel;
    if (!channel || channel.id !== channelId) {
      await interaction.reply({ content: 'This button belongs to another channel.', ephemeral: true });
      return;
    }

    // Find the pending question for this channel's session.
    const sessionId = sessions.get(channelId);
    if (!sessionId) {
      await interaction.reply({ content: 'No active session for this channel.', ephemeral: true });
      return;
    }
    const pending = pendingQuestions.get(sessionId);
    if (!pending || Date.now() > pending.expiresAt) {
      await interaction.reply({ content: '⏳ Question expired — send a new prompt to continue.', ephemeral: true });
      return;
    }
    const question = pending.questions[qIndex] as { options?: { label?: string }[] } | undefined;
    const option = question?.options?.[optIndex];
    if (!question || !option) {
      await interaction.reply({ content: 'Invalid question option.', ephemeral: true });
      return;
    }

    // Enqueue the chosen label as the user's next message; delete the button row so it
    // can't be tapped twice.
    await interaction.update({ content: `Answered: ${option.label}`, components: [] });
    pendingQuestions.delete(sessionId);

    // If a turn is running, the answer continues it as a steer; else start a turn.
    const queue = channelQueues.get(channelId) ?? [];
    queue.push(option.label ?? '');
    channelQueues.set(channelId, queue);
    const store = loadStore();
    const project = projectForChannel(store, channelId);
    const pid = projectIdForChannel(store, channelId);
    if (project && pid) void processChannel(channel as SendableChannel, project, pid);
    return;
  }
});

/**
 * Channel deleted in Discord — clean up everything tied to it:
 * kill any active turn (process group + queue), delete the bound project from the
 * registry, and scrub its binding / session / throughline state.
 */
client.on(Events.ChannelDelete, async (channel) => {
  const channelId = channel.id;
  console.log(`[channelDelete] id=${channelId} name=${'name' in channel ? channel.name : '(dm)'}`);

  // Kill any active turn for this channel.
  const handle = activeRuns.get(channelId);
  if (handle) {
    handle.kill();
    activeRuns.delete(channelId);
    channelQueues.delete(channelId);
    console.log(`[channelDelete] killed active run for ${channelId}`);
  }

  // Scrub session + throughline + posted-files state.
  if (sessions.has(channelId)) {
    sessions.delete(channelId);
    saveSessions();
  }
  clearThroughline(channelId);
  clearPosted(channelId);

  // Delete the project this channel was bound to (user chose "also delete project").
  const projectId = unbindChannel(channelId);
  if (projectId) {
    deleteProject(projectId);
    console.log(`[channelDelete] deleted project ${projectId} (was bound to ${channelId})`);
  }
});

async function handleStop(interaction: ChatInputCommandInteraction): Promise<void> {
  const channelId = interaction.channelId;
  // Forbidden unless this channel is allowed to drive the agent.
  if (!interaction.channel || !isAllowed(interaction.channel)) {
    await interaction.reply('This channel is not allowed to drive the agent.');
    return;
  }
  const handle = activeRuns.get(channelId);
  if (!handle) {
    const queued = channelQueues.get(channelId)?.length ?? 0;
    await interaction.reply(queued > 0 ? `No turn running — ${queued} queued (use /clear to drop them).` : 'No turn is running in this channel.');
    return;
  }
  handle.kill();
  // Drop anything queued behind the killed turn — the user asked to stop.
  channelQueues.delete(channelId);
  activeRuns.delete(channelId);
  await interaction.reply('⏹️ Stopped.');
}

/** R16: /status — session id, queue length, and current state for this channel. */
async function handleStatus(interaction: ChatInputCommandInteraction): Promise<void> {
  const channelId = interaction.channelId;
  if (!interaction.channel || !isAllowed(interaction.channel)) {
    await interaction.reply('This channel is not allowed to drive the agent.');
    return;
  }
  const running = activeRuns.has(channelId);
  const queued = channelQueues.get(channelId)?.length ?? 0;
  const sessionId = sessions.get(channelId);
  const store = loadStore();
  const projectId = projectIdForChannel(store, channelId);
  const project = projectId ? store.projects[projectId] : undefined;

  const lines = [
    `**State:** ${running ? '🔧 running' : queued > 0 ? '⏳ queued' : 'idle'}`,
    `**Session:** ${sessionId ? `\`${sessionId.slice(0, 8)}…\`` : 'none (starts fresh on next prompt)'}`,
    `**Queue:** ${queued}`,
    projectId ? `**Project:** \`${projectId}\` → ${project?.dir ?? '?'}` : '**Project:** unbound',
  ];
  await interaction.reply(lines.join('\n'));
}

/**
 * DM control plane — the private chat with the bot is the owner's control surface for
 * projects. Commands:
 *   projects list
 *   projects add <id> --dir <path> [--model m] [--max-turns n] [--tools a,b]
 *   projects rm <id>
 * Only the first guild's owner may use these.
 */
async function handleDmControl(msg: Message): Promise<void> {
  const ownerId = await guildOwnerId();
  if (!ownerId || msg.author.id !== ownerId) {
    await msg.reply('Only the server owner can manage projects from DM.');
    return;
  }
  const [sub, ...rest] = msg.content.trim().split(/\s+/);
  const reply = async (text: string): Promise<void> => {
    await msg.reply(text);
  };

  if (sub === 'projects' && rest[0] === 'list') {
    const store = loadStore();
    const ids = Object.keys(store.projects);
    if (ids.length === 0) return reply('No projects.');
    const lines = ids.map((id) => {
      const p = store.projects[id];
      const bound = Object.entries(store.bindings).find(([, pid]) => pid === id);
      return `\`${id}\` → ${p.dir}${bound ? ` — bound to <#${bound[0]}>` : ' (unbound)'}`;
    });
    return reply(`**Projects:**\n${lines.join('\n')}`);
  }

  if (sub === 'projects' && rest[0] === 'add') {
    const id = rest[1];
    if (!id) return reply('usage: `projects add <id> --dir <path> [--model m] [--max-turns n] [--tools a,b]`');
    // Parse flags (same shape as the CLI's projects add).
    let dir: string | undefined;
    const cfg: Partial<ProjectConfig> = {};
    for (let i = 2; i < rest.length; i++) {
      const a = rest[i];
      if (a === '--dir') dir = rest[++i];
      else if (a === '--model') cfg.model = rest[++i];
      else if (a === '--max-turns') cfg.maxTurns = Number(rest[++i]);
      else if (a === '--tools') cfg.tools = rest[++i].split(',');
      else return reply(`unknown flag: ${a}`);
    }
    if (!dir) return reply('--dir is required.');
    if (!existsSync(dir)) return reply(`directory does not exist: ${dir}`);
    cfg.dir = dir;

    const store = loadStore();
    if (store.projects[id]) return reply(`project already exists: ${id}`);
    saveProject(id, cfg as ProjectConfig);

    // Create a guild channel named after the project and bind it.
    try {
      const guild = client.guilds.cache.first();
      if (!guild) throw new Error('Bot is not in any guild');
      const channel = await guild.channels.create({
        name: sanitizeChannelName(id),
        reason: `bot-commandcode project ${id} (from DM)`,
      });
      const bindings = { ...store.bindings, [channel.id]: id };
      writeFileSync(resolve(process.cwd(), 'data', 'bindings.json'), JSON.stringify(bindings, null, 2) + '\n');
      return reply(`✅ Created #${channel.name} (${channel.id}) and bound it to \`${id}\`. Send prompts there.`);
    } catch (e) {
      return reply(`✅ Project saved, but channel creation failed: ${errMsg(e)}. Bind a channel manually with \`bot-commandcode bind <channelId> ${id}\`.`);
    }
  }

  if (sub === 'projects' && rest[0] === 'rm') {
    const id = rest[1];
    if (!id) return reply('usage: `projects rm <id>`');
    const removed = deleteProject(id);
    if (removed.length === 0) return reply(`no such project: ${id}`);
    return reply(`✅ Deleted project \`${id}\`.`);
  }

  return reply('Commands: `projects list` · `projects add <id> --dir <path> [--model m]` · `projects rm <id>`');
}

/** Id of the first guild's owner, cached after first lookup. */
let ownerIdCache: string | undefined;
async function guildOwnerId(): Promise<string | undefined> {
  if (ownerIdCache) return ownerIdCache;
  try {
    const guild = client.guilds.cache.first();
    if (!guild) return undefined;
    const owner = await guild.fetchOwner();
    ownerIdCache = owner.id;
    return owner.id;
  } catch {
    return undefined;
  }
}

client.on(Events.MessageCreate, async (msg) => {
  console.log(`[message] author=${msg.author.username} (bot=${msg.author.bot}) channelType=${msg.channel.type} id=${msg.channel.id} content=${msg.content.slice(0, 50)}`);
  if (msg.author.bot) return;
  if (!msg.content && msg.attachments.size === 0) return;

  // Reload sessions each message so CLI-seeded sessions (projects add --resume) are picked up live.
  loadSessions();

  if (config.commandPrefix && msg.content && !msg.content.startsWith(config.commandPrefix)) return;
  const prompt = config.commandPrefix && msg.content
    ? msg.content.slice(config.commandPrefix.length).trim()
    : (msg.content ?? '');

  if (!isAllowed(msg.channel)) {
    await msg.reply('This channel is not allowed to drive the agent.');
    return;
  }
  if (!isTextChannel(msg.channel)) return;

  // H1: /clear — fork the channel's session to fresh context (old conversation preserved on disk).
  if (msg.content?.trim() === '/clear') {
    if (!sessions.has(msg.channel.id)) {
      await msg.reply('No session to clear in this channel.');
      return;
    }
    sessions.delete(msg.channel.id);
    saveSessions();
    clearThroughline(msg.channel.id);
    clearPosted(msg.channel.id);
    await msg.reply('✅ Session cleared — next message starts fresh (previous session preserved on disk).');
    return;
  }

  // Control plane via DM: owner can manage projects from the private chat with the bot.
  if (isDMChannel(msg.channel)) {
    await handleDmControl(msg);
    return;
  }

  // Resolve channel → bound project.
  const store = loadStore();
  const project = projectForChannel(store, msg.channel.id);
  const projectId = projectIdForChannel(store, msg.channel.id);
  if (!project || !projectId) {
    await msg.reply('No project bound to this channel. Use `bot-commandcode bind <channelId> <projectId>` to set one.');
    return;
  }

  // R14: free-text answer while a question is pending — treat the text as the answer.
  const pendingForChannel = [...pendingQuestions.values()].find(
    (p) => p.channelId === msg.channel.id && Date.now() <= p.expiresAt,
  );
  if (pendingForChannel) {
    const sessionId = [...pendingQuestions.entries()].find(([, v]) => v === pendingForChannel)?.[0];
    if (sessionId) pendingQuestions.delete(sessionId);
    await msg.reply(`✅ Answer noted: "${prompt}"`);
    const queue = channelQueues.get(msg.channel.id) ?? [];
    queue.push(prompt);
    channelQueues.set(msg.channel.id, queue);
    void processChannel(msg.channel, project, projectId);
    return;
  }

  // Reject-while-running: one turn per channel at a time. If a turn is active (or a
  // queued prompt is already waiting), refuse the new prompt instead of queueing it —
  // the user said "stop" to cancel, then sends the follow-up once the turn ends.
  const busy = activeRuns.has(msg.channel.id) || (channelQueues.get(msg.channel.id)?.length ?? 0) > 0;
  if (busy) {
    await msg.reply('⏳ A turn is already running in this channel. Use `/stop` to cancel it, then send your prompt again once it ends.');
    return;
  }

  // F1: in-bound attachments — download into the workspace, append paths to the prompt.
  let prompt2 = prompt;
  if (msg.attachments.size > 0) {
    const attached: string[] = [];
    for (const a of msg.attachments.values()) {
      try {
        const saved = await downloadAttachment(projectId, a);
        attached.push(saved.path);
        console.log(`Downloaded attachment ${a.name} -> ${saved.path}`);
      } catch (e) {
        console.error(`Attachment download failed for ${a.name}:`, errMsg(e));
        await msg.reply(`⚠️ Couldn't download ${a.name}: ${errMsg(e)}`);
      }
    }
    if (attached.length > 0) {
      prompt2 = `${prompt}\n\n[attached: ${attached.join(', ')}]`;
    }
  }

  // Enqueue and start the turn. Reject-while-running (checked above) guarantees the
  // queue has at most this one item, so no "N ahead" path exists anymore.
  const queue = channelQueues.get(msg.channel.id) ?? [];
  queue.push(prompt2);
  channelQueues.set(msg.channel.id, queue);
  void processChannel(msg.channel, project, projectId);
});

async function processChannel(channel: SendableChannel, project: ProjectConfig, projectId: string): Promise<void> {
  const queue = channelQueues.get(channel.id) ?? [];
  while (queue.length > 0) {
    const prompt = queue.shift()!;
    await runTurn(channel, project, projectId, prompt);
  }
  channelQueues.delete(channel.id);
}

async function runTurn(channel: SendableChannel, project: ProjectConfig, projectId: string, prompt: string): Promise<void> {
  // R6: streaming — push new messages as deltas arrive, never edit (edit caps + rate limits).
  const streamer: Streamer = new Streamer(channel);

  // F2: ensure the agent has a drop point for out-bound files (real dir + project symlink).
  ensureOutDir(projectId, project.dir);

  let finalText = '';
  let durationMs: number | undefined;
  let newSessionId: string | undefined;

  const resumeSessionId = sessions.get(channel.id);

  // Throughline memory: prepend the channel's rolling context block so the model keeps
  // the throughline even across compaction / forks.
  const preamble = throughlinePreamble(channel.id);
  const promptWithContext = preamble ? `${preamble}\n\n${prompt}` : prompt;

  // H2: cost-aware resume — if resuming would re-send a huge history, fork fresh instead.
  // Lower than cmd's own auto-compact tiers (~90% of the 1M window) so we fork before
  // the model is drowning in its own raw transcript.
  const FORK_THRESHOLD = 200_000; // input tokens
  const fork = resumeSessionId !== undefined && shouldFork(project.dir, resumeSessionId, FORK_THRESHOLD);
  if (fork) console.log(`H2: forking session ${resumeSessionId.slice(0, 8)}… (resume too expensive)`);

  const relay = runCmd(
    config,
    { prompt: promptWithContext, project, resumeSessionId, fork },
    {
      onLine: (line: RelayEvent) => {
        if (line.type === 'event' && line.event?.type === 'text_delta') {
          const delta = (line.event as { delta?: string }).delta;
          if (delta) {
            streamer.append(delta);
          }
        } else if (line.type === 'event' && line.event?.type === 'tool_running') {
          // R7: one short status line per tool start (never streamed into the answer).
          const ev = line.event as { toolName?: string; description?: string };
          const label = ev.description || ev.toolName || 'tool';
          void channel.send(`🔧 ${label}`).catch(() => {});
        } else if (line.type === 'event' && line.event?.type === 'tool_completed') {
          const ev = line.event as { toolName?: string };
          void channel.send(`✅ ${ev.toolName ?? 'tool'}`).catch(() => {});
        } else if (line.type === 'event' && line.event?.type === 'tool_errored') {
          const ev = line.event as { toolName?: string; error?: string };
          const err = ev.error ? `: ${ev.error.slice(0, 200)}` : '';
          void channel.send(`❌ ${ev.toolName ?? 'tool'}${err}`).catch(() => {});
        } else if (line.type === 'event' && line.event?.type === 'tool_denied') {
          const ev = line.event as { toolName?: string };
          void channel.send(`🚫 ${ev.toolName ?? 'tool'} denied`).catch(() => {});
        } else if (line.type === 'event' && line.event?.type === 'notice') {
          const ev = line.event as { level?: string; message?: string };
          void channel.send(`⚠️ ${ev.message ?? 'notice'}`).catch(() => {});
        } else if (line.type === 'result') {
          finalText = line.finalText;
          durationMs = line.durationMs;
          if (line.sessionId) {
            newSessionId = line.sessionId;
            sessions.set(channel.id, line.sessionId);
            saveSessions();
          }
          // R10: max_turns — the turn cap was hit; surface it with the partial answer.
          if (line.subtype === 'max_turns' && finalText) {
            void channel
              .send(`🔁 Reached the turn limit. Partial result:\n${finalText.slice(0, 1500)}`)
              .catch(() => {});
          }
        }
      },
      onExit: async ({ exitCode, gotResult, stderrTail }) => {
        activeRuns.delete(channel.id);
        if (gotResult && finalText) {
          // Throughline: roll the latest exchange into the channel's rolling context block.
          const prev = loadThroughlineSummary(channel.id);
          const next = compactThroughline(prev, prompt, finalText);
          saveThroughline(channel.id, next);
          // Finalize: post the final answer as its own message (footer + out-files).
          // Dedup: skip files already posted in this channel; mark the ones we send.
          const allOut = collectOutFiles(projectId);
          let fresh = allOut.filter((f) => !alreadyPosted(channel.id, f.path));
          // F3: never upload >25MB — Discord rejects it and the send would fail.
          const oversized = fresh.filter((f) => statSync(f.path).size > MAX_UPLOAD_BYTES);
          if (oversized.length > 0) {
            console.log(`[files] skipping ${oversized.map((f) => f.name).join(', ')} — over ${MAX_UPLOAD_BYTES / 1024 / 1024}MB`);
            fresh = fresh.filter((f) => statSync(f.path).size <= MAX_UPLOAD_BYTES);
          }
          for (const f of fresh) markPosted(channel.id, f.path, f.name);
          if (fresh.length < allOut.length) {
            console.log(`[dedup] skipped ${allOut.length - fresh.length} already-posted file(s) in ${channel.id}`);
          }
          const content = `**${prompt}** → ${finalText}${durationMs !== undefined ? `\n*(took ${durationMs}ms)*` : ''}`;
          await streamer.finalize(content, fresh);
        } else if (relay.killed()) {
          // /stop killed this turn — the handler already replied "stopped".
          streamer.abandon();
        } else {
          // R8: failure embed — exit code + stderr tail (kept ~2000 chars in the relay).
          const tail = (stderrTail ?? '').trim().slice(0, 1500);
          const msg = tail
            ? `⚠️ Turn failed (exit code ${exitCode}).\n\`\`\`\n${tail}\n\`\`\``
            : `⚠️ Turn failed (exit code ${exitCode}).`;
          await streamer.finalize(msg, []);
        }
      },
    },
  );
  activeRuns.set(channel.id, relay);

  void relay;
}

/**
 * Render a question set as Discord messages with button rows. One message per question,
 * each an ActionRow of buttons (customId q:<channel>:<qIndex>:<optIndex>). multiSelect
 * renders as single-select for v1 (see PRODUCTION-BACKLOG).
 */
async function postQuestions(
  channel: SendableChannel,
  channelId: string,
  sessionId: string,
  questions: unknown[],
): Promise<void> {
  for (let qi = 0; qi < questions.length; qi++) {
    const q = questions[qi] as { question?: string; options?: { label?: string }[] } | undefined;
    if (!q) continue;
    const opts = q.options ?? [];
    if (opts.length === 0) continue;
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      opts.slice(0, 5).map((o, oi) =>
        new ButtonBuilder()
          .setCustomId(`q:${channelId}:${qi}:${oi}`)
          .setLabel(o.label ?? `Option ${oi + 1}`)
          .setStyle(ButtonStyle.Primary),
      ),
    );
    try {
      await channel.send({ content: q.question ?? 'Question:', components: [row] });
    } catch (e) {
      console.error(`[question] send failed: ${errMsg(e)}`);
    }
  }
  // Clean up expired pending questions periodically.
  setTimeout(() => {
    if (pendingQuestions.get(sessionId)?.expiresAt && Date.now() > pendingQuestions.get(sessionId)!.expiresAt) {
      pendingQuestions.delete(sessionId);
    }
  }, QUESTION_TTL_MS + 1000).unref();
}

/**
 * Push-only streamer: accumulates text_delta into chunks and sends them as new messages
 * (batched ~1/sec to respect Discord's ~5 sends/5s per channel). Never edits. On finalize,
 * posts the final answer as its own message with optional file attachments.
 */
class Streamer {
  private buf = '';
  private timer: NodeJS.Timeout | null = null;
  private done = false;
  private readonly MAX_CHARS = 1900; // under Discord's 2000-char cap

  constructor(private channel: SendableChannel) {}

  append(delta: string): void {
    if (this.done) return;
    this.buf += delta;
    if (this.buf.length >= this.MAX_CHARS) {
      void this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), 1000);
    }
  }

  private async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.buf || this.done) return;
    const text = this.buf;
    this.buf = '';
    try {
      await this.channel.send(text);
    } catch (e) {
      console.error(`Stream send failed: ${errMsg(e)}`);
      this.buf = text + this.buf; // retry next flush
    }
  }

  async finalize(content: string, outFiles: { name: string; path: string }[]): Promise<void> {
    this.done = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.buf = ''; // the final content supersedes any unflushed partial
    try {
      const chunks = chunkMessage(content, this.MAX_CHARS);
      if (outFiles.length > 0) {
        // Attach files on the last chunk (Discord allows files on one message per call).
        for (let i = 0; i < chunks.length; i++) {
          const last = i === chunks.length - 1;
          const body = chunks.length === 1 ? chunks[i] : `(${i + 1}/${chunks.length}) ${chunks[i]}`;
          await this.channel.send(last ? { content: body, files: outFiles.map((f) => f.path) } : body);
        }
        console.log(`Attached ${outFiles.length} out-file(s): ${outFiles.map((f) => f.name).join(', ')}`);
      } else {
        for (let i = 0; i < chunks.length; i++) {
          const body = chunks.length === 1 ? chunks[i] : `(${i + 1}/${chunks.length}) ${chunks[i]}`;
          await this.channel.send(body);
        }
      }
    } catch (e) {
      console.error(`Final send failed: ${errMsg(e)}`);
    }
  }

  /** A /stop killed this turn — drop any pending stream without posting a failure embed. */
  abandon(): void {
    this.done = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.buf = '';
  }
}

let shuttingDown = false;
process.on('SIGINT', () => { shuttingDown = true; void shutdown('SIGINT'); });
process.on('SIGTERM', () => { shuttingDown = true; void shutdown('SIGTERM'); });

async function shutdown(signal: string): Promise<void> {
  console.log(`${signal} received — shutting down cleanly`);
  try { await client.destroy(); } catch { /* already gone */ }
  process.exit(0);
}

/**
 * Reconnect watchdog — discord.js auto-reconnects, but a laptop sleep / network cut can
 * leave the gateway websocket dead-but-not-destroyed indefinitely (bot shows offline,
 * no ClientReady refire). Heartbeat: if not ready for HEARTBEAT_STRIKES consecutive
 * checks, destroy and log back in.
 */
function startReconnectWatchdog(): void {
  const HEARTBEAT_MS = 15_000;
  const HEARTBEAT_STRIKES = 4; // ~60s of not-ready before forcing a reconnect
  let strikes = 0;

  setInterval(async () => {
    if (shuttingDown) return;
    if (client.isReady()) {
      strikes = 0;
      return;
    }
    strikes += 1;
    console.log(`Watchdog: not ready (strike ${strikes}/${HEARTBEAT_STRIKES}) — ws status=${client.ws.status}`);
    if (strikes < HEARTBEAT_STRIKES) return;

    console.log('Watchdog: forcing reconnect (destroy + login)…');
    strikes = 0;
    try {
      await client.destroy();
    } catch (e) {
      console.error('Watchdog: destroy failed:', errMsg(e));
    }
    try {
      await client.login(config.discordToken);
      console.log('Watchdog: reconnected, awaiting ClientReady…');
    } catch (e) {
      console.error('Watchdog: login failed:', errMsg(e));
    }
  }, HEARTBEAT_MS).unref();
}

client.login(config.discordToken)
  .then(() => { startReconnectWatchdog(); })
  .catch((err) => {
    console.error('Login failed:', err.message);
    process.exit(1);
  });

// Local control bridge: mod → bot (question, file_ready) and CLI → bot (create channel).
startBridge(config.relayPort, client, {
  onQuestion: ({ sessionId, questions }) => {
    // Map session id → channel via the sessions map (invert it).
    let channelId: string | undefined;
    for (const [cid, sid] of sessions) {
      if (sid === sessionId) { channelId = cid; break; }
    }
    if (!channelId) {
      console.error(`[question] no channel for session ${sessionId.slice(0, 8)} — dropping`);
      return;
    }
    const channel = client.channels.cache.get(channelId) as SendableChannel | undefined;
    if (!channel) {
      console.error(`[question] channel ${channelId} not found — dropping`);
      return;
    }
    pendingQuestions.set(sessionId, { questions, channelId, expiresAt: Date.now() + QUESTION_TTL_MS });
    void postQuestions(channel, channelId, sessionId, questions);
  },
  onPush: async ({ channelId, projectId, dir, message, question, callback }) => {
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
        `no channel bound for ${projectId ? `project ${projectId}` : `dir ${dir}`} — ` +
        'register it with `bot-commandcode projects add <id> --dir <path>` and bind a channel',
      );
    }
    const channel = client.channels.cache.get(cid) as SendableChannel | undefined;
    if (!channel) {
      throw new Error(`channel ${cid} not in cache — bot may need to reconnect to see it`);
    }
    try {
      if (question && callback) {
        const pushId = Date.now().toString();
        const opts = (question.options ?? []).slice(0, 5);
        const labels = opts.map((o) => o.label ?? '');
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
          opts.map((o, oi) =>
            new ButtonBuilder()
              .setCustomId(`push:${pushId}:${oi}`)
              .setLabel(o.label ?? `Option ${oi + 1}`)
              .setStyle(ButtonStyle.Primary),
          ),
        );
        await channel.send({ content: question.text ?? 'Question:', components: [row] });
        pendingPushCallbacks.set(pushId, {
          callback,
          options: labels,
          channelId: cid,
          expiresAt: Date.now() + QUESTION_TTL_MS,
        });
        console.log(`[push] question posted to #${(channel as { name?: string }).name ?? cid} (pushId=${pushId})`);
      } else if (message) {
        await channel.send(message);
        console.log(`[push] posted to #${(channel as { name?: string }).name ?? cid}`);
      }
    } catch (e) {
      console.error(`[push] send failed: ${errMsg(e)}`);
    }
  },
  onFileReady: ({ path }) => {
    // Mid-turn file display: a cmd child wrote a file under its project's out dir.
    // Resolve the real path (through the .cmd-relay/out symlink) and find the channel
    // whose project owns it.
    const store = loadStore();
    let channelId: string | undefined;
    let projectId: string | undefined;
    let real: string;
    try {
      real = realpathSync(path);
    } catch {
      console.log(`[file_ready] ${path} not readable — ignoring`);
      return;
    }
    for (const [cid, pid] of Object.entries(store.bindings)) {
      const p = store.projects[pid];
      if (p && real.startsWith(outDir(pid))) { channelId = cid; projectId = pid; break; }
    }
    if (!channelId || !projectId) {
      console.log(`[file_ready] ${real} not under any bound project's out dir — ignoring`);
      return;
    }
    if (!existsSync(real)) {
      console.log(`[file_ready] ${real} gone before send — ignoring`);
      return;
    }
    if (statSync(real).size > MAX_UPLOAD_BYTES) {
      console.log(`[file_ready] ${real} over ${MAX_UPLOAD_BYTES / 1024 / 1024}MB — skipping (Discord cap)`);
      return;
    }
    if (alreadyPosted(channelId, real)) {
      console.log(`[file_ready] ${real} already posted in ${channelId} — skipping duplicate`);
      return;
    }
    const channel = client.channels.cache.get(channelId) as SendableChannel | undefined;
    if (!channel) {
      console.log(`[file_ready] channel ${channelId} not found — ignoring`);
      return;
    }
    markPosted(channelId, real, basename(real));
    void channel
      .send({ content: `📎 **${basename(real)}**`, files: [real] })
      .then(() => console.log(`[file_ready] posted ${real} in ${channelId}`))
      .catch((e) => console.error(`[file_ready] send failed: ${errMsg(e)}`));
  },
  onMcp: (req) => {
    const ctx: McpCtx = {
      client,
      pendingAnswers: mcpPendingAnswers,
      registerPushQuestion: (pushId, options, channelId) => {
        pendingPushCallbacks.set(pushId, {
          callback: '', // no HTTP callback for MCP — the promise resolver handles it
          options,
          channelId,
          expiresAt: Date.now() + QUESTION_TTL_MS,
        });
      },
    };
    return handleMcpRequest(ctx, req as Parameters<typeof handleMcpRequest>[1]);
  },
});
