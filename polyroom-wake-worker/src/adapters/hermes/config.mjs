import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { parseEnv } from 'node:util';
import { integer, numericVariable, text } from '../../core/config.mjs';
import { WorkerProblems, workerDataDirectory } from '../codex/config.mjs';
import { nameSource, pickName, polyroomName } from '../server-name.mjs';
import { wakeBatchVariables } from '../wake-adapter.mjs';

export const hermesServerVariable = 'POLYROOM_HERMES_MCP_SERVER_NAME';
export const hermesWebhookVariable = 'POLYROOM_HERMES_WEBHOOK_URL';

export const hermesNumericVariables = [
  ...wakeBatchVariables,
  ['POLYROOM_HERMES_WEBHOOK_TIMEOUT_MS', 'webhookTimeoutMs', 1000, 600_000],
  ['POLYROOM_HERMES_COMMAND_TIMEOUT_MS', 'commandTimeoutMs', 1000, 600_000],
  ['POLYROOM_HERMES_STATUS_INTERVAL_MS', 'statusIntervalMs', 100, 60_000],
  ['POLYROOM_HERMES_LOG_MAX_BYTES', 'logMaxBytes', 1024, 1_073_741_824],
  numericVariable('POLYROOM_WRITE_RETRY_ATTEMPTS'),
  numericVariable('POLYROOM_WRITE_RETRY_MS'),
];

const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);
const namePattern = /^[A-Za-z0-9_-]{1,64}$/;
const isExample = (value) => /[<>]/.test(value);
const insecureSecret = 'INSECURE_NO_AUTH';

function webhookAddress(env, problems) {
  const value = text(env, hermesWebhookVariable);
  if (!value) { problems.push(`${hermesWebhookVariable} must be set in the apps/mcp-long-polling .env.`); return {}; }
  let parsed;
  try { parsed = new URL(value); } catch { problems.push(`${hermesWebhookVariable} must be a valid URL.`); return {}; }
  if (parsed.protocol !== 'http:' || !loopbackHosts.has(parsed.hostname)) {
    problems.push(`${hermesWebhookVariable} must be http on this machine (127.0.0.1, localhost or [::1]): the worker never signs a wake for another machine.`);
    return {};
  }
  const route = /^\/webhooks\/([A-Za-z0-9_-]+)$/.exec(parsed.pathname)?.[1];
  if (route) return { webhookUrl: parsed.href, webhookRoute: route, webhookBase: null };
  if (/^\/webhooks\/?$/.test(parsed.pathname) && !parsed.search && !parsed.hash) return { webhookUrl: null, webhookRoute: null, webhookBase: `${parsed.origin}/webhooks` };
  problems.push(`${hermesWebhookVariable} must be the Hermes webhook adapter, /webhooks to find the route polyroom in the Hermes config.yaml, or /webhooks/<route> for one route (for example http://127.0.0.1:8644/webhooks/polyroom).`);
  return {};
}

export function readHermesSettings(env) {
  const problems = [];
  const home = text(env, 'POLYROOM_HERMES_HOME');
  if (home && (isExample(home) || !isAbsolute(home))) problems.push('POLYROOM_HERMES_HOME must be the absolute path of the Hermes home folder, or empty for the HERMES_HOME of the environment and then the Hermes default.');
  const executable = text(env, 'POLYROOM_HERMES_EXECUTABLE') || 'hermes';
  if (executable !== 'hermes' && (!isAbsolute(executable) || !existsSync(executable))) problems.push('POLYROOM_HERMES_EXECUTABLE must be the absolute path of the hermes executable, or empty to use hermes from the PATH.');
  const serverName = text(env, hermesServerVariable) || null;
  if (serverName && !namePattern.test(serverName)) problems.push(`${hermesServerVariable} must be the name of the polyroom server in mcp_servers of the Hermes config.yaml (letters, digits, - and _), or empty to find polyroom there.`);
  const webhookSecret = text(env, 'POLYROOM_HERMES_WEBHOOK_SECRET');
  if (webhookSecret && (isExample(webhookSecret) || /\s/.test(webhookSecret))) problems.push('POLYROOM_HERMES_WEBHOOK_SECRET still has an example value or has spaces.');
  else if (webhookSecret === insecureSecret) problems.push('POLYROOM_HERMES_WEBHOOK_SECRET cannot be INSECURE_NO_AUTH: the route must check the signature of every wake.');
  const userAgent = text(env, 'POLYROOM_HERMES_USER_AGENT');
  if (!userAgent) problems.push('POLYROOM_HERMES_USER_AGENT must be set in the apps/mcp-long-polling .env.');
  const settings = { home, executable, serverName, webhookSecret, userAgent, ...webhookAddress(env, problems), dataDirectory: workerDataDirectory(env) };
  for (const [name, key, min, max] of hermesNumericVariables) settings[key] = integer(env, name, min, max, problems);
  if (problems.length) throw new WorkerProblems(problems);
  settings.writeRetry = { attempts: settings.writeRetryAttempts, retryMs: settings.writeRetryMs };
  return settings;
}

export function runHermesCommand(executable, args, { env, timeoutMs }) {
  return new Promise((resolve) => {
    execFile(executable, args, { env, timeout: timeoutMs, maxBuffer: 1_048_576, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : null) : 0, failure: error && typeof error.code !== 'number' ? (error.killed ? 'timeout' : error.code ?? error.name) : null,
        stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

const absent = Symbol('absent');

async function readServerEntry(settings, childEnv, runHermes, name) {
  const key = `mcp_servers.${name}`;
  const answer = await runHermes(settings.executable, ['config', 'get', '--json', '--raw', key], { env: childEnv, timeoutMs: settings.commandTimeoutMs });
  if (answer.failure) {
    throw new WorkerProblems([answer.failure === 'timeout'
      ? `hermes config get did not answer in ${settings.commandTimeoutMs} ms (POLYROOM_HERMES_COMMAND_TIMEOUT_MS).`
      : `hermes could not be started (${answer.failure}). Install Hermes, or set POLYROOM_HERMES_EXECUTABLE to the hermes executable.`]);
  }
  if (answer.code !== 0) {
    if (/Config key not set/.test(answer.stdout + answer.stderr)) return absent;
    throw new WorkerProblems([`hermes config get ${key} failed with exit code ${answer.code}.`]);
  }
  try { return JSON.parse(answer.stdout); } catch { throw new WorkerProblems([`hermes config get ${key} did not print JSON.`]); }
}

export async function readHermesIdentity(settings, env, { runHermes = runHermesCommand } = {}) {
  const childEnv = settings.home ? { ...env, HERMES_HOME: settings.home } : { ...env };
  const fixFor = (name) => `Add it to mcp_servers in the Hermes config.yaml as ${name}, as the Connect screen of the agent explains.`;
  const entries = new Map();
  const lookedUp = settings.serverName ?? polyroomName;
  entries.set(lookedUp, await readServerEntry(settings, childEnv, runHermes, lookedUp));
  const server = pickName({
    configured: settings.serverName,
    present: (name) => entries.get(name) !== absent,
    missing: (first) => `The Hermes configuration has no MCP server "${first}". ${fixFor(first)}`,
  });
  const serverName = server.name;
  const fix = fixFor(serverName);
  const entry = entries.get(serverName);
  if (entry === absent) throw new WorkerProblems([`The Hermes configuration has no MCP server "${serverName}". ${fix}`]);
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new WorkerProblems([`The MCP server "${serverName}" of Hermes is not a server entry. ${fix}`]);
  const problems = [];
  if (entry.enabled === false) problems.push(`The MCP server "${serverName}" is disabled in Hermes.`);
  if (typeof entry.url !== 'string' || !entry.url) problems.push(`The MCP server "${serverName}" must be remote (url), not a local command.`);
  if (entry.auth === 'oauth') problems.push(`The MCP server "${serverName}" uses OAuth; the polyroom bot address takes only the bot token in the Authorization header.`);
  const header = Object.entries(entry.headers ?? {}).find(([name]) => name.toLowerCase() === 'authorization')?.[1];
  if (typeof header !== 'string') problems.push(`The MCP server "${serverName}" must have the header Authorization: Bearer <bot token>.`);
  if (problems.length) throw new WorkerProblems(problems);
  const unresolved = [...new Set([...`${entry.url} ${header}`.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((match) => match[1]))];
  if (unresolved.length) throw new WorkerProblems([`Hermes did not resolve ${unresolved.map((name) => `\${${name}}`).join(', ')}: put it in the Hermes .env (hermes config env-path shows where).`]);
  if (!/^Bearer\s+\S+$/i.test(header)) throw new WorkerProblems([`The Authorization header of the MCP server "${serverName}" must be Bearer <bot token>.`]);
  const webhook = await configuredWebhook(settings, childEnv, runHermes, { required: !settings.webhookSecret });
  const webhookSecret = settings.webhookSecret || webhook.secret;
  return { url: entry.url, authorization: header, settings: { webhookSecret, serverName, serverSource: server.source, webhookUrl: webhook.url, webhookRoute: webhook.route, routeSource: webhook.source } };
}

const objectOf = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
const filled = (value) => typeof value === 'string' && value.trim() ? value.trim() : null;

function webhookRoute(settings, webhook, routes) {
  if (settings.webhookRoute) {
    if (Object.keys(webhook).length && !Object.hasOwn(routes, settings.webhookRoute)) {
      throw new WorkerProblems([`The Hermes webhook adapter has no route "${settings.webhookRoute}" (from ${hermesWebhookVariable}). Add it under platforms.webhook.extra.routes in the Hermes config.yaml.`]);
    }
    return { name: settings.webhookRoute, source: nameSource.variable };
  }
  if (!Object.keys(webhook).length) return { name: polyroomName, source: nameSource.fallback };
  return pickName({
    configured: null,
    present: (name) => Object.hasOwn(routes, name),
    missing: (first) => `The Hermes webhook adapter has no route "${first}". Add ${first} under platforms.webhook.extra.routes in the Hermes config.yaml.`,
  });
}

async function configuredWebhook(settings, childEnv, runHermes, { required }) {
  const answer = await runHermes(settings.executable, ['config', 'get', '--json', '--raw', 'platforms.webhook'], { env: childEnv, timeoutMs: settings.commandTimeoutMs });
  let webhook = {};
  if (answer.failure) throw new WorkerProblems([`hermes config get platforms.webhook did not run (${answer.failure}).`]);
  if (answer.code === 0) {
    try { webhook = objectOf(JSON.parse(answer.stdout)); } catch { throw new WorkerProblems(['hermes config get platforms.webhook did not print JSON.']); }
  } else if (!/Config key not set/.test(answer.stdout + answer.stderr)) throw new WorkerProblems([`hermes config get platforms.webhook failed with exit code ${answer.code}.`]);
  const extra = objectOf(webhook.extra);
  const routes = { ...objectOf(webhook.routes), ...objectOf(extra.routes) };
  const picked = webhookRoute(settings, webhook, routes);
  const route = picked.name;
  const found = { route, source: picked.source, url: settings.webhookUrl ?? `${settings.webhookBase}/${route}` };
  let secret = filled(objectOf(routes[route]).secret) ?? filled(extra.secret) ?? filled(webhook.secret);
  if (!secret) {
    const envPath = await runHermes(settings.executable, ['config', 'env-path'], { env: childEnv, timeoutMs: settings.commandTimeoutMs });
    const file = envPath.code === 0 ? envPath.stdout.trim() : '';
    let values = {};
    try { if (file) values = parseEnv(readFileSync(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw new WorkerProblems([`The Hermes .env ${file} could not be read (${error.code ?? error.name}).`]); }
    secret = filled(values.WEBHOOK_SECRET) ?? filled(childEnv.WEBHOOK_SECRET);
  }
  if (!secret && !required) return { ...found, secret: null };
  if (!secret) throw new WorkerProblems([`No secret signs the Hermes route "${route}": set secret on the route in the Hermes config.yaml, or WEBHOOK_SECRET in the Hermes .env, or put the same value in POLYROOM_HERMES_WEBHOOK_SECRET.`]);
  if (secret === insecureSecret) throw new WorkerProblems([`The Hermes route "${route}" uses INSECURE_NO_AUTH; the worker only wakes a route that checks the signature. Give the route a real secret.`]);
  if (/\s/.test(secret)) throw new WorkerProblems([`The secret of the Hermes route "${route}" has spaces.`]);
  return { ...found, secret };
}
