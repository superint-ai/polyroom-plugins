import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';

export const settingsFile = (projectDir) => join(projectDir, '.claude', 'settings.local.json');

export function allowRuleFor(toolName, toolInput) {
  if (toolName !== 'Bash') return { refused: 'tool' };
  const command = typeof toolInput?.command === 'string' ? toolInput.command.trim() : '';
  if (!command) return { refused: 'empty' };
  if (/[\r\n]/.test(command)) return { refused: 'multiline' };
  if (command.includes('*')) return { refused: 'wildcard' };
  if (/[;&|`]|[$<>]\(/.test(command)) return { refused: 'compound' };
  return { rule: `Bash(${command})` };
}

function readSettings(projectDir) {
  const file = settingsFile(projectDir);
  if (!existsSync(file)) return {};
  const settings = JSON.parse(readFileSync(file, 'utf8'));
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) throw new Error(`${file} does not hold a JSON object`);
  return settings;
}

function writeSettings(projectDir, settings) {
  const file = settingsFile(projectDir);
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`);
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

const allowList = (settings) => Array.isArray(settings.permissions?.allow) ? settings.permissions.allow : [];

export function hasAllowRule(projectDir, rule) {
  try { return allowList(readSettings(projectDir)).includes(rule); }
  catch { return false; }
}

export function addAllowRule(projectDir, rule) {
  const settings = readSettings(projectDir);
  const allow = allowList(settings);
  if (allow.includes(rule)) return { added: false };
  const permissions = settings.permissions !== null && typeof settings.permissions === 'object' && !Array.isArray(settings.permissions) ? settings.permissions : {};
  writeSettings(projectDir, { ...settings, permissions: { ...permissions, allow: [...allow, rule] } });
  return { added: true };
}

export function removeAllowRule(projectDir, rule) {
  const settings = readSettings(projectDir);
  const allow = allowList(settings);
  if (!allow.includes(rule)) return { removed: false };
  writeSettings(projectDir, { ...settings, permissions: { ...settings.permissions, allow: allow.filter((entry) => entry !== rule) } });
  return { removed: true };
}
