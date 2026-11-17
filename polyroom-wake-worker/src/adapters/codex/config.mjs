import { existsSync, readFileSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { integer, numericVariable, processingLeaseMaxMs, text } from '../../core/config.mjs';

export const workerNumericVariables = [
  ['POLYROOM_CODEX_TIMEOUT_MS', 'timeoutMs', 1000, processingLeaseMaxMs],
  ['POLYROOM_CODEX_LEASE_MARGIN_MS', 'leaseMarginMs', 0, 3_600_000],
  ['POLYROOM_CODEX_RECEIPT_MAX_CHARS', 'receiptMaxChars', 64, 1_048_576],
  ['POLYROOM_CODEX_JSONL_LINE_MAX_CHARS', 'lineMaxChars', 1024, 67_108_864],
  ['POLYROOM_CODEX_STATUS_INTERVAL_MS', 'statusIntervalMs', 100, 60_000],
  ['POLYROOM_CODEX_COMMAND_TIMEOUT_MS', 'commandTimeoutMs', 1000, 600_000],
  ['POLYROOM_CODEX_STOP_GRACE_MS', 'stopGraceMs', 100, 600_000],
  ['POLYROOM_CODEX_KILL_SETTLE_MS', 'killSettleMs', 0, 60_000],
  ['POLYROOM_CODEX_SESSIONS_MAX', 'sessionsMax', 1, 100_000],
  ['POLYROOM_CODEX_LOG_MAX_BYTES', 'logMaxBytes', 1024, 1_073_741_824],
  ['POLYROOM_CODEX_PROBE_PORT', 'probePort', 1, 65_535],
  ['POLYROOM_CODEX_PROBE_NETWORK_TIMEOUT_MS', 'probeNetworkTimeoutMs', 100, 60_000],
  ['POLYROOM_CODEX_FAILURES_BEFORE_PAUSE', 'failuresBeforePause', 1, 100],
  ['POLYROOM_CODEX_PREFLIGHT_BUDGET_MS', 'preflightBudgetMs', 1000, 3_600_000],
  ['POLYROOM_CODEX_PREFLIGHT_CANCEL_WAIT_MS', 'preflightCancelWaitMs', 1000, 600_000],
  ['POLYROOM_CODEX_PROCESS_CLOCK_SLACK_MS', 'processClockSlackMs', 0, 60_000],
  ['POLYROOM_CODEX_PROBE_SAMPLES_PER_DIRECTORY', 'probeSamplesPerDirectory', 1, 20],
  ['POLYROOM_CODEX_SCAN_MAX_DEPTH', 'scanMaxDepth', 1, 30],
  ['POLYROOM_CODEX_SCAN_MAX_ENTRIES', 'scanMaxEntries', 1000, 50_000_000],
  ['POLYROOM_CODEX_SCAN_REPORT_MAX', 'scanReportMax', 1, 1000],
  numericVariable('POLYROOM_WRITE_RETRY_ATTEMPTS'),
  numericVariable('POLYROOM_WRITE_RETRY_MS'),
];

export const disabledCodexFeatures = [
  'plugins', 'apps', 'browser_use', 'browser_use_external', 'computer_use', 'in_app_browser', 'image_generation',
  'memories', 'multi_agent', 'multi_agent_v2', 'hooks', 'remote_plugin', 'skill_mcp_dependency_install',
];

const childEnvNames = ['PATH', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'USERPROFILE', 'APPDATA', 'TEMP', 'TMP'];
const namePattern = /^[A-Za-z0-9_-]{1,64}$/;

export class WorkerProblems extends Error {
  constructor(problems) {
    super(problems.join(' '));
    this.name = 'WorkerProblems';
    this.problems = problems;
  }
}

const isExample = (value) => /[<>]/.test(value);

function existingDirectory(env, name, problems, { create = false } = {}) {
  const value = text(env, name);
  if (!value) { problems.push(`${name} must be set in the apps/mcp-long-polling .env.`); return null; }
  if (isExample(value)) { problems.push(`${name} still has the example value from .env. Set the path of the bot folder, as INSTALL-WINDOWS.md explains.`); return null; }
  if (!isAbsolute(value)) { problems.push(`${name} must be an absolute path.`); return null; }
  if (create) return value;
  let directory = false;
  try { directory = statSync(value).isDirectory(); } catch {}
  if (!directory) { problems.push(`${name} points to a folder that does not exist: ${value}.`); return null; }
  return value;
}

function nameList(env, name, problems) {
  const items = text(env, name).split(',').map((item) => item.trim()).filter(Boolean);
  if (!items.length) problems.push(`${name} must list the scan values, separated by commas.`);
  return items;
}

function isDirectoryPath(path) {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

const comparablePath = (path) => resolve(path).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

function isSameOrInside(path, folder) {
  const [inner, outer] = [comparablePath(path), comparablePath(folder)];
  return inner === outer || inner.startsWith(`${outer}/`);
}

function pathList(env, name, problems) {
  const items = text(env, name).split(';').map((item) => item.trim()).filter(Boolean);
  const invalid = items.filter((item) => !isAbsolute(item) || isExample(item));
  if (invalid.length) problems.push(`${name} must be a list of absolute paths separated by ";": ${invalid.join(', ')}.`);
  return items;
}

export function writeRetryFromEnv(env) {
  const problems = [];
  const [attemptsName, , attemptsMin, attemptsMax] = numericVariable('POLYROOM_WRITE_RETRY_ATTEMPTS');
  const [retryName, , retryMin, retryMax] = numericVariable('POLYROOM_WRITE_RETRY_MS');
  const attempts = integer(env, attemptsName, attemptsMin, attemptsMax, problems);
  const retryMs = integer(env, retryName, retryMin, retryMax, problems);
  return problems.length ? { attempts: 1, retryMs: 0 } : { attempts, retryMs };
}

export function workerDataDirectory(env) {
  const configured = text(env, 'POLYROOM_DATA_DIR');
  return configured ? resolve(configured) : fileURLToPath(new URL('../../../data/', import.meta.url));
}

export function findExecutable(env, platform = process.platform, arch = process.arch) {
  const configured = text(env, 'POLYROOM_CODEX_EXECUTABLE');
  if (configured) {
    if (!isAbsolute(configured) || !existsSync(configured) || (platform === 'win32' && !configured.toLowerCase().endsWith('.exe'))) {
      throw new WorkerProblems(['POLYROOM_CODEX_EXECUTABLE must be the absolute path of an existing executable (.exe on Windows).']);
    }
    return configured;
  }
  const paths = (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean);
  for (const directory of paths) {
    const native = join(directory, platform === 'win32' ? 'codex.exe' : 'codex');
    if (existsSync(native) && statSync(native).isFile()) return native;
    if (platform === 'win32') {
      const triple = arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
      const vendor = join(directory, 'node_modules', '@openai', 'codex', 'node_modules', '@openai', `codex-win32-${arch}`, 'vendor', triple);
      for (const folder of ['bin', 'codex']) {
        const file = join(vendor, folder, 'codex.exe');
        if (existsSync(file)) return file;
      }
    }
  }
  throw new WorkerProblems(['Could not find the native Codex executable in PATH. Set POLYROOM_CODEX_EXECUTABLE.']);
}

export function readWorkerSettings(env, { executablePrefix = [] } = {}) {
  const problems = [];
  const settings = { dataDirectory: workerDataDirectory(env) };
  for (const [name, key, min, max] of workerNumericVariables) settings[key] = integer(env, name, min, max, problems);
  settings.writeRetry = { attempts: settings.writeRetryAttempts, retryMs: settings.writeRetryMs };
  settings.codexHome = existingDirectory(env, 'POLYROOM_CODEX_HOME', problems);
  settings.localAppData = existingDirectory(env, 'POLYROOM_CODEX_LOCALAPPDATA', problems, { create: true });
  settings.workspace = existingDirectory(env, 'POLYROOM_CODEX_WORKSPACE', problems);
  settings.permissionProfile = text(env, 'POLYROOM_CODEX_PERMISSION_PROFILE');
  if (!namePattern.test(settings.permissionProfile)) problems.push('POLYROOM_CODEX_PERMISSION_PROFILE must be the name of the permission profile in the bot CODEX_HOME (letters, digits, _ or -), not a built-in profile such as :read-only.');
  settings.serverName = text(env, 'POLYROOM_CODEX_MCP_SERVER_NAME') || null;
  if (settings.serverName && !namePattern.test(settings.serverName)) problems.push('POLYROOM_CODEX_MCP_SERVER_NAME must be the name of the chat server in the bot CODEX_HOME (letters, digits, _ or -), or empty to find polyroom and then polyroom there.');
  settings.codexVersion = text(env, 'POLYROOM_CODEX_VERSION');
  if (!/^\d+\.\d+\.\d+$/.test(settings.codexVersion)) problems.push('POLYROOM_CODEX_VERSION must be the Codex CLI version the worker was checked against, such as 0.162.1.');
  settings.requiredDisabledTools = text(env, 'POLYROOM_CODEX_REQUIRED_DISABLED_TOOLS').split(',').map((item) => item.trim()).filter(Boolean);
  if (!settings.requiredDisabledTools.length || settings.requiredDisabledTools.some((tool) => !/^[a-z][a-z0-9_]{1,63}$/.test(tool))) {
    problems.push('POLYROOM_CODEX_REQUIRED_DISABLED_TOOLS must list, separated by commas, the chat tools the bot must not use.');
  }
  settings.userAgent = text(env, 'POLYROOM_CODEX_USER_AGENT');
  if (!settings.userAgent) problems.push('POLYROOM_CODEX_USER_AGENT must be set in the apps/mcp-long-polling .env.');
  settings.model = text(env, 'POLYROOM_CODEX_MODEL') || null;
  if (settings.model && !/^[A-Za-z0-9._:-]{1,100}$/.test(settings.model)) problems.push('POLYROOM_CODEX_MODEL has characters that are not accepted in a model name.');
  settings.probeHost = text(env, 'POLYROOM_CODEX_PROBE_HOST');
  if (!settings.probeHost) problems.push('POLYROOM_CODEX_PROBE_HOST must be set in the apps/mcp-long-polling .env.');
  settings.probeHttpsUrl = text(env, 'POLYROOM_CODEX_PROBE_HTTPS_URL');
  if (!/^https:\/\/[^\s/]+/.test(settings.probeHttpsUrl)) problems.push('POLYROOM_CODEX_PROBE_HTTPS_URL must be an https URL.');
  settings.probeDnsSuffix = text(env, 'POLYROOM_CODEX_PROBE_DNS_SUFFIX');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(settings.probeDnsSuffix)) problems.push('POLYROOM_CODEX_PROBE_DNS_SUFFIX must be a domain, such as example.com.');
  settings.probeDeniedPaths = pathList(env, 'POLYROOM_CODEX_PROBE_DENIED_PATHS', problems);
  settings.probeWritePaths = pathList(env, 'POLYROOM_CODEX_PROBE_WRITE_PATHS', problems);
  settings.scanRoots = pathList(env, 'POLYROOM_CODEX_SCAN_ROOTS', problems);
  if (!settings.scanRoots.length) problems.push('POLYROOM_CODEX_SCAN_ROOTS must list the folders to scan for files that look like secrets.');
  const missingRoots = settings.scanRoots.filter((root) => isAbsolute(root) && !isDirectoryPath(root));
  if (missingRoots.length) problems.push(`POLYROOM_CODEX_SCAN_ROOTS has folders that do not exist; check the path: ${missingRoots.join(', ')}.`);
  if (settings.scanRoots.some((root) => isSameOrInside(root, settings.dataDirectory))) {
    problems.push(`POLYROOM_DATA_DIR (${settings.dataDirectory}) cannot be a scan root or a folder above one, because the data folder is accepted by the scan. Use a folder that belongs only to the worker.`);
  }
  settings.scanAcceptedPaths = pathList(env, 'POLYROOM_CODEX_SCAN_ACCEPTED_PATHS', problems);
  const coversRoot = settings.scanAcceptedPaths.filter((accepted) => settings.scanRoots.some((root) => isSameOrInside(root, accepted)));
  if (coversRoot.length) problems.push(`POLYROOM_CODEX_SCAN_ACCEPTED_PATHS cannot accept a scan root or a folder above one; accept only specific folders: ${coversRoot.join(', ')}.`);
  settings.scanNames = nameList(env, 'POLYROOM_CODEX_SCAN_NAMES', problems);
  settings.scanExtensions = nameList(env, 'POLYROOM_CODEX_SCAN_EXTENSIONS', problems);
  settings.scanSkippedDirectories = nameList(env, 'POLYROOM_CODEX_SCAN_SKIPPED_DIRECTORIES', problems);
  settings.scanSkippedExtensions = nameList(env, 'POLYROOM_CODEX_SCAN_SKIPPED_EXTENSIONS', problems);
  const leaseParts = [settings.timeoutMs, settings.leaseMarginMs, settings.preflightBudgetMs, settings.preflightCancelWaitMs];
  if (leaseParts.every(Number.isSafeInteger) && leaseParts.reduce((sum, part) => sum + part, 0) > processingLeaseMaxMs) {
    problems.push(`POLYROOM_CODEX_TIMEOUT_MS, POLYROOM_CODEX_LEASE_MARGIN_MS, POLYROOM_CODEX_PREFLIGHT_BUDGET_MS and POLYROOM_CODEX_PREFLIGHT_CANCEL_WAIT_MS added together exceed the maximum lease of ${processingLeaseMaxMs} ms.`);
  }
  const policyFile = text(env, 'POLYROOM_CODEX_POLICY_FILE');
  settings.policyFile = policyFile;
  settings.policy = '';
  if (!policyFile || isExample(policyFile) || !isAbsolute(policyFile)) problems.push('POLYROOM_CODEX_POLICY_FILE must be the absolute path of the operator policy.');
  else {
    try { settings.policy = readFileSync(policyFile, 'utf8').trim(); } catch { problems.push(`Could not read the operator policy at ${policyFile}.`); }
    if (existsSync(policyFile) && !settings.policy) problems.push('The operator policy is empty.');
  }
  if (problems.length) throw new WorkerProblems(problems);
  settings.executable = findExecutable(env);
  settings.executablePrefix = executablePrefix;
  return settings;
}

export function codexChildEnv(settings, baseEnv) {
  const env = {};
  for (const name of childEnvNames) {
    const key = Object.keys(baseEnv).find((candidate) => candidate.toUpperCase() === name.toUpperCase());
    if (key !== undefined && typeof baseEnv[key] === 'string') env[name] = baseEnv[key];
  }
  return { ...env, CODEX_HOME: settings.codexHome, LOCALAPPDATA: settings.localAppData };
}

export function skillsConfigArgs(skillFiles) {
  if (!skillFiles.length) return [];
  return ['-c', `skills.config=[${skillFiles.map((file) => `{path=${JSON.stringify(file)},enabled=false}`).join(',')}]`];
}

export function codexConfigArgs(settings, skillFiles = []) {
  return [
    '-c', `default_permissions=${JSON.stringify(settings.permissionProfile)}`,
    '-c', 'windows.sandbox="elevated"',
    '-c', 'approval_policy="never"',
    '-c', 'web_search="disabled"',
    '-c', 'shell_environment_policy.inherit="core"',
    '-c', 'shell_environment_policy.set={}',
    '-c', 'notify=[]',
    ...disabledCodexFeatures.flatMap((feature) => ['--disable', feature]),
    ...skillsConfigArgs(skillFiles),
  ];
}

export function codexLaunch(settings, baseEnv = process.env, skillFiles = []) {
  return {
    file: settings.executable,
    prefix: settings.executablePrefix,
    cwd: settings.workspace,
    env: codexChildEnv(settings, baseEnv),
    configArgs: codexConfigArgs(settings, skillFiles),
    skillFiles,
  };
}
