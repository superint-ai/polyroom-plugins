import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { parseEnv } from 'node:util';
import { integer, numericVariable, text } from '../../core/config.mjs';
import { WorkerProblems, workerDataDirectory } from '../codex/config.mjs';
import { pickName, polyroomName } from '../server-name.mjs';
import { wakeBatchVariables } from '../wake-adapter.mjs';

export const openClawServerVariable = 'POLYROOM_OPENCLAW_MCP_SERVER_NAME';

export const openClawNumericVariables = [
  ...wakeBatchVariables,
  ['POLYROOM_OPENCLAW_HOOK_TIMEOUT_MS', 'hookTimeoutMs', 1000, 600_000],
  ['POLYROOM_OPENCLAW_STATUS_INTERVAL_MS', 'statusIntervalMs', 100, 60_000],
  ['POLYROOM_OPENCLAW_LOG_MAX_BYTES', 'logMaxBytes', 1024, 1_073_741_824],
  numericVariable('POLYROOM_WRITE_RETRY_ATTEMPTS'),
  numericVariable('POLYROOM_WRITE_RETRY_MS'),
];

const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);
const namePattern = /^[A-Za-z0-9_-]{1,64}$/;
const isExample = (value) => /[<>]/.test(value);

function hookUrl(env, problems) {
  const value = text(env, 'POLYROOM_OPENCLAW_HOOK_URL');
  if (!value) { problems.push('POLYROOM_OPENCLAW_HOOK_URL must be set in the apps/mcp-long-polling .env.'); return null; }
  let parsed;
  try { parsed = new URL(value); } catch { problems.push('POLYROOM_OPENCLAW_HOOK_URL must be a valid URL.'); return null; }
  if (parsed.protocol !== 'http:' || !loopbackHosts.has(parsed.hostname)) {
    problems.push('POLYROOM_OPENCLAW_HOOK_URL must be http on this machine (127.0.0.1, localhost or [::1]): the worker never sends the hook token outside it.');
    return null;
  }
  if (!parsed.pathname.endsWith('/wake')) problems.push('POLYROOM_OPENCLAW_HOOK_URL must end in /wake, the OpenClaw wake hook (for example http://127.0.0.1:18789/hooks/wake).');
  return parsed.href;
}

export function readOpenClawSettings(env) {
  const problems = [];
  const home = text(env, 'POLYROOM_OPENCLAW_HOME') || text(env, 'OPENCLAW_STATE_DIR') || join(homedir(), '.openclaw');
  if (isExample(home) || !isAbsolute(home)) problems.push('POLYROOM_OPENCLAW_HOME must be the absolute path of the OpenClaw state folder, or empty for OPENCLAW_STATE_DIR and then ~/.openclaw.');
  const configFile = text(env, 'OPENCLAW_CONFIG_PATH') || join(home, 'openclaw.json');
  if (!isAbsolute(configFile)) problems.push('OPENCLAW_CONFIG_PATH must be an absolute path when it is set.');
  const serverName = text(env, openClawServerVariable) || null;
  if (serverName && !namePattern.test(serverName)) problems.push(`${openClawServerVariable} must be the name of the polyroom MCP server in OpenClaw (letters, digits, - and _), or empty to find polyroom in the OpenClaw configuration.`);
  const agentId = text(env, 'POLYROOM_OPENCLAW_AGENT_ID');
  if (!namePattern.test(agentId)) problems.push('POLYROOM_OPENCLAW_AGENT_ID must be the OpenClaw agent id that receives the wakes (letters, digits, - and _).');
  const hookToken = text(env, 'POLYROOM_OPENCLAW_HOOK_TOKEN');
  if (hookToken && (isExample(hookToken) || /\s/.test(hookToken))) problems.push('POLYROOM_OPENCLAW_HOOK_TOKEN still has an example value or has spaces.');
  const userAgent = text(env, 'POLYROOM_OPENCLAW_USER_AGENT');
  if (!userAgent) problems.push('POLYROOM_OPENCLAW_USER_AGENT must be set in the apps/mcp-long-polling .env.');
  const settings = { home, configFile, serverName, agentId, hookToken, userAgent, hookUrl: hookUrl(env, problems), dataDirectory: workerDataDirectory(env) };
  for (const [name, key, min, max] of openClawNumericVariables) settings[key] = integer(env, name, min, max, problems);
  if (problems.length) throw new WorkerProblems(problems);
  settings.writeRetry = { attempts: settings.writeRetryAttempts, retryMs: settings.writeRetryMs };
  return settings;
}

function readEnvFile(file) {
  let content;
  try { content = readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw new WorkerProblems([`The OpenClaw environment file ${file} could not be read (${error.code ?? error.name}).`]); }
  return parseEnv(content);
}

const filled = (value) => typeof value === 'string' && value.trim() ? value.trim() : null;

export function conflictingReferences(value, env, dotEnv) {
  const names = [...value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((match) => match[1]);
  return [...new Set(names)].filter((name) => filled(env[name]) && filled(dotEnv[name]) && filled(env[name]) !== filled(dotEnv[name]));
}

export function expandReferences(value, sources) {
  const missing = [];
  const expanded = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (reference, name) => {
    const found = sources.map((source) => source[name]).find((candidate) => typeof candidate === 'string' && candidate.trim());
    if (found === undefined) { missing.push(name); return reference; }
    return found.trim();
  });
  return { expanded, missing };
}

const saveCommand = (name) => `openclaw config set mcp.servers.${name} '<server configuration>' --strict-json`;

export function readOpenClawIdentity(settings, env) {
  const { configFile } = settings;
  let content;
  try { content = readFileSync(configFile, 'utf8'); }
  catch (error) {
    throw new WorkerProblems([error.code === 'ENOENT'
      ? `There is no OpenClaw configuration at ${configFile}. Set POLYROOM_OPENCLAW_HOME, or save the polyroom server with ${saveCommand(polyroomName)}, as the Connect screen of the agent explains.`
      : `The OpenClaw configuration ${configFile} could not be read (${error.code ?? error.name}).`]);
  }
  let config;
  try { config = JSON.parse(content); }
  catch {
    throw new WorkerProblems([`The OpenClaw configuration ${configFile} is not plain JSON. The worker reads the file that openclaw config set writes; a file edited by hand with comments or JSON5 syntax is refused.`]);
  }
  const servers = config?.mcp?.servers !== null && typeof config?.mcp?.servers === 'object' ? config.mcp.servers : {};
  const server = pickName({
    configured: settings.serverName,
    present: (name) => Object.hasOwn(servers, name),
    missing: (first) => `The OpenClaw configuration has no MCP server "${first}". Save it with ${saveCommand(first)}, as the Connect screen of the agent explains.`,
  });
  const serverName = server.name;
  const fix = `Save it with ${saveCommand(serverName)}, as the Connect screen of the agent explains.`;
  const entry = servers[serverName];
  if (!entry || typeof entry !== 'object') throw new WorkerProblems([`The OpenClaw configuration has no MCP server "${serverName}". ${fix}`]);
  const problems = [];
  if (entry.enabled === false) problems.push(`The MCP server "${serverName}" is disabled in OpenClaw.`);
  if (typeof entry.url !== 'string' || !entry.url) problems.push(`The MCP server "${serverName}" must be remote (url), not a local command.`);
  if (entry.transport !== 'streamable-http') problems.push(`The MCP server "${serverName}" must use transport streamable-http.`);
  if (entry.auth === 'oauth') problems.push(`The MCP server "${serverName}" uses OAuth; the polyroom bot address takes only the bot token in the Authorization header.`);
  const header = Object.entries(entry.headers ?? {}).find(([name]) => name.toLowerCase() === 'authorization')?.[1];
  if (typeof header !== 'string') problems.push(`The MCP server "${serverName}" must have the header Authorization: Bearer <bot token>.`);
  if (problems.length) throw new WorkerProblems(problems);
  const dotEnvFile = join(settings.home, '.env');
  const dotEnv = readEnvFile(dotEnvFile);
  const conflicts = [...new Set([...conflictingReferences(entry.url, env, dotEnv), ...conflictingReferences(header, env, dotEnv)])];
  if (conflicts.length) {
    throw new WorkerProblems([`${conflicts.join(', ')} has one value in the environment of the worker and another in ${dotEnvFile}. A Gateway started as a service usually sees only ${dotEnvFile}, so the worker and the Gateway would act as different bots. Remove the variable from the environment of the worker, or make both values equal.`]);
  }
  const sources = [env, dotEnv];
  const url = expandReferences(entry.url, sources);
  const authorization = expandReferences(header, sources);
  const missing = [...new Set([...url.missing, ...authorization.missing])];
  if (missing.length) throw new WorkerProblems([`The OpenClaw configuration refers to ${missing.map((name) => `\${${name}}`).join(', ')}, which is not in ${dotEnvFile} nor in the environment.`]);
  if (!/^Bearer\s+\S+$/i.test(authorization.expanded)) throw new WorkerProblems([`The Authorization header of the MCP server "${serverName}" must be Bearer <bot token>.`]);
  const hookToken = configuredHookToken(config, sources, env, dotEnv, dotEnvFile, { required: !settings.hookToken });
  checkHooks(config, settings);
  return { url: url.expanded, authorization: authorization.expanded, settings: { hookToken: settings.hookToken || hookToken, serverName, serverSource: server.source } };
}

function checkHooks(config, settings) {
  const hooks = config?.hooks !== null && typeof config?.hooks === 'object' ? config.hooks : {};
  const problems = [];
  if (hooks.enabled !== true) problems.push('The OpenClaw hooks are off: run openclaw config set hooks.enabled true.');
  const path = typeof hooks.path === 'string' && hooks.path.trim() ? hooks.path.trim().replace(/\/+$/, '') : '/hooks';
  const expected = `${path}/wake`;
  if (new URL(settings.hookUrl).pathname !== expected) problems.push(`POLYROOM_OPENCLAW_HOOK_URL must end in ${expected}, the wake hook under hooks.path of the OpenClaw configuration.`);
  if (Array.isArray(hooks.allowedAgentIds) && !hooks.allowedAgentIds.includes(settings.agentId)) {
    problems.push(`hooks.allowedAgentIds of the OpenClaw configuration does not list "${settings.agentId}" (POLYROOM_OPENCLAW_AGENT_ID): add it with openclaw config set hooks.allowedAgentIds.`);
  }
  if (problems.length) throw new WorkerProblems(problems);
}

function configuredHookToken(config, sources, env, dotEnv, dotEnvFile, { required }) {
  const configured = config?.hooks?.token;
  if ((typeof configured !== 'string' || !configured.trim()) && !required) return null;
  if (typeof configured !== 'string' || !configured.trim()) {
    throw new WorkerProblems(['The OpenClaw configuration has no hooks.token. Set it with openclaw config set hooks.token <a long random value>, or put the same value in POLYROOM_OPENCLAW_HOOK_TOKEN.']);
  }
  const conflicts = conflictingReferences(configured, env, dotEnv);
  if (conflicts.length) throw new WorkerProblems([`${conflicts.join(', ')} has one value in the environment of the worker and another in ${dotEnvFile}, and hooks.token refers to it. Remove the variable from the environment of the worker, or make both values equal.`]);
  const token = expandReferences(configured.trim(), sources);
  if (token.missing.length) throw new WorkerProblems([`hooks.token refers to ${token.missing.map((name) => `\${${name}}`).join(', ')}, which is not in ${dotEnvFile} nor in the environment.`]);
  if (/\s/.test(token.expanded)) throw new WorkerProblems(['hooks.token of the OpenClaw configuration has spaces; the Gateway compares it as one Bearer value.']);
  return token.expanded;
}
