import { randomInt } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { addAllowRule, allowRuleFor, hasAllowRule, removeAllowRule } from './rules.mjs';
import { permissionTexts, wakeTexts } from './texts.mjs';

const verdictWords = new Map([['pode', 'allow'], ['sim', 'allow'], ['yes', 'allow'], ['sí', 'allow'], ['si', 'allow'], ['não', 'deny'], ['nao', 'deny'], ['no', 'deny']]);
const answeredMax = 500;
const codeAlphabet = 'abcdefghijkmnopqrstuvwxyz';
const elisionMarker = /⋯ \d+ code points elided ⋯/u;

function newCode() {
  return Array.from({ length: 5 }, () => codeAlphabet[randomInt(codeAlphabet.length)]).join('');
}

const leadingMentions = /^(?:@[a-z][a-z0-9_-]*[,:]?\s+)+/u;

export function verdictOf(text) {
  if (typeof text !== 'string' || text.trimEnd().endsWith('…')) return null;
  const word = text.normalize('NFC').trim().toLowerCase().replace(leadingMentions, '').replace(/[.!]+$/u, '');
  return verdictWords.get(word) ?? null;
}

export function cardVerdictOf(text, code) {
  if (typeof text !== 'string') return null;
  const match = text.normalize('NFC').trim().toLowerCase().replace(leadingMentions, '').match(/^(\S+?)[.!]?\s+(\S+)$/u);
  if (!match || match[2] !== code.toLowerCase()) return null;
  return verdictWords.get(match[1]) ?? null;
}

export function approverKinds(mode) {
  return { people: ['human'], agents: ['agent'], both: ['human', 'agent'] }[mode] ?? [];
}

export function eligibleApprovers(approval, botId) {
  const kinds = approverKinds(approval?.mode);
  const approvers = Array.isArray(approval?.approvers) ? approval.approvers : [];
  return approvers.filter((actor) => typeof actor?.id === 'string' && actor.id !== botId && kinds.includes(actor.kind));
}

function truncate(text, max) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

const fitsWhole = (text, max) => typeof text === 'string' && text.length <= max && !elisionMarker.test(text);

function createRuleStore(dataDirectory, botId) {
  const file = join(dataDirectory, `permission-rules-${botId}.json`);
  return {
    read() {
      let text;
      try { text = readFileSync(file, 'utf8'); }
      catch (error) { if (error.code === 'ENOENT') return []; throw error; }
      const rules = JSON.parse(text);
      if (!Array.isArray(rules)) throw new Error(`${file} does not hold a list`);
      return rules.filter((entry) => typeof entry?.rule === 'string' && typeof entry?.projectDir === 'string');
    },
    write(rules) {
      mkdirSync(dataDirectory, { recursive: true });
      const temporary = `${file}.${process.pid}.tmp`;
      try {
        writeFileSync(temporary, JSON.stringify(rules));
        renameSync(temporary, file);
      } finally {
        rmSync(temporary, { force: true });
      }
    },
  };
}

export function createPermissionRelay({ config, client, botId, handle, locale, dataDirectory, projectDir, sessionId, clock, log, origin, notify, wake }) {
  const texts = permissionTexts(locale);
  const open = new Map();
  const answered = new Map();
  const ruleTimers = new Map();
  const store = createRuleStore(dataDirectory, botId);
  let liveRules = [];
  let stopped = false;

  const roomKey = (roomId, messageId) => `${roomId}:${messageId}`;
  const ruleKey = ({ rule, projectDir }) => `${projectDir}\n${rule}`;
  const warn = (what) => (error) => log(`permission relay: ${what}: ${error.message}`);

  function remember(key, approvers) {
    answered.set(key, approvers);
    if (answered.size > answeredMax) answered.delete(answered.keys().next().value);
  }

  const approverOf = (approvers, sender) => approvers.find((actor) => actor.id === sender?.id && actor.kind === sender?.kind);

  function destinationOf(event) {
    if (event.kind === 'card') {
      const roomIds = Array.isArray(event.roomIds) ? event.roomIds : [];
      if (roomIds.length !== 1) return { skip: `card ${event.card?.ref ?? event.card?.id} has ${roomIds.length} linked rooms` };
      const reference = event.card?.ref ?? event.card?.id;
      if (!reference) return { skip: 'card notice without a reference' };
      return { type: 'card', card: reference, roomId: roomIds[0] };
    }
    if (typeof event.roomId !== 'string' || !event.roomId) return { skip: `notice ${event.id} has no room` };
    return { type: 'room', roomId: event.roomId };
  }

  async function target() {
    const { events = [], last = null } = origin() ?? {};
    const candidates = events.length ? events : last ? [last] : [];
    if (!candidates.length) return { skip: 'no notice delivered to this session yet' };
    const destinations = candidates.map(destinationOf);
    const skipped = destinations.find((destination) => destination.skip);
    if (skipped) return skipped;
    const distinct = new Set(destinations.map((destination) => `${destination.type}:${destination.card ?? destination.roomId}`));
    if (distinct.size > 1) return { skip: `the origin is ambiguous: notices without ack come from ${distinct.size} rooms or cards` };
    return destinations.at(-1);
  }

  async function approversOf(roomId) {
    const context = await client.roomContext(roomId);
    return { mode: context?.approval?.mode ?? null, approvers: eligibleApprovers(context?.approval, botId) };
  }

  async function post(destination, approvers, content, clientId, code) {
    const people = approvers.filter((actor) => actor.kind === 'human').map((actor) => actor.id);
    const agents = approvers.filter((actor) => actor.kind === 'agent').map((actor) => actor.id);
    if (destination.type === 'room') {
      const result = await client.sendMessage({ roomId: destination.roomId, clientId, content,
        ...(people.length ? { mentionPersonIds: people, alertMentionedPeople: true } : {}), ...(agents.length ? { mentionIds: agents } : {}) });
      return { messageId: result?.message?.id ?? null };
    }
    const names = approvers.map((actor) => actor.kind === 'agent' && actor.handle ? `@${actor.handle}` : `@${actor.name}`);
    const reply = code ? `\n\n${texts.cardReply(code)}` : '';
    const result = await client.comment({ card: destination.card, content: `${texts.cardMention(names)}\n\n${content}${reply}`,
      ...(people.length ? { mentionPersonIds: people } : {}) });
    const mine = (Array.isArray(result?.comments) ? result.comments : []).filter((comment) => comment?.author?.id === botId).at(-1);
    return { commentId: mine?.id ?? null, postedAt: mine?.createdAt ?? new Date(clock.now()).toISOString() };
  }

  async function markClosed(entry, emoji, comment) {
    if (entry.destination.type === 'room') {
      if (entry.messageId) await client.react({ roomId: entry.destination.roomId, messageId: entry.messageId, emoji });
      return;
    }
    await client.comment({ card: entry.destination.card, content: comment });
  }

  function close(entry) {
    entry.closed = true;
    if (entry.timer !== undefined) clock.clearTimeout(entry.timer);
    if (entry.pollTimer !== undefined) clock.clearTimeout(entry.pollTimer);
    open.delete(entry.key);
    if (entry.messageId) remember(roomKey(entry.destination.roomId, entry.messageId), entry.approvers);
  }

  function expire(entry) {
    if (entry.closed) return;
    close(entry);
    log(`permission relay: ${entry.label} expired without an answer`);
    void markClosed(entry, '⌛', texts.expired({ requestId: entry.label })).catch(warn('cannot mark the expired request'));
  }

  async function settle(entry, behavior, approver) {
    if (entry.closed) return;
    close(entry);
    const approverName = approver.name ?? approver.handle ?? approver.id;
    log(`permission relay: ${entry.label} ${behavior} by ${approverName} (${approver.id}) in room ${entry.destination.roomId}${entry.command ? `: ${entry.command}` : ''}`);
    if (entry.kind === 'relay') {
      await Promise.resolve().then(() => notify({ request_id: entry.requestId, behavior })).catch(warn('cannot send the verdict'));
    } else if (behavior === 'allow') {
      if (!(await grant(entry, approver))) {
        await markClosed(entry, '⚠️', texts.failed({ requestId: entry.label })).catch(warn('cannot mark the failed request'));
        return;
      }
    } else {
      await Promise.resolve().then(() => wake(wakeTexts.denied({ approver: { id: approver.id, name: approverName }, roomId: entry.destination.roomId, command: entry.command }))).catch(warn('cannot wake the bot'));
    }
    await markClosed(entry, behavior === 'allow' ? '✅' : '⛔', texts.resolved({ requestId: entry.label, behavior, approver: approverName }))
      .catch(warn('cannot mark the answered request'));
  }

  function schedule(live, delay, why) {
    const key = ruleKey(live);
    const timer = ruleTimers.get(key);
    if (timer !== undefined) clock.clearTimeout(timer);
    ruleTimers.set(key, clock.setTimeout(() => { void revoke(live, why); }, delay));
  }

  async function grant(entry, approver) {
    const approverName = approver.name ?? approver.handle ?? approver.id;
    const live = { rule: entry.rule, projectDir: entry.projectDir, expiresAt: new Date(clock.now() + config.ruleTtlMs).toISOString() };
    let preexisting;
    try { preexisting = hasAllowRule(entry.projectDir, entry.rule); }
    catch (error) { warn(`cannot read the settings for ${entry.command}`)(error); return false; }
    if (!preexisting) {
      const next = [...liveRules.filter((other) => ruleKey(other) !== ruleKey(live)), live];
      try { store.write(next); }
      catch (error) { warn(`cannot record the rule for ${entry.command} before writing it, so it was not written`)(error); return false; }
      liveRules = next;
      try { addAllowRule(entry.projectDir, entry.rule); }
      catch (error) {
        warn(`cannot write the rule for ${entry.command}`)(error);
        schedule(live, config.pollMs, 'the write failed');
        return false;
      }
      schedule(live, config.ruleTtlMs, 'its time ran out');
    }
    await Promise.resolve().then(() => wake(wakeTexts.approved({ approver: { id: approver.id, name: approverName }, roomId: entry.destination.roomId, command: entry.command })))
      .catch(warn('cannot wake the bot'));
    return true;
  }

  async function revoke(live, why) {
    const key = ruleKey(live);
    const timer = ruleTimers.get(key);
    if (timer !== undefined) clock.clearTimeout(timer);
    ruleTimers.delete(key);
    try { removeAllowRule(live.projectDir, live.rule); }
    catch (error) {
      warn(`cannot remove ${live.rule}, trying again in ${config.pollMs} ms`)(error);
      if (!stopped) schedule(live, config.pollMs, why);
      return false;
    }
    const next = liveRules.filter((other) => ruleKey(other) !== key);
    try { store.write(next); }
    catch (error) { warn(`removed ${live.rule} but cannot update the record`)(error); }
    liveRules = next;
    log(`permission relay: removed ${live.rule} from ${live.projectDir} because ${why}`);
    return true;
  }

  function pollCard(entry) {
    entry.pollTimer = clock.setTimeout(async () => {
      if (entry.closed || stopped) return;
      try {
        const result = await client.card(entry.destination.card);
        const after = Date.parse(entry.postedAt);
        const comments = (Array.isArray(result?.comments) ? result.comments : [])
          .filter((comment) => Date.parse(comment?.createdAt) > after && comment?.id !== entry.commentId)
          .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
        for (const comment of comments) {
          const approver = approverOf(entry.approvers, comment.author);
          const behavior = approver ? cardVerdictOf(comment.content, entry.cardCode) : null;
          if (behavior) { await settle(entry, behavior, approver); return; }
        }
      } catch (error) { warn(`cannot read card ${entry.destination.card}`)(error); }
      if (!entry.closed && !stopped) pollCard(entry);
    }, config.pollMs);
  }

  async function openRequest({ key, kind, label, content, extra }) {
    const destination = await target();
    if (destination.skip) { log(`permission relay: ${label} stays in the terminal: ${destination.skip}`); return; }
    const { approvers } = await approversOf(destination.roomId);
    if (!approvers.length) { log(`permission relay: ${label} stays in the terminal: room ${destination.roomId} has no approver for this bot`); return; }
    const cardCode = `${handle}-${label}`.toLowerCase();
    const posted = await post(destination, approvers, content, `permission-${key}`, destination.type === 'card' ? cardCode : null);
    const entry = { key, kind, label, destination, approvers, cardCode, ...posted, ...extra, closed: false };
    if (stopped) return;
    open.set(key, entry);
    entry.timer = clock.setTimeout(() => expire(entry), config.timeoutMs);
    if (destination.type === 'card') pollCard(entry);
  }

  return {
    async start() {
      let recorded;
      try { recorded = store.read(); }
      catch (error) { warn('cannot read the record of pending rules; it is kept as it is and no rule is written this session')(error); stopped = true; return; }
      liveRules = recorded;
      for (const live of recorded) await revoke(live, 'the previous session left it');
    },
    async request(params) {
      const requestId = String(params?.request_id ?? '');
      if (!/^[a-km-z]{5}$/.test(requestId)) { log('permission relay: ignored a request without a valid request_id'); return; }
      if (!fitsWhole(params.input_preview, config.previewMaxChars)) {
        log(`permission relay: ${requestId} stays in the terminal: its input is longer than POLYROOM_PERMISSION_PREVIEW_MAX_CHARS or came cut by Claude Code`);
        return;
      }
      const content = texts.relay({ bot: handle, tool: truncate(params.tool_name, 200), description: truncate(params.description, config.previewMaxChars),
        preview: truncate(params.input_preview, config.previewMaxChars), requestId, timeoutMs: config.timeoutMs });
      await openRequest({ key: requestId, kind: 'relay', label: requestId, content, extra: { requestId } })
        .catch(warn(`cannot post request ${requestId}`));
    },
    async blocked(entry) {
      const toolName = String(entry?.toolName ?? '');
      const toolInput = entry?.toolInput ?? {};
      const reason = typeof entry?.reason === 'string' && entry.reason.trim() ? entry.reason.trim() : texts.noReason;
      const preview = truncate(toolName === 'Bash' && typeof toolInput.command === 'string' ? toolInput.command : JSON.stringify(toolInput), config.previewMaxChars);
      const label = newCode();
      if (entry?.sessionId !== sessionId) {
        log(`permission relay: ignored block ${label} reported by another Claude session (${entry?.sessionId})`);
        return;
      }
      if (typeof entry?.projectDir !== 'string' || !entry.projectDir || resolve(entry.projectDir) !== resolve(projectDir)) {
        log(`permission relay: ignored block ${label} reported for another project folder (${entry?.projectDir}), this session runs in ${projectDir}`);
        return;
      }
      const ruled = allowRuleFor(toolName, toolInput);
      const allowed = ruled.refused || fitsWhole(toolInput.command.trim(), config.previewMaxChars) ? ruled : { refused: 'too_long' };
      if (allowed.refused) {
        const why = allowed.refused;
        const destination = await target();
        if (destination.skip) { log(`permission relay: block ${label} stays in the terminal: ${destination.skip}`); return; }
        const { approvers } = await approversOf(destination.roomId).catch(() => ({ approvers: [] }));
        if (!approvers.length) { log(`permission relay: block ${label} stays in the terminal: room ${destination.roomId} has no approver for this bot`); return; }
        await post(destination, approvers, texts.terminalOnly({ bot: handle, tool: toolName, reason, preview, why, folder: projectDir }), `permission-blocked-${entry?.toolUseId ?? label}`)
          .catch(warn(`cannot post block ${label}`));
        return;
      }
      const command = toolInput.command.trim();
      const content = texts.blocked({ bot: handle, tool: toolName, reason, command, folder: projectDir, timeoutMs: config.timeoutMs });
      await openRequest({ key: `blocked-${entry.toolUseId ?? label}`, kind: 'blocked', label, content, extra: { command, rule: allowed.rule, projectDir: resolve(projectDir) } })
        .catch(warn(`cannot post block ${label}`));
    },
    async used(entry) {
      if (entry?.sessionId !== sessionId) return;
      const live = liveRules.find((other) => other.rule === entry?.rule && typeof entry?.projectDir === 'string' && other.projectDir === resolve(entry.projectDir));
      if (live) await revoke(live, 'the approved command ran');
    },
    async consume(event) {
      if (event?.kind !== undefined && event.kind !== 'message') return false;
      if (typeof event?.roomId !== 'string' || !verdictOf(event?.excerpt)) return false;
      const approversIn = (key) => [...open.values()].find((candidate) => candidate.destination.type === 'room' && candidate.messageId !== null
        && roomKey(candidate.destination.roomId, candidate.messageId) === key)?.approvers ?? answered.get(key);
      const roomPrefix = roomKey(event.roomId, '');
      const awaited = [...[...open.values()].filter((candidate) => candidate.destination.type === 'room' && candidate.messageId !== null)
        .map((candidate) => roomKey(candidate.destination.roomId, candidate.messageId)), ...answered.keys()].filter((key) => key.startsWith(roomPrefix));
      if (!awaited.some((key) => approverOf(approversIn(key), event.sender))) return false;
      let replyTo = Number.isSafeInteger(event.replyTo) ? event.replyTo : null;
      if (replyTo === null && Number.isSafeInteger(event.messageId)) {
        const message = await client.message(event.roomId, event.messageId).catch(warn(`cannot read message ${event.messageId} to match it to a request`));
        replyTo = Number.isSafeInteger(message?.replyTo) ? message.replyTo : null;
      }
      if (replyTo === null) return false;
      const key = roomKey(event.roomId, replyTo);
      const entry = [...open.values()].find((candidate) => candidate.destination.type === 'room' && candidate.messageId !== null
        && roomKey(candidate.destination.roomId, candidate.messageId) === key);
      const approvers = entry?.approvers ?? answered.get(key);
      if (!approvers) return false;
      const approver = approverOf(approvers, event.sender);
      const behavior = approver ? verdictOf(event.excerpt) : null;
      if (!behavior) return false;
      if (entry) void settle(entry, behavior, approver).catch(warn('cannot settle the request'));
      return true;
    },
    abandon() {
      stopped = true;
      for (const entry of open.values()) close(entry);
      for (const timer of ruleTimers.values()) clock.clearTimeout(timer);
      ruleTimers.clear();
    },
    async stop() {
      stopped = true;
      for (const entry of [...open.values()]) close(entry);
      for (const live of [...liveRules]) await revoke(live, 'the channel stopped');
      for (const timer of ruleTimers.values()) clock.clearTimeout(timer);
      ruleTimers.clear();
    },
  };
}
