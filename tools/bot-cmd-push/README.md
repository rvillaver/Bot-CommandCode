# bot-cmd-push

A tiny zero-dependency CLI for pushing updates and questions from any local process into a running **bot-commandcode** Discord bot thread.

No `cmd` invocation needed — external workloads (CI scripts, build pipelines, monitoring tools, shell loops) can POST directly to the bot's local HTTP bridge.

## Install

```bash
# from the bot-commandcode repo root:
npm i -g . -w tools/bot-cmd-push
# or:
npm i -g /path/to/bot-commandcode/tools/bot-cmd-push
# or just link for local use:
npm link /path/to/bot-commandcode/tools/bot-cmd-push
```

## Usage

From within a **project directory** that the bot knows about (`bot-commandcode projects add`), the working directory is used to find the channel automatically:

```bash
cd /Users/rv/work/my-project
bot-cmd-push push "Build complete — 12 tests passed."
```

From anywhere, target a specific channel, project, or directory:

```bash
bot-cmd-push push --channel 123456789 "Deploy staging?"
bot-cmd-push push --project my-server "Artifact v1.2.3 ready."
bot-cmd-push push --dir /path/to/project "Progress: 42%"
```

### Options

| Flag | Default | Description |
|------|---------|-------------|
| `--channel <id>` | — | Discord channel ID to post to directly |
| `--project <id>` | — | Project ID (looked up via bindings) |
| `--dir <path>` | `pwd` | Directory (matched against project dirs to find the channel) |
| `--port <n>` | `8787` | Bridge port (env: `RELAY_PORT`) |
| `--host <addr>` | `127.0.0.1` | Bridge host (env: `RELAY_HOST`) |

## How channel resolution works

1. If `--channel` is given, that channel receives the message directly.
2. If `--project` is given, the bot looks up the project's bound Discord channel.
3. If neither is given (default), the bot matches `--dir` (defaults to your `pwd`) against
   each project's recorded `dir` in `data/projects.json`, then finds the bound channel.

## Asking questions (two-way)

Use `ask` to send a question with button options — the user picks a button in
Discord and the selected answer is returned to your workflow:

```bash
bot-cmd-push ask "Deploy to production?" "yes" "no" "later"
# → prints: yes
```

The bot renders the question as clickable buttons in the Discord channel. When
the user clicks one, their choice is POSTed back to a temporary callback server
that `bot-cmd-push` spins up on `127.0.0.1`. The CLI prints the answer and exits.

## Prerequisites

The bot-commandcode bot must be running (`npm run bot` or `npm run botcmd:start`) and the directory/project must have a channel bound via `bot-commandcode projects add <id> --dir <path>` (which auto-creates and binds a Discord channel).
