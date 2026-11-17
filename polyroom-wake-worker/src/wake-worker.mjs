import { existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createChatClient } from './core/chat-client.mjs';
import { readConfig } from './core/config.mjs';
import { createRuntime, statusWithEvents } from './core/runtime.mjs';
import { retryTransient, writeJsonAtomic } from './core/state.mjs';
import { WorkerProblems, workerDataDirectory, writeRetryFromEnv } from './adapters/codex/config.mjs';
import { retryOffline, withOfflineState } from './adapters/codex/control.mjs';
import { createWorkerLog, resolveBotId, statusSummary, writeStatus } from './worker-common.mjs';

export function wakeWorkerFiles(dataDirectory, prefix) {
  return {
    log: join(dataDirectory, `${prefix}-worker.log`),
    status: join(dataDirectory, `${prefix}-worker-status.json`),
    stop: join(dataDirectory, `${prefix}-worker-stop.request`),
    batch: join(dataDirectory, `${prefix}-worker-wake-batch.json`),
  };
}

function readStatus(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new WorkerProblems([`The status file ${file} is unreadable; it was preserved.`]); }
}

export function wakeStatusSummary(status, dataDirectory, title) {
  if (!status) return `The ${title} worker has not written a status in this data folder yet.`;
  return statusSummary(status, dataDirectory).replace(/^Codex worker/, `${title} worker`);
}

const needsPersonExitCode = 78;

function recordRefusal(files, error, retry, state = 'stopped_preflight') {
  const problems = error instanceof WorkerProblems ? error.problems : ['The worker stopped because of an unexpected error before it started.'];
  try {
    mkdirSync(dirname(files.status), { recursive: true });
    createWorkerLog(files.log, null, [])(`worker refused to run: ${problems.join(' ')}`);
  } catch {}
  writeStatus(files.status, { state, problems, pid: process.pid, observedAt: new Date().toISOString() }, retry);
}

export function createWakeWorker({ title, prefix, readSettings, readIdentity, createAdapter, checkLines, checkNote, stoppedMessages, secretsOf }) {
  const stoppedMessage = (status, settings) => {
    const message = stoppedMessages[status.state];
    if (message) return message(status.bot, settings);
    return `The ${title} worker of @${status.bot} stopped (${status.state}). ${(status.problems ?? []).join(' ')}`.trim();
  };
  const prepare = async (env, dependencies) => {
    const read = readSettings(env);
    const identity = await readIdentity(read, env, dependencies);
    const settings = { ...read, ...identity.settings };
    const coreEnv = { ...env, POLYROOM_MCP_URL: identity.url, POLYROOM_MCP_AUTHORIZATION: identity.authorization, POLYROOM_USER_AGENT: settings.userAgent };
    const loaded = readConfig(coreEnv);
    if (!loaded.ok) throw new WorkerProblems(loaded.problems);
    return { settings, identity, coreEnv, handle: loaded.config.handle, companySlug: loaded.config.companySlug };
  };
  return async function main(argv = process.argv.slice(2), env = process.env, { createClient = createChatClient, fetch = globalThis.fetch, out = console.log, err = console.error, ...dependencies } = {}) {
    const command = argv[0] || 'help';
    if (command === 'help') {
      out(`${prefix}-worker: check | status | run | stop | retry <notice IDs>`);
      return;
    }
    const dataDirectory = workerDataDirectory(env);
    const files = wakeWorkerFiles(dataDirectory, prefix);
    const retry = writeRetryFromEnv(env);
    if (command === 'status') { out(wakeStatusSummary(readStatus(files.status), dataDirectory, title)); return; }
    if (command === 'stop') {
      writeJsonAtomic(files.stop, { requestedAt: new Date().toISOString() }, retry);
      out('Stop request written. The running worker stops; a wake still waiting for the answer of the gateway is cut off and goes out again on the next run.');
      return;
    }
    if (!['check', 'run', 'retry'].includes(command)) throw new WorkerProblems([`Unknown command: ${command}.`]);
    if (command === 'run' && existsSync(files.stop)) {
      retryTransient(() => unlinkSync(files.stop), retry);
      const message = 'There was a stop request from an earlier run. It was cleared and the worker did not start; run it again to start.';
      recordRefusal(files, new WorkerProblems([message]), retry, 'stopped_stale_stop_request');
      err(message);
      process.exitCode = 1;
      return;
    }
    let prepared;
    try { prepared = await prepare(env, dependencies); }
    catch (error) {
      if (command === 'run') recordRefusal(files, error, retry);
      throw error;
    }
    const { settings, handle, companySlug } = prepared;
    if (command === 'check') {
      out([`${title} worker of @${handle} ready to run.`, ...checkLines(settings), `- Data: ${dataDirectory}`, checkNote].join('\n'));
      return;
    }
    const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    if (command === 'retry') {
      const control = { handle, companySlug, dataDirectory, writeRetry: settings.writeRetry, botId: await resolveBotId(prepared.coreEnv, { createClient, version }) };
      out(JSON.stringify(await withOfflineState(control, (store) => retryOffline(store, argv.slice(1)))));
      return;
    }
    mkdirSync(dataDirectory, { recursive: true });
    const token = prepared.identity.authorization.replace(/^Bearer\s+/i, '');
    const log = createWorkerLog(files.log, settings.logMaxBytes, [prepared.identity.authorization, token, ...secretsOf(settings)], settings.writeRetry);
    let runtime;
    let closing;
    let stopRequested = false;
    const report = () => {
      if (!runtime?.delivery) return;
      const value = { ...statusWithEvents(runtime), pid: process.pid, observedAt: new Date().toISOString() };
      if (!writeStatus(files.status, value, settings.writeRetry)) { try { log('status write failed after retries; the worker keeps running'); } catch {} }
    };
    const batchStore = {
      read: () => { try { return JSON.parse(readFileSync(files.batch, 'utf8')).ids; } catch (error) { if (error.code === 'ENOENT') return null; throw error; } },
      write: (ids) => ids ? writeJsonAtomic(files.batch, { ids, savedAt: new Date().toISOString() }, settings.writeRetry) : existsSync(files.batch) && retryTransient(() => unlinkSync(files.batch), settings.writeRetry),
    };
    const adapter = createAdapter({ settings, handle, log, fetch, onChange: report, batchStore });
    runtime = createRuntime({ env: prepared.coreEnv, dataDirectory, log, version, createClient, deliveryOverrides: { pendingMax: settings.wakeBatchMax }, skillsTarget: prefix,
      emit: (notice) => adapter.handle(notice, runtime.delivery), onStop: () => adapter.stop() });
    const shutdown = () => {
      closing ??= (async () => {
        await runtime.stop();
        report();
        if (existsSync(files.stop)) retryTransient(() => unlinkSync(files.stop), settings.writeRetry);
      })();
      return closing;
    };
    const signalStop = () => { stopRequested = true; void shutdown().catch(() => { process.exitCode = 1; }); };
    process.once('SIGINT', signalStop);
    process.once('SIGTERM', signalStop);
    const timer = setInterval(() => {
      report();
      if (existsSync(files.stop)) signalStop();
    }, settings.statusIntervalMs);
    try { await runtime.start(); }
    finally {
      clearInterval(timer);
      await shutdown();
      process.removeListener('SIGINT', signalStop);
      process.removeListener('SIGTERM', signalStop);
    }
    const final = runtime.status();
    if (!stopRequested && final.state.startsWith('stopped_')) {
      try { log(`worker stopped in state ${final.state}`); } catch {}
      err(stoppedMessage(final, settings));
      process.exitCode = needsPersonExitCode;
    }
  };
}

export function runAsEntry(moduleUrl, title, main) {
  let entry = false;
  try { entry = Boolean(process.argv[1]) && pathToFileURL(realpathSync(process.argv[1])).href === moduleUrl; } catch {}
  if (!entry) return;
  Promise.resolve().then(() => {
    try { process.loadEnvFile(new URL('../.env', import.meta.url)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return main();
  }).catch((error) => {
    console.error(error instanceof WorkerProblems
      ? `The ${title} worker did not run:\n- ${error.problems.join('\n- ')}`
      : `The ${title} worker stopped. Check the local configuration and state; no credentials or remote content are printed.`);
    process.exitCode = error instanceof WorkerProblems ? needsPersonExitCode : 1;
  });
}
