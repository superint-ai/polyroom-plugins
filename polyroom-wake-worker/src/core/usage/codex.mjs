import { count } from './calls.mjs';

export const codexMarkers = ['"session_meta"', '"turn_context"', '"token_count"'];
export const codexSessionIdPattern = /^[a-zA-Z0-9_-]{1,100}$/;

const fields = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens'];
const validId = (value) => (typeof value === 'string' && codexSessionIdPattern.test(value) ? value : null);

function totalsOf(usage) {
  return Object.fromEntries(fields.map((field) => [field, count(usage?.[field])]));
}

const sameTotals = (a, b) => fields.every((field) => a[field] === b[field]);
const restarted = (totals, previous) => totals.input_tokens < previous.input_tokens || totals.output_tokens < previous.output_tokens;

export function codexHeader(line) {
  let entry;
  try { entry = JSON.parse(line); } catch { return null; }
  if (entry?.type !== 'session_meta') return null;
  const payload = entry.payload ?? {};
  const id = validId(payload.id) ?? validId(payload.session_id);
  if (!id) return null;
  return { id, sessionId: validId(payload.session_id), parentThreadId: validId(payload.parent_thread_id) };
}

export const codexIdentities = (header) => [header.id, header.sessionId, header.parentThreadId].filter(Boolean);

export function codexEvent(line, fileState, sessions) {
  let entry;
  try { entry = JSON.parse(line); } catch { return null; }
  const payload = entry?.payload;
  if (payload === null || typeof payload !== 'object') return null;
  const context = (fileState.context ??= { model: null, provider: null });
  if (entry.type === 'session_meta') {
    if (typeof payload.model_provider === 'string' && payload.model_provider) context.provider = payload.model_provider;
    return null;
  }
  if (entry.type === 'turn_context') {
    if (typeof payload.model === 'string' && payload.model) context.model = payload.model;
    return null;
  }
  if (entry.type !== 'event_msg' || payload.type !== 'token_count') return null;
  const info = payload.info;
  const at = Date.parse(entry.timestamp);
  if (info === null || typeof info !== 'object' || info.total_token_usage === null || typeof info.total_token_usage !== 'object' || Number.isNaN(at)) return null;
  const sessionKey = fileState.header.id;
  const session = sessions[sessionKey];
  if (session && at <= session.at) return null;
  const totals = totalsOf(info.total_token_usage);
  if (session && sameTotals(totals, session.totals)) { session.at = at; return null; }
  const last = totalsOf(info.last_token_usage);
  const delta = !session || restarted(totals, session.totals)
    ? last
    : Object.fromEntries(fields.map((field) => [field, Math.max(0, totals[field] - session.totals[field])]));
  sessions[sessionKey] = { at, totals };
  if (delta.input_tokens === 0 && delta.output_tokens === 0) return null;
  const cacheRead = Math.min(delta.cached_input_tokens, delta.input_tokens);
  const cacheWrite = Math.min(delta.cache_write_input_tokens, delta.input_tokens - cacheRead);
  return {
    at,
    model: context.model ?? 'unknown',
    provider: context.provider ?? 'unknown',
    prompt: delta.input_tokens,
    tokens: {
      inputTokens: delta.input_tokens - cacheRead - cacheWrite,
      outputTokens: delta.output_tokens,
      cacheReadTokens: cacheRead,
      cacheWrite5mTokens: cacheWrite,
      cacheWrite1hTokens: null,
      reasoningTokens: delta.reasoning_output_tokens,
    },
  };
}
