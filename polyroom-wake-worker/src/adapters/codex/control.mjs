import { existsSync, readFileSync } from 'node:fs';
import { createStateStore, StateConflict, writeJsonAtomic } from '../../core/state.mjs';

export const handoffKind = 'handoff';
import { botLockTarget, lockTarget, tryAcquireLock } from '../../core/lock.mjs';
import { WorkerProblems } from './config.mjs';
import { botIdPattern } from '../../core/chat-client.mjs';

export async function withOfflineState(config, action) {
  if (typeof config.botId !== 'string' || !botIdPattern.test(config.botId)) throw new WorkerProblems(['Could not find out the bot id; nothing was changed. Check the bot token and run it again.']);
  const busy = () => new WorkerProblems([`The bot @${config.handle} already has a consumer running on this machine. Stop the worker (stop) before changing the state.`]);
  const target = botLockTarget({ botId: config.botId, platform: process.platform, directory: config.dataDirectory });
  const address = await tryAcquireLock(lockTarget({ handle: config.handle, companySlug: config.companySlug ?? null, platform: process.platform, directory: config.dataDirectory }));
  if (!address) throw busy();
  try {
    const lock = await tryAcquireLock(target);
    if (!lock) throw busy();
    try { return await stateAction(config, action); }
    finally { await lock.release(); }
  } finally { await address.release(); }
}

async function stateAction(config, action) {
  const store = createStateStore({ directory: config.dataDirectory, handle: config.handle, botId: config.botId, log: () => {}, writeRetry: config.writeRetry });
  try { store.adoptHandleState(); }
  catch (error) { throw error instanceof StateConflict ? new WorkerProblems([error.message]) : error; }
  return await action(store);
}

export function importMonitor(store, config, sourceFile) {
  let snapshot;
  try { snapshot = JSON.parse(readFileSync(sourceFile, 'utf8')); }
  catch { throw new WorkerProblems([`Could not read the monitor at ${sourceFile}.`]); }
  if (!Number.isSafeInteger(snapshot.notificationCursor) || snapshot.notificationCursor < 0) throw new WorkerProblems(['The monitor cursor (notificationCursor) is invalid.']);
  if (!Array.isArray(snapshot.historicalQueue) || snapshot.historicalQueue.length) throw new WorkerProblems(['Reconcile the monitor historical candidates (historicalQueue) before importing.']);
  if ((snapshot.sendIntents ?? []).some((intent) => !['confirmed', 'cancelled'].includes(intent.status))) throw new WorkerProblems(['Reconcile the monitor uncertain send intents before importing.']);
  if (Object.values(snapshot.rooms ?? {}).some((room) => room.myClaims?.length)) throw new WorkerProblems(['Reconcile the monitor active claims before importing.']);
  const handoffFile = store.companionFile(handoffKind);
  if (existsSync(store.cursorFile) || existsSync(store.pendingFile) || existsSync(handoffFile)) throw new WorkerProblems(['The target already has state; the import does not replace files. Check them first.']);
  const now = new Date().toISOString();
  writeJsonAtomic(handoffFile, config.botId ? { ...snapshot, botId: config.botId } : snapshot, config.writeRetry);
  store.writeQueue({ pending: [{ event: { id: `handoff-${snapshot.notificationCursor}`, kind: 'handoff', reason: 'monitor_handoff', createdAt: now },
    storedAt: now, state: 'queued', attempt: -1, origin: 'restored' }], acknowledged: [] });
  store.writeCursor(snapshot.notificationCursor);
  return { cursor: snapshot.notificationCursor, handoffQueued: true };
}

export function retryOffline(store, ids) {
  if (!ids.length) throw new WorkerProblems(['Give the ids of the notices that should go back to the queue.']);
  const wanted = new Set(ids);
  const data = store.readQueue();
  const retried = [];
  const pending = data.pending.map((entry) => {
    if (!wanted.has(String(entry.event.id))) return entry;
    if (!['suspended', 'processing'].includes(entry.state)) return entry;
    retried.push(String(entry.event.id));
    return { ...entry, state: 'queued', attempt: -1, origin: 'restored', leaseUntil: null, reason: null };
  });
  store.writeQueue({ pending, acknowledged: data.acknowledged });
  return { retried };
}

export function statusFiles(config) {
  const store = createStateStore({ directory: config.dataDirectory, handle: config.handle, botId: config.botId ?? undefined, log: () => {} });
  const queue = store.readQueue();
  return { cursor: store.readCursor(),
    events: queue.pending.map(({ event, state, reason, attempt, storedAt }) => ({ id: String(event.id), state: state ?? 'legacy', reason, attempt, storedAt })) };
}
