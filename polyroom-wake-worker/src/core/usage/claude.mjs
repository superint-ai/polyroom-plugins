import { createHash } from 'node:crypto';
import { count } from './calls.mjs';

export const claudeMarkers = ['"usage"'];
export const syntheticModel = '<synthetic>';

const messageKey = (message, requestId) => createHash('sha256').update(`${message.id ?? ''}\u0000${requestId ?? ''}`).digest('base64url').slice(0, 16);

export function claudeEntry(line) {
  let entry;
  try { entry = JSON.parse(line); } catch { return null; }
  const message = entry?.message;
  if (message === null || typeof message !== 'object' || message.role !== 'assistant') return null;
  const usage = message.usage;
  const at = Date.parse(entry.timestamp);
  if (usage === null || typeof usage !== 'object' || Number.isNaN(at)) return null;
  const model = typeof message.model === 'string' && message.model ? message.model : 'unknown';
  if (model === syntheticModel) return null;
  const split = usage.cache_creation !== null && typeof usage.cache_creation === 'object' ? usage.cache_creation : {};
  return {
    key: messageKey(message, entry.requestId),
    at,
    model,
    raw: {
      input: count(usage.input_tokens),
      output: count(usage.output_tokens),
      read: count(usage.cache_read_input_tokens),
      write: count(usage.cache_creation_input_tokens),
      write5m: count(split.ephemeral_5m_input_tokens),
      write1h: count(split.ephemeral_1h_input_tokens),
    },
  };
}

export const mergeRaw = (known, seen) => Object.fromEntries(Object.keys(known).map((field) => [field, Math.max(known[field], seen[field])]));

export function claudeTokens(raw) {
  const write1h = raw.write5m + raw.write1h === raw.write ? raw.write1h : Math.max(0, raw.write - raw.write5m);
  return { inputTokens: raw.input, outputTokens: raw.output, cacheReadTokens: raw.read, cacheWrite5mTokens: raw.write5m, cacheWrite1hTokens: write1h, reasoningTokens: null };
}

export const claudePrompt = (raw) => raw.input + raw.read + raw.write;
