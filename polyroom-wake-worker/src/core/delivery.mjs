import { AuthRejected, ConfigRejected } from './chat-client.mjs';
import { addPending, eventId, rememberAcknowledged, removePending, StateConflict } from './state.mjs';
import { fallbackNoticeLocale, noticeTexts, statusTexts } from '../notices.mjs';
import { processingLeaseMaxMs } from './config.mjs';
import { createWait } from './wait.mjs';

export class StateNotLoaded extends Error {
  constructor() {
    super('the long polling state is not loaded yet');
    this.name = 'StateNotLoaded';
  }
}

const hourMs = 3_600_000;

export function createDelivery({ config, client, store: openedStore = null, openStore, emit, clock, log, intercept = null }) {
  let store = openedStore;
  const backlogMs = config.backlogHours * hourMs;
  const deliveries = new Map();
  const retryWait = createWait(clock);
  let pending = [];
  let acknowledged = [];
  let unreportedAcks = [];
  let reportingAcks = false;
  let ackReportFailed = false;
  let cursor = null;
  let collectingBacklog = false;
  let state = 'polling';
  let locale = fallbackNoticeLocale;
  let problems = [];
  let stopped = false;
  let halted = false;
  let dispatchPaused;
  let pumping = false;
  let lastError = null;
  let lastErrorAt = null;
  let queueFull = false;
  let queueFullNotified = false;
  let backlogCutoff = null;
  let lastDelivered = null;
  const suspendedNotices = new Map();
  let suspendedNoticeTimer = null;
  let overCapacityLogged = false;
  const timestamp = () => new Date(clock.now()).toISOString();
  const find = (id) => pending.find((entry) => eventId(entry) === String(id));
  const statusNotification = (state, content) => ({ kind: 'status', state, content });

  function recordError(error) { lastError = error.message; lastErrorAt = timestamp(); }
  function save(next, nextAcknowledged = acknowledged, nextUnreported = unreportedAcks) {
    try { store?.writeQueue({ pending: next, acknowledged: nextAcknowledged, unreportedAcks: nextUnreported }); }
    catch (error) { localFailure(error); throw error; }
    pending = next;
    acknowledged = nextAcknowledged;
    unreportedAcks = nextUnreported;
  }
  const reportable = (ids) => client.reportsAcknowledgements?.() ? ids.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0) : [];
  async function reportAcks() {
    if (reportingAcks || stopped || !unreportedAcks.length || !client.reportsAcknowledgements?.()) return;
    reportingAcks = true;
    try {
      while (!stopped && unreportedAcks.length && client.reportsAcknowledgements()) {
        const batch = unreportedAcks.slice(0, config.ackReportMax);
        try { await client.acknowledge(batch); }
        catch (error) {
          if (!ackReportFailed) log(`acknowledgements not reported to polyroom yet, kept for the next read: ${error.message}`);
          ackReportFailed = true;
          return;
        }
        ackReportFailed = false;
        const sent = new Set(batch);
        save(pending, acknowledged, unreportedAcks.filter((id) => !sent.has(id)));
      }
    } finally { reportingAcks = false; }
  }
  function reportProcessing(ids, leaseMs, leaseUntil) {
    if (stopped || !client.reportsProcessing?.()) return;
    const numbers = ids.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0);
    const leaseSeconds = Math.ceil(leaseMs / 1000);
    for (let start = 0; start < numbers.length; start += config.ackReportMax) {
      const batch = numbers.slice(start, start + config.ackReportMax);
      void Promise.resolve().then(() => client.reportProcessing(batch, leaseSeconds))
        .then((result) => {
          const refused = Array.isArray(result?.unknown) ? result.unknown : [];
          if (refused.length) log(`processing of events ${refused.join(', ')} not leased by polyroom, kept only locally until the next chat_processing`);
          const leased = Array.isArray(result?.processing) ? result.processing : [];
          const until = Date.parse(result?.processingUntil ?? '');
          if (leased.length && Number.isFinite(until) && until < Date.parse(leaseUntil) - config.processingCutToleranceMs)
            log(`lease of events ${leased.join(', ')} cut by polyroom to ${new Date(until).toISOString()}, renew with chat_processing before it ends`);
        }, (error) => log(`processing of events ${batch.join(', ')} not reported to polyroom, and not sent again until the next chat_processing: ${error.message}`));
    }
  }
  function update(id, values) {
    save(pending.map((entry) => eventId(entry) === String(id) ? { ...entry, ...values } : entry));
  }
  function cancel(id) {
    const delivery = deliveries.get(id);
    if (delivery?.timer) clock.clearTimeout(delivery.timer);
    deliveries.delete(id);
  }
  function haltRedelivery() {
    halted = true;
    for (const id of deliveries.keys()) cancel(id);
  }
  function localFailure(error) {
    recordError(new Error('Local state could not be loaded or saved; files preserved.'));
    state = 'stopped_storage';
    stopped = true;
    haltRedelivery();
    retryWait.cancel();
    client.close?.();
    try { log('queue persistence failed; processing stopped, files preserved'); } catch {}
  }
  async function send(notice, description) {
    try { await emit(notice); }
    catch (error) { log(`cannot emit ${description}: ${error.message}`); }
  }
  function later(id, delay, action) {
    cancel(id);
    const delivery = { timer: null };
    delivery.timer = clock.setTimeout(() => {
      if (deliveries.get(id) !== delivery || stopped || halted) return;
      Promise.resolve().then(action).catch(localFailure);
    }, delay);
    deliveries.set(id, delivery);
  }
  function flushSuspendedNotices() {
    suspendedNoticeTimer = null;
    const batches = [...suspendedNotices];
    suspendedNotices.clear();
    for (const [reason, ids] of batches) void send(statusNotification('suspended', noticeTexts(locale).suspendedNotice(ids, reason)), 'status event');
  }
  function noticeSuspended(ids, reason) {
    suspendedNotices.set(reason, [...(suspendedNotices.get(reason) ?? []), ...ids]);
    suspendedNoticeTimer ??= clock.setTimeout(flushSuspendedNotices, 0);
  }
  function suspend(ids, reason = 'manual') {
    const wanted = new Set(ids.map(String));
    const affected = pending.filter((entry) => wanted.has(eventId(entry))).map(eventId);
    save(pending.map((entry) => wanted.has(eventId(entry)) ? { ...entry, state: 'suspended', reason, leaseUntil: null } : entry));
    for (const id of affected) cancel(id);
    if (affected.length) log(`suspended events ${affected.join(', ')}: ${reason}; explicit retry required`);
    if (affected.length && noticeTexts(locale).suspendedNotice(affected, reason)) noticeSuspended(affected, reason);
    void pump().catch(localFailure);
    return { suspended: affected };
  }
  async function deliver(entry) {
    const id = eventId(entry);
    const attempt = (entry.attempt ?? -1) + 1;
    if (attempt > config.redeliveryMaxAttempts) { suspend([id], 'delivery_attempts_exhausted'); return; }
    const origin = entry.origin ?? 'live';
    update(id, { state: 'waiting', attempt, deliveredAt: timestamp(), origin, reason: null });
    lastDelivered = entry.event;
    later(id, (attempt + 1) * config.redeliveryStepMs, () => {
      const current = find(id);
      if (current?.state === 'waiting') return deliver(current);
    });
    await send({ kind: 'event', event: entry.event, attempt, origin, now: clock.now(), locale }, `event ${id}`);
  }
  async function pump() {
    if (pumping || stopped || halted) return;
    pumping = true;
    try {
      while (!stopped && !halted && deliveries.size < config.pendingMax) {
        const next = pending.find((entry) => entry.state === 'queued');
        if (!next) break;
        await deliver(next);
      }
    } finally { pumping = false; }
  }
  async function intercepted(event) {
    if (!intercept) return false;
    try { return await intercept(event) === true; }
    catch (error) { log(`permission relay could not inspect event ${event.id}: ${error.message}`); return false; }
  }
  async function accept(events, origin) {
    const handled = new Set(acknowledged);
    const fresh = events.filter((event) => !handled.has(String(event.id)));
    const consumed = new Set();
    for (const event of fresh) if (await intercepted(event)) consumed.add(event);
    if (consumed.size) {
      const consumedIds = [...consumed].map((event) => String(event.id));
      const reported = reportable(consumedIds);
      save(pending, rememberAcknowledged(acknowledged, consumedIds, config.acknowledgedMax),
        reported.length ? [...unreportedAcks.filter((id) => !reported.includes(id)), ...reported].slice(-config.acknowledgedMax) : unreportedAcks);
    }
    const entries = fresh.filter((event) => !consumed.has(event))
      .map((event) => ({ event, storedAt: timestamp(), state: 'queued', origin, attempt: -1 }));
    const result = addPending(pending, entries);
    if (!result.added.length) return;
    save(result.pending);
    if (pending.length > config.pendingMax && !overCapacityLogged) log(`queue holds more than the delivery capacity of ${config.pendingMax}; the rest waits, none discarded`);
    overCapacityLogged = pending.length > config.pendingMax;
    await pump();
  }
  async function restore() {
    const stored = store.readQueue();
    acknowledged = rememberAcknowledged([], stored.acknowledged, config.acknowledgedMax);
    unreportedAcks = (stored.unreportedAcks ?? []).slice(-config.acknowledgedMax);
    save(stored.pending.map((entry) => {
      if (entry.state === 'suspended') return entry;
      if (entry.state === 'processing') return { ...entry, state: 'suspended', reason: 'interrupted_processing', leaseUntil: null };
      return { ...entry, state: 'queued', attempt: entry.attempt ?? -1, origin: 'restored' };
    }));
    const suspended = pending.filter((entry) => entry.state === 'suspended').length;
    if (suspended) log(`${suspended} suspended events preserved; explicit retry required`);
    const interrupted = stored.pending.filter((entry) => entry.state === 'processing').map(eventId);
    if (interrupted.length) await send(statusNotification('suspended', noticeTexts(locale).suspendedNotice(interrupted, 'interrupted_processing')), 'status event');
    await pump();
  }

  function reportDiscarded(page) {
    if (Number.isSafeInteger(page.discarded) && page.discarded > 0) {
      log(`the polyroom MCP left out ${page.discarded} notices it could not read, up to cursor ${page.nextCursor}`);
    }
  }

  function withinBacklog(event, cutoff) {
    const createdAt = Date.parse(event.createdAt);
    return Number.isFinite(createdAt) && createdAt >= cutoff;
  }

  async function collectBacklog() {
    backlogCutoff ??= clock.now() - backlogMs;
    const cutoff = backlogCutoff;
    for (;;) {
      if (pending.length >= config.queueMax) return;
      const page = await client.notifications(cursor ?? 0, 0, { acknowledgements: false });
      if (stopped) return;
      reportDiscarded(page);
      await accept(page.events.filter((event) => withinBacklog(event, cutoff)), 'backlog');
      store.writeCursor(page.nextCursor, { backlog: page.hasMore });
      cursor = page.nextCursor;
      void reportAcks().catch(localFailure);
      if (!page.hasMore) {
        collectingBacklog = false;
        backlogCutoff = null;
        return;
      }
    }
  }

  async function stopForAuth(error) {
    state = 'stopped_auth';
    haltRedelivery();
    log(`polling stopped, the polyroom credential was refused: ${error.message}`);
    await send(statusNotification('stopped_auth', statusTexts.authRejected(config.handle)), 'status event');
  }

  async function stopForConfig(error) {
    state = 'stopped_config';
    problems = [statusTexts.queryRejected(error.code)];
    haltRedelivery();
    log(`polling stopped, the polyroom MCP rejected the query: ${error.message}`);
    await send(statusNotification('stopped_config', statusTexts.stopped(problems)), 'status event');
  }

  async function stopForState(error) {
    state = 'stopped_state';
    problems = [error.message];
    haltRedelivery();
    log(`polling stopped, the local state is ambiguous: ${error.message}`);
    await send(statusNotification('stopped_state', statusTexts.stopped(problems)), 'status event');
  }

  function requireLoaded() {
    if (!store) throw new StateNotLoaded();
  }

  async function poll() {
    let retryDelay = config.retryMinMs;
    let initialized = false;
    while (!stopped) {
      if (pending.length >= config.queueMax) {
        if (!queueFull) log(`queue holds ${pending.length} notices, POLYROOM_QUEUE_MAX is ${config.queueMax}; polling waits until it drains, nothing is discarded`);
        if (!queueFullNotified) {
          queueFullNotified = true;
          await send(statusNotification('queue_full', noticeTexts(locale).queueFull(pending.length, config.queueMax)), 'status event');
        }
        queueFull = true;
        await retryWait(config.retryMinMs);
        continue;
      }
      queueFull = false;
      if (pending.length <= config.queueResumeBelow) queueFullNotified = false;
      try {
        if (!initialized) {
          await client.initialize();
          initialized = true;
        }
        if (stopped) return;
        if (!store) {
          const identity = await client.identity();
          if (stopped) return;
          locale = identity.locale ?? fallbackNoticeLocale;
          try {
            store = await openStore(identity);
            if (!store) return;
            await load();
          } catch (error) {
            store = null;
            if (error instanceof StateConflict) await stopForState(error);
            else localFailure(error);
            return;
          }
          continue;
        }
        if (collectingBacklog) {
          await collectBacklog();
        } else {
          const page = await client.notifications(cursor, config.waitSeconds);
          if (stopped) return;
          reportDiscarded(page);
          await accept(page.events, 'live');
          store.writeCursor(page.nextCursor);
          cursor = page.nextCursor;
          void reportAcks().catch(localFailure);
        }
        retryDelay = config.retryMinMs;
      } catch (error) {
        if (stopped) return;
        recordError(error);
        if (error instanceof AuthRejected) {
          await stopForAuth(error);
          return;
        }
        if (error instanceof ConfigRejected) {
          await stopForConfig(error);
          return;
        }
        if (!error.keepsSession) initialized = false;
        const wait = Math.max(retryDelay, Number.isFinite(error.retryAfterMs) ? Math.min(error.retryAfterMs, config.retryMaxMs) : 0);
        log(`polling failed, retrying in ${wait} ms: ${error.message}`);
        await retryWait(wait);
        retryDelay = Math.min(retryDelay * 2, config.retryMaxMs);
      }
    }
  }



  async function load() {
    const saved = store.readCursor();
    cursor = saved?.cursor ?? null;
    collectingBacklog = saved === null || saved.backlog;
    await restore();
  }

  return {
    async start() {
      if (store) {
        try { await load(); }
        catch (error) { localFailure(error); return; }
      }
      await poll();
    },
    stop() {
      stopped = true;
      if (state === 'polling') state = 'stopped';
      haltRedelivery();
      retryWait.cancel();
      if (suspendedNoticeTimer !== null) clock.clearTimeout(suspendedNoticeTimer);
      suspendedNoticeTimer = null;
      client.close?.();
    },
    fail: localFailure,
    pause(reason) { dispatchPaused = reason; haltRedelivery(); },
    loaded() { return store !== null; },
    origin() {
      const open = pending.filter((entry) => ['waiting', 'processing'].includes(entry.state) && entry.deliveredAt)
        .sort((a, b) => a.deliveredAt.localeCompare(b.deliveredAt));
      const processing = open.filter((entry) => entry.state === 'processing');
      return { events: (processing.length ? processing : open).map((entry) => entry.event), last: lastDelivered };
    },
    ack(ids) {
      requireLoaded();
      const result = removePending(pending, ids);
      const reported = reportable(result.removed);
      if (result.removed.length) save(result.pending, rememberAcknowledged(acknowledged, result.removed, config.acknowledgedMax),
        reported.length ? [...unreportedAcks.filter((id) => !reported.includes(id)), ...reported].slice(-config.acknowledgedMax) : unreportedAcks);
      for (const id of result.removed) cancel(id);
      void pump().catch(localFailure);
      void reportAcks().catch(localFailure);
      return { acknowledged: result.removed, unknown: result.unknown };
    },
    processing(ids, leaseMs = config.processingLeaseMs) {
      requireLoaded();
      if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > processingLeaseMaxMs) throw new Error('invalid processing lease');
      if (stopped || halted) return { processing: [], unknown: ids.map(String) };
      const eligible = new Set(ids.map(String).filter((id) => ['waiting', 'processing'].includes(find(id)?.state)));
      const leaseUntil = new Date(clock.now() + leaseMs).toISOString();
      save(pending.map((entry) => eligible.has(eventId(entry)) ? { ...entry, state: 'processing', leaseUntil } : entry));
      for (const id of eligible) later(id, leaseMs, () => suspend([id], 'processing_lease_expired'));
      reportProcessing([...eligible], leaseMs, leaseUntil);
      return { processing: [...eligible], unknown: ids.map(String).filter((id) => !eligible.has(id)), leaseUntil };
    },
    suspend(ids, reason) {
      requireLoaded();
      return suspend(ids, reason);
    },
    retry(ids) {
      requireLoaded();
      if (stopped || halted) throw new Error('restart the stopped poller before retrying');
      const eligible = new Set(ids.map(String).filter((id) => find(id)?.state === 'suspended'));
      save(pending.map((entry) => eligible.has(eventId(entry)) ? { ...entry, state: 'queued', attempt: -1, origin: 'restored', reason: null } : entry));
      void pump().catch(localFailure);
      return { retried: [...eligible], unknown: ids.map(String).filter((id) => !eligible.has(id)) };
    },
    entries() { return pending.map(({ event, storedAt, state, attempt, reason, leaseUntil }) => ({ id: String(event.id), storedAt, state, attempt, reason: reason ?? null, leaseUntil: leaseUntil ?? null })); },
    status() {
      const count = (value) => pending.filter((entry) => entry.state === value).length;
      return { state, cursor, pending: pending.length, queued: count('queued'), waiting: count('waiting'), processing: count('processing'), suspended: count('suspended'),
        pendingDropped: 0, lastDroppedAt: null, lastError, lastErrorAt, ...(queueFull ? { queueFull } : {}), ...(dispatchPaused ? { dispatchPaused } : {}), ...(problems.length ? { problems } : {}) };
    },
  };
}
