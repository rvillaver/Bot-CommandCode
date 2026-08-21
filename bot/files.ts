import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, basename, resolve } from 'node:path';
import type { Message, Attachment } from 'discord.js';

/**
 * Transfer files live in the bot's own runtime space (gitignored), NOT inside the
 * bound project repos — so starting cmd-remote never pollutes the target folders.
 *
 *   <bot-root>/data/transfer/<projectId>/attachments   in-bound Discord attachments
 *   <bot-root>/data/transfer/<projectId>/out           agent's out drop-point
 *
 * The project keeps a `.bot-commandcode/out` symlink → the real out dir, so the agent can
 * still write to a path inside its workspace (mod checks resolve to the same place).
 */
const POSTED_CAP = 100;
/** Discord attachment limit (standard tier). Files over this are never uploaded. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** Resolve the transfer root at call time so tests (and cwd changes) are honored. */
function transferRoot(): string {
  return resolve(process.cwd(), 'data', 'transfer');
}

/** Absolute path to a project's real transfer dir. */
function transferDir(projectId: string): string {
  return resolve(transferRoot(), projectId);
}

/** Where in-bound attachments land, per project. */
export function attachDir(projectId: string): string {
  return join(transferDir(projectId), 'attachments');
}

/** Where the agent drops files to send back, per project. */
export function outDir(projectId: string): string {
  return join(transferDir(projectId), 'out');
}

/** The in-project symlink path the agent writes to (relative to the project dir). */
export const OUT_LINK = '.bot-commandcode/out';

export interface DownloadedAttachment {
  /** Absolute path the file was saved to. */
  path: string;
  name: string;
}

/**
 * Download a Discord attachment into <transferDir>/<projectId>/attachments.
 * Discord file limit is 25MB (25 * 1024 * 1024 bytes); Nitro raises it, but the
 * standard limit is the safe cap for saving + re-uploading.
 */
export async function downloadAttachment(projectId: string, attachment: Attachment): Promise<DownloadedAttachment> {
  if (attachment.size > 25 * 1024 * 1024) {
    throw new Error(`Attachment ${attachment.name} is too large (${(attachment.size / 1024 / 1024).toFixed(1)}MB > 25MB)`);
  }
  const dir = attachDir(projectId);
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, sanitizeFilename(attachment.name));
  const res = await fetch(attachment.url);
  if (!res.ok) throw new Error(`Failed to download ${attachment.name}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf);
  return { path: dest, name: attachment.name };
}

/**
 * Ensure the project's out drop-point exists: the real dir under data/transfer, plus a
 * `.bot-commandcode/out` symlink inside the project pointing at it (so the agent can write to
 * a workspace path). Recreates the symlink if it's missing or dangling.
 */
export function ensureOutDir(projectId: string, projectDir: string): void {
  const real = outDir(projectId);
  mkdirSync(real, { recursive: true });
  const link = resolve(projectDir, OUT_LINK);
  try {
    if (existsSync(link) && lstatSync(link).isSymbolicLink() && realpathSync(link) === real) {
      return; // already correct
    }
    if (existsSync(link)) {
      rmSync(link, { recursive: true, force: true }); // stale real dir or wrong symlink
    }
  } catch {
    // not a symlink or unreadable — replace below
  }
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(real, link, 'dir');
}

/**
 * Collect files the agent wrote to the project's out dir for sending back.
 * Reads the real transfer dir (resolves through any symlink).
 */
export function collectOutFiles(projectId: string): { name: string; path: string }[] {
  const dir = outDir(projectId);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return []; // no out dir yet
  }
  return entries
    .filter((f) => !f.startsWith('.'))
    .map((f) => ({ name: f, path: join(dir, f) }));
}

/** Discord-safe filename: keep alnum, dot, dash, underscore; collapse spaces. */
function sanitizeFilename(name: string): string {
  return basename(name).replace(/[^a-zA-Z0-9._-]+/g, '_');
}

/**
 * sha256 of a file's bytes — the dedup key. Content-based, so editing a file changes the
 * key (re-sends) but re-posting identical bytes never re-sends.
 */
export function hashFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * Posted-files registry: channelId → { fileKey → { name, postedAt } }.
 * Persisted to data/posted-files.json (gitignored). Bounded per channel.
 */
type PostedRegistry = Record<string, Record<string, { name: string; postedAt: number }>>;

/** Resolve the posted-files registry path at call time (tests change cwd). */
function postedFile(): string {
  return resolve(process.cwd(), 'data', 'posted-files.json');
}

function readPosted(): PostedRegistry {
  try {
    return JSON.parse(readFileSync(postedFile(), 'utf8')) as PostedRegistry;
  } catch {
    return {};
  }
}

function writePosted(all: PostedRegistry): void {
  mkdirSync(dirname(postedFile()), { recursive: true });
  writeFileSync(postedFile(), JSON.stringify(all, null, 2));
}

/** True if this exact file content was already posted in this channel. */
export function alreadyPosted(channelId: string, filePath: string): boolean {
  const all = readPosted();
  const key = hashFile(filePath);
  return Boolean(all[channelId]?.[key]);
}

/** Record that a file was posted in a channel (dedup key = content hash). */
export function markPosted(channelId: string, filePath: string, name: string): void {
  const all = readPosted();
  const byChannel = all[channelId] ?? {};
  byChannel[hashFile(filePath)] = { name, postedAt: Date.now() };
  // Evict oldest beyond the cap.
  const keys = Object.keys(byChannel);
  if (keys.length > POSTED_CAP) {
    for (const k of keys.slice(0, keys.length - POSTED_CAP)) delete byChannel[k];
  }
  all[channelId] = byChannel;
  writePosted(all);
}

/** Forget every file posted in a channel (used by /clear and channel-delete). */
export function clearPosted(channelId: string): void {
  const all = readPosted();
  if (!all[channelId]) return;
  delete all[channelId];
  writePosted(all);
}

export type { Message };
