import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Channel, DMChannel, TextChannel } from 'discord.js';
import { ChannelType } from 'discord.js';

export interface ProjectConfig {
  dir: string;
  model?: string;
  maxTurns?: number;
  tools?: string[];
  config?: Record<string, string>;
  /** Permission mode for this project's spawns: default | auto-accept | bypass. Defaults to default. */
  permissionMode?: 'default' | 'auto-accept' | 'bypass';
}

export interface Store {
  projects: Record<string, ProjectConfig>;
  bindings: Record<string, string>;
}

const DATA_DIR = resolve(process.cwd(), 'data');
const PROJECTS_FILE = resolve(DATA_DIR, 'projects.json');
const BINDINGS_FILE = resolve(DATA_DIR, 'bindings.json');

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, data: unknown): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

/** Load project registry + channel bindings fresh on each call (CLI writes them at runtime). */
export function loadStore(): Store {
  return {
    projects: readJson(PROJECTS_FILE, {}),
    bindings: readJson(BINDINGS_FILE, {}),
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
  const projects = readJson<Record<string, ProjectConfig>>(PROJECTS_FILE, {});
  projects[id] = cfg;
  writeJson(PROJECTS_FILE, projects);
}

/** Delete a project from the registry and unbind every channel bound to it. Returns removed project ids. */
export function deleteProject(id: string): string[] {
  const projects = readJson<Record<string, ProjectConfig>>(PROJECTS_FILE, {});
  if (!(id in projects)) return [];
  delete projects[id];
  writeJson(PROJECTS_FILE, projects);
  return unbindProject(id);
}

/** Remove every channel binding pointing at a project. Returns the unbound channel ids. */
export function unbindProject(id: string): string[] {
  const bindings = readJson<Record<string, string>>(BINDINGS_FILE, {});
  const removed: string[] = [];
  for (const [channelId, projectId] of Object.entries(bindings)) {
    if (projectId === id) {
      delete bindings[channelId];
      removed.push(channelId);
    }
  }
  if (removed.length > 0) writeJson(BINDINGS_FILE, bindings);
  return removed;
}

/** Remove a single channel binding. Returns the project id that was bound, or undefined. */
export function unbindChannel(channelId: string): string | undefined {
  const bindings = readJson<Record<string, string>>(BINDINGS_FILE, {});
  const projectId = bindings[channelId];
  if (!projectId) return undefined;
  delete bindings[channelId];
  writeJson(BINDINGS_FILE, bindings);
  return projectId;
}

/** True when the message came from a DM to the bot (not a guild channel). */
export function isDMChannel(channel: Channel): channel is DMChannel {
  return channel.type === ChannelType.DM;
}

export type { TextChannel };
