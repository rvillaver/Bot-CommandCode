import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** Read the last committed turn's input token count from a session transcript, if parseable. */
export function lastTurnInputTokens(projectDir: string, sessionId: string): number | undefined {
  const transcript = transcriptPath(projectDir, sessionId);
  if (!existsSync(transcript)) return undefined;
  try {
    const lines = readFileSync(transcript, 'utf8').split('\n');
    // Scan from the end for the last line carrying usage.inputTokens.
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line) continue;
      try {
        const entry = JSON.parse(line) as { usage?: { inputTokens?: number } };
        if (entry.usage?.inputTokens !== undefined) {
          return entry.usage.inputTokens;
        }
      } catch {
        // skip malformed lines (docs: torn files never block startup)
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Decide whether to resume a session or fork fresh, based on how expensive the last
 * committed turn was. Resuming re-sends the whole history, so past a threshold a fork
 * (fresh context) is cheaper and preserves the old session for later.
 */
export function shouldFork(projectDir: string, sessionId: string, threshold: number): boolean {
  const tokens = lastTurnInputTokens(projectDir, sessionId);
  if (tokens === undefined) return false;
  return tokens > threshold;
}

/** Absolute path to a session's transcript. */
export function transcriptPath(projectDir: string, sessionId: string): string {
  const slug = slugify(projectDir);
  return join(homedir(), '.commandcode', 'projects', slug, `${sessionId}.jsonl`);
}

/** Convert a project dir into the same slug cmd uses for its projects catalog. */
function slugify(dir: string): string {
  // cmd slugs the working directory: lowercase, non-alnum → dashes, trim dashes.
  return dir
    .replace(/^\/+|\/+$/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
