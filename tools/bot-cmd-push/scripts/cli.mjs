#!/usr/bin/env node
/**
 * bot-cmd-push — push messages and questions from any local process to a running
 * bot-commandcode bot on Discord. Zero dependencies (Node built-in http only).
 *
 * Usage:
 *   bot-cmd-push push "Build complete"
 *   bot-cmd-push push --channel <channelId> "Deploy staging?"
 *   bot-cmd-push push --project <projectId> "Artifact v1.2.3 ready"
 *   bot-cmd-push push --dir /path/to/project "Progress: 42%"
 *   bot-cmd-push ask "Deploy to production?" "yes" "no" "later"
 *
 * The working directory (pwd) is used by default to resolve the channel, so from
 * within a project folder you can just run `bot-cmd-push push "message"`.
 *
 * The bot bridge listens on 127.0.0.1:8787 by default. Override with --port or
 * the RELAY_PORT env var.
 */
import { createServer, request as httpRequest } from 'node:http';
import { argv, cwd, exit, env } from 'node:process';

function usage() {
  console.error('Usage:');
  console.error('  bot-cmd-push push <message>');
  console.error('  bot-cmd-push push --channel <id> <message>');
  console.error('  bot-cmd-push push --project <id> <message>');
  console.error('  bot-cmd-push push --dir <path> <message>');
  console.error('  bot-cmd-push ask <question> <option1> [option2] ...');
  console.error('');
  console.error('Options:');
  console.error('  --channel <id>   Discord channel ID to post to directly');
  console.error('  --project <id>   Project ID (looked up via bindings)');
  console.error('  --dir <path>     Directory (default: pwd)');
  console.error('  --port <n>       Bridge port (default: 8787, env: RELAY_PORT)');
  console.error('  --host <addr>    Bridge host (default: 127.0.0.1, env: RELAY_HOST)');
  console.error('');
  console.error('pwd is used as --dir by default.');
  exit(1);
}

const args = argv.slice(2);

if (args.length === 0) usage();

const cmd = args[0];
const rest = args.slice(1);

// Parse shared flags, collect positional args.
let channelId, projectId, dir = cwd(), portStr, host;
const positional = [];
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a === '--channel') channelId = rest[++i];
  else if (a === '--project') projectId = rest[++i];
  else if (a === '--dir') dir = rest[++i];
  else if (a === '--port') portStr = rest[++i];
  else if (a === '--host') host = rest[++i];
  else positional.push(a);
}

const bridgePort = portStr ?? env.RELAY_PORT ?? '8787';
const bridgeHost = host ?? env.RELAY_HOST ?? '127.0.0.1';

if (cmd === 'push') {
  if (positional.length === 0) usage();
  const message = positional.join(' ').trim();
  if (!message) usage();
  postPush(message);
} else if (cmd === 'ask') {
  if (positional.length < 2) usage();
  const questionText = positional[0];
  const options = positional.slice(1);
  ask(questionText, options);
} else {
  console.error(`Unknown command: ${cmd}`);
  usage();
}

function postPush(message) {
  const payload = JSON.stringify({
    ...(channelId ? { channelId } : {}),
    ...(projectId ? { projectId } : {}),
    dir,
    message,
  });
  const req = httpRequest(`http://${bridgeHost}:${bridgePort}/push`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
  }, (res) => {
    let data = '';
    res.on('data', (chunk) => data += chunk);
    res.on('end', () => {
      if (res.statusCode !== 200) {
        console.error(`✗ bridge returned ${res.statusCode}: ${data}`);
        exit(1);
      }
      try {
        const parsed = JSON.parse(data);
        if (parsed.ok) {
          console.log('✓ pushed to bot');
        } else {
          console.error(`✗ ${parsed.error ?? 'push failed'}`);
          exit(1);
        }
      } catch {
        console.log('✓ pushed to bot');
      }
    });
  });
  req.on('error', (e) => {
    console.error(`✗ Can't reach bot-commandcode bot bridge at ${bridgeHost}:${bridgePort}.`);
    console.error('  Is the bot running? Start it with: npm run botcmd:start');
    exit(1);
  });
  req.write(payload);
  req.end();
}

async function ask(questionText, options) {
  // Start a tiny local HTTP server to receive the answer via callback.
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

  console.log('⌛ waiting for answer…');

  // POST the question to the bot bridge with the callback URL.
  const payload = JSON.stringify({
    ...(channelId ? { channelId } : {}),
    ...(projectId ? { projectId } : {}),
    dir,
    question: { text: questionText, options: options.map((label) => ({ label })) },
    callback: `http://127.0.0.1:${callbackPort}/answer`,
  });

  try {
    const res = await fetch(`http://${bridgeHost}:${bridgePort}/push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      body: payload,
    });
    const data = await res.json();
    if (!data.ok) {
      console.error(`✗ ${data.error ?? 'ask failed'}`);
      server.close();
      exit(1);
    }
  } catch (e) {
    console.error(`✗ Can't reach bot-commandcode bot bridge at ${bridgeHost}:${bridgePort}.`);
    console.error('  Is the bot running? Start it with: npm run botcmd:start');
    server.close();
    exit(1);
  }

  // Wait for the answer (5 min timeout).
  const TIMEOUT_MS = 300000;
  const start = Date.now();
  while (!answerValue && Date.now() - start < TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, 100));
  }
  server.close();
  if (!answerValue) {
    console.error('✗ timed out waiting for answer');
    exit(1);
  }
  console.log(answerValue);
}
