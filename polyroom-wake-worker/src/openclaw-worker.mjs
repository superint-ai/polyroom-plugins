import { join } from 'node:path';
import { createOpenClawAdapter } from './adapters/openclaw/adapter.mjs';
import { openClawServerVariable, readOpenClawIdentity, readOpenClawSettings } from './adapters/openclaw/config.mjs';
import { describeSource } from './adapters/server-name.mjs';
import { createWakeWorker, runAsEntry, wakeWorkerFiles } from './wake-worker.mjs';

export const openClawWorkerFiles = (dataDirectory) => wakeWorkerFiles(dataDirectory, 'openclaw');

export const main = createWakeWorker({
  title: 'OpenClaw',
  prefix: 'openclaw',
  readSettings: readOpenClawSettings,
  readIdentity: (settings, env) => readOpenClawIdentity(settings, env),
  createAdapter: createOpenClawAdapter,
  secretsOf: (settings) => [settings.hookToken],
  checkLines: (settings) => [
    `- polyroom MCP: the "${settings.serverName}" server of ${settings.configFile} (${describeSource(settings.serverSource, openClawServerVariable)}), with the bot token`,
    `- Wakes: ${settings.hookUrl}, agent "${settings.agentId}", ${settings.hookTimeoutMs} ms to answer`,
  ],
  checkNote: 'The check does not call polyroom, the Gateway or the model.',
  stoppedMessages: {
    stopped_auth: (handle, settings) => `polyroom refused the token of @${handle} (401/403). The worker stopped. Check the Authorization header of the "${settings.serverName}" server in ${settings.configFile} and the token in ${join(settings.home, '.env')}, then run the check.`,
    stopped_storage: (handle, settings) => `The OpenClaw worker of @${handle} stopped: the local state could not be read or written. The files were preserved in ${settings.dataDirectory}.`,
  },
});

runAsEntry(import.meta.url, 'OpenClaw', main);
