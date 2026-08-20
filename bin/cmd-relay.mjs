#!/usr/bin/env node
/**
 * cmd-relay CLI — manage projects, channel bindings, and the PM2 service.
 *
 *   cmd-relay projects add <id> --dir <path> [--model m] [--max-turns n] [--tools a,b] [--config k=v ...] [--permission-mode default|auto-accept|bypass]
 *   cmd-relay projects list
 *   cmd-relay projects rm <id>
 *   cmd-relay bind <channelId> <projectId>
 *   cmd-relay unbind <channelId>
 *   cmd-relay pm2 start|stop|status|logs
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = resolve(ROOT, 'data');
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

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

async function projectsAdd() {
  const id = args[1];
  if (!id) fail('usage: cmd-relay projects add <id> --dir <path> [--model m] [--max-turns n] [--tools a,b] [--config k=v ...] [--resume <sessionId>] [--no-channel]');
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

  const projects = await readJson(PROJECTS_FILE, {});
  if (projects[id]) fail(`project already exists: ${id}`);
  projects[id] = opts;
  await writeJson(PROJECTS_FILE, projects);
  console.log(`✓ project ${id} -> ${opts.dir}`);

  if (!noChannel) {
    // Ask the running bot to create a channel named after the folder.
    const port = process.env.RELAY_PORT ?? '8787';
    try {
      const res = await fetch(`http://127.0.0.1:${port}/create-channel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: channelName ?? id, reason: `cmd-relay project ${id}` }),
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
    console.error('✗ --no-channel given but --resume needs a channel to seed; bind one manually then `cmd-relay resume <channelId> <sessionId>`');
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
  if (!id) fail('usage: cmd-relay projects rm <id>');
  const projects = await readJson(PROJECTS_FILE, {});
  if (!projects[id]) fail(`no such project: ${id}`);
  delete projects[id];
  await writeJson(PROJECTS_FILE, projects);
  console.log(`✓ removed project ${id}`);
}

async function bind() {
  const [channelId, projectId] = args;
  if (!channelId || !projectId) fail('usage: cmd-relay bind <channelId> <projectId>');
  const projects = await readJson(PROJECTS_FILE, {});
  if (!projects[projectId]) fail(`no such project: ${projectId} (add it first)`);
  const bindings = await readJson(BINDINGS_FILE, {});
  bindings[channelId] = projectId;
  await writeJson(BINDINGS_FILE, bindings);
  console.log(`✓ channel ${channelId} -> ${projectId}`);
}

async function unbind() {
  const [channelId] = args;
  if (!channelId) fail('usage: cmd-relay unbind <channelId>');
  const bindings = await readJson(BINDINGS_FILE, {});
  if (!bindings[channelId]) fail(`no binding for channel ${channelId}`);
  delete bindings[channelId];
  await writeJson(BINDINGS_FILE, bindings);
  console.log(`✓ unbound channel ${channelId}`);
}

async function pm2Start() {
  const { execSync } = await import('node:child_process');
  try {
    execSync('pm2 -v', { stdio: 'ignore' });
  } catch {
    fail('pm2 not installed — run `npm i -g pm2` first');
  }
  execSync(
    `pm2 start "${resolve(ROOT, 'bot/index.ts')}" --name cmd-relay --interpreter "${resolve(ROOT, 'node_modules/.bin/tsx')}" --restart-delay 3000`,
    { stdio: 'inherit', cwd: ROOT },
  );
  console.log('✓ pm2 started cmd-relay (see `cmd-relay pm2 status`)');
}

async function pm2Stop() {
  const { execSync } = await import('node:child_process');
  execSync('pm2 stop cmd-relay', { stdio: 'inherit' });
}

async function pm2Status() {
  const { execSync } = await import('node:child_process');
  execSync('pm2 status cmd-relay', { stdio: 'inherit' });
}

async function pm2Logs() {
  const { execSync } = await import('node:child_process');
  execSync('pm2 logs cmd-relay', { stdio: 'inherit' });
}

async function main() {
  if (cmd === 'projects' && args[0] === 'add') await projectsAdd();
  else if (cmd === 'projects' && args[0] === 'list') await projectsList();
  else if (cmd === 'projects' && args[0] === 'rm') await projectsRm();
  else if (cmd === 'bind') await bind();
  else if (cmd === 'unbind') await unbind();
  else if (cmd === 'pm2' && args[0] === 'start') await pm2Start();
  else if (cmd === 'pm2' && args[0] === 'stop') await pm2Stop();
  else if (cmd === 'pm2' && args[0] === 'status') await pm2Status();
  else if (cmd === 'pm2' && args[0] === 'logs') await pm2Logs();
  else {
    console.log(`Usage:
  cmd-relay projects add <id> --dir <path> [--model m] [--max-turns n] [--tools a,b] [--config k=v ...] [--permission-mode default|auto-accept|bypass]
  cmd-relay projects list
  cmd-relay projects rm <id>
  cmd-relay bind <channelId> <projectId>
  cmd-relay unbind <channelId>
  cmd-relay pm2 start|stop|status|logs`);
    process.exit(1);
  }
}

main().catch((e) => fail(e.message));
