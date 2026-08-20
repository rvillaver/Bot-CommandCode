import { spawn } from 'node:child_process';
import readline from 'node:readline';
import type { Config } from './config.js';
import type { ProjectConfig } from './store.js';

export interface RunOptions {
  /** Prompt text (passed as -p argument, never stdin per SPEC §1 gotcha 5). */
  prompt: string;
  /** The project this turn runs in — provides cwd + per-project cmd flags. */
  project: ProjectConfig;
  /** Resume a prior session by id; omit for a fresh session. */
  resumeSessionId?: string;
  /** Fork the resumed session into a new one (fresh context, original preserved). */
  fork?: boolean;
}

export interface RunResult {
  sessionId?: string;
  stopReason?: string;
  finalText: string;
  durationMs?: number;
}

export type RelayEvent =
  | { type: 'event'; event: Record<string, unknown> }
  | { type: 'result'; subtype: string; sessionId?: string; stopReason?: string; finalText: string; durationMs?: number };

export interface RelayCallbacks {
  /** One NDJSON line, parsed. */
  onLine: (line: RelayEvent) => void;
  /** Captured stderr (kept ~2000 chars tail). */
  onStderr?: (tail: string) => void;
  /** Process exited. exitCode 0 + result line = success; else error path. */
  onExit: (info: { exitCode: number | null; gotResult: boolean; stderrTail: string }) => void;
}

export interface RunHandle {
  /** Kill the turn's whole process group (child + any tool subprocesses). */
  kill: () => void;
  /** True once kill() has been called — lets the caller distinguish stop from crash. */
  killed: () => boolean;
}

/**
 * Spawn `cmd -p <prompt> --output-format json ...` and stream its NDJSON stdout
 * line by line (never buffering the whole stream, per SPEC §5.3).
 */
export function runCmd(config: Config, opts: RunOptions, cb: RelayCallbacks): RunHandle {
  const args = [
    '-p', opts.prompt,
    '--output-format', 'json',
    // Safety: default mode (ask for anything mutating) instead of --yolo. Deny rules in
    // .commandcode/settings.json still win; per-project permissionMode can opt into
    // auto-accept or bypass for trusted workspaces.
    '--permission-mode', opts.project.permissionMode ?? 'default',
    '--skip-onboarding',
    '--tools-enable', 'ask_user_question',
    '--verbose',
    // Fast tiered compaction: long sessions compress into a summary that persists
    // across resumes, instead of re-hydrating the whole raw transcript every turn.
    '--config', 'compact-mode=fast',
    '--mod', modPath(),
    ...(opts.resumeSessionId ? ['--resume', opts.resumeSessionId] : []),
    ...(opts.resumeSessionId && opts.fork ? ['--fork-session'] : []),
    // Per-project flags
    ...(opts.project.model ? ['--model', opts.project.model] : []),
    ...(opts.project.maxTurns !== undefined ? ['--max-turns', String(opts.project.maxTurns)] : []),
    ...(opts.project.tools?.length ? ['--tools-enable', opts.project.tools.join(',')] : []),
    ...(opts.project.config ? Object.entries(opts.project.config).flatMap(([k, v]) => ['--config', `${k}=${v}`]) : []),
  ];

  // detached: the child leads its own process group, so /stop can kill the whole
  // group (child + tool subprocesses) rather than just the direct child.
  const child = spawn(config.cmdBinary, args, {
    cwd: opts.project.dir,
    env: process.env,
    detached: true,
  });

  let gotResult = false;
  let stderrTail = '';
  let killed = false;

  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (raw) => {
    if (!raw.trim()) return;
    try {
      const parsed = JSON.parse(raw) as RelayEvent;
      if (parsed.type === 'result') gotResult = true;
      cb.onLine(parsed);
    } catch {
      // Non-JSON line on stdout — ignore (forward-compatible).
    }
  });

  child.stderr.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-2000);
  });

  child.on('close', (code) => {
    cb.onExit({ exitCode: code, gotResult, stderrTail });
    if (stderrTail && cb.onStderr) cb.onStderr(stderrTail);
  });

  return {
    kill: () => {
      killed = true;
      if (child.pid === undefined) return;
      try {
        // Negative pid = the whole process group (detached: true made the child a leader).
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // Already gone — fine.
      }
    },
    killed: () => killed,
  };
}

function modPath(): string {
  // Resolve to an absolute path — the bot may spawn cmd with a different cwd (SPEC §4).
  return new URL('../mods/relay.ts', import.meta.url).pathname;
}
