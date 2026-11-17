import { createHmac } from 'node:crypto';
import { createWakeAdapter, hookOutcome, wakeBatchText, wakeText } from '../wake-adapter.mjs';

export function signedWakeHeaders(secret, body, eventId, seconds = Math.floor(Date.now() / 1000)) {
  const timestamp = String(seconds);
  return {
    'content-type': 'application/json',
    'x-webhook-timestamp': timestamp,
    'x-webhook-signature-v2': createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex'),
    'x-request-id': `polyroom-${eventId}`,
  };
}

export function classifyWebhookAnswer(status, body) {
  if (status >= 200 && status < 300) {
    let parsed = null;
    try { parsed = JSON.parse(body); } catch {}
    if (['accepted', 'delivered', 'duplicate'].includes(parsed?.status)) return { outcome: hookOutcome.delivered, detail: parsed.status };
    return { outcome: hookOutcome.pause, reason: 'hermes_webhook_unexpected_answer', detail: `HTTP ${status} without status accepted, delivered or duplicate` };
  }
  if (status >= 300 && status < 400) return { outcome: hookOutcome.pause, reason: 'hermes_webhook_redirect', detail: `HTTP ${status}: the gateway answered with a redirect, which the worker never follows; point POLYROOM_HERMES_WEBHOOK_URL at the webhook route itself` };
  if (status === 401 || status === 403) return { outcome: hookOutcome.pause, reason: 'hermes_webhook_auth', detail: `HTTP ${status}: the route refused the signature; check that POLYROOM_HERMES_WEBHOOK_SECRET is the secret of the route` };
  if (status === 404) return { outcome: hookOutcome.pause, reason: 'hermes_webhook_not_found', detail: 'HTTP 404: the route does not exist; check platforms.webhook in the Hermes config.yaml' };
  if (status === 400 || status === 413 || status === 422) return { outcome: hookOutcome.pause, reason: 'hermes_webhook_refused', detail: `HTTP ${status}: the gateway refused the wake` };
  return { outcome: hookOutcome.retry, detail: `HTTP ${status}` };
}

export function createHermesAdapter({ settings, handle, log, fetch = globalThis.fetch, onChange = () => {}, batchStore }) {
  const post = async (events, signal) => {
    const body = JSON.stringify({ text: wakeBatchText(events, handle, settings.serverName) });
    const requestId = events.map((event) => String(event.id)).sort((left, right) => Number(left) - Number(right) || left.localeCompare(right)).join('-');
    const response = await fetch(settings.webhookUrl, { method: 'POST', headers: signedWakeHeaders(settings.webhookSecret, body, requestId), body, redirect: 'manual', signal });
    return { status: response.status, body: await response.text() };
  };
  return createWakeAdapter({ target: 'the Hermes gateway', timeoutMs: settings.webhookTimeoutMs, windowMs: settings.wakeBatchWindowMs, post, classify: classifyWebhookAnswer, log, onChange, batchStore });
}
