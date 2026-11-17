import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { botIdPattern } from './chat-client.mjs';

export function eventId(entry) {
  return String(entry.event.id);
}

function isPendingEntry(entry) {
  return entry !== null && typeof entry === 'object'
    && entry.event !== null && typeof entry.event === 'object'
    && entry.event.id !== undefined && entry.event.id !== null
    && typeof entry.storedAt === 'string' && !Number.isNaN(Date.parse(entry.storedAt));
}

export function addPending(pending, entries) {
  const known = new Set(pending.map(eventId));
  const fresh = [];
  for (const entry of entries) {
    const id = eventId(entry);
    if (known.has(id)) continue;
    known.add(id);
    fresh.push(entry);
  }
  return { pending: [...pending, ...fresh], added: fresh, dropped: [] };
}

export function removePending(pending, ids) {
  const wanted = new Set(ids.map(String));
  const removed = pending.filter((entry) => wanted.has(eventId(entry))).map(eventId);
  const removedSet = new Set(removed);
  return {
    pending: pending.filter((entry) => !removedSet.has(eventId(entry))),
    removed,
    unknown: [...wanted].filter((id) => !removedSet.has(id)),
  };
}

export function rememberAcknowledged(acknowledged, ids, max) {
  const fresh = ids.map(String);
  const freshSet = new Set(fresh);
  const merged = [...acknowledged.filter((id) => !freshSet.has(id)), ...new Set(fresh)];
  return merged.slice(Math.max(0, merged.length - max));
}

const transientWriteCodes = new Set(['EPERM', 'EBUSY', 'EACCES']);
const noRetry = { attempts: 1, retryMs: 0 };

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function retryTransient(action, { attempts, retryMs } = noRetry) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return action();
    } catch (error) {
      if (!transientWriteCodes.has(error?.code) || attempt >= attempts) throw error;
      sleepSync(retryMs);
    }
  }
}

export function writeJsonAtomic(file, value, retry = noRetry, rename = renameSync) {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value));
  try {
    retryTransient(() => rename(temporary, file), retry);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

export const stateKinds = ['cursor', 'pending', 'handoff'];

export class StateConflict extends Error {
  constructor({ handle, directory, files, detail, advice }) {
    super(`The old state of @${handle}, kept only by handle in ${directory} (${files.join(', ')}), ${detail}. Nothing was adopted or deleted. `
      + `Stop this long polling session, which holds the bot lock. ${advice}`);
    this.name = 'StateConflict';
  }
}

const botIdHint = 'the id of each bot is shown as botId in chat_polling_status';
const keepOneAdvice = 'Compare the files and keep only one of each pair: move the other out of the data folder. The two are never merged automatically.';
const pairNames = (entries) => entries.map(({ from, to }) => `${basename(from)} and ${basename(to)}`).join('; ');

function ownStateAdvice({ pairs, unpaired, botId }) {
  const advice = [];
  if (pairs.length) advice.push(`In each pair (${pairNames(pairs)}), compare the two files and keep only one: move the other out of the data folder. The two are never merged automatically.`);
  if (unpaired.length) {
    advice.push(`The old files without a pair (${unpaired.map(({ from }) => basename(from)).join(', ')}) have no file of this bot to compare with: move them out of the data folder or, if they belong to this bot, write "botId": "${botId}" in them (${botIdHint})`
      + (pairs.length ? ', and the bot adopts them on the next start, after the pairs are resolved.' : ', and the bot adopts them on the next start.'));
  }
  return advice.join(' ');
}

export function stateFile(directory, kind, handle, botId) {
  return join(directory, botId ? `${kind}-${handle}.${botId}.json` : `${kind}-${handle}.json`);
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function cursorProblem(data) {
  return isPlainObject(data) && Number.isSafeInteger(data.cursor) && data.cursor >= 0 ? null : 'corrupted cursor; expected a non-negative integer';
}

function queueProblem(data) {
  if (!isPlainObject(data) || !Array.isArray(data.pending)) return 'corrupted queue: pending is not a list';
  if (!data.pending.every(isPendingEntry)) return 'corrupted queue: malformed pending entries';
  if (data.pending.some((entry) => entry.state !== undefined && !['queued', 'waiting', 'processing', 'suspended'].includes(entry.state))) return 'corrupted queue: unknown state';
  if (data.pending.some((entry) => entry.attempt !== undefined && (!Number.isSafeInteger(entry.attempt) || entry.attempt < -1))) return 'corrupted queue: invalid attempt';
  if (data.acknowledged !== undefined && !Array.isArray(data.acknowledged)) return 'corrupted queue: acknowledged is not a list';
  if (Array.isArray(data.acknowledged) && !data.acknowledged.every((id) => typeof id === 'string' || Number.isSafeInteger(id))) return 'corrupted queue: invalid acknowledged ids';
  return null;
}

const legacyProblem = { cursor: cursorProblem, pending: queueProblem, handoff: (data) => (isPlainObject(data) ? null : 'corrupted handoff: expected an object') };

export function createStateStore({ directory, handle, botId, log, now = Date.now, writeRetry = noRetry, rename = renameSync }) {
  const cursorFile = stateFile(directory, 'cursor', handle, botId);
  const pendingFile = stateFile(directory, 'pending', handle, botId);
  const legacyLockFile = join(directory, `poller-${handle}.lock`);
  const owned = botId ? { botId } : {};
  const belongsHere = (data, file) => {
    if (!botId || data?.botId === botId) return true;
    log(`the state file ${file} belongs to bot ${data?.botId ?? 'unknown'}, not ${botId}; it was discarded and this bot starts from zero`);
    return false;
  };

  function readJson(file) {
    let raw;
    try {
      raw = readFileSync(file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return undefined;
      throw new Error(`cannot read state file ${file}; preserved for repair`);
    }
    try {
      return JSON.parse(raw);
    } catch (error) {
      throw new Error(`corrupted state file ${file}; preserved for repair`);
    }
  }

  return {
    cursorFile,
    pendingFile,

    readCursor() {
      const data = readJson(cursorFile);
      if (data === undefined || !belongsHere(data, cursorFile)) return null;
      const problem = cursorProblem(data);
      if (problem) throw new Error(problem);
      return { cursor: data.cursor, backlog: data.backlog === true };
    },

    writeCursor(cursor, { backlog = false } = {}) {
      writeJsonAtomic(cursorFile, { ...owned, cursor, savedAt: new Date(now()).toISOString(), ...(backlog ? { backlog: true } : {}) }, writeRetry, rename);
    },

    readQueue() {
      const data = readJson(pendingFile);
      if (data === undefined || !belongsHere(data, pendingFile)) return { pending: [], acknowledged: [], unreportedAcks: [] };
      const problem = queueProblem(data);
      if (problem) throw new Error(problem);
      return {
        pending: addPending([], data.pending, Number.MAX_SAFE_INTEGER).pending,
        acknowledged: rememberAcknowledged([], data.acknowledged ?? [], Number.MAX_SAFE_INTEGER),
        unreportedAcks: Array.isArray(data.unreportedAcks) ? data.unreportedAcks.filter((id) => Number.isSafeInteger(id) && id > 0) : [],
      };
    },

    writeQueue({ pending, acknowledged, unreportedAcks = [] }) {
      writeJsonAtomic(pendingFile, { ...owned, pending, acknowledged, ...(unreportedAcks.length ? { unreportedAcks } : {}), savedAt: new Date(now()).toISOString() },
        writeRetry, rename);
    },

    adoptHandleState() {
      if (!botId) return false;
      const entries = stateKinds.map((kind) => {
        const from = stateFile(directory, kind, handle);
        const data = readJson(from);
        if (data !== undefined && legacyProblem[kind](data)) throw new Error(`corrupted state file ${from}; preserved for repair`);
        return { kind, from, to: stateFile(directory, kind, handle, botId), data };
      });
      const legacy = entries.filter(({ data }) => data !== undefined);
      if (!legacy.length) return false;
      const files = legacy.map(({ from }) => basename(from));
      const owners = [...new Set(legacy.map(({ data }) => data.botId).filter((id) => id !== undefined))];
      if (owners.length > 1) {
        throw new StateConflict({ handle, directory, files, detail: `is marked by two bots (${owners.join(', ')})`,
          advice: `Leave in each file the "botId" of the bot that owns it (${botIdHint}) or move the files out of the data folder.` });
      }
      const [owner] = owners;
      if (owner !== undefined && owner !== botId) {
        log(`the state of @${handle} kept by handle belongs to bot ${owner}, not ${botId}; it was left untouched and this bot starts from zero`);
        return false;
      }
      const ownFiles = entries.filter(({ to }) => existsSync(to)).map(({ to }) => basename(to));
      if (owner === undefined && ownFiles.length) {
        const pairs = legacy.filter(({ to }) => existsSync(to));
        const unpaired = legacy.filter(({ to }) => !existsSync(to));
        throw new StateConflict({ handle, directory, files, detail: `does not say which bot it belongs to, and this bot (${botId}) already has its own state in this folder (${ownFiles.join(', ')})`,
          advice: ownStateAdvice({ pairs, unpaired, botId }) });
      }
      const others = this.otherBots();
      if (owner === undefined && others.length) {
        throw new StateConflict({ handle, directory, files, detail: `does not say which bot it belongs to, and there is already state of another bot with the same handle (${others.join(', ')})`,
          advice: `If the old state belongs to this bot, write "botId": "${botId}" in each of these files (${botIdHint}) and start again: since this bot has no state of its own yet, the adoption loses nothing. If not, move these files out of the data folder.` });
      }
      const clashes = legacy.filter(({ to, data }) => existsSync(to) && !isDeepStrictEqual(readJson(to), { ...data, botId }));
      if (clashes.length) {
        throw new StateConflict({ handle, directory, files, advice: keepOneAdvice,
          detail: `is marked with this bot (${botId}), but differs from the bot file (${pairNames(clashes)})` });
      }
      for (const { from, data } of legacy) if (data.botId !== botId) writeJsonAtomic(from, { ...data, botId }, writeRetry, rename);
      const copied = [];
      for (const kind of ['pending', 'handoff', 'cursor']) {
        const entry = legacy.find((item) => item.kind === kind);
        if (!entry || existsSync(entry.to)) continue;
        writeJsonAtomic(entry.to, { ...entry.data, botId }, writeRetry, rename);
        copied.push(kind);
      }
      for (const { from } of legacy) retryTransient(() => rmSync(from, { force: true }), writeRetry);
      log(copied.length
        ? `adopted the state of @${handle} kept by handle for bot ${botId} (${copied.join(', ')})`
        : `removed the state of @${handle} kept by handle, already marked and copied by bot ${botId}`);
      return copied.length > 0;
    },

    otherBots() {
      let names = [];
      try { names = readdirSync(directory); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const ids = new Set();
      for (const kind of stateKinds) {
        const prefix = `${kind}-${handle}.`;
        for (const name of names) {
          if (!name.startsWith(prefix) || !name.endsWith('.json')) continue;
          const id = name.slice(prefix.length, -'.json'.length);
          if (id !== botId && botIdPattern.test(id)) ids.add(id);
        }
      }
      return [...ids];
    },

    companionFile(kind) {
      return stateFile(directory, kind, handle, botId);
    },

    removeLegacyLock() {
      rmSync(legacyLockFile, { force: true });
    },
  };
}
