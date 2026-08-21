import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Channel, DMChannel, TextChannel } from 'discord.js';
import { ChannelType } from 'discord.js';

export type PermissionMode = 'default' | 'auto-accept' | 'plan' | 'dont-ask' | 'bypass';

/** Modes that require --yolo to bypass the print-mode write gate. */
export const YOLO_MODES: PermissionMode[] = ['auto-accept', 'dont-ask', 'bypass'];

export interface ProjectConfig {
  dir: string;
  model?: string;
  maxTurns?: number;
  tools?: string[];
  config?: Record<string, string>;
  /** Permission mode for this project's cmd spawns. */
  permissionMode?: PermissionMode;
}

export interface Store {
  projects: Record<string, ProjectConfig>;
  bindings: Record<string, string>;
}

/** Resolve the data dir at call time so tests (and cwd changes) are honored. */
function dataDir(): string {
  return resolve(process.cwd(), 'data');
}

function projectsFile(): string {
  return resolve(dataDir(), 'projects.json');
}

function bindingsFile(): string {
  return resolve(dataDir(), 'bindings.json');
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, data: unknown): void {
  mkdirSync(dataDir(), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

/** Load project registry + channel bindings fresh on each call (CLI writes them at runtime). */
export function loadStore(): Store {
  return {
    projects: readJson(projectsFile(), {}),
    bindings: readJson(bindingsFile(), {}),
  };
}

/** Resolve a channel id to its bound project config, or undefined if unbound. */
export function projectForChannel(store: Store, channelId: string): ProjectConfig | undefined {
  const projectId = store.bindings[channelId];
  if (!projectId) return undefined;
  return store.projects[projectId];
}

/** Resolve a channel id to its bound project id, or undefined if unbound. */
export function projectIdForChannel(store: Store, channelId: string): string | undefined {
  return store.bindings[channelId];
}

/** Add or update a project in the registry. Returns the project id. */
export function saveProject(id: string, cfg: ProjectConfig): void {
  const projects = readJson<Record<string, ProjectConfig>>(projectsFile(), {});
  projects[id] = cfg;
  writeJson(projectsFile(), projects);
}

/** Delete a project from the registry and unbind every channel bound to it. Returns removed project ids. */
export function deleteProject(id: string): string[] {
  const projects = readJson<Record<string, ProjectConfig>>(projectsFile(), {});
  if (!(id in projects)) return [];
  delete projects[id];
  writeJson(projectsFile(), projects);
  return unbindProject(id);
}

/** Remove every channel binding pointing at a project. Returns the unbound channel ids. */
export function unbindProject(id: string): string[] {
  const bindings = readJson<Record<string, string>>(bindingsFile(), {});
  const removed: string[] = [];
  for (const [channelId, projectId] of Object.entries(bindings)) {
    if (projectId === id) {
      delete bindings[channelId];
      removed.push(channelId);
    }
  }
  if (removed.length > 0) writeJson(bindingsFile(), bindings);
  return removed;
}

/** Remove a single channel binding. Returns the project id that was bound, or undefined. */
export function unbindChannel(channelId: string): string | undefined {
  const bindings = readJson<Record<string, string>>(bindingsFile(), {});
  const projectId = bindings[channelId];
  if (!projectId) return undefined;
  delete bindings[channelId];
  writeJson(bindingsFile(), bindings);
  return projectId;
}

/** True when the message came from a DM to the bot (not a guild channel). */
export function isDMChannel(channel: Channel): channel is DMChannel {
  return channel.type === ChannelType.DM;
}

export type { TextChannel };
