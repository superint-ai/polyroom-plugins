import { integer, text } from '../config.mjs';
import { enabledHookPlugins } from './plugin.mjs';

const numericVariables = [
  ['POLYROOM_PERMISSION_TIMEOUT_MS', 'timeoutMs', 1000, 86_400_000],
  ['POLYROOM_PERMISSION_RULE_TTL_MS', 'ruleTtlMs', 1000, 86_400_000],
  ['POLYROOM_PERMISSION_POLL_MS', 'pollMs', 100, 600_000],
  ['POLYROOM_PERMISSION_PREVIEW_MAX_CHARS', 'previewMaxChars', 100, 6000],
];

export function readPermissionConfig(env) {
  const flag = text(env, 'POLYROOM_PERMISSION_RELAY_ENABLED').toLowerCase();
  if (!flag || flag === 'false') return { enabled: false, problems: [] };
  if (flag !== 'true') return { enabled: false, problems: ['POLYROOM_PERMISSION_RELAY_ENABLED must be true or false in the apps/mcp-long-polling .env.'] };
  const problems = [];
  const config = {};
  for (const [name, key, min, max] of numericVariables) config[key] = integer(env, name, min, max, problems);
  if (problems.length) return { enabled: false, problems };
  const plugins = enabledHookPlugins(env);
  if (plugins.length) return { enabled: false, problems: [`POLYROOM_PERMISSION_RELAY_ENABLED is true, but the plugin ${plugins.join(' and ')} is installed and enabled for this Claude config, and its hook already sends the permission prompts of this session to the chat; the relay stays off so a prompt is not posted twice. Set POLYROOM_PERMISSION_RELAY_ENABLED=false in the apps/mcp-long-polling .env, or disable the plugin.`] };
  return { enabled: true, problems: [], config };
}
