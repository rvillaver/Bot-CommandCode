# TESTING — acceptance-criteria walkthrough

Manual walkthrough of the bot-commandcode bot against the SPEC §9 acceptance criteria and the
features added after. Exercise the **real thing**: the running bot under pm2, driven from
Discord (DM or a bound channel). `tsc --noEmit` green is necessary, never sufficient.

## Setup

```bash
npm i
node bin/bot-commandcode.mjs pm2 start     # or: npm run bot
node bin/bot-commandcode.mjs projects list # confirm bound channels
```

Every test below happens in a bound Discord channel (or the bot's DM for owner commands).

## §9.1 Baseline sanity (no bot needed)

```bash
cmd -p "say hello" --output-format json
```
Expect: a `result` line with `subtype: success` and `finalText: hello`.

## §9.2 Streaming + finalize

Send in a bound channel: `what time is it` (or any prompt).

- Expect: text streams in as the answer is produced; a final message with the answer.
- Long answers (>1900 chars): ask for a long response — expect it split across messages
  with `(1/2)`, `(2/2)` markers, nothing truncated.

## §9.3 Question → buttons

Send: `ask me a multiple-choice question about project setup, then react to my answer`.

- Expect: the question appears with **one button per option**.
- Tap a button → the run continues with that answer; **buttons are disabled** after tap.
- Free-text fallback: instead of tapping, type an answer — expect `✅ Answer noted: "…"`
  and the run continues with it.
- Late answer: wait ~10 min, then tap → `⏳ Question expired`.

## §9.4 Session memory

Ask `what was the first thing I asked?` after a few turns.

- Expect: the bot (resuming the same session) answers from prior context.

## §9.5 Tool progress

Send: `run git status and summarize`.

- Expect: `🔧 …` line while a tool runs, then `✅ …` on completion, then the summary.
- A denied tool (e.g. `rm -rf /` under `default` mode) → `🚫 … denied`, turn continues
  with guidance, never executes.

## §9.6 Error path

- `/status` in an unbound channel → clean refusal.
- Trigger a failing turn (e.g. a prompt that makes cmd exit non-zero) → expect
  `⚠️ Turn failed (exit code N)` with a stderr codeblock.

## §9.7 /stop and /clear

- `/stop` during a long turn → turn killed, `⏹️ Stopped.`, next prompt starts clean.
- `/clear` → `✅ Session cleared`, next prompt starts fresh (old session preserved).
- `/status` → shows state (idle/running/queued), session id prefix, queue length, project.

## §9.8 Bot restart

Restart the bot (`node bin/bot-commandcode.mjs pm2 stop` then `start`).

- Expect: sessions reload (`Loaded N session(s)`), `/status` still shows the session,
  a follow-up prompt resumes context.

## File transfer

- **In-bound:** attach a file → bot downloads to `<bot>/data/transfer/<projectId>/attachments/`
  and the agent can read it (`[attached: …]`).
- **Out-bound:** ask the agent to write a file to `.bot-commandcode/out/` (the symlink) → the file
  appears as a Discord attachment, **once**. Ask again for the same file → not re-sent
  (`[dedup] skipping duplicate` in logs). Edit the file → re-sent (hash changed).
- **>25MB:** drop a >25MB file in `.bot-commandcode/out/` → bot logs `over 25MB — skipping`,
  no failed upload.

## DM control plane (owner only)

In the bot's DM:
- `projects list` → bound projects + channels.
- `projects add myproj --dir /path [--model m]` → creates a guild channel, binds it.
- `projects rm myproj` → deletes project + unbinds.
- Non-owner DM → `Only the server owner can manage projects from DM.`

## Delete cleanup

Delete a bound channel in Discord.

- Expect: bot kills any active run, deletes the project from the registry, clears the
  channel's session/throughline/posted-files state (`[channelDelete] …` in logs).

## MCP server & director control

The bot serves a JSON-RPC MCP server alongside the bridge on
`http://127.0.0.1:8787/mcp`. Director tools let an agent inside a `cmd` turn
manage cmd turns in other Discord channels. Register the server in a project:

```bash
cmd mcp add --transport http bot-cmd-push http://127.0.0.1:8787/mcp
```

### MCP server (no bot restart needed)

- `POST http://127.0.0.1:8787/mcp` with `{"jsonrpc":"2.0","id":1,"method":"initialize"}` →
  expect `protocolVersion`, `capabilities.tools`, `serverInfo.name: "bot-cmd-push"`.
- `tools/list` → expect all six tools: `push_message`, `ask_question`, `start_turn`,
  `stop_turn`, `status_turn`, `list_projects`.
- Unknown tool → `{"isError":true}` in the result, bot alive. Unknown route → 404, bot alive.

### §9.9 Director: start_turn → Discord streams

From inside a `cmd` turn in a bound project directory:

```bash
cmd mcp call mcp__bot-cmd-push__start_turn --arg prompt="Explain 2+2" --arg dir="$PWD"
```

- Expect: Discord channel bound to the project shows `▶️ Starting a cmd turn` and the
  answer streams in; `status_turn` shows `🔧 running`.

### §9.10 Director: stop_turn

While a turn is running, from a second `cmd` turn (or a direct MCP call):

```bash
cmd mcp call mcp__bot-cmd-push__stop_turn --arg dir="$PWD"
```

- Expect: cmd subprocess receives SIGTERM, Discord shows `⏹️ Stopped.`, `status_turn`
  shows `idle`.

### §9.11 Director: queueing during busy

With a turn running in the channel, call `start_turn` again:

- Expect: response is `Queued in <#channel> — resumes after the current turn.`,
  `status_turn` shows `Queue: 1`. After the running turn finishes, the queue drains
  automatically. After `stop_turn`, the queue is cleared.

### §9.12 MCP ask_question done-gate

```bash
cmd mcp call mcp__bot-cmd-push__ask_question --arg question="Pick a color" --arg options="red,blue" --arg dir="$PWD"
```

- Expect: Discord channel shows a question with one button per option; tapping a button
  resolves the blocking MCP call (returns the label). Closing the MCP client connection
  mid-wait cleans up the pending answer without crashing the bot.
