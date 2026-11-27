import { createChatClient } from './chat-client.mjs';
import { readConfig, text } from './config.mjs';
import { createDelivery } from './delivery.mjs';
import { fallbackNoticeLocale, noticeTexts, statusTexts, systemClock } from '../notices.mjs';
import { botLockTarget, lockTarget, waitForLock } from './lock.mjs';
import { createStateStore } from './state.mjs';
import { createWait } from './wait.mjs';
import { readSkillsConfig } from './skills/config.mjs';
import { createSkillsSync } from './skills/sync.mjs';
import { readUsageConfig } from './usage/config.mjs';
import { createUsageReporter } from './usage/reporter.mjs';
import { readPermissionConfig } from './permissions/config.mjs';
import { createPermissionRelay } from './permissions/relay.mjs';
import { readSpoolEntries, sessionSpool } from './permissions/spool.mjs';

export function statusWithEvents(runtime) {
  const priority = (entry) => ({ suspended: 0, processing: 1 })[entry.state] ?? 2;
  const events = [...(runtime.delivery?.entries() ?? [])].sort((a, b) => priority(a) - priority(b));
  const max = runtime.config?.statusEventsMax ?? events.length;
  return { ...runtime.status(), events: events.slice(0, max), ...(events.length > max ? { eventsOmitted: events.length - max } : {}) };
}

export function createRuntime({ env, dataDirectory, log, version, emit, platform = process.platform, clock = systemClock, createClient = createChatClient, acquireLock, onStop = async () => {}, deliveryOverrides = {}, usageFetch = globalThis.fetch, codexSessionFromEnvironment = false, skillsTarget = 'claude', permissionNotify = null, permissionMask = null }) {
  const loaded = readConfig(env);
  const usageLoaded = loaded.ok ? readUsageConfig(env, loaded.config) : { enabled: false, problems: [] };
  const usage = usageLoaded.enabled ? createUsageReporter({ config: usageLoaded.config, dataDirectory, handle: loaded.config.handle, version, log, clock, fetch: usageFetch,
    writeRetry: { attempts: loaded.config.writeRetryAttempts, retryMs: loaded.config.writeRetryMs } }) : null;
  const skillsLoaded = loaded.ok ? readSkillsConfig(env, loaded.config, skillsTarget) : { enabled: false, problems: [] };
  let skills = null;
  const permissionLoaded = loaded.ok && permissionNotify ? readPermissionConfig(env) : { enabled: false, problems: [] };
  let permissions = null;
  let spoolTimer = null;
  const wait = createWait(clock);
  let stopping;
  const runtime = {
    state: loaded.ok ? 'waiting_lock' : loaded.state,
    bot: loaded.ok ? loaded.config.handle : loaded.handle,
    problems: loaded.ok ? [] : loaded.problems,
    lastError: null,
    lastErrorAt: null,
    delivery: null,
    lock: null,
    botLock: null,
    waitingLock: false,
    started: false,
    stopped: false,
  };

  async function reportStatus(state, content) {
    try {
      await emit({ kind: 'status', state, content });
    } catch (error) {
      log(`cannot emit status event: ${error.message}`);
    }
  }

  function status() {
    const delivery = runtime.delivery?.status();
    const problems = delivery?.problems ?? runtime.problems;
    const latestError = [delivery, runtime]
      .filter((source) => source?.lastErrorAt)
      .sort((a, b) => a.lastErrorAt.localeCompare(b.lastErrorAt))
      .at(-1);
    return {
      state: runtime.waitingLock ? 'waiting_lock' : delivery?.state ?? runtime.state,
      bot: runtime.bot,
      botId: runtime.botId ?? null,
      cursor: delivery?.cursor ?? null,
      pending: delivery?.pending ?? 0,
      queued: delivery?.queued ?? 0,
      waiting: delivery?.waiting ?? 0,
      processing: delivery?.processing ?? 0,
      suspended: delivery?.suspended ?? 0,
      pendingDropped: delivery?.pendingDropped ?? 0,
      lastDroppedAt: delivery?.lastDroppedAt ?? null,
      lastError: latestError?.lastError ?? null,
      lastErrorAt: latestError?.lastErrorAt ?? null,
      ...(delivery?.queueFull ? { queueFull: delivery.queueFull } : {}),
      ...(delivery?.dispatchPaused ? { dispatchPaused: delivery.dispatchPaused } : {}),
      ...(problems.length ? { problems } : {}),
      ...(usage ? { usage: usage.status() } : usageLoaded.problems.length ? { usage: { state: 'stopped_config', problems: usageLoaded.problems } } : {}),
      ...(skills ? { skills: skills.status() } : skillsLoaded.problems.length ? { skills: { state: 'stopped_config', problems: skillsLoaded.problems } } : {}),
      ...(permissions ? { permissionRelay: 'on' } : permissionLoaded.problems.length ? { permissionRelay: { state: 'stopped_config', problems: permissionLoaded.problems } } : {}),
    };
  }

  async function begin() {
    if (!loaded.ok) {
      log(`stopped: ${loaded.problems.join(' ')}`);
      await reportStatus(loaded.state, statusTexts.stopped(loaded.problems));
      return;
    }
    const { config } = loaded;
    if (usageLoaded.problems.length) log(`usage reporting is off: ${usageLoaded.problems.join(' ')}`);
    if (skillsLoaded.problems.length) log(`skills sync is off: ${skillsLoaded.problems.join(' ')}`);
    if (permissionLoaded.problems.length) log(`permission relay is off: ${permissionLoaded.problems.join(' ')}`);
    const hold = async (target, holder, locale = fallbackNoticeLocale) => {
      let errorReported = false;
      const acquired = await waitForLock({
        target,
        retryMs: config.lockRetryMs,
        wait,
        ...(acquireLock ? { acquire: acquireLock } : {}),
        isCancelled: () => runtime.stopped,
        onBusy: () => {
          runtime.waitingLock = true;
          log(`another session already polls for ${holder}, retrying every ${config.lockRetryMs} ms`);
          void reportStatus('waiting_lock', noticeTexts(locale).lockBusy(config.handle));
        },
        onError: (error) => {
          runtime.lastError = error.message;
          runtime.lastErrorAt = new Date(clock.now()).toISOString();
          log(`cannot take the lock for ${holder}, retrying every ${config.lockRetryMs} ms: ${error.message}`);
          if (errorReported) return;
          errorReported = true;
          void reportStatus('waiting_lock', statusTexts.lockFailed(config.handle, error.code ?? error.name, config.lockRetryMs));
        },
      });
      runtime.waitingLock = false;
      if (!acquired) return null;
      if (acquired.waited) {
        log(`took over polling for ${holder}`);
        await reportStatus('polling', noticeTexts(locale).lockAcquired(config.handle));
      }
      if (runtime.stopped) {
        await acquired.lock.release();
        return null;
      }
      return acquired.lock;
    };
    const address = config.companySlug ? `@${config.handle} of ${config.companySlug}` : `@${config.handle}`;
    runtime.lock = await hold(lockTarget({ handle: config.handle, companySlug: config.companySlug, platform, directory: dataDirectory }), address);
    if (!runtime.lock) return;
    const openStore = async (identity) => {
      runtime.botLock = await hold(botLockTarget({ botId: identity.id, platform, directory: dataDirectory }), `the bot ${identity.id}`, identity.locale ?? fallbackNoticeLocale);
      if (!runtime.botLock) return null;
      runtime.botId = identity.id;
      if (identity.handle && identity.handle !== config.handle) log(`the polyroom identity is @${identity.handle}, but the MCP address names @${config.handle}; the state follows the bot id ${identity.id}`);
      const store = createStateStore({ directory: dataDirectory, handle: config.handle, botId: identity.id, log, now: clock.now,
        writeRetry: { attempts: config.writeRetryAttempts, retryMs: config.writeRetryMs } });
      store.adoptHandleState();
      usage?.start(identity.id, codexSessionFromEnvironment && usageLoaded.config.codexDir ? { environmentSession: { id: text(env, 'CODEX_SESSION_ID') } } : {});
      skills?.start(identity.id);
      if (permissionLoaded.enabled) await startPermissions(identity);
      for (const other of store.otherBots()) log(`state of another bot named @${config.handle} (${other}) found in the data folder and left untouched`);
      try {
        store.removeLegacyLock();
      } catch (error) {
        log(`cannot remove the old lock file: ${error.message}`);
      }
      return store;
    };
    const client = createClient({ ...config, clientVersion: version });
    const startPermissions = async (identity) => {
      permissions = createPermissionRelay({ config: permissionLoaded.config, client, botId: identity.id, handle: identity.handle ?? config.handle,
        locale: identity.locale ?? fallbackNoticeLocale, dataDirectory, projectDir: text(env, 'CLAUDE_PROJECT_DIR') || process.cwd(), sessionId: text(env, 'CLAUDE_CODE_SESSION_ID') || null, clock, log,
        origin: () => runtime.delivery?.origin() ?? null,
        notify: permissionNotify,
        mask: permissionMask,
        wake: (content) => emit({ kind: 'status', state: 'permission', content }) });
      await permissions.start();
      const spool = sessionSpool(dataDirectory, env, text(env, 'CLAUDE_CODE_SESSION_ID'));
      if (!spool) { log('permission relay: CLAUDE_CODE_SESSION_ID is missing, so the hook reports of this session are not read'); return; }
      const drain = () => {
        spoolTimer = clock.setTimeout(async () => {
          spoolTimer = null;
          for (const entry of readSpoolEntries(spool)) {
            if (runtime.stopped) return;
            if (entry?.event === 'denied') await permissions.blocked(entry);
            else if (entry?.event === 'used') await permissions.used(entry);
          }
          if (!runtime.stopped) drain();
        }, permissionLoaded.config.pollMs);
      };
      drain();
    };
    if (skillsLoaded.enabled) skills = createSkillsSync({ config: skillsLoaded.config, client, dataDirectory, handle: config.handle, log, clock,
      writeRetry: { attempts: config.writeRetryAttempts, retryMs: config.writeRetryMs } });
    runtime.delivery = createDelivery({ config: { ...config, ...deliveryOverrides }, client, openStore, emit, clock, log,
      intercept: (event) => permissions?.consume(event) ?? false });
    runtime.state = 'polling';
    await runtime.delivery.start();
  }

  function stop() {
    stopping ??= (async () => {
      runtime.stopped = true;
      if (['polling', 'waiting_lock'].includes(runtime.state)) runtime.state = 'stopped';
      wait.cancel();
      runtime.delivery?.stop();
      if (spoolTimer !== null) clock.clearTimeout(spoolTimer);
      try { await onStop(); }
      finally {
        await permissions?.stop();
        await usage?.stop();
        await skills?.stop();
        await runtime.botLock?.release();
        await runtime.lock?.release();
      }
    })();
    return stopping;
  }


  return {
    status, stop,
    get delivery() { return runtime.delivery; },
    get usage() { return usage; },
    get skills() { return skills; },
    get config() { return loaded.ok ? loaded.config : null; },
    get permissionRelayEnabled() { return permissionLoaded.enabled; },
    async permissionRequest(params) {
      if (!permissions) { log('permission relay: a request arrived before the bot identity was loaded; it stays in the terminal'); return; }
      await permissions.request(params);
    },
    async start() {
      if (runtime.started) return;
      runtime.started = true;
      try { await begin(); }
      catch (error) {
        runtime.state = 'stopped_storage';
        runtime.lastError = 'Local state could not be loaded or saved; files preserved.';
        runtime.lastErrorAt = new Date(clock.now()).toISOString();
        runtime.delivery?.stop();
        log(runtime.lastError);
        await reportStatus(runtime.state, runtime.lastError);
      }
    },
  };
}
