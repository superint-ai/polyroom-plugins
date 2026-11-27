import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { text } from '../config.mjs';

export const hookPluginIds = ['polyroom@superint'];

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function readObject(path) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    return isObject(value) ? value : null;
  } catch { return null; }
}

function installedFor(entries, projectDir) {
  if (!Array.isArray(entries)) return false;
  return entries.some((entry) => isObject(entry) && (entry.scope === 'user' || typeof entry.projectPath !== 'string' || resolve(entry.projectPath) === resolve(projectDir)));
}

function enabledIn(settings, id) {
  let enabled = true;
  for (const file of settings) {
    const value = isObject(file?.enabledPlugins) ? file.enabledPlugins[id] : undefined;
    if (typeof value === 'boolean') enabled = value;
  }
  return enabled;
}

export function enabledHookPlugins(env) {
  const configDir = text(env, 'CLAUDE_CONFIG_DIR') || join(homedir(), '.claude');
  const projectDir = text(env, 'CLAUDE_PROJECT_DIR') || process.cwd();
  const installed = readObject(join(configDir, 'plugins', 'installed_plugins.json'))?.plugins;
  const settings = [join(configDir, 'settings.json'), join(projectDir, '.claude', 'settings.json'), join(projectDir, '.claude', 'settings.local.json')].map(readObject);
  return hookPluginIds.filter((id) => isObject(installed) && installedFor(installed[id], projectDir) && enabledIn(settings, id));
}
