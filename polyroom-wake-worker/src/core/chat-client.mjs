import { noticeLocaleOf } from '../notices.mjs';

const rejectedCredentialCodes = new Set(['BACKEND_UNAUTHORIZED', 'BACKEND_FORBIDDEN', 'SCOPE_FORBIDDEN', 'INSUFFICIENT_SCOPE']);
const rejectedQueryCodes = new Set(['INVALID_ARGUMENTS', 'BACKEND_INVALID_REQUEST']);
const baseNoticeKinds = ['message', 'card', 'decision'];
const noticeKinds = [...baseNoticeKinds, 'pending', 'reply_batch', 'message_change'];
export const botIdPattern = /^[A-Za-z0-9-]{1,64}$/;
const skillNamePattern = /^(?!.*--)[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const sha256Pattern = /^[0-9a-f]{64}$/;

export class AuthRejected extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthRejected';
  }
}

export class RetryLater extends Error {
  constructor(message, retryAfterMs, keepsSession) {
    super(message);
    this.name = 'RetryLater';
    this.retryAfterMs = retryAfterMs;
    this.keepsSession = keepsSession;
  }
}

export class ToolFailed extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ToolFailed';
    this.code = code;
    this.keepsSession = true;
  }
}

export function retryAfterMs(header, now) {
  const value = header?.trim();
  if (!value) return null;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now()) : null;
}

export class ConfigRejected extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ConfigRejected';
    this.code = code;
  }
}

function parsePayload(body, contentType) {
  if (!contentType?.startsWith('text/event-stream')) return JSON.parse(body);
  const data = body.split('\n').filter((line) => line.startsWith('data:')).at(-1);
  if (data === undefined) throw new Error('polyroom MCP returned an event stream without data');
  return JSON.parse(data.slice(5));
}

function toolFailure(result) {
  if (result.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent;
  try {
    return JSON.parse(result.content?.[0]?.text ?? '');
  } catch {
    return {};
  }
}

export function createChatClient({
  url,
  authorization,
  userAgent,
  limit,
  initializeTimeoutMs,
  pollMarginMs,
  clientVersion,
  fetch = globalThis.fetch,
  now = Date.now,
}) {
  let requestId = 0;
  const controller = new AbortController();

  async function rpc(method, params, timeoutMs) {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'User-Agent': userAgent,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params }),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]),
    });
    if (response.status === 401 || response.status === 403) throw new AuthRejected(`polyroom MCP responded ${response.status}`);
    const wait = response.status === 429 || response.status === 503 ? retryAfterMs(response.headers.get('retry-after'), now) : null;
    if (wait !== null) throw new RetryLater(`polyroom MCP responded ${response.status}`, wait, true);
    if (!response.ok) throw new Error(`polyroom MCP responded ${response.status}`);
    let payload;
    try { payload = parsePayload(await response.text(), response.headers.get('content-type')); }
    catch { throw new Error('polyroom MCP returned invalid JSON'); }
    if (payload.error) throw new Error('polyroom MCP returned a JSON-RPC error');
    return payload.result;
  }

  async function initialize() {
    await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'polyroom-long-polling', version: clientVersion },
    }, initializeTimeoutMs);
  }

  async function callToolResult(name, args, timeoutMs) {
    const result = await rpc('tools/call', { name, arguments: args }, timeoutMs);
    if (result?.isError) {
      const failure = toolFailure(result);
      const code = typeof failure.code === 'string' && /^[A-Z_]{1,64}$/.test(failure.code) ? failure.code : 'UNKNOWN_ERROR';
      const message = `${name} failed: ${code}`;
      if (rejectedCredentialCodes.has(failure.code)) throw new AuthRejected(message);
      if (rejectedQueryCodes.has(failure.code)) throw new ConfigRejected(message, failure.code);
      if (Number.isFinite(failure.retryAfterSeconds) && failure.retryAfterSeconds >= 0) throw new RetryLater(message, failure.retryAfterSeconds * 1000, true);
      throw new ToolFailed(message, code);
    }
    return result;
  }

  async function callTool(name, args, timeoutMs) {
    const result = await callToolResult(name, args, timeoutMs);
    try { return result?.structuredContent ?? JSON.parse(result?.content?.[0]?.text ?? 'null'); }
    catch { throw new Error(`${name} returned invalid JSON`); }
  }

  async function identity() {
    const payload = await callTool('chat_identity', {}, initializeTimeoutMs);
    const bot = payload?.identity;
    if (typeof bot?.id !== 'string' || !botIdPattern.test(bot.id)) throw new Error('chat_identity returned an unexpected identity');
    return { id: bot.id, handle: typeof bot.handle === 'string' ? bot.handle : null, locale: noticeLocaleOf(payload.locale) ?? noticeLocaleOf(payload.defaultLocale) };
  }

  let declaredNoticeKinds = null;
  let acknowledgementsAnnounced = false;
  let acknowledgementsRefused = false;
  let processingAnnounced = false;
  let processingRefused = false;
  const reportsAcknowledgements = () => acknowledgementsAnnounced && !acknowledgementsRefused;
  const reportsProcessing = () => reportsAcknowledgements() && processingAnnounced && !processingRefused;

  async function serverNoticeKinds() {
    if (declaredNoticeKinds === null) {
      const listed = await rpc('tools/list', {}, initializeTimeoutMs);
      const tools = Array.isArray(listed?.tools) ? listed.tools : [];
      const tool = tools.find((item) => item?.name === 'chat_notifications');
      const properties = tool?.inputSchema?.properties ?? {};
      acknowledgementsAnnounced = Object.hasOwn(properties, 'reportsAcknowledgements') && tools.some((item) => item?.name === 'chat_notifications_ack');
      processingAnnounced = tools.some((item) => item?.name === 'chat_notifications_processing');
      const property = Object.hasOwn(properties, 'acceptedNoticeKinds') ? properties.acceptedNoticeKinds : undefined;
      const announced = Array.isArray(property?.items?.enum) ? property.items.enum : baseNoticeKinds;
      const kinds = property ? noticeKinds.filter((kind) => announced.includes(kind)) : [];
      declaredNoticeKinds = kinds.length ? kinds : false;
    }
    return declaredNoticeKinds;
  }

  const read = (after, wait, kinds, acknowledgements) => callTool('chat_notifications',
    { after, wait, limit, ...(kinds ? { acceptedNoticeKinds: kinds } : {}), ...(acknowledgements ? { reportsAcknowledgements: true } : {}) }, wait * 1000 + pollMarginMs);

  async function readDeclaring(after, wait, declaresAcknowledgements) {
    const kinds = await serverNoticeKinds();
    const acknowledgements = declaresAcknowledgements && reportsAcknowledgements();
    try {
      return await read(after, wait, kinds, acknowledgements);
    } catch (error) {
      if (!(error instanceof ConfigRejected)) throw error;
      if (acknowledgements && error.code === 'BACKEND_INVALID_REQUEST') {
        acknowledgementsRefused = true;
        return readDeclaring(after, wait, declaresAcknowledgements);
      }
      if (!kinds) throw error;
      declaredNoticeKinds = null;
      const announced = await serverNoticeKinds();
      if (announced && announced.join(',') === kinds.join(',')) throw error;
      return read(after, wait, announced, declaresAcknowledgements && reportsAcknowledgements());
    }
  }

  async function acknowledge(ids) {
    try {
      return await callTool('chat_notifications_ack', { ids }, initializeTimeoutMs);
    } catch (error) {
      if (error instanceof ConfigRejected || (error instanceof ToolFailed && ['BACKEND_NOT_FOUND', 'UNKNOWN_TOOL'].includes(error.code))) acknowledgementsRefused = true;
      throw error;
    }
  }

  async function reportProcessing(ids, leaseSeconds) {
    try {
      return await callTool('chat_notifications_processing', { ids, leaseSeconds }, initializeTimeoutMs);
    } catch (error) {
      if (error instanceof ConfigRejected || (error instanceof ToolFailed && ['BACKEND_NOT_FOUND', 'UNKNOWN_TOOL'].includes(error.code))) processingRefused = true;
      throw error;
    }
  }

  async function notifications(after, wait, { acknowledgements = true } = {}) {
    const page = await readDeclaring(after, wait, acknowledgements);
    if (!Array.isArray(page?.events) || !Number.isSafeInteger(page.nextCursor)) {
      throw new Error('chat_notifications returned an unexpected page');
    }
    return page;
  }

  async function skills() {
    const listed = await rpc('tools/list', {}, initializeTimeoutMs);
    if (!Array.isArray(listed?.tools) || !listed.tools.some((tool) => tool?.name === 'skill_list')) return null;
    const page = await callTool('skill_list', {}, initializeTimeoutMs);
    if (!Array.isArray(page?.skills) || !page.skills.every((skill) => typeof skill?.name === 'string' && skillNamePattern.test(skill.name) && typeof skill.sha256 === 'string' && sha256Pattern.test(skill.sha256))) {
      throw new Error('skill_list returned an unexpected list');
    }
    return page.skills.map(({ name, sha256 }) => ({ name, sha256 }));
  }

  async function skill(name) {
    const result = await callToolResult('skill_get', { name }, initializeTimeoutMs);
    let metadata;
    try { metadata = JSON.parse(result?.content?.[0]?.text ?? 'null')?.skill; }
    catch { metadata = null; }
    const content = result?.content?.[1]?.text;
    if (metadata?.name !== name || typeof metadata.sha256 !== 'string' || !sha256Pattern.test(metadata.sha256) || typeof content !== 'string') throw new Error('skill_get returned an unexpected skill');
    return { name, sha256: metadata.sha256, content };
  }

  const roomContext = (roomId) => callTool('chat_room_context', { roomId }, initializeTimeoutMs);
  const sendMessage = (args) => callTool('chat_send_message', args, initializeTimeoutMs);
  const react = (args) => callTool('chat_react', args, initializeTimeoutMs);
  const card = (reference) => callTool('kanban_card', { card: reference }, initializeTimeoutMs);
  const comment = (args) => callTool('kanban_comment', args, initializeTimeoutMs);
  const message = async (roomId, messageId) => (await callTool('chat_messages', { roomId, after: messageId - 1, limit: 1 }, initializeTimeoutMs))
    ?.messages?.find((candidate) => candidate.id === messageId) ?? null;

  return { initialize, identity, notifications, reportsAcknowledgements, acknowledge, reportsProcessing, reportProcessing, skills, skill,
    roomContext, sendMessage, react, card, comment, message, close: () => controller.abort() };
}
