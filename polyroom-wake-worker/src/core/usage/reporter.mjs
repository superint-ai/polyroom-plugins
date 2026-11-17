import { createHash } from 'node:crypto';
import { open, readdir } from 'node:fs/promises';
import { readFileSync, renameSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { retryAfterMs } from '../chat-client.mjs';
import { writeJsonAtomic } from '../state.mjs';
import { createWait } from '../wait.mjs';
import { hourOf, minuteOf, priceTier } from './calls.mjs';
import { claudeEntry, claudeMarkers, claudePrompt, claudeTokens, mergeRaw } from './claude.mjs';
import { codexEvent, codexHeader, codexIdentities, codexMarkers, codexSessionIdPattern } from './codex.mjs';
import { readFirstLine, readHead, readNewLines } from './lines.mjs';

const hourMs = 3_600_000;
const tokenFields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWrite5mTokens', 'cacheWrite1hTokens', 'reasoningTokens'];
const dropStatuses = new Set([400, 422]);
const resetAdvice = 'It was left unchanged; delete the file to count usage again from POLYROOM_USAGE_SINCE. The list of authorized Codex sessions goes with it: add them again with npm run usage-sessions.';
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function longPromptTiersOf(value) {
  if (!isObject(value)) return null;
  const entries = Object.entries(value);
  if (!entries.length || !entries.every(([model, tokens]) => /^[A-Za-z0-9._-]+$/.test(model) && Number.isSafeInteger(tokens) && tokens > 0)) return null;
  return new Map(entries);
}
const validIds = (value) => Array.isArray(value) && value.every((id) => typeof id === 'string' && codexSessionIdPattern.test(id));

export const freshUsageState = (botId) => ({ botId, since: null, prunedBefore: null, codexSessions: [], unassignedSessions: [], files: {}, calls: {}, sessions: {}, buckets: {}, hours: {} });

export function usageStateFile(directory, handle, botId) {
  return join(directory, `usage-${handle}.${botId}.json`);
}

export class UsageStateProblem extends Error {}

export function loadUsageState(file, botId, log) {
  let raw;
  try { raw = readFileSync(file, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return freshUsageState(botId);
    throw new UsageStateProblem(`The usage state of this bot could not be read (${error.code}). ${resetAdvice}`);
  }
  let data;
  try { data = JSON.parse(raw); }
  catch { throw new UsageStateProblem(`The usage state of this bot (${basename(file)}) is corrupted. ${resetAdvice}`); }
  if (!isObject(data) || !['files', 'calls', 'sessions', 'buckets', 'hours'].every((field) => isObject(data[field])) || !validIds(data.codexSessions) || !validIds(data.unassignedSessions)
    || (data.since !== null && typeof data.since !== 'string') || (data.prunedBefore !== null && typeof data.prunedBefore !== 'string')) {
    throw new UsageStateProblem(`The usage state of this bot (${basename(file)}) has an unexpected format. ${resetAdvice}`);
  }
  if (data.botId !== botId) {
    log(`the usage state file ${basename(file)} belongs to bot ${data.botId ?? 'unknown'}, not ${botId}; usage is counted again from POLYROOM_USAGE_SINCE`);
    return freshUsageState(botId);
  }
  return data;
}

export function saveUsageState(file, state, writeRetry, rename) {
  writeJsonAtomic(file, state, writeRetry, rename);
}

async function jsonlFiles(directory) {
  const found = [];
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  for (const entry of entries) if (entry.isFile() && entry.name.endsWith('.jsonl')) found.push(join(entry.parentPath, entry.name));
  return found.sort();
}

export async function codexSessionFileExists(codexDir, id, lineMaxBytes) {
  if (!codexSessionIdPattern.test(id)) return false;
  let paths;
  try { paths = await jsonlFiles(resolve(codexDir)); } catch { return false; }
  for (const path of paths) {
    if (!basename(path).endsWith(`${id}.jsonl`)) continue;
    const first = await readFirstLine(path, lineMaxBytes).catch(() => null);
    if (first !== null && codexHeader(first)?.id === id) return true;
  }
  return false;
}

export function bucketKey({ source, model, priceTier: tier, at }) {
  return [source, model, tier, hourOf(at)].join('|');
}

function addToBucket(state, call, connection, { newCall }) {
  const { buckets, hours } = state;
  const key = bucketKey(call);
  const bucket = (buckets[key] ??= {
    source: call.source, provider: call.provider, model: call.model, connection, priceTier: call.priceTier, periodStart: hourOf(call.at),
    calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: null, reasoningTokens: null, minutes: [], dirty: true,
  });
  bucket.provider = call.provider;
  bucket.connection = connection;
  if (newCall) bucket.calls += 1;
  for (const field of tokenFields) if (call.tokens[field] !== null) bucket[field] = (bucket[field] ?? 0) + call.tokens[field];
  const minute = minuteOf(call.at);
  if (!bucket.minutes.includes(minute)) bucket.minutes.push(minute);
  bucket.dirty = true;
  const hour = (hours[bucket.periodStart] ??= []);
  if (hour.includes(minute)) return;
  hour.push(minute);
  for (const other of Object.values(buckets)) if (other.periodStart === bucket.periodStart) other.dirty = true;
}

export function reportRow(bucket, collectorVersion, agentMinutes) {
  const { minutes, dirty, ...row } = bucket;
  return { ...row, activeMinutes: minutes.length, agentActiveMinutes: agentMinutes, measurement: 'measured', collectorVersion };
}

const tokenDifference = (after, before) => Object.fromEntries(tokenFields.map((field) => [field, after[field] === null ? null : after[field] - (before[field] ?? 0)]));
const fileIdentity = (info) => `${info.ino}:${Math.round(info.birthtimeMs)}`;
const headCheckBytes = 4096;

async function fileHead(opened, size) {
  const head = await readHead(opened, Math.min(size, headCheckBytes));
  return { bytes: head.length, sha256: createHash('sha256').update(head).digest('hex') };
}

async function sameHead(opened, head) {
  return (await fileHead(opened, head.bytes)).sha256 === head.sha256;
}

export function createUsageReporter({ config, dataDirectory, handle, version, log, clock, fetch = globalThis.fetch, writeRetry, rename = renameSync, statFile = (path, opened) => opened.stat(), readLines = readNewLines }) {
  const wait = createWait(clock);
  const stopping = new AbortController();
  const collectorVersion = `mcp-long-polling/${version}`;
  let state = null;
  let file = null;
  let loop = null;
  let stopped = false;
  let retryAt = 0;
  let lastUnassigned = -1;
  const round = { late: 0, unreadable: new Map(), skippedLines: 0, shrank: 0 };
  const report = { state: 'waiting_identity', lastReportAt: null, lastError: null, lastErrorAt: null, problems: [], unassignedCodexSessions: 0, lateCalls: 0 };

  const fail = (message) => {
    report.lastError = message;
    report.lastErrorAt = new Date(clock.now()).toISOString();
    log(`usage: ${message}`);
  };
  const save = () => saveUsageState(file, state, writeRetry, rename);
  const sinceMs = () => Date.parse(state.since);
  const counts = (at) => at >= sinceMs();
  const closed = (call) => state.prunedBefore !== null && Date.parse(hourOf(call.at)) <= Date.parse(state.prunedBefore) && !state.buckets[bucketKey(call)];
  let chatTiers = null;
  let tiersWarned = false;
  const tierOf = (model, prompt) => priceTier(model, prompt, chatTiers ?? config.longPromptTiers);
  function learnTiers(answer) {
    const tiers = longPromptTiersOf(answer?.longPromptTiers);
    if (!tiers) return;
    chatTiers = tiers;
    state.longPromptTiers = Object.fromEntries(tiers);
    tiersWarned = false;
  }
  async function askTiers() {
    try {
      const response = await fetch(config.url, {
        method: 'POST',
        headers: { Authorization: config.authorization, 'Content-Type': 'application/json', 'User-Agent': config.userAgent },
        body: JSON.stringify({ rows: [] }),
        signal: AbortSignal.any([AbortSignal.timeout(config.timeoutMs), stopping.signal]),
      });
      if (response.ok) learnTiers(await response.json().catch(() => null));
    } catch {
      if (stopped) return;
    }
    if (!chatTiers && !tiersWarned) {
      tiersWarned = true;
      log('usage: the chat did not send the long prompt limits; POLYROOM_USAGE_LONG_PROMPT_TIERS is used until it does');
    }
  }

  function takeClaude(line) {
    const entry = claudeEntry(line);
    if (!entry) return;
    const known = state.calls[entry.key];
    if (known) {
      const raw = mergeRaw(known.raw, entry.raw);
      const tokens = tokenDifference(claudeTokens(raw), claudeTokens(known.raw));
      known.raw = raw;
      if (tokenFields.every((field) => !tokens[field])) return;
      addToBucket(state, { ...known, at: known.at, tokens }, config.connection, { newCall: false });
      return;
    }
    if (!counts(entry.at)) return;
    const call = { source: 'claude-code', provider: 'anthropic', model: entry.model, priceTier: tierOf(entry.model, claudePrompt(entry.raw)), at: entry.at };
    if (closed(call)) { round.late += 1; return; }
    state.calls[entry.key] = { ...call, raw: entry.raw };
    addToBucket(state, { ...call, tokens: claudeTokens(entry.raw) }, config.connection, { newCall: true });
  }

  function takeCodex(line, fileState) {
    const event = codexEvent(line, fileState, state.sessions);
    if (!event || !counts(event.at)) return;
    const call = { source: 'codex', provider: event.provider, model: event.model, priceTier: tierOf(event.model, event.prompt), at: event.at, tokens: event.tokens };
    if (closed(call)) { round.late += 1; return; }
    addToBucket(state, call, config.connection, { newCall: true });
  }

  const codexSource = {
    dir: config.codexDir,
    markers: codexMarkers,
    async admits(path, fileState, unassigned) {
      if (fileState.header === undefined) {
        const first = await readFirstLine(path, config.lineMaxBytes);
        if (first === null) return false;
        fileState.header = codexHeader(first);
      }
      if (fileState.header && codexIdentities(fileState.header).some((id) => state.codexSessions.includes(id))) return true;
      if (fileState.header) unassigned.add(fileState.header.id);
      return false;
    },
    take: takeCodex,
  };
  const claudeSource = { dir: config.claudeDir, markers: claudeMarkers, admits: async () => true, take: (line) => takeClaude(line) };
  const sources = [claudeSource, codexSource].filter((source) => source.dir).map((source) => Object.assign(source, { dir: resolve(source.dir) }));

  async function readFile(source, path, unassigned) {
    const opened = await open(path, 'r');
    try {
      const info = await statFile(path, opened);
      let fileState = state.files[path];
      const fresh = () => {
        fileState = { offset: 0, size: -1, mtimeMs: -1, identity: fileIdentity(info) };
        state.files[path] = fileState;
      };
      if (!fileState || fileState.identity !== fileIdentity(info)) fresh();
      else if (fileState.head && info.size >= fileState.offset && !(await sameHead(opened, fileState.head))) fresh();
      if (fileState.size === info.size && fileState.mtimeMs === info.mtimeMs) return true;
      if (!(await source.admits(path, fileState, unassigned))) return true;
      if (info.size < fileState.offset) {
        round.shrank += 1;
        fileState.offset = 0;
      }
      const result = await readLines({ file: path, handle: opened, offset: fileState.offset, maxLineBytes: config.lineMaxBytes, markers: source.markers,
        onLine: (line) => source.take(line, fileState), shouldStop: () => stopped });
      if (result.aborted) return false;
      round.skippedLines += result.skipped;
      Object.assign(fileState, { offset: result.offset, size: info.size, mtimeMs: info.mtimeMs, head: await fileHead(opened, info.size) });
      return true;
    } finally {
      await opened.close();
    }
  }

  async function collect() {
    const unassigned = new Set();
    for (const source of sources) {
      let paths;
      try { paths = await jsonlFiles(source.dir); }
      catch (error) {
        fail(`could not read the ${source === claudeSource ? 'Claude Code' : 'Codex'} sessions folder (${error.code ?? error.name})`);
        continue;
      }
      const present = new Set(paths);
      for (const known of Object.keys(state.files)) if (known.startsWith(source.dir + sep) && !present.has(known)) delete state.files[known];
      for (const path of paths) {
        if (stopped) return false;
        try { if (!(await readFile(source, path, unassigned))) return false; }
        catch (error) {
          const code = error.code ?? error.name;
          round.unreadable.set(code, (round.unreadable.get(code) ?? 0) + 1);
        }
      }
    }
    state.unassignedSessions = [...unassigned].sort();
    report.unassignedCodexSessions = unassigned.size;
    if (unassigned.size !== lastUnassigned) {
      lastUnassigned = unassigned.size;
      if (unassigned.size) log(`usage: ${unassigned.size} Codex sessions are not assigned to this bot and were left out; npm run usage-sessions lists them`);
    }
    return true;
  }

  function reportRound() {
    report.lateCalls = round.late;
    if (round.late) log(`usage: ${round.late} calls belong to hours already sent and dropped from the state, older than POLYROOM_USAGE_KEEP_HOURS, and were left out`);
    if (round.skippedLines) log(`usage: ${round.skippedLines} session lines are longer than POLYROOM_USAGE_LINE_MAX_BYTES and were skipped`);
    if (round.shrank) log(`usage: ${round.shrank} session files shrank below the position already read; they are read again from the start, and calls already counted are skipped`);
    if (round.unreadable.size) {
      const unreadable = [...round.unreadable.values()].reduce((sum, value) => sum + value, 0);
      fail(unreadable === 1
        ? `1 session file could not be read (${[...round.unreadable.keys()].join(', ')}); it is tried again in the next round`
        : `${unreadable} session files could not be read (${[...round.unreadable.keys()].join(', ')}); they are tried again in the next round`);
    }
    Object.assign(round, { late: 0, unreadable: new Map(), skippedLines: 0, shrank: 0 });
  }

  async function post(batch) {
    try {
      return await fetch(config.url, {
        method: 'POST',
        headers: { Authorization: config.authorization, 'Content-Type': 'application/json', 'User-Agent': config.userAgent },
        body: JSON.stringify({ rows: batch.map((bucket) => reportRow(bucket, collectorVersion, state.hours[bucket.periodStart]?.length ?? bucket.minutes.length)) }),
        signal: AbortSignal.any([AbortSignal.timeout(config.timeoutMs), stopping.signal]),
      });
    } catch (error) {
      if (stopped) return null;
      fail(`sending usage to the chat failed (${error.name}); it is kept and sent again in the next round`);
      return null;
    }
  }

  async function send() {
    const dirty = Object.values(state.buckets).filter((bucket) => bucket.dirty);
    let start = 0;
    let batchRows = config.maxRows;
    while (start < dirty.length && !stopped) {
      const batch = dirty.slice(start, start + batchRows);
      const response = await post(batch);
      if (!response) return;
      if (response.status === 429 || response.status === 503) {
        retryAt = clock.now() + (retryAfterMs(response.headers.get('retry-after'), clock.now) ?? config.intervalMs);
        fail(`the chat asked to wait before receiving usage (${response.status})`);
        return;
      }
      if (response.status === 413 && batch.length > 1) {
        batchRows = Math.max(1, Math.floor(batch.length / 2));
        log(`usage: the chat found a batch of ${batch.length} rows too large; batches now carry ${batchRows} rows`);
        continue;
      }
      if (dropStatuses.has(response.status) || response.status === 413) {
        for (const bucket of batch) bucket.dirty = false;
        fail(batch.length === 1
          ? `the chat refused a batch of 1 hour of usage (${response.status}); it is not sent again, and sending goes on with the others`
          : `the chat refused a batch of ${batch.length} hours of usage (${response.status}); they are not sent again, and sending goes on with the others`);
        start += batch.length;
        continue;
      }
      if (!response.ok) {
        fail(response.status === 401 || response.status === 403
          ? `the chat refused the bot credential when receiving usage (${response.status})`
          : `the chat answered ${response.status} when receiving usage; it is kept and sent again in the next round`);
        return;
      }
      const answer = await response.json().catch(() => null);
      learnTiers(answer);
      const refused = Array.isArray(answer?.rejected) ? answer.rejected : [];
      if (refused.length) log(`usage: the chat refused ${refused.length} of ${batch.length} rows (${[...new Set(refused.map((entry) => entry?.field))].join(', ')}); they are not sent again`);
      for (const bucket of batch) bucket.dirty = false;
      report.lastReportAt = new Date(clock.now()).toISOString();
      start += batch.length;
    }
  }

  function prune() {
    const oldest = clock.now() - config.keepHours * hourMs;
    let newest = state.prunedBefore === null ? -Infinity : Date.parse(state.prunedBefore);
    for (const [key, bucket] of Object.entries(state.buckets)) {
      const hour = Date.parse(bucket.periodStart);
      if (bucket.dirty || hour + hourMs >= oldest) continue;
      delete state.buckets[key];
      newest = Math.max(newest, hour);
    }
    if (newest === -Infinity) return;
    state.prunedBefore = new Date(newest).toISOString();
    for (const [key, call] of Object.entries(state.calls)) if (Date.parse(hourOf(call.at)) <= newest && !state.buckets[bucketKey(call)]) delete state.calls[key];
    for (const [key, session] of Object.entries(state.sessions)) {
      const hour = hourOf(session.at);
      const pending = Object.values(state.buckets).some((bucket) => bucket.source === 'codex' && Date.parse(bucket.periodStart) <= Date.parse(hour));
      if (Date.parse(hour) <= newest && !pending) delete state.sessions[key];
    }
    for (const hour of Object.keys(state.hours)) if (Date.parse(hour) <= newest && !Object.values(state.buckets).some((bucket) => bucket.periodStart === hour)) delete state.hours[hour];
  }

  async function tick() {
    if (!chatTiers && clock.now() >= retryAt) await askTiers();
    if (stopped) return;
    if (!(await collect())) return;
    reportRound();
    if (!stopped && clock.now() >= retryAt) {
      await send();
      prune();
    }
    if (!stopped) save();
  }

  async function run() {
    while (!stopped) {
      try { await tick(); }
      catch (error) { fail(`the usage round failed (${error.code ?? error.name})`); }
      if (!stopped) await wait(config.intervalMs);
    }
  }

  function load(botId) {
    file = usageStateFile(dataDirectory, handle, botId);
    try { state = loadUsageState(file, botId, log); }
    catch (error) {
      report.state = 'stopped_state';
      report.problems = [error.message];
      log(`usage: ${error.message}`);
      return false;
    }
    const configured = config.since == null ? null : new Date(config.since).toISOString();
    state.since = configured ?? state.since ?? hourOf(clock.now());
    chatTiers = longPromptTiersOf(state.longPromptTiers);
    report.state = 'running';
    return true;
  }

  function authorizeCodexSession(id) {
    if (!codexSessionIdPattern.test(id)) return;
    if (!state) {
      log(`usage: the Codex session ${id} could not be assigned to this bot, because the usage state is stopped; add it later with npm run usage-sessions`);
      return;
    }
    if (state.codexSessions.includes(id)) return;
    state.codexSessions.push(id);
    save();
    log(`usage: Codex session ${id} assigned to this bot`);
  }

  async function registerEnvironmentSession(id) {
    if (!id) {
      report.codexSession = { registered: false, reason: 'Codex session not identified: the process did not receive CODEX_SESSION_ID' };
    } else if (!config.codexDir || !(await codexSessionFileExists(config.codexDir, id, config.lineMaxBytes))) {
      report.codexSession = { id, registered: false, reason: 'CODEX_SESSION_ID does not match any session file in the POLYROOM_USAGE_CODEX_DIR folder; nothing was assigned' };
    } else {
      authorizeCodexSession(id);
      report.codexSession = { id, registered: true };
    }
    log(`usage: ${report.codexSession.registered ? `Codex session ${id} registered from CODEX_SESSION_ID` : report.codexSession.reason}`);
  }

  return {
    load,
    tick,
    authorizeCodexSession,
    registerEnvironmentSession,
    start(botId, { environmentSession } = {}) {
      if (loop || stopped || !load(botId)) return;
      loop = (async () => {
        if (environmentSession) await registerEnvironmentSession(environmentSession.id).catch((error) => fail(`the Codex session could not be registered (${error.code ?? error.name})`));
        await run();
      })();
    },
    async stop() {
      stopped = true;
      stopping.abort();
      wait.cancel();
      await loop;
      if (report.state === 'running') report.state = 'stopped';
    },
    status() {
      const pendingRows = state ? Object.values(state.buckets).filter((bucket) => bucket.dirty).length : 0;
      const { problems, ...rest } = report;
      return { ...rest, pendingRows, since: state?.since ?? null, ...(problems.length ? { problems } : {}) };
    },
  };
}
