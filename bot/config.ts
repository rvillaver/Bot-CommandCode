import 'dotenv/config';

export interface Config {
  discordToken: string;
  relayPort: number;
  projectDir: string;
  allowedChannelIds: string[];
  commandPrefix: string;
  cmdBinary: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`
✗ Missing required environment variable: ${name}

To set up the bot-commandcode bot:

1. Copy the example env file:
     cp .env.example .env

2. Create a Discord application and bot token:
   - Go to https://discord.com/developers/applications
   - New Application → name it → Create
   - Bot tab → Reset Token → copy the token (starts with MT...)
   - Enable the MESSAGE CONTENT INTENT (Privileged Gateway Intents)

3. Paste the token into .env:
     DISCORD_TOKEN=<your-token>

4. Add the bot to a server:
   - OAuth2 → URL Generator → scopes: bot + applications.commands
   - Bot permissions: Send Messages, Embed Links, Read Message History,
     Add Reactions, Use Slash Commands
   - Open the generated URL → pick a server → Authorize

5. Start the bot:
     npm run bot        # or: npm start  (pm2-managed)

Full setup guide: see the README (Discord setup section).
`);
    process.exit(1);
  }
  return value;
}

export function loadConfig(): Config {
  return {
    discordToken: requireEnv('DISCORD_TOKEN'),
    relayPort: Number(process.env.RELAY_PORT ?? '8787'),
    // Legacy single-project dir — optional; the project registry (data/projects.json)
    // is the source of truth for which folders the bot drives.
    projectDir: process.env.PROJECT_DIR ?? '',
    allowedChannelIds: (process.env.ALLOWED_CHANNEL_IDS ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
    commandPrefix: process.env.COMMAND_PREFIX ?? '',
    cmdBinary: process.env.CMD_BINARY ?? 'cmd',
  };
}
