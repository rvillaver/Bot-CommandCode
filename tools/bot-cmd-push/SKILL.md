---
name: bot-cmd-push
description: Push status updates and interactive questions from any local process or subagent into a running bot-commandcode Discord bot thread. Use when you need to notify a user in Discord, or ask them a question and block for the answer, from a script, background job, CI pipeline, or another agent.
argument-hint: "push <message> | ask <question> <option1> [option2] ..."
---

# bot-cmd-push — push updates & questions to a Discord bot thread

**What it is**: a zero-dependency CLI (Node only) that POSTs to the bot-commandcode bot's local HTTP bridge at
`127.0.0.1:8787/push`. No `cmd` session and no global install needed — the CLI is bundled in this skill's
`scripts/` directory and invoked with `node`.

**When to use it** (as an AI agent inside `cmd`):

| Need | Command | Blocks? |
|------|---------|---------|
| One-way status update to Discord | `push "Build complete"` | No |
| Ask user a question, get answer back | `ask "Deploy?" "yes" "no"` | Yes (up to 5 min) |

> This is NOT the built-in `ask_user_question` tool (which goes through cmd's mod system). Use `bot-cmd-push`
> when you need to communicate with the user while NOT in a `cmd` session — a subagent shell-out, a background
> build, or a CI/CD script.

## How to invoke

The CLI lives at `${COMMANDCODE_SKILL_DIR}/scripts/cli.mjs`. Run it with node:

```bash
node "${COMMANDCODE_SKILL_DIR}/scripts/cli.mjs" push "Build #42 complete — 12 tests passed."
node "${COMMANDCODE_SKILL_DIR}/scripts/cli.mjs" ask "Deploy to production?" "yes" "no" "later"
```

Both sub-commands default the target directory to the current working directory (`pwd`) and respect `RELAY_PORT`
(default 8787). Override the target with `--channel <id>`, `--project <id>`, or `--dir <path>`:

```bash
node "${COMMANDCODE_SKILL_DIR}/scripts/cli.mjs" push --dir /path/to/project "Deploy started"
```

<!-- MCP_SECTION_START -->
## MCP path (in-cmd agents)

The bot also serves an MCP endpoint at `http://127.0.0.1:8787/mcp` (same bridge, same port). It is already
registered in this project (`cmd mcp list` to confirm).

Then inside a `cmd` session the tools appear alongside built-ins and are gateable by cmd's permission rules
(`allow`/`deny`/`ask` on `mcp__bot-cmd-push__*`):

| Tool | What it does |
|------|-------------|
| `mcp__bot-cmd-push__push_message` | Post a message into the channel bound to a dir/project |
| `mcp__bot-cmd-push__ask_question` | Post a button question and return the user's chosen label |
| `mcp__bot-cmd-push__start_turn` | Launch a `cmd` turn in a Discord channel; streams live to Discord. Mirrors a user prompt |
| `mcp__bot-cmd-push__stop_turn` | Hard-stop the running `cmd` turn for a channel. Mirrors `/stop` |
| `mcp__bot-cmd-push__status_turn` | Show session id, queue length, and current state for a channel. Mirrors `/status` |
| `mcp__bot-cmd-push__list_projects` | List registered projects + bound channels |

The director tools (`start_turn`/`stop_turn`/`status_turn`) let an agent running *inside* a `cmd` turn manage turns in
*other* Discord channels — useful for an agent that wants to spawn sub-tasks or check on a parallel channel. All
three accept `dir`, `projectId`, or `channelId` for channel resolution (same as CLI push/ask).

**Prefer MCP when the caller is a `cmd` agent** (structured calls, permission-gated). Use the CLI below when the
caller is a script, cron job, or CI pipeline (any local process, no session needed).
<!-- MCP_SECTION_END -->

## Channel resolution

The bot maps a directory to a Discord channel via its stored bindings:

```
pwd → data/projects.json (dir → project ID) → data/bindings.json (project ID → channel ID) → Discord channel
```

Run from within the project directory and it Just Works. If the dir isn't a registered project, the CLI prints a
clear error telling you to register it (`bot-commandcode projects add <id> --dir <path>`).

## `push` — one-way message

```bash
node "${COMMANDCODE_SKILL_DIR}/scripts/cli.mjs" push "Build #42 complete — 12 tests passed."
```

**Result**: the message appears in the Discord channel bound to the current directory. No response needed. The CLI
exits immediately after the bridge acknowledges.

If the bot isn't running, you'll see:
```
✗ Can't reach bot-commandcode bot bridge at 127.0.0.1:8787.
  Is the bot running? Start it with: npm run botcmd:start
```

## `ask` — two-way question with callback

```bash
node "${COMMANDCODE_SKILL_DIR}/scripts/cli.mjs" ask "Deploy to production?" "yes" "no" "later"
```

**The full flow (request-response):**

1. You run the CLI as a subprocess
2. The CLI starts a **local HTTP server** on a random port (the callback)
3. The CLI POSTs `{ dir, question: {text, options}, callback: "http://127.0.0.1:<port>/answer" }` to the bot's `/push`
   endpoint
4. The bot renders **Discord buttons** in the channel bound to your `pwd`
5. The **user clicks a button** in Discord
6. The bot POSTs `{ answer: "yes" }` to the CLI's callback URL
7. The CLI prints the answer to **stdout** and exits 0

**Read the answer from stdout** — the command's output is the clicked option label (e.g. `yes`).

**Timeout**: 5 minutes. If the user doesn't click, the CLI prints `✗ timed out waiting for answer` and exits 1. The
Discord buttons expire after 10 minutes (clicking shows "This question has expired").

### As an AI agent: how to invoke

When you need to ask the user something and block for their answer, shell out to the CLI and read stdout:

```bash
ANSWER=$(node "${COMMANDCODE_SKILL_DIR}/scripts/cli.mjs" ask "Pick a color" "red" "green" "blue")
# $ANSWER = "red"  (the user's chosen option)
```

### Error cases

| Scenario | CLI behavior |
|----------|-------------|
| Bot not running | `✗ Can't reach bot-commandcode bot bridge at 127.0.0.1:8787.` + exit 1 |
| Dir not a registered project | `✗ bridge returned 422: no channel bound for dir ...` + exit 1 |
| Question expired (10 min) | Discord button click → ephemeral "This question has expired." |
| Callback POST failed (CLI killed) | Discord: ephemeral "Callback failed: ..." |
| Unknown command | Help text + exit 1 |

## Prerequisites

- **Node.js ≥ 20** on the machine running the CLI.
- The **bot-commandcode bot running** on the same machine (`npm run botcmd:start`), with the bridge bound to
  `127.0.0.1:8787` (override with `RELAY_PORT`).
- The current directory (or `--dir`/`--project` target) must be a **registered project** with a bound Discord
  channel (`bot-commandcode projects add <id> --dir <path>`).

## Installing this skill into a project

This skill ships as a folder. To install it into a target project (e.g. one you want external workloads to be able
to push from):

```bash
# From this repo:
node tools/bot-cmd-push/install.mjs /path/to/target/project
```

This copies the skill folder into `<target>/.commandcode/skills/bot-cmd-push/`, where Command Code discovers it
automatically (`/skills` to confirm, or `cmd skills list`). Alternatively, copy the folder manually, or install via
`cmd skills add` from a hosted copy of this repo.
