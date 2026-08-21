# Bot-CommandCode — Discord relay for Command Code

**The Discord chat interface for [Command Code](https://commandcode.ai) — with interaction-aware question buttons.**

Send a prompt from Discord; the bot spawns `cmd` in headless mode and relays the conversation back as a chat thread.
When the agent asks a multiple-choice question you get **clickable buttons**, plain text input works like any messenger,
and tool runs show **live progress** — no more black box.

[![Node.js](https://img.shields.io/badge/node-%3E%3D20-18181b?style=flat-square&labelColor=18181b&logo=node.js&logoColor=white)](https://nodejs.org)
[![Discord.js](https://img.shields.io/badge/discord.js-14-18181b?style=flat-square&labelColor=18181b&logo=discord&logoColor=white)](https://discord.js.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-18181b?style=flat-square&labelColor=18181b)](LICENSE)

## Why Bot-CommandCode

- **Interaction-aware** — `ask_user_question` becomes Discord buttons; the user's answer continues the run.
- **One project per channel** — bind a Discord channel to any folder on disk; each has its own session, queue, and
  cmd config (model, max turns, tools, permission mode).
- **Works from anywhere** — phone, tablet, or desktop: drive your coding agent from a DM or a server channel.
- **Safe by default** — `cmd` runs in `default` permission mode (mutating actions denied); projects that need writes opt
  into `--yolo` with deny rules as the backstop. The local bridge never leaves `127.0.0.1`.

## Quickstart

```bash
# 1. Install dependencies
npm i

# 2. Configure (see .env.example)
cp .env.example .env
#    - set DISCORD_TOKEN from the Discord Developer Portal

# 3. Start the bot
npm run bot
```

Add the bot to your server (one-time, ~5 minutes) — full steps in [Discord setup](#discord-setup-one-time).

## Features

| Feature | How it works |
|---|---|
| **Prompt → stream** | Plain messages in a bound channel are prompts; answers stream in as `text_delta`s arrive |
| **Question → buttons** | When the agent calls `ask_user_question`, one button per option; tap to answer, or type a free-text answer |
| **Tool progress** | 🔧 running / ✅ completed / ❌ errored / 🚫 denied lines while a turn runs |
| **Session memory** | Each channel resumes its own `cmd` session across turns (`--resume`), survives restarts, and forks before the context bloats |
| **File transfer** | Attach a file in → the agent reads it; the agent writes to `.bot-commandcode/out/` → the file appears as an attachment (dedup'd by content hash) |
| **Workspaces** | One project per channel — register a folder, the bot creates and binds a channel for it |
| **Slash commands** | `/stop` kills a turn, `/clear` starts fresh, `/status` shows session/queue/project |
| **DM control plane** | The server owner can manage projects from the bot's DM (`projects list/add/rm`) |
| **Resilient** | Runs under PM2 with auto-restart; sessions reload on boot; a watchdog reconnects the gateway after network drops |

## Requirements

- **Node.js ≥ 20**
- **Command Code CLI** (`cmd`) installed and authenticated — `npm i -g command-code`
- A **Discord application** with a bot token (see below)

## Discord setup (one-time)

1. **Create the app** — <https://discord.com/developers/applications> → **New Application** → name it → **Create**.
2. **Get the bot token** — **Bot** tab → **Reset Token** → copy. It starts with `MT...`. Treat it as a secret.
3. **Enable the message content intent** — **Bot** tab → **Privileged Gateway Intents** → **MESSAGE CONTENT INTENT** **ON**.
4. **Generate the invite URL** — **OAuth2 → URL Generator** → scopes **bot** + **applications.commands** → bot
   permissions **Send Messages**, **Embed Links**, **Read Message History**, **Add Reactions**, **Use Slash Commands**.
5. **Add the bot to a private server** — open the URL → pick your server → **Authorize**.

## Configure

Copy `.env.example` to `.env` and fill it in:

| Var | Meaning |
|---|---|
| `DISCORD_TOKEN` | Your bot token (step 2). Required. |
| `RELAY_PORT` | Port for the local mod→bot bridge. Default `8787`. Never expose publicly. |
| `ALLOWED_CHANNEL_IDS` | Comma-separated channel IDs allowed to drive the agent. Empty = any DM + any channel the bot can see. |
| `COMMAND_PREFIX` | Optional `"!"` prefix mode; empty = plain messages are prompts. |
| `CMD_BINARY` | Override for testing (e.g. a wrapper script). Default `cmd`. |

## Run

```bash
npm i
npm run bot
```

The bot connects to Discord, loads your sessions, and is ready for prompts in bound channels.

## Workspaces (one channel per project folder)

The bot runs **one project per Discord channel** — each channel is bound to a folder on disk and has its own session,
queue, and cmd config.

```bash
# Register a project — the bot creates + binds a channel named after the folder
node bin/bot-commandcode.mjs projects add myproj --dir /path/to/folder --model deepseek/deepseek-v4-flash

# Manual bind/unbind (if you want a different channel)
node bin/bot-commandcode.mjs bind <channelId> <projectId>
node bin/bot-commandcode.mjs unbind <channelId>

# List / remove projects
node bin/bot-commandcode.mjs projects list
node bin/bot-commandcode.mjs projects rm <id>
```

- `projects add` auto-creates a Discord channel and binds it (requires **Manage Channels**); use `--no-channel` to skip.
- Per-project flags: `--model`, `--max-turns`, `--tools a,b`, `--config k=v`, `--permission-mode default|auto-accept|plan|dont-ask|bypass`.
- **Unbound channels are refused politely** — bind one first. DMs are the owner's control plane, not a workspace.

## PM2 (resilient service)

```bash
node bin/bot-commandcode.mjs pm2 start      # start under PM2 (auto-restart on crash)
node bin/bot-commandcode.mjs pm2 status
node bin/bot-commandcode.mjs pm2 logs
node bin/bot-commandcode.mjs pm2 stop
```

Sessions are persisted to `data/sessions.json` per channel and resume after a restart.

## External workload push (updates & questions)

Other processes — scripts, build jobs, monitoring — can push messages or
interactive questions into a running bot thread. **No `cmd` involvement needed.**

### `bot-commandcode push` / `npm run botcmd:push`

Push a message into the Discord channel bound to the current project directory:

```bash
# from within a project directory — pwd is used for channel lookup
npm run botcmd:push -- "Build complete — 12 tests passed."
node bin/bot-commandcode.mjs push "Deploying to staging…"
# target explicitly
node bin/bot-commandcode.mjs push --channel <channelId> "hello"
node bin/bot-commandcode.mjs push --project <projectId> "hello"
```

The bot resolves `dir` (defaults to `pwd`) → project → Discord channel via
`data/bindings.json`. Override the bridge port with `RELAY_PORT` (default 8787).

### `bot-commandcode ask` / `npm run botcmd:ask`

Push a **question** with button options. The bot renders buttons in Discord;
when the user clicks one, the answer is POSTed back to a temporary local HTTP
server the CLI starts, and the CLI prints the answer:

```bash
npm run botcmd:ask -- "Deploy to production?" "yes" "no" "later"
```

### Standalone CLI: `bot-cmd-push`

For external workloads that don't have `bot-commandcode` installed, a zero-dependency
standalone CLI lives in [`tools/bot-cmd-push/`](tools/bot-cmd-push):

```bash
cd tools/bot-cmd-push && npm i -g .
bot-cmd-push push "Build #42 succeeded"
bot-cmd-push ask "Use staging or prod?" "staging" "prod"
```

Both sub-commands default to `pwd` for channel resolution and respect
`RELAY_PORT` (default 8787).

## Safety

The bot is the **chat interface for Command Code** — it lets you drive `cmd` (shell + file access) from Discord, so
it's a powerful surface by design. The safety model keeps that power on a leash:

- **Write gate in print mode** — in headless print mode (`cmd -p`), *all* mutating tools (file writes, shell commands) are
  blocked by a built-in gate. The only way to enable writes is `--yolo`, which sets `cmd` to `bypass` mode for that
  session and bypasses the write gate. Permission modes like `auto-accept` or `dont-ask` are accepted by `cmd` but
  are **overridden** by `--yolo` — they do *not* independently enable writes in print mode.
- **Permission modes** — the bot maps each project's `--permission-mode` to the right `cmd` flags:
  - `default` / `plan` → `--permission-mode <mode>` (no `--yolo`; writes denied — use for read-only repos).
  - `auto-accept` / `dont-ask` / `bypass` → `--yolo` (writes allowed; bypass mode).
- **Deny rules** — `.commandcode/settings.json` → `permissions.deny` blocks destructive commands (`rm -rf /`, `sudo`,
  force-pushes, …). Deny rules beat every mode **including `--yolo`/bypass** — they're the backstop that makes
  `--yolo` safe to run. A project that needs writes should always pair `--yolo` with deny rules + PreToolUse hooks
  (see [Command Code hooks docs](https://commandcode.ai/docs/hooks)).
- **`ALLOWED_CHANNEL_IDS`** restricts who can drive the agent; unbound channels are refused.
- **Local bridge only** — the mod→bot bridge binds to `127.0.0.1`; never expose it publicly.
- **Secrets** — `.env` is gitignored; never log or echo the Discord token.

## File transfer

Transfer files live in the bot's own runtime space — **not** inside the bound project repos — so the bot never
pollutes your `cmd`, `engineering`, or other target folders:

- **In-bound:** attach a file to a message — the bot downloads it to `<bot>/data/transfer/<projectId>/attachments/`
  and appends `[attached: <path>]` to the prompt so the agent can read it. (Limit: Discord's 25MB file cap.)
- **Out-bound:** the agent writes files to `<project>/.bot-commandcode/out/` (a symlink to
  `<bot>/data/transfer/<projectId>/out/`); the bot attaches them mid-turn and on the finalizing message, dedup'd by
  content hash so the same file is never re-sent in a channel.

## How it works

Three parts:

1. **Discord bot** (`bot/`) — owns the chat UI: messages, streaming, buttons, slash commands.
2. **Relay** (`bot/relay.ts`) — spawns `cmd -p --output-format json` and parses its NDJSON event stream into
   messages/buttons, serialized one turn per channel.
3. **Command Code mod** (`mods/relay.ts`) — intercepts `ask_user_question` so questions surface in Discord as buttons
   instead of auto-answering; also detects out-file writes for mid-turn uploads.

The mod is passed to every `cmd` spawn automatically — no manual install needed.

## Testing

The manual acceptance-criteria walkthrough lives in `TESTING.md`. Baseline sanity check:

```bash
cmd -p "say hello" --output-format json
```

## License

MIT — see [LICENSE](LICENSE).
