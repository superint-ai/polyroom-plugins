import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [action = 'prepare'] = process.argv.slice(2);
const dir = process.env.POLYROOM_WAKE_DIR || join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'polyroom');
const config = join(dir, 'wake.env');
const staging = join(dirname(dir), `${basename(dir)}.next`);
const staged = join(staging, 'wake.env');
const posix = (process.env.POLYROOM_WAKE_TEST_PLATFORM || process.platform) !== 'win32';
const user = posix && process.getuid ? process.getuid() : null;
const wake = fileURLToPath(new URL('wake.mjs', import.meta.url));
const hookFiles = ['wake.env', 'cursor', 'pending', 'pending-session', 'stopped', 'wake.lock'];
const claimSettings = ['SystemRoot', 'USERDOMAIN', 'POLYROOM_WAKE_TEST_PLATFORM', 'NODE_EXTRA_CA_CERTS', 'NODE_USE_ENV_PROXY', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy'];
const retriedRename = ['EPERM', 'EBUSY', 'EACCES'];

const exists = (path) => { try { lstatSync(path); return true; } catch { return false; } };

const problemWith = (path, folder, requirePrivate) => {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) return `${path} is a symbolic link`;
  if (folder ? !stats.isDirectory() : !stats.isFile()) return `${path} is not a ${folder ? 'folder' : 'file'}`;
  if (user !== null && stats.uid !== user) return `${path} belongs to another user`;
  if (requirePrivate && posix && (stats.mode & 0o077) !== 0) return `${path} is still open to other users`;
  return '';
};

const settingsOf = (path) => {
  const values = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const index = line.indexOf('=');
    if (index > 0) values[line.slice(0, index)] = line.slice(index + 1).trim();
  }
  return values;
};

const tuning = () => (exists(config) && !problemWith(config, false, false) ? settingsOf(config) : {});
const numberSetting = (key, fallback) => {
  const value = tuning()[key] ?? '';
  return /^\d+$/.test(value) ? Number(value) : fallback;
};

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const owner = () => (process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${userInfo().username}` : userInfo().username);
const icacls = (args) => execFileSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe'), args, {
  shell: false, windowsHide: true, timeout: Math.max(numberSetting('POLYROOM_WAKE_ICACLS_TIMEOUT_MS', 10000), 1000), stdio: ['ignore', 'pipe', 'ignore'], encoding: 'latin1',
});

const onlyOwnerFull = (path) => {
  const lines = icacls([path]).split(/\r?\n/);
  const end = lines.findIndex((line) => line.trim() === '');
  const entries = lines.slice(0, end === -1 ? lines.length : end);
  return entries.length === 1 && new RegExp(` ${escapeRegExp(owner())}:(?:\\((?:OI|CI|IO|NP|I)\\))*\\(F\\)$`, 'i').test(entries[0].trimEnd());
};

const openToOthers = (paths) => (posix ? '' : paths.filter((path) => !onlyOwnerFull(path)).map((path) => `${path} is still open to other accounts`).join(', '));

const keepToOwner = (folder) => {
  if (posix) {
    chmodSync(folder, 0o700);
    return '';
  }
  const files = hookFiles.map((name) => join(folder, name)).filter(exists);
  icacls([folder, '/reset']);
  icacls([folder, '/inheritance:r', '/grant:r', `${owner()}:(OI)(CI)F`]);
  for (const file of files) icacls([file, '/reset']);
  return openToOthers([folder, ...files]);
};

const privateProblem = (folder, file) => problemWith(folder, true, true) || problemWith(file, false, true) || openToOthers([folder, file]);

const hookEntry = (name) => [...hookFiles, '.owner-only', 'declined'].includes(name) || /^wake\.env\.\d+\.tmp$/.test(name) || /^\.(?:auth|headers|body|status)\.\d+$/.test(name);
const foreignProblem = () => {
  const foreign = readdirSync(dir).filter((name) => !hookEntry(name)).sort();
  return foreign.length ? `${dir} also holds ${foreign.map((name) => join(dir, name)).join(', ')}, which the polyroom hooks did not write: move them out of it and run the connect skill again` : '';
};

const activeProblem = () => (exists(dir) && (problemWith(dir, true, false) || foreignProblem())) || (exists(config) && problemWith(config, false, false)) || '';

const dropStaging = () => rmSync(staging, { recursive: true, force: true });

const pause = (milliseconds) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);

const renameKept = (from, to) => {
  const attempts = Math.max(numberSetting('POLYROOM_WAKE_RENAME_ATTEMPTS', 5), 1);
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(from, to);
      return '';
    } catch (error) {
      if (!retriedRename.includes(error.code) || attempt >= attempts) return error.code || error.message;
      pause(numberSetting('POLYROOM_WAKE_RENAME_PAUSE_MS', 200));
    }
  }
};

const done = (stream, text, status) => process[stream].write(text, () => process.exit(status));
const refused = (problem) => done('stderr', `The polyroom settings folder ${dir} could not be kept readable only by the current user: ${problem}.\n`, 1);

const prepare = () => {
  const active = activeProblem();
  if (active) return refused(active);
  dropStaging();
  mkdirSync(dirname(staging), { recursive: true, mode: 0o700 });
  mkdirSync(staging, { mode: 0o700 });
  closeSync(openSync(staged, 'wx', 0o600));
  const problem = problemWith(staging, true, false) || keepToOwner(staging) || problemWith(staging, true, true) || problemWith(staged, false, true);
  if (problem) {
    dropStaging();
    return refused(problem);
  }
  done('stdout', `Ready: ${staged} is readable only by the current user.\n`, 0);
};

const claimSettingsOf = () => {
  const settings = { POLYROOM_WAKE_DIR: staging };
  for (const name of claimSettings) if (process.env[name] !== undefined) settings[name] = process.env[name];
  return settings;
};

const claim = () => {
  if (!exists(staged)) return done('stderr', `No prepared polyroom settings file at ${staged}. Run the connect skill again.\n`, 1);
  const stagingProblem = privateProblem(staging, staged);
  if (stagingProblem) {
    dropStaging();
    return refused(stagingProblem);
  }
  const written = settingsOf(staged);
  if (!written.POLYROOM_WAKE_URL || !written.POLYROOM_WAKE_CODE) {
    dropStaging();
    return done('stderr', `The prepared polyroom settings file ${staged} has no address or connection code. Run the connect skill again.\n`, 1);
  }
  const fresh = !exists(dir);
  const active = activeProblem();
  if (active) {
    dropStaging();
    return refused(active);
  }
  const child = spawnSync(process.execPath, [wake, 'claude', 'claim'], { env: claimSettingsOf(), shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  if (child.error || child.status !== 0 || !settingsOf(staged).POLYROOM_WAKE_TOKEN) {
    dropStaging();
    const said = `${child.stderr || ''}${child.error ? `${child.error.message}\n` : ''}`;
    return done('stderr', said || 'The connection was not saved. Run the connect skill again.\n', child.status || 1);
  }
  const closed = fresh ? '' : activeProblem() || keepToOwner(dir) || problemWith(dir, true, true);
  if (closed) {
    dropStaging();
    return refused(closed);
  }
  const moved = fresh ? renameKept(staging, dir) : renameKept(staged, config);
  if (moved) {
    dropStaging();
    return done('stderr', `The new polyroom connection could not replace ${config} (${moved}): another program may hold it open. The earlier settings were kept as they were. Close the other Claude Code sessions of this computer and run the connect skill again.\n`, 1);
  }
  if (!fresh) {
    for (const name of ['stopped', 'pending', 'pending-session', 'declined']) rmSync(join(dir, name), { force: true });
    dropStaging();
  }
  const kept = privateProblem(dir, config);
  if (kept) return refused(kept);
  done('stdout', child.stdout, 0);
};

const cancel = () => {
  dropStaging();
  done('stdout', `Cancelled: ${staging} was removed and the earlier settings were kept.\n`, 0);
};

const actions = { prepare, claim, cancel };
if (!Object.hasOwn(actions, action)) done('stderr', 'usage: prepare.mjs [claim|cancel]\n', 64);
else {
  try { actions[action](); } catch (error) {
    let left = '';
    try { dropStaging(); } catch (dropped) { left = `, and ${staging} could not be removed: ${dropped.message}`; }
    refused(`${error.message}${left}`);
  }
}
