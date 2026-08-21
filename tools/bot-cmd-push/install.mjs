#!/usr/bin/env node
/**
 * bot-cmd-push installer — copy the skill (SKILL.md + scripts/cli.mjs) into a
 * target project's .commandcode/skills/ so Command Code discovers it there,
 * and (optionally) register the bot's MCP endpoint in that project.
 *
 * Usage:
 *   node tools/bot-cmd-push/install.mjs /path/to/target/project [--mcp]
 *
 * Installs to: <target>/.commandcode/skills/bot-cmd-push/
 * --mcp also runs `cmd mcp add --transport http bot-cmd-push http://127.0.0.1:8787/mcp`
 * Optionally pass --global to install to ~/.commandcode/skills/ instead.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { argv, exit } from 'node:process';
import { execSync } from 'node:child_process';

const SELF = dirname(fileURLToPath(import.meta.url));
const SKILL_NAME = 'bot-cmd-push';

const args = argv.slice(2);
let globalInstall = false;
let withMcp = false;
let target;

for (const a of args) {
  if (a === '--global' || a === '-g') globalInstall = true;
  else if (a === '--mcp') withMcp = true;
  else target = a;
}

if (!target) {
  console.error('usage: node tools/bot-cmd-push/install.mjs <target-project-dir> [--global] [--mcp]');
  console.error('  installs the bot-cmd-push skill into <target>/.commandcode/skills/');
  console.error('  --mcp also registers the bot MCP server in the target project');
  exit(1);
}

const targetDir = globalInstall
  ? resolve(homedir(), '.commandcode', 'skills')
  : resolve(target, '.commandcode', 'skills');

const dest = resolve(targetDir, SKILL_NAME);

if (existsSync(dest)) {
  console.error(`✗ ${SKILL_NAME} already exists at ${dest}`);
  console.error('  Remove it first, or copy the folder manually to overwrite.');
  exit(1);
}

mkdirSync(targetDir, { recursive: true });

// Copy SKILL.md + scripts/cli.mjs (skip install.mjs — it's the installer, not part of the skill).
for (const rel of ['SKILL.md', 'scripts/cli.mjs']) {
  const src = resolve(SELF, rel);
  if (!existsSync(src)) {
    console.error(`✗ missing bundled file: ${src}`);
    exit(1);
  }
  cpSync(src, resolve(dest, rel), { recursive: false });
}

// Tailor the installed SKILL.md: drop the MCP section when MCP wasn't registered,
// so the destination agent only sees the path that actually works in this project.
if (!withMcp) {
  const installed = resolve(dest, 'SKILL.md');
  const full = readFileSync(installed, 'utf8');
  const startMarker = '<!-- MCP_SECTION_START -->';
  const endMarker = '<!-- MCP_SECTION_END -->';
  const start = full.indexOf(startMarker);
  const end = full.indexOf(endMarker);
  if (start !== -1 && end !== -1 && end > start) {
    const tailored = full.slice(0, start) + full.slice(end + endMarker.length);
    writeFileSync(installed, tailored, 'utf8');
    console.log('✓ MCP section removed from installed SKILL.md (no --mcp)');
  }
}

console.log(`✓ installed ${SKILL_NAME} skill → ${dest}`);
console.log('');
console.log('To confirm, run in the target project:');
console.log(`  cmd skills list`);
console.log('Then invoke it with:');
console.log(`  /${SKILL_NAME} push "hello"   (or: node "${dest}/scripts/cli.mjs" push "hello")`);

if (withMcp) {
  console.log('');
  console.log('Registering the bot MCP endpoint in the target project…');
  try {
    const out = execSync(
      `cmd mcp add --transport http bot-cmd-push http://127.0.0.1:8787/mcp`,
      { encoding: 'utf8', cwd: target },
    );
    console.log(out.trim());
    console.log('✓ MCP server registered. Tools available in-cmd as mcp__bot-cmd-push__*');
  } catch (e) {
    console.error(`✗ failed to register MCP server: ${e instanceof Error ? e.message : String(e)}`);
    console.error('  Is cmd installed and the bot bridge running on 127.0.0.1:8787?');
  }
}
