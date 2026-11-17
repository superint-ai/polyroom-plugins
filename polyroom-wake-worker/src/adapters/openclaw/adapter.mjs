import { createWakeAdapter, hookOutcome, wakeBatchText, wakeText } from '../wake-adapter.mjs';

export { hookOutcome, wakeText };

export function classifyHookAnswer(status, body) {
  if (status === 200) {
    let parsed = null;
    try { parsed = JSON.parse(body); } catch {}
    if (parsed?.ok === true && ['queued', 'coalesced'].includes(parsed.eventOutcome)) return { outcome: hookOutcome.delivered, detail: parsed.eventOutcome };
    return { outcome: hookOutcome.pause, reason: 'openclaw_hook_unexpected_answer', detail: 'HTTP 200 without ok and eventOutcome queued or coalesced' };
  }
  if (status >= 300 && status < 400) return { outcome: hookOutcome.pause, reason: 'openclaw_hook_redirect', detail: `HTTP ${status}: the Gateway answered with a redirect, which the worker never follows; point POLYROOM_OPENCLAW_HOOK_URL at the wake hook itself` };
  if (status === 401 || status === 403) return { outcome: hookOutcome.pause, reason: 'openclaw_hook_auth', detail: `HTTP ${status}: the Gateway refused POLYROOM_OPENCLAW_HOOK_TOKEN` };
  if (status === 404) return { outcome: hookOutcome.pause, reason: 'openclaw_hook_not_found', detail: 'HTTP 404: check hooks.enabled and hooks.path in the OpenClaw configuration' };
  if (status === 400 || status === 413 || status === 422) return { outcome: hookOutcome.pause, reason: 'openclaw_hook_refused', detail: `HTTP ${status}: the Gateway refused the wake (check POLYROOM_OPENCLAW_AGENT_ID and hooks.allowedAgentIds)` };
  return { outcome: hookOutcome.retry, detail: `HTTP ${status}` };
}

export function createOpenClawAdapter({ settings, handle, log, fetch = globalThis.fetch, onChange = () => {}, batchStore }) {
  const post = async (events, signal) => {
    const response = await fetch(settings.hookUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${settings.hookToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: wakeBatchText(events, handle, settings.serverName), mode: 'now', agentId: settings.agentId }),
      redirect: 'manual',
      signal,
    });
    return { status: response.status, body: await response.text() };
  };
  return createWakeAdapter({ target: 'the OpenClaw Gateway', timeoutMs: settings.hookTimeoutMs, windowMs: settings.wakeBatchWindowMs, post, classify: classifyHookAnswer, log, onChange, batchStore });
}
