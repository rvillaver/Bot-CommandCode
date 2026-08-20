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
    throw new Error(`Missing required env var ${name}. Copy .env.example to .env and fill it in.`);
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
