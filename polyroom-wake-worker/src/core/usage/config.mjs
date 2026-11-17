import { integer, text } from '../config.mjs';
import { parseLongPromptTiers } from './calls.mjs';

const usageNumbers = [
  ['POLYROOM_USAGE_REPORT_INTERVAL_MS', 'intervalMs', 1000, 86_400_000],
  ['POLYROOM_USAGE_REPORT_MAX_ROWS', 'maxRows', 1, 10_000],
  ['POLYROOM_USAGE_REPORT_TIMEOUT_MS', 'timeoutMs', 1000, 600_000],
  ['POLYROOM_USAGE_KEEP_HOURS', 'keepHours', 1, 8760],
  ['POLYROOM_USAGE_LINE_MAX_BYTES', 'lineMaxBytes', 1024, 536_870_912],
];

export const connections = ['subscription', 'api'];

export function usageUrl(mcpUrl) {
  const url = new URL(mcpUrl);
  url.pathname = url.pathname.replace(/\/mcp\/?$/, '/usage');
  return url.href;
}

export function readUsageConfig(env, { url, authorization, userAgent }) {
  const claudeDir = text(env, 'POLYROOM_USAGE_CLAUDE_DIR');
  const codexDir = text(env, 'POLYROOM_USAGE_CODEX_DIR');
  if (!claudeDir && !codexDir) return { enabled: false, problems: [] };
  const problems = [];
  const connection = text(env, 'POLYROOM_USAGE_CONNECTION');
  if (!connections.includes(connection)) problems.push(`POLYROOM_USAGE_CONNECTION must be ${connections.join(' or ')}.`);
  const longPromptTiers = parseLongPromptTiers(text(env, 'POLYROOM_USAGE_LONG_PROMPT_TIERS'));
  if (!longPromptTiers?.size) problems.push('POLYROOM_USAGE_LONG_PROMPT_TIERS must be a comma-separated list of model:tokens, for example claude-haiku-5-5:100000.');
  const sinceText = text(env, 'POLYROOM_USAGE_SINCE');
  const since = sinceText ? Date.parse(sinceText) : null;
  if (sinceText && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(sinceText) || Number.isNaN(since))) {
    problems.push('POLYROOM_USAGE_SINCE must be empty or an ISO date and time with the time zone, such as 2026-10-17T00:00:00-03:00.');
  }
  const config = { claudeDir, codexDir, connection, since, longPromptTiers, url: usageUrl(url), authorization, userAgent };
  for (const [name, key, min, max] of usageNumbers) config[key] = integer(env, name, min, max, problems);
  return problems.length ? { enabled: false, problems } : { enabled: true, config, problems };
}
