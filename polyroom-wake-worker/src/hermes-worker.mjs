import { createHermesAdapter } from './adapters/hermes/adapter.mjs';
import { hermesServerVariable, hermesWebhookVariable, readHermesIdentity, readHermesSettings } from './adapters/hermes/config.mjs';
import { describeSource } from './adapters/server-name.mjs';
import { createWakeWorker, runAsEntry, wakeWorkerFiles } from './wake-worker.mjs';

export const hermesWorkerFiles = (dataDirectory) => wakeWorkerFiles(dataDirectory, 'hermes');

export const main = createWakeWorker({
  title: 'Hermes',
  prefix: 'hermes',
  readSettings: readHermesSettings,
  readIdentity: (settings, env, dependencies) => readHermesIdentity(settings, env, dependencies),
  createAdapter: createHermesAdapter,
  secretsOf: (settings) => [settings.webhookSecret],
  checkLines: (settings) => [
    `- polyroom MCP: the "${settings.serverName}" server of the Hermes configuration${settings.home ? ` in ${settings.home}` : ''}, read with hermes config (${describeSource(settings.serverSource, hermesServerVariable)}), with the bot token`,
    `- Wakes: ${settings.webhookUrl}, route "${settings.webhookRoute}" (${describeSource(settings.routeSource, hermesWebhookVariable, `no route in ${hermesWebhookVariable}`)}), signed with the route secret, ${settings.webhookTimeoutMs} ms to answer`,
  ],
  checkNote: 'The check reads the Hermes configuration with hermes config and does not call polyroom, the gateway or the model.',
  stoppedMessages: {
    stopped_auth: (handle, settings) => `polyroom refused the token of @${handle} (401/403). The worker stopped. Check the Authorization header of the "${settings.serverName}" server in the Hermes config.yaml and the token in the Hermes .env (hermes config env-path shows where), then run the check.`,
    stopped_storage: (handle, settings) => `The Hermes worker of @${handle} stopped: the local state could not be read or written. The files were preserved in ${settings.dataDirectory}.`,
  },
});

runAsEntry(import.meta.url, 'Hermes', main);
