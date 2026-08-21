#!/usr/bin/env node
/**
 * bot-commandcode CLI — manage projects, channel bindings, and the PM2 service.
 *
 *   bot-commandcode projects add <id> --dir <path> [--model m] [--max-turns n] [--tools a,b] [--config k=v ...] [--permission-mode default|auto-accept|plan|dont-ask|bypass] [--yolo]
 *   bot-commandcode projects list
 *   bot-commandcode projects rm <id>
 *   bot-commandcode bind <channelId> <projectId>
 *   bot-commandcode unbind <channelId>
 *   bot-commandcode pm2 start|stop|restart|status|logs
 *   bot-commandcode push [--channel ID | --project ID | --dir PATH] <message>
 *   bot-commandcode ask [--channel ID | --project ID | --dir PATH] <question> <option1> [option2]...
 *   bot-commandcode doctor
 *   bot-commandcode setup
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Allow tests to isolate the data dir (defaults to the repo's own data/).
const DATA_DIR = process.env.CMD_RELAY_DATA_DIR
  ? resolve(process.env.CMD_RELAY_DATA_DIR)
  : resolve(ROOT, 'data');
const PROJECTS_FILE = resolve(DATA_DIR, 'projects.json');
const BINDINGS_FILE = resolve(DATA_DIR, 'bindings.json');
const SESSIONS_FILE = resolve(DATA_DIR, 'sessions.json');

const [cmd, ...args] = process.argv.slice(2);

async function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(file, data) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

/**
 * Write a .commandcode/settings.json into a project dir with deny rules that
 * survive --yolo. The bot runs cmd with --yolo (bypass) for auto-accept/dont-ask/
 * bypass modes; deny rules are the backstop that still blocks destructive commands.
 * Never overwrites an existing settings.json (a project may already have rules).
 */
async function ensureDenyRules(projectDir) {
  const settingsDir = resolve(projectDir, '.commandcode');
  const settingsFile = resolve(settingsDir, 'settings.json');
  if (existsSync(settingsFile)) {
    console.log(`✓ .commandcode/settings.json already exists in ${projectDir} — leaving as-is`);
    return;
  }
  const rules = {
    permissions: {
      deny: [
        'Shell(rm -rf /)',
        'Shell(rm -rf ~)',
        'Shell(rm -rf $HOME)',
        'Shell(sudo *)',
        'Shell(git push --force*)',
        'Shell(git reset --hard*)',
        'Shell(git clean -*)',
        'Shell(:(){ :|:& };:)',
        'Shell(curl * | sh)',
        'Shell(curl * | bash)',
      ],
      ask: [
        'Shell(git push:*)',
        'Shell(git pull:*)',
      ],
      allow: [
        'Shell(git status:*)',
        'Shell(git log:*)',
        'Shell(git diff:*)',
      ],
    },
  };
  await mkdir(settingsDir, { recursive: true });
  await writeFile(settingsFile, JSON.stringify(rules, null, 2) + '\n', 'utf8');
  console.log(`✓ wrote deny rules to ${settingsFile}`);
}

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

async function projectsAdd() {
  const id = args[1];
  if (!id) fail('usage: bot-commandcode projects add <id> --dir <path> [--model m] [--max-turns n] [--tools a,b] [--config k=v ...] [--resume <sessionId>] [--no-channel]');
  const opts = {};
  let noChannel = false;
  let resumeSessionId;
  let channelName;
  for (let i = 2; i < args.length; i++) {
    if (args[i] === '--dir') opts.dir = args[++i];
    else if (args[i] === '--model') opts.model = args[++i];
    else if (args[i] === '--max-turns') opts.maxTurns = Number(args[++i]);
    else if (args[i] === '--tools') opts.tools = args[++i].split(',');
    else if (args[i] === '--permission-mode') opts.permissionMode = args[++i];
    else if (args[i] === '--yolo') opts.permissionMode = 'bypass'; // alias: bypass the write gate
    else if (args[i] === '--config') {
      opts.config = opts.config ?? {};
      const [k, v] = args[++i].split('=');
      opts.config[k] = v;
    } else if (args[i] === '--resume') resumeSessionId = args[++i];
    else if (args[i] === '--channel-name') channelName = args[++i];
    else if (args[i] === '--no-channel') noChannel = true;
  }
  if (!opts.dir) fail('--dir is required');
  if (!existsSync(opts.dir)) fail(`directory does not exist: ${opts.dir}`);
  // Normalize legacy aliases (cmd accepts these spellings too).
  const MODE_ALIASES = {
    manual: 'default',
    standard: 'default',
    acceptEdits: 'auto-accept',
    dontAsk: 'dont-ask',
    bypassPermissions: 'bypass',
  };
  if (opts.permissionMode && MODE_ALIASES[opts.permissionMode]) {
    opts.permissionMode = MODE_ALIASES[opts.permissionMode];
  }
  const VALID_MODES = ['default', 'auto-accept', 'plan', 'dont-ask', 'bypass'];
  if (opts.permissionMode && !VALID_MODES.includes(opts.permissionMode)) {
    fail(`invalid --permission-mode: ${opts.permissionMode}. Allowed: ${VALID_MODES.join('|')}`);
  }

  const projects = await readJson(PROJECTS_FILE, {});
  if (projects[id]) fail(`project already exists: ${id}`);
  projects[id] = opts;
  await writeJson(PROJECTS_FILE, projects);
  console.log(`✓ project ${id} -> ${opts.dir}`);
  await ensureDenyRules(opts.dir);

  if (!noChannel) {
    // Ask the running bot to create a channel named after the folder.
    const port = process.env.RELAY_PORT ?? '8787';
    try {
      const res = await fetch(`http://127.0.0.1:${port}/create-channel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: channelName ?? id, reason: `bot-commandcode project ${id}` }),
      });
      const data = await res.json();
      if (data.ok) {
        console.log(`✓ channel #${data.channelName} (${data.channelId})`);
        // Auto-bind the new channel to this project.
        const bindings = await readJson(BINDINGS_FILE, {});
        bindings[data.channelId] = id;
        await writeJson(BINDINGS_FILE, bindings);
        console.log(`✓ bound #${data.channelName} -> ${id}`);

        // If --resume was given, seed the channel's session id now that we know the channel.
        if (resumeSessionId) {
          const sessions = await readJson(SESSIONS_FILE, {});
          sessions[data.channelId] = resumeSessionId;
          await writeJson(SESSIONS_FILE, sessions);
          console.log(`✓ seeded session ${resumeSessionId.slice(0, 8)}… for #${data.channelName}`);
        }
      } else {
        console.error(`✗ channel creation failed: ${data.error}`);
      }
    } catch (e) {
      console.error(`✗ bot bridge unreachable at 127.0.0.1:${port} (is the bot running?) — channel not created: ${e.message}`);
    }
  } else if (resumeSessionId) {
    console.error('✗ --no-channel given but --resume needs a channel to seed; bind one manually then `bot-commandcode resume <channelId> <sessionId>`');
  }
}

async function projectsList() {
  const projects = await readJson(PROJECTS_FILE, {});
  const ids = Object.keys(projects);
  if (ids.length === 0) {
    console.log('(no projects)');
    return;
  }
  for (const id of ids) {
    const p = projects[id];
    console.log(`${id}\t${p.dir}${p.model ? `\tmodel=${p.model}` : ''}${p.maxTurns ? `\tmax-turns=${p.maxTurns}` : ''}`);
  }
}

async function projectsRm() {
  const id = args[1];
  if (!id) fail('usage: bot-commandcode projects rm <id>');
  const projects = await readJson(PROJECTS_FILE, {});
  if (!projects[id]) fail(`no such project: ${id}`);
  delete projects[id];
  await writeJson(PROJECTS_FILE, projects);
  console.log(`✓ removed project ${id}`);
}

async function bind() {
  const [channelId, projectId] = args;
  if (!channelId || !projectId) fail('usage: bot-commandcode bind <channelId> <projectId>');
  const projects = await readJson(PROJECTS_FILE, {});
  if (!projects[projectId]) fail(`no such project: ${projectId} (add it first)`);
  const bindings = await readJson(BINDINGS_FILE, {});
  bindings[channelId] = projectId;
  await writeJson(BINDINGS_FILE, bindings);
  console.log(`✓ channel ${channelId} -> ${projectId}`);
}

async function unbind() {
  const [channelId] = args;
  if (!channelId) fail('usage: bot-commandcode unbind <channelId>');
  const bindings = await readJson(BINDINGS_FILE, {});
  if (!bindings[channelId]) fail(`no binding for channel ${channelId}`);
  delete bindings[channelId];
  await writeJson(BINDINGS_FILE, bindings);
  console.log(`✓ unbound channel ${channelId}`);
}

async function pm2Start() {
  const { execSync } = await import('node:child_process');
  let pm2Available = true;
  try {
    execSync('pm2 -v', { stdio: 'ignore' });
  } catch {
    pm2Available = false;
  }

  if (!pm2Available) {
    console.error('✗ pm2 is not installed.');
    console.error('');
    console.error('  bot-commandcode runs as a resilient service under PM2 (auto-restart on crash).');
    console.error('  Options:');
    console.error('');
    console.error('    [1]  npm i -g pm2   — install pm2 globally, then retry');
    console.error('    [2]  npm run bot    — run the bot in the foreground (no auto-restart)');
    console.error('');
    const { createInterface } = await import('node:readline');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((resolve) => rl.question('Choose [1/2]: ', resolve));
    rl.close();
    if (answer.trim() === '1') {
      console.log('Installing pm2 globally…');
      execSync('npm i -g pm2', { stdio: 'inherit' });
      console.log('✓ pm2 installed. Starting bot-commandcode…');
    } else if (answer.trim() === '2') {
      console.log('Starting bot in the foreground (Ctrl+C to stop)…');
      execSync('npx tsx bot/index.ts', { stdio: 'inherit', cwd: ROOT });
      return;
    } else {
      fail('aborted — no action taken');
    }
  }

  execSync(
    `pm2 start "${resolve(ROOT, 'bot/index.ts')}" --name bot-commandcode --interpreter "${resolve(ROOT, 'node_modules/.bin/tsx')}" --restart-delay 3000`,
    { stdio: 'inherit', cwd: ROOT },
  );
  console.log('✓ pm2 started bot-commandcode (see `bot-commandcode pm2 status`)');
}

async function pm2Stop() {
  const { execSync } = await import('node:child_process');
  execSync('pm2 stop bot-commandcode', { stdio: 'inherit' });
}

async function pm2Restart() {
  const { execSync } = await import('node:child_process');
  execSync('pm2 restart bot-commandcode', { stdio: 'inherit' });
  console.log('✓ pm2 restarted bot-commandcode');
}

async function pm2Status() {
  const { execSync } = await import('node:child_process');
  execSync('pm2 status bot-commandcode', { stdio: 'inherit' });
}

async function pm2Logs() {
  const { execSync } = await import('node:child_process');
  execSync('pm2 logs bot-commandcode', { stdio: 'inherit' });
}

async function push() {
  // Parse: push [--channel ID | --project ID | --dir PATH] <message...>
  let channelId, projectId, dir = process.cwd(), message = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--channel') channelId = args[++i];
    else if (args[i] === '--project') projectId = args[++i];
    else if (args[i] === '--dir') dir = args[++i];
    else message += (message ? ' ' : '') + args[i];
  }
  if (!message) fail('usage: bot-commandcode push [--channel ID | --project ID | --dir PATH] <message>');
  message = message.trim();

  const port = process.env.RELAY_PORT ?? '8787';
  const host = process.env.RELAY_HOST ?? '127.0.0.1';
  try {
    const res = await fetch(`http://${host}:${port}/push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channelId, projectId, dir, message }),
    });
    const data = await res.json();
    if (data.ok) {
      console.log('✓ pushed to bot');
    } else {
      console.error(`✗ ${data.error ?? 'push failed'}`);
      process.exit(1);
    }
  } catch (e) {
    console.error(`✗ bot bridge unreachable at ${host}:${port} (is the bot running? \`npm run bot\` or \`npm run botcmd:start\`) — ${e.message}`);
    process.exit(1);
  }
}

async function ask() {
  // Parse: ask [--channel ID | --project ID | --dir PATH] <question> <option1> [option2] ...
  let channelId, projectId, dir = process.cwd(), question = '', options = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--channel') channelId = args[++i];
    else if (args[i] === '--project') projectId = args[++i];
    else if (args[i] === '--dir') dir = args[++i];
    else if (!question) question = args[i];
    else options.push(args[i]);
  }
  if (!question || options.length === 0) fail('usage: bot-commandcode ask [--channel ID | --project ID | --dir PATH] <question> <option1> [option2] ...');

  // Start a tiny local HTTP server to receive the answer via callback.
  const { createServer } = await import('node:http');
  let answerValue = null;
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/answer') {
      let body = '';
      req.on('data', (c) => body += c);
      req.on('end', () => {
        try { answerValue = JSON.parse(body).answer; } catch {}
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    } else {
      res.writeHead(404); res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const callbackPort = server.address().port;

  const bridgePort = process.env.RELAY_PORT ?? '8787';
  try {
    const res = await fetch(`http://127.0.0.1:${bridgePort}/push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        channelId, projectId, dir,
        question: { text: question, options: options.map((label) => ({ label })) },
        callback: `http://127.0.0.1:${callbackPort}/answer`,
      }),
    });
    const data = await res.json();
    if (!data.ok) { console.error(`✗ ${data.error ?? 'ask failed'}`); process.exit(1); }
  } catch (e) {
    console.error(`✗ bot bridge unreachable at 127.0.0.1:${bridgePort} (is the bot running? \`npm run bot\` or \`npm run botcmd:start\`) — ${e.message}`);
    server.close();
    process.exit(1);
  }

  console.log('⌛ waiting for answer…');
  const TIMEOUT_MS = 300000;
  const start = Date.now();
  while (!answerValue && Date.now() - start < TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, 100));
  }
  server.close();
  if (!answerValue) { console.error('✗ timed out waiting for answer'); process.exit(1); }
  console.log(answerValue);
}

async function doctor() {
  const { execSync } = await import('node:child_process');
  const checks = [];

  // Node version
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  checks.push({
    name: 'Node.js >= 20',
    ok: nodeMajor >= 20,
    detail: `v${process.versions.node}`,
  });

  // cmd binary
  try {
    const v = execSync('cmd --version 2>&1', { encoding: 'utf8' }).trim().split('\n')[0];
    checks.push({ name: 'cmd CLI', ok: true, detail: v });
  } catch {
    checks.push({ name: 'cmd CLI', ok: false, detail: 'not found — run `npm i -g command-code`' });
  }

  // pm2
  try {
    execSync('pm2 -v', { stdio: 'ignore' });
    checks.push({ name: 'pm2', ok: true, detail: 'installed' });
  } catch {
    checks.push({ name: 'pm2', ok: false, detail: 'not found — `npm i -g pm2` (or use `npm run bot`)' });
  }

  // .env + DISCORD_TOKEN
  const envFile = resolve(ROOT, '.env');
  const token = process.env.DISCORD_TOKEN;
  if (!existsSync(envFile)) {
    checks.push({ name: '.env file', ok: false, detail: 'missing — run `cp .env.example .env`' });
  } else {
    checks.push({ name: '.env file', ok: true, detail: 'present' });
  }
  if (!token) {
    checks.push({ name: 'DISCORD_TOKEN', ok: false, detail: 'missing — add it to .env (see README Discord setup)' });
  } else {
    checks.push({ name: 'DISCORD_TOKEN', ok: true, detail: 'set' });
  }

  // Bridge reachable?
  const port = process.env.RELAY_PORT ?? '8787';
  let bridgeOk = false;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '' }), // will 400 but proves reachability
    });
    bridgeOk = res.status === 400 || res.status === 200;
  } catch { bridgeOk = false; }
  checks.push({
    name: `Bot bridge (127.0.0.1:${port})`,
    ok: bridgeOk,
    detail: bridgeOk ? 'reachable' : 'not running — `npm run botcmd:start`',
  });

  const failures = checks.filter((c) => !c.ok).length;
  for (const c of checks) {
    console.log(`${c.ok ? '✓' : '✗'} ${c.name} — ${c.detail}`);
  }
  console.log('');
  if (failures > 0) {
    console.log(`${failures} issue(s) found. Fix them, then re-run \`bot-commandcode doctor\`.`);
    process.exit(1);
  }
  console.log('All checks passed. Bot is ready to run.');
}

async function setup() {
  console.log('bot-commandcode setup — walkthrough\n');
  console.log('To get the bot running, you need four things:\n');
  console.log('1. Node.js >= 20    → https://nodejs.org');
  console.log('2. cmd CLI          → `npm i -g command-code`, then `cmd login`');
  console.log('3. A Discord bot token → https://discord.com/developers/applications');
  console.log('   - New Application → Bot → Reset Token');
  console.log('   - Enable MESSAGE CONTENT INTENT (Privileged Gateway Intents)');
  console.log('4. Add the bot to a server');
  console.log('   - OAuth2 → URL Generator → scopes: bot + applications.commands');
  console.log('   - Bot permissions: Send Messages, Embed Links, Read Message History,');
  console.log('     Add Reactions, Use Slash Commands\n');
  console.log('Then:\n');
  console.log('  cp .env.example .env');
  console.log('  # paste your token as DISCORD_TOKEN=...\n');
  console.log('  npm run botcmd:start    # or: npm run bot (foreground)\n');
  console.log('After the bot is online, register a project:\n');
  console.log('  botcmd projects add myproject --dir /path/to/folder\n');
  console.log('Run `botcmd doctor` to check your setup at any time.');
}

async function main() {
  if (cmd === 'projects' && args[0] === 'add') await projectsAdd();
  else if (cmd === 'projects' && args[0] === 'list') await projectsList();
  else if (cmd === 'projects' && args[0] === 'rm') await projectsRm();
  else if (cmd === 'bind') await bind();
  else if (cmd === 'unbind') await unbind();
  else if (cmd === 'pm2' && args[0] === 'start') await pm2Start();
  else if (cmd === 'pm2' && args[0] === 'stop') await pm2Stop();
  else if (cmd === 'pm2' && args[0] === 'restart') await pm2Restart();
  else if (cmd === 'pm2' && args[0] === 'status') await pm2Status();
  else if (cmd === 'pm2' && args[0] === 'logs') await pm2Logs();
  else if (cmd === 'push') await push();
  else if (cmd === 'ask') await ask();
  else if (cmd === 'doctor') await doctor();
  else if (cmd === 'setup') await setup();
  else {
    console.log(`Usage:
  bot-commandcode projects add <id> --dir <path> [--model m] [--max-turns n] [--tools a,b] [--config k=v ...] [--permission-mode default|auto-accept|plan|dont-ask|bypass] [--yolo]
  bot-commandcode projects list
  bot-commandcode projects rm <id>
  bot-commandcode bind <channelId> <projectId>
  bot-commandcode unbind <channelId>
  bot-commandcode pm2 start|stop|restart|status|logs
  bot-commandcode push [--channel ID | --project ID | --dir PATH] <message>
  bot-commandcode ask [--channel ID | --project ID | --dir PATH] <question> <option1> [option2]...
  bot-commandcode doctor
  bot-commandcode setup`);
    process.exit(1);
  }
}

main().catch((e) => fail(e.message));
