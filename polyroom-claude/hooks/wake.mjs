import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.umask(0o077);

const platform = process.env.POLYROOM_WAKE_TEST_PLATFORM || process.platform;

const idleText = 'No new polyroom notices. Call the polyroom tool chat_identity once so this session keeps waiting, then end the turn with one word.';
const refusedText = 'The chat refused the polyroom wake token, so this session stopped waiting for notices: the connection was removed or expired, or the agent or its workspace was deleted. Tell the person in one sentence, and say they can type Connect polyroom to connect again.';
const connectedText = 'polyroom connected this conversation, and it now waits for notices. Tell the person in one short sentence that it is connected, then end the turn.';
const codeRefusedText = 'The chat refused the polyroom connection code, so this conversation is not connected. Tell the person, and run the polyroom connect skill again only if they ask.';
const addressMissingText = 'The polyroom plugin has no chat address in its .mcp.json, so this conversation is not connected. Tell the person to reinstall the polyroom plugin.';
const unreachableText = 'polyroom could not reach the chat to connect this conversation. Tell the person to check the network, and run the polyroom connect skill again only if they ask.';
const foreignCodeText = 'The polyroom connection code was not used, because this conversation did not get it from the chat_wake_code tool of polyroom. Tell the person, and run the polyroom connect skill again only if they ask.';
const busyText = 'Another polyroom session on this computer already waits for notices for this agent, so this session does not wait. Close the other session, then send any message here so this one waits.';
const alreadyConnectedText = 'This conversation is already connected to polyroom, so the new connection code was not used. To connect another agent, the person removes this connection on the Agents page of polyroom, under Tokens and Plugin connections, and then runs the polyroom connect skill again.';

const unknownCursor = '999999999999999';
const userAgent = 'polyroom-wake/1';
const pluginRoot = fileURLToPath(new URL('..', import.meta.url));
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const serverName = (() => {
  try {
    const servers = JSON.parse(readFileSync(join(pluginRoot, '.mcp.json'), 'utf8')).mcpServers;
    const names = servers && typeof servers === 'object' && !Array.isArray(servers) ? Object.keys(servers) : [];
    const entry = names.length === 1 ? servers[names[0]] : null;
    return entry && typeof entry === 'object' && typeof entry.url === 'string' && entry.url && /^[A-Za-z0-9_-]+$/.test(names[0]) ? names[0] : '';
  } catch { return ''; }
})();
const isNumber = (value) => /^\d+$/.test(value ?? '');
const cksumTable = Array.from({ length: 256 }, (_, index) => {
  let value = index << 24;
  for (let bit = 0; bit < 8; bit++) value = value & 0x80000000 ? (value << 1) ^ 0x04c11db7 : value << 1;
  return value >>> 0;
});

const [product = '', action = ''] = process.argv.slice(2);
const actions = { codex: ['wait', 'session-start', 'claim'], claude: ['wait', 'listen', 'session-start', 'claim'] };
if (!Object.hasOwn(actions, product) || !actions[product].includes(action)) {
  process.stderr.write('usage: wake.mjs codex wait|session-start|claim, or wake.mjs claude wait|listen|session-start|claim\n', () => process.exit(64));
} else {
  await main();
}

async function main() {
  const parent = process.ppid;
  const dir = process.env.POLYROOM_WAKE_DIR
    || (product === 'codex' ? join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'polyroom')
      : join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'polyroom'));
  const config = join(dir, 'wake.env');
  const temporary = `${config}.${process.pid}.tmp`;
  const lock = join(dir, 'wake.lock');
  const staged = join(lock, `.new.${process.pid}`);
  let record = '';
  let current = null;
  let watch = null;

  const remove = (path) => { try { rmSync(path, { force: true }); } catch {} };
  const records = () => {
    try { return readdirSync(lock).filter((name) => /^\d+$/.test(name)).sort((left, right) => Number(left) - Number(right)); } catch { return []; }
  };
  const holdsLock = () => record !== '' && records().at(-1) === record;
  const release = () => {
    if (!record) return;
    if (!holdsLock()) { remove(join(lock, record)); return; }
    try { writeFileSync(staged, 'released\n'); renameSync(staged, join(lock, record)); } catch { remove(staged); }
  };
  const cleanup = () => {
    current?.destroy();
    remove(temporary);
    remove(staged);
    release();
  };
  process.on('exit', cleanup);
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => process.exit(record && !holdsLock() ? 0 : 143));

  const finish = (code, { stdout = null, stderr = null } = {}) => new Promise(() => {
    clearInterval(watch);
    let left = 1;
    const done = () => { if (--left === 0) process.exit(code); };
    if (stdout !== null) { left++; process.stdout.write(stdout, done); }
    if (stderr !== null) { left++; process.stderr.write(stderr, done); }
    done();
  });

  const attended = product === 'claude' && process.env.CLAUDE_CODE_SESSION_ATTENDED === '1';
  if (action === 'listen' && !attended) await finish(0);
  if (action === 'wait' && product === 'claude' && process.env.CLAUDE_CODE_SESSION_ATTENDED === '0') await finish(0);

  const readText = (path) => { try { return readFileSync(path, 'utf8'); } catch { return null; } };

  const settings = () => {
    const values = {};
    for (const line of (readText(config) ?? '').split('\n')) {
      const index = line.indexOf('=');
      if (index > 0) values[line.slice(0, index)] = line.slice(index + 1).trim();
    }
    return values;
  };

  const numberSetting = (values, key, fallback) => (isNumber(values[key]) ? Number(values[key]) : fallback);

  const saveSetting = (key, value) => {
    try {
      const lines = (readText(config) ?? '').split('\n').filter((line) => line !== '' && !line.startsWith(`${key}=`));
      if (value) lines.push(`${key}=${value}`);
      writeFileSync(temporary, lines.map((line) => `${line}\n`).join(''));
      renameSync(temporary, config);
      return true;
    } catch {
      remove(temporary);
      return false;
    }
  };

  const alive = (pid) => {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
  };
  const orphaned = () => !alive(parent) || process.ppid !== parent;

  const sweep = () => {
    let names;
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      const owner = /^\.(?:auth|headers|body|status)\.(\d+)$/.exec(name)?.[1] ?? /^wake\.env\.(\d+)\.tmp$/.exec(name)?.[1];
      if (owner && (Number(owner) === process.pid || !alive(Number(owner)))) remove(join(dir, name));
    }
  };
  sweep();

  const values = settings();
  let url = (values.POLYROOM_WAKE_URL ?? '').replace(/\/+$/, '');
  let token = values.POLYROOM_WAKE_TOKEN ?? '';
  let code = values.POLYROOM_WAKE_CODE ?? '';
  const budget = numberSetting(values, 'POLYROOM_WAKE_BUDGET_SECONDS', 1740);
  const waitSeconds = numberSetting(values, 'POLYROOM_WAKE_WAIT_SECONDS', 20);
  const margin = numberSetting(values, 'POLYROOM_WAKE_MARGIN_SECONDS', 15);
  const retryMin = numberSetting(values, 'POLYROOM_WAKE_RETRY_MIN_SECONDS', 2);
  const retryMax = numberSetting(values, 'POLYROOM_WAKE_RETRY_MAX_SECONDS', 60);
  const heartbeatMs = Math.max(numberSetting(values, 'POLYROOM_WAKE_HEARTBEAT_MS', 250), 10);
  const takeoverSeconds = numberSetting(values, 'POLYROOM_WAKE_TAKEOVER_SECONDS', 5);
  const cooperative = (values.POLYROOM_WAKE_STOP || (platform === 'win32' ? 'cooperative' : 'signal')) === 'cooperative';
  const staleMs = heartbeatMs * 4;
  const icaclsTimeoutMs = Math.max(numberSetting(values, 'POLYROOM_WAKE_ICACLS_TIMEOUT_MS', 10000), 1000);

  const marks = () => {
    const bytes = Buffer.from(token, 'utf8');
    return { cksum: cksum(bytes), sha: createHash('sha256').update(bytes).digest('hex').slice(0, 12) };
  };
  const ownMark = () => marks()[process.platform === 'win32' ? 'sha' : 'cksum'];

  const marked = (path) => {
    const text = readText(path);
    if (text === null) return { state: 'missing' };
    const parts = text.trim().split(/\s+/);
    if (parts.length === 1 && isNumber(parts[0])) return { state: 'mine', number: parts[0] };
    if ((parts.length === 2 || parts.length === 3) && isNumber(parts[1])) {
      const { cksum: posix, sha } = marks();
      return parts[0] === posix || parts[0] === sha ? { state: 'mine', number: parts[1], turn: parts[2] ?? '' } : { state: 'foreign' };
    }
    return { state: 'missing' };
  };
  const write = (path, text) => { try { writeFileSync(path, text); return true; } catch { return false; } };
  const saveMarked = (path, number, turn = '') => write(path, `${ownMark()} ${number}${turn ? ` ${turn}` : ''}\n`);
  const sessionOfPending = (pending) => {
    if (pending.state !== 'mine') return '';
    const parts = (readText(join(dir, 'pending-session')) ?? '').trim().split(/\s+/);
    const { cksum: posix, sha } = marks();
    return parts.length === 3 && (parts[0] === posix || parts[0] === sha) && parts[1] === pending.number ? parts[2] : '';
  };
  const removePending = () => { remove(join(dir, 'pending')); remove(join(dir, 'pending-session')); };
  const connectedAsBefore = () => (settings().POLYROOM_WAKE_TOKEN ?? '') === token;

  const send = (method, address, headers, body, timeoutSeconds) => new Promise((resolve) => {
    let settled = false;
    const settle = (answer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      current = null;
      resolve(answer);
    };
    const failed = () => settle({ status: 0, body: Buffer.alloc(0), cursor: '' });
    const timer = setTimeout(() => { current?.destroy(); failed(); }, timeoutSeconds * 1000);
    let target;
    try { target = new URL(address); } catch { failed(); return; }
    const client = target.protocol === 'https:' ? https : target.protocol === 'http:' ? http : null;
    if (!client) { failed(); return; }
    const outgoing = { 'User-Agent': userAgent, ...headers };
    if (body !== null) Object.assign(outgoing, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    const request = client.request(target, { method, headers: outgoing, agent: false }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const header = response.headers['x-polyroom-cursor'];
        const cursor = (Array.isArray(header) ? header.at(-1) : header ?? '').split(',').at(-1).trim();
        settle({ status: response.statusCode ?? 0, body: Buffer.concat(chunks), cursor });
      });
      response.on('error', failed);
      response.on('aborted', failed);
    });
    current = request;
    request.on('error', failed);
    request.end(body ?? undefined);
  });

  const pause = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));

  let claimStatus = null;
  const claim = async () => {
    if (!/^[A-Za-z0-9_-]+$/.test(code)) {
      process.stderr.write('No valid POLYROOM_WAKE_CODE in wake.env.\n');
      return false;
    }
    const answer = await send('POST', `${url}/wake/claim`, {}, JSON.stringify({ code }), waitSeconds + margin);
    claimStatus = answer.status;
    const received = answer.body.toString('utf8').replace(/[\r\n]/g, '');
    if (answer.status === 200 && received.startsWith('saw_')) {
      if (!/^[A-Za-z0-9_-]+$/.test(received)) {
        process.stderr.write('The chat answered the claim with an invalid token.\n');
        return false;
      }
      if (!saveSetting('POLYROOM_WAKE_TOKEN', received) || !saveSetting('POLYROOM_WAKE_CODE', '')) return false;
      token = received;
      if (!saveMarked(join(dir, 'cursor'), unknownCursor)) return false;
      remove(join(dir, 'stopped'));
      removePending();
      return true;
    }
    process.stderr.write(`The chat refused the connection code (HTTP ${String(answer.status).padStart(3, '0')}). Run the connect skill again for a new code.\n`);
    return false;
  };

  const deliverText = (text) => (product === 'codex'
    ? finish(0, { stdout: `${JSON.stringify({ decision: 'block', reason: text })}\n` })
    : finish(2, { stderr: `${text}\n` }));
  const deliverBody = (body) => (product === 'codex' ? finish(0, { stdout: body }) : finish(2, { stderr: body }));

  const exists = (path) => { try { statSync(path); return true; } catch { return false; } };
  const ownerOnlyMark = join(dir, '.owner-only');
  const hookFiles = ['wake.env', 'cursor', 'pending', 'pending-session', 'stopped', 'wake.lock'];
  const hookEntry = (name) => [...hookFiles, '.owner-only'].includes(name) || /^wake\.env\.\d+\.tmp$/.test(name) || /^\.(?:auth|headers|body|status)\.\d+$/.test(name);
  const onlyHookEntries = () => { try { return readdirSync(dir).every(hookEntry); } catch { return false; } };
  const onlyOwnerFull = (listing, owner) => {
    const lines = listing.split(/\r?\n/);
    const end = lines.findIndex((line) => line.trim() === '');
    const entries = lines.slice(0, end === -1 ? lines.length : end);
    return entries.length === 1 && new RegExp(` ${escapeRegExp(owner)}:(?:\\((?:OI|CI|IO|NP|I)\\))*\\(F\\)$`, 'i').test(entries[0].trimEnd());
  };
  const keepFolderToOwner = (beforeToken) => {
    if (platform !== 'win32') return;
    if (!onlyHookEntries()) { remove(ownerOnlyMark); return; }
    if (!beforeToken && exists(ownerOnlyMark)) return;
    remove(ownerOnlyMark);
    const icacls = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe');
    const run = (args) => execFileSync(icacls, args, { shell: false, windowsHide: true, timeout: icaclsTimeoutMs, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'latin1' });
    try {
      const owner = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${userInfo().username}` : userInfo().username;
      const files = hookFiles.map((name) => join(dir, name)).filter(exists);
      run([dir, '/reset']);
      run([dir, '/inheritance:r', '/grant:r', `${owner}:(OI)(CI)F`]);
      for (const file of files) run([file, '/reset']);
      if ([dir, ...files].every((path) => onlyOwnerFull(run([path]), owner))) write(ownerOnlyMark, '');
    } catch {}
  };

  const issuedHere = async (transcript, offered) => {
    if (!transcript) return false;
    for (let tries = 0; ; tries++) {
      const text = readText(transcript);
      if (text !== null && text.split('\n').some((line) => line.includes(`"server":"${serverName}","tool":"chat_wake_code"`)
        && line.includes(`"structuredContent":{"code":"${offered}"`))) return true;
      if (tries >= 4) return false;
      await pause(1);
    }
  };

  const readInput = () => new Promise((resolve) => {
    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });

  const connectFromStop = async () => {
    if (!input) return;
    if (!serverName) {
      if (/ wake code: `?swc_[A-Za-z0-9_-]{43}/.test(input)) await deliverText(addressMissingText);
      return;
    }
    const offered = [...input.matchAll(new RegExp(`${escapeRegExp(serverName)} wake code: \`?(swc_[A-Za-z0-9_-]{43})\`?(?:\\\\n)?"`, 'g'))].at(-1)?.[1];
    if (!offered) return;
    if (token && !exists(join(dir, 'stopped'))) await deliverText(alreadyConnectedText);
    let transcript = '';
    try { transcript = `${JSON.parse(input).transcript_path ?? ''}`; } catch {}
    if (!(await issuedHere(transcript, offered))) await deliverText(foreignCodeText);
    let pluginUrl = '';
    try { pluginUrl = `${JSON.parse(readFileSync(join(pluginRoot, '.mcp.json'), 'utf8')).mcpServers[serverName].url ?? ''}`; } catch {}
    pluginUrl = pluginUrl.replace(/\/+$/, '').replace(/\/mcp$/, '');
    if (!pluginUrl) await deliverText(addressMissingText);
    try { mkdirSync(dir, { recursive: true }); } catch { await finish(0); }
    keepFolderToOwner(true);
    url = pluginUrl;
    code = offered;
    if (!saveSetting('POLYROOM_WAKE_URL', url) || !saveSetting('POLYROOM_WAKE_TOKEN', '') || !saveSetting('POLYROOM_WAKE_CODE', code)) await finish(0);
    if (await claim()) await deliverText(connectedText);
    saveSetting('POLYROOM_WAKE_CODE', '');
    if (claimStatus === 0) await deliverText(unreachableText);
    await deliverText(codeRefusedText);
  };

  const input = (action === 'wait' || action === 'listen') && !process.stdin.isTTY ? await readInput() : '';
  const field = (name) => {
    try {
      const value = JSON.parse(input)[name];
      return typeof value === 'string' && /^[A-Za-z0-9_.:-]+$/.test(value) ? value : '';
    } catch { return ''; }
  };
  const session = field('session_id');
  const turn = field('turn_id');
  const ownTurn = turn || field('prompt_id');

  if (product === 'codex' && action === 'wait') await connectFromStop();

  try { if (!statSync(dir).isDirectory()) await finish(0); } catch { await finish(0); }
  keepFolderToOwner(action === 'claim' || (!token && code !== ''));
  if (!url) await finish(0);

  if (action === 'claim') {
    if (!(await claim())) await finish(1);
    await finish(0, { stdout: 'Connected: this session now wakes on polyroom notices.\n' });
  }

  if (exists(join(dir, 'stopped'))) await finish(0);
  if (!token) {
    if (!code) await finish(0);
    if (!(await claim())) await finish(0);
  }
  const authorization = { Authorization: `Bearer ${token}` };

  const savedCursor = () => {
    const saved = marked(join(dir, 'cursor'));
    return saved.state === 'mine' ? saved.number : saved.state === 'foreign' ? unknownCursor : '0';
  };
  let cursor = savedCursor();

  if (action === 'session-start') {
    if (marked(join(dir, 'pending')).state !== 'mine' || attended) await finish(0);
    const answer = await send('GET', `${url}/wake?after=${cursor}&wait=0&format=session-start&redelivery=1`, authorization, null, margin);
    await finish(0, answer.status === 200 ? { stdout: answer.body } : {});
  }

  const busy = () => finish(0, product === 'codex' ? { stdout: `${JSON.stringify({ systemMessage: busyText })}\n` } : {});
  const holderOf = (name) => {
    if (name) {
      const text = readText(join(lock, name));
      if (text === null) return null;
      const [pid = '', heldSession = '', heldTurn = '', marker = ''] = text.split('\n');
      return { pid: isNumber(pid) ? Number(pid) : 0, session: heldSession, turn: heldTurn, beats: marker === 'beats' };
    }
    const pid = (readText(join(lock, 'pid')) ?? '').trim();
    const [heldSession = '', heldTurn = ''] = (readText(join(lock, 'owner')) ?? '').trim().split(' ');
    return { pid: isNumber(pid) ? Number(pid) : 0, session: heldSession, turn: heldTurn, beats: false };
  };
  const awaitLockTest = async (seen) => {
    const gate = process.env.POLYROOM_WAKE_LOCK_TEST_GATE;
    if (!gate) return;
    write(join(gate, String(process.pid)), `${seen}\n`);
    for (let tries = 0; tries < 400 && !exists(join(gate, `${process.pid}.go`)); tries++) await pause(0.05);
  };
  const beatOf = (name) => { try { return statSync(join(lock, name || 'pid')).mtimeMs; } catch { return null; } };
  const recent = (beat) => beat !== null && Date.now() - beat <= staleMs && beat - Date.now() <= heartbeatMs;
  const fresh = (name) => recent(beatOf(name));
  const withinOldBudget = (name) => {
    const beat = beatOf(name);
    return beat !== null && Date.now() - beat <= (budget + margin) * 1000 && beat - Date.now() <= heartbeatMs;
  };
  const holding = (name) => {
    const held = holderOf(name);
    if (!alive(held?.pid ?? 0)) return false;
    if (!cooperative) return true;
    return held.beats ? fresh(name) : withinOldBudget(name);
  };
  const previousVersionHolding = () => [...records(), ''].some((name) => holderOf(name)?.beats === false && holderOf(name).pid !== process.pid && holding(name));
  const beating = async (name) => {
    const first = beatOf(name);
    if (!recent(first)) return false;
    for (let waited = 0; waited <= staleMs; waited += heartbeatMs / 2) {
      await pause(heartbeatMs / 2000);
      const beat = beatOf(name);
      if (beat === null) return false;
      if (beat !== first) return alive(holderOf(name)?.pid ?? 0);
    }
    return false;
  };
  const earlierHolders = () => [...records().filter((name) => Number(name) < Number(record)), '']
    .map((name) => holderOf(name)?.pid ?? 0)
    .filter((pid) => pid !== process.pid && alive(pid));
  const stopCooperatively = async () => {
    const firstBeats = new Map(), proven = new Map();
    const live = () => records().filter((name) => Number(name) < Number(record) && holderOf(name)?.pid !== process.pid && holding(name));
    const provenLive = () => live().filter((name) => proven.get(name) === holderOf(name)?.pid);
    const observe = () => {
      for (const name of live()) {
        const beat = beatOf(name);
        if (!firstBeats.has(name)) firstBeats.set(name, beat);
        else if (beat !== firstBeats.get(name)) proven.set(name, holderOf(name)?.pid);
      }
    };
    for (let waited = 0; live().length > 0 && waited < takeoverSeconds * 1000; waited += heartbeatMs) {
      observe();
      await pause(heartbeatMs / 1000);
    }
    observe();
    for (const name of provenLive()) { try { process.kill(proven.get(name)); } catch {} }
    if (provenLive().length > 0) await pause(heartbeatMs / 1000);
    return provenLive().length === 0;
  };
  const stopEarlierHolders = async () => {
    if (cooperative) return stopCooperatively();
    const signal = (name) => { for (const pid of earlierHolders()) { try { process.kill(pid, name); } catch {} } };
    signal('SIGTERM');
    for (let tries = 0; earlierHolders().length > 0 && tries < 60; tries++) {
      if (tries === 50) signal('SIGKILL');
      await pause(0.1);
    }
    return earlierHolders().length === 0;
  };
  const tidyLock = () => {
    let names;
    try { names = readdirSync(lock); } catch { return; }
    for (const name of names) {
      const staging = /^\.new\.(\d+)$/.exec(name)?.[1];
      if (staging && !alive(Number(staging))) remove(join(lock, name));
      if (/^\d+$/.test(name) && Number(name) < Number(record) && !holding(name)) remove(join(lock, name));
    }
    if (!holding('')) {
      remove(join(lock, 'pid'));
      remove(join(lock, 'owner'));
    }
  };

  try { mkdirSync(lock, { recursive: true }); } catch {}
  const gaveWayFrom = Date.now();
  const gaveWaySeconds = () => Math.ceil((Date.now() - gaveWayFrom) / 1000);
  let gaveWay = false;
  while (cooperative && previousVersionHolding()) {
    gaveWay = true;
    if (!connectedAsBefore() || orphaned()) await finish(0);
    if (budget - gaveWaySeconds() - margin < 1) await deliverText(idleText);
    await pause(heartbeatMs / 1000);
  }
  const spentGivingWay = gaveWay ? gaveWaySeconds() : 0;
  const top = records().at(-1) ?? '';
  const holder = holderOf(top);
  if (!holder) await busy();
  const holderAlive = holder.pid !== process.pid && alive(holder.pid) && (!cooperative || await beating(top));
  const resumingListen = action === 'listen' && field('source') === 'resume';
  if (holderAlive && (!session || holder.session !== session || (holder.turn === ownTurn && !resumingListen))) await busy();
  await awaitLockTest(top || '0');
  const next = String(Number(top || '0') + 1);
  try {
    writeFileSync(staged, `${process.pid}\n${session}\n${ownTurn}\n${cooperative ? 'beats\n' : ''}`);
    linkSync(staged, join(lock, next));
  } catch {
    remove(staged);
    await busy();
  }
  remove(staged);
  record = next;
  if (cooperative) {
    watch = setInterval(() => {
      if (!holdsLock()) { current?.destroy(); process.exit(0); }
      const now = new Date();
      try { utimesSync(join(lock, record), now, now); } catch {}
    }, heartbeatMs);
  }
  if (!(await stopEarlierHolders()) || !holdsLock()) await finish(0);
  tidyLock();
  cursor = savedCursor();

  const pending = marked(join(dir, 'pending'));
  const deliveredToThisSession = action === 'listen' && session !== '' && sessionOfPending(pending) === session;
  let redelivery = action === 'listen' && pending.state === 'mine' && !deliveredToThisSession;
  if (pending.state === 'mine' && !redelivery && (deliveredToThisSession || !pending.turn || pending.turn === turn)) {
    cursor = pending.number;
    saveMarked(join(dir, 'cursor'), cursor);
  }
  removePending();

  const format = product === 'codex' ? 'stop' : 'text';
  const now = () => Math.floor(Date.now() / 1000);
  const deadline = now() + budget - spentGivingWay;
  let backoff = retryMin;
  for (;;) {
    let left = deadline - now();
    let waitNow = waitSeconds;
    if (waitNow + margin > left) waitNow = left - margin;
    if (waitNow < 1) break;
    if (!connectedAsBefore() || orphaned() || !holdsLock()) await finish(0);
    const answer = await send('GET', `${url}/wake?after=${cursor}&wait=${waitNow}&format=${format}${redelivery ? '&redelivery=1' : ''}`, authorization, null, waitNow + margin);
    if (!connectedAsBefore()) {
      if (answer.status === 200 && isNumber(answer.cursor)) await deliverBody(answer.body);
      await finish(0);
    }
    if (answer.status === 200 && isNumber(answer.cursor)) {
      if (orphaned() || !holdsLock()) await finish(0);
      if (/^\S+$/.test(session)) write(join(dir, 'pending-session'), `${ownMark()} ${answer.cursor} ${session}\n`);
      else remove(join(dir, 'pending-session'));
      saveMarked(join(dir, 'pending'), answer.cursor, turn);
      await deliverBody(answer.body);
    }
    if (!holdsLock()) await finish(0);
    if (answer.status === 204) {
      redelivery = false;
      if (cursor === unknownCursor && answer.cursor === unknownCursor) {
        cursor = '0';
        saveMarked(join(dir, 'cursor'), cursor);
      } else if (isNumber(answer.cursor) && answer.cursor !== cursor) {
        cursor = answer.cursor;
        saveMarked(join(dir, 'cursor'), cursor);
      }
      backoff = retryMin;
      continue;
    }
    if (answer.status === 401 || answer.status === 403) {
      write(join(dir, 'stopped'), '');
      await deliverText(refusedText);
    }
    left = deadline - now() - margin;
    if (left < 1) break;
    if (backoff > left) backoff = left;
    await pause(backoff);
    backoff = Math.min(backoff * 2, retryMax);
  }
  if (!holdsLock()) await finish(0);
  await deliverText(idleText);
}

function cksum(bytes) {
  let crc = 0;
  const step = (byte) => { crc = ((crc << 8) ^ cksumTable[((crc >>> 24) ^ byte) & 0xff]) >>> 0; };
  for (const byte of bytes) step(byte);
  for (let length = bytes.length; length > 0; length = Math.floor(length / 256)) step(length & 0xff);
  return String(~crc >>> 0);
}
