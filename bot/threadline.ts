import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Per-channel "throughline" memory — a compact rolling context block that survives
 * compaction and session forks. Each entry is a short plain-text summary of what the
 * channel's project conversation is about, what's been decided, and what's next.
 *
 * The bot injects it as a preamble on every turn, so the model keeps the throughline
 * even when the underlying cmd session has been compacted or forked into fresh context.
 */

export interface Throughline {
  /** Short plain-text summary; kept small (a few sentences) so it stays cheap. */
  summary: string;
  /** Unix ms of the last update. */
  updatedAt: number;
}

const DATA_DIR = resolve(process.cwd(), 'data');
const FILE = resolve(DATA_DIR, 'threadlines.json');

/** Bound on stored summary length — long enough for a real throughline, short enough to stay cheap. */
export const SUMMARY_LIMIT = 800;

function readAll(): Record<string, Throughline> {
  try {
    return JSON.parse(readFileSync(FILE, 'utf8')) as Record<string, Throughline>;
  } catch {
    return {};
  }
}

function writeAll(all: Record<string, Throughline>): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify(all, null, 2));
}

/** Load the throughline for a channel (re-read each call so CLI edits are picked up). */
export function loadThroughline(channelId: string): Throughline | undefined {
  return readAll()[channelId];
}

/** Save the throughline for a channel. */
export function saveThroughline(channelId: string, summary: string): void {
  const all = readAll();
  all[channelId] = { summary: summary.slice(0, SUMMARY_LIMIT), updatedAt: Date.now() };
  writeAll(all);
}

/** Clear the throughline for a channel (used by /clear). */
export function clearThroughline(channelId: string): void {
  const all = readAll();
  if (!(channelId in all)) return;
  delete all[channelId];
  writeAll(all);
}

/**
 * Build the throughline block injected ahead of a prompt. Returns an empty string when
 * the channel has no throughline yet, so a fresh channel pays nothing.
 */
export function throughlinePreamble(channelId: string): string {
  const t = loadThroughline(channelId);
  if (!t?.summary) return '';
  return `[Project conversation so far: ${t.summary}]`;
}

/** Load just the summary text for a channel (empty string when absent). */
export function loadThroughlineSummary(channelId: string): string {
  return loadThroughline(channelId)?.summary ?? '';
}

/**
 * Roll a completed exchange into the rolling throughline. Keeps the tail of the summary
 * (the oldest context, what the project conversation is fundamentally about) plus the
 * newest exchange — the "what's next" — and stays under SUMMARY_LIMIT. This is a cheap
 * structural compaction, not a model summary: the full fidelity lives in the cmd session
 * transcript, which fast compaction preserves.
 */
export function compactThroughline(prev: string, prompt: string, finalText: string): string {
  const exchange = `Latest: asked "${trimTo(prompt, 120)}" → ${trimTo(finalText, 300)}`;
  const head = prev ? `${trimTo(prev, SUMMARY_LIMIT - exchange.length - 40)}\n` : '';
  return `${head}${exchange}`.slice(0, SUMMARY_LIMIT);
}

function trimTo(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}
