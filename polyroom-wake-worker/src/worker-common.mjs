import { appendFileSync, renameSync, statSync } from 'node:fs';
import { readConfig } from './core/config.mjs';
import { retryTransient, writeJsonAtomic } from './core/state.mjs';
import { WorkerProblems } from './adapters/codex/config.mjs';
import { statusFiles } from './adapters/codex/control.mjs';

export function writeStatus(file, value, retry, write = writeJsonAtomic) {
  try {
    write(file, value, retry);
    return true;
  } catch {
    return false;
  }
}

export function createWorkerLog(file, maxBytes, redactions, retry, rename = renameSync) {
  return (text) => {
    let line = `${new Date().toISOString()} ${String(text)}`;
    for (const secret of redactions) if (secret) line = line.replaceAll(secret, '[REDACTED]');
    if (maxBytes) {
      try { if (statSync(file).size >= maxBytes) retryTransient(() => rename(file, `${file}.1`), retry); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    appendFileSync(file, `${line}\n`);
  };
}

const technicalErrors = [
  [/^polyroom MCP responded (\d+)$/, (status) => `the polyroom MCP answered ${status}`],
  [/^chat_notifications failed: ([A-Z_]+)$/, (code) => `the notice query failed (${code})`],
  [/^Local state could not be loaded or saved; files preserved\.$/, () => 'the local state could not be read or written; the files were preserved'],
  [/^polyroom MCP returned invalid JSON$/, () => 'the polyroom MCP returned an invalid answer'],
  [/^polyroom MCP returned an event stream without data$/, () => 'the polyroom MCP returned an event stream without data'],
  [/^polyroom MCP returned a JSON-RPC error$/, () => 'the polyroom MCP returned a protocol error (JSON-RPC)'],
  [/^chat_notifications returned (invalid JSON|an unexpected page)$/, () => 'the notice query returned an invalid page'],
  [/(timeout|aborted|fetch failed|ECONN|ENOTFOUND|EAI_AGAIN)/i, () => 'the connection to the polyroom MCP failed or took too long'],
];

export function describeError(message) {
  for (const [pattern, describe] of technicalErrors) {
    const match = String(message).match(pattern);
    if (match) return describe(...match.slice(1));
  }
  return `technical error: ${message}`;
}

export function statusSummary(status, dataDirectory) {
  if (!status) return 'The Codex worker has not written a status in this data folder yet.';
  const lines = [`Codex worker${status.bot ? ` of @${status.bot}` : ''}: state ${status.state}, observed at ${status.observedAt} (pid ${status.pid})`];
  if (status.dispatchPaused) lines.push(`Dispatch paused: ${status.dispatchPaused}`);
  if (status.lastError) lines.push(`Last error: ${describeError(status.lastError)} (${status.lastErrorAt})`);
  if (status.problems?.length) lines.push(`Problems:\n- ${status.problems.join('\n- ')}`);
  if (status.bot && !('botId' in status)) {
    lines.push('This status was written by a version from before the switch to state per bot. The queue and the cursor show up here once the worker writes a new status.');
  } else if (status.bot && !status.botId) {
    lines.push('The worker has not read the bot identity from polyroom yet. The queue and the cursor show up here after that.');
  } else if (status.bot) {
    const queue = statusFiles({ handle: status.bot, botId: status.botId, dataDirectory });
    lines.push(`Cursor: ${queue.cursor?.cursor ?? 'none'}`);
    const byState = queue.events.reduce((counts, event) => ({ ...counts, [event.state]: (counts[event.state] ?? 0) + 1 }), {});
    lines.push(`Notices in the queue: ${queue.events.length}${Object.keys(byState).length ? ` (${Object.entries(byState).map(([state, count]) => `${state}: ${count}`).join(', ')})` : ''}`);
    const suspended = queue.events.filter((event) => event.state === 'suspended');
    if (suspended.length) {
      lines.push('Suspended notices, to check and send again with retry:');
      for (const event of suspended) lines.push(`- ${event.id}: ${event.reason ?? 'no reason'}`);
    }
  }
  return lines.join('\n');
}

export async function resolveBotId(coreEnv, { createClient, version }) {
  const loaded = readConfig(coreEnv);
  if (!loaded.ok) throw new WorkerProblems(loaded.problems);
  const client = createClient({ ...loaded.config, clientVersion: version });
  try {
    await client.initialize();
    return (await client.identity()).id;
  } catch (error) {
    throw new WorkerProblems([`Could not read the bot identity from polyroom (${describeError(error.message)}). The queue state is kept per bot, and this command needs it.`]);
  } finally { client.close?.(); }
}
