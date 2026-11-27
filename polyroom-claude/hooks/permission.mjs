import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { cutText, maskLiteral } from './mask.mjs';

const userAgent = 'polyroom-wake/1';
const unknownCursor = '999999999999999';
const destinations = new Set(['session', 'localSettings', 'projectSettings', 'userSettings', 'cliArg']);
const behaviors = new Set(['allow', 'deny', 'ask']);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const suggestionIndexMax = 1000;
const nameMaxChars = 200;
const sessionIdMaxChars = 200;
const isNumber = (value) => /^\d+$/.test(value ?? '');
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const filled = (value) => typeof value === 'string' && value.length > 0;
const cksumTable = Array.from({ length: 256 }, (_, index) => {
  let value = index << 24;
  for (let bit = 0; bit < 8; bit++) value = value & 0x80000000 ? (value << 1) ^ 0x04c11db7 : value << 1;
  return value >>> 0;
});

const [product = '', action = ''] = process.argv.slice(2);
if (product !== 'claude' || !['permission', 'question'].includes(action)) {
  process.stderr.write('usage: permission.mjs claude permission|question\n', () => process.exit(64));
} else {
  await main();
}

async function main() {
  const finish = (code, stdout = null) => new Promise(() => {
    if (stdout === null) process.exit(code);
    process.stdout.write(stdout, () => process.exit(code));
  });
  const readText = (path) => { try { return readFileSync(path, 'utf8'); } catch { return null; } };
  const exists = (path) => { try { statSync(path); return true; } catch { return false; } };

  const appUrl = process.env.POLYROOM_WAKE_URL ?? '';
  const appToken = process.env.POLYROOM_WAKE_TOKEN ?? '';
  const appMode = appUrl !== '' || appToken !== '';
  const appAddressValid = /^(?:https:\/\/[^/]|http:\/\/127\.0\.0\.1(?:[:/]|$))/.test(appUrl) && !/[\s\x00-\x1f\x7f?#@]/.test(appUrl);
  if (appMode && !(process.env.POLYROOM_WAKE_DIR && appAddressValid && /^saw_[A-Za-z0-9_-]+$/.test(appToken))) await finish(0);
  const dir = process.env.POLYROOM_WAKE_DIR || join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'polyroom');
  const values = {};
  for (const line of (readText(join(dir, 'wake.env')) ?? '').split('\n')) {
    const index = line.indexOf('=');
    if (index > 0) values[line.slice(0, index)] = line.slice(index + 1).trim();
  }
  const numberSetting = (key, fallback) => (isNumber(values[key]) ? Number(values[key]) : fallback);
  const url = (appMode ? appUrl : values.POLYROOM_WAKE_URL ?? '').replace(/\/+$/, '');
  const token = appMode ? appToken : values.POLYROOM_WAKE_TOKEN ?? '';
  const httpTimeoutMs = numberSetting('POLYROOM_WAKE_PERMISSION_HTTP_TIMEOUT_MS', 5000);
  const pollMs = Math.max(1, numberSetting('POLYROOM_WAKE_PERMISSION_POLL_MS', 3000));
  const graceMs = numberSetting('POLYROOM_WAKE_PERMISSION_GRACE_MS', 30000);
  const budgetMs = numberSetting('POLYROOM_WAKE_PERMISSION_BUDGET_MS', 870000);
  const postAttempts = Math.max(1, numberSetting('POLYROOM_WAKE_PERMISSION_POST_ATTEMPTS', 2));
  const textMaxChars = Math.max(2, numberSetting('POLYROOM_WAKE_PERMISSION_TEXT_MAX_CHARS', 3500));
  const optionsMax = Math.max(2, numberSetting('POLYROOM_WAKE_PERMISSION_OPTIONS_MAX', 8));
  const questionsMax = Math.max(1, numberSetting('POLYROOM_WAKE_PERMISSION_QUESTIONS_MAX', 4));
  const started = Date.now();

  if (!url || !token || exists(join(dir, 'stopped'))) await finish(0);

  const input = await new Promise((resolve) => {
    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => resolve(''));
  });
  let event;
  try { event = JSON.parse(input); } catch { await finish(0); }
  if (!isObject(event)) await finish(0);

  let unshowable = false;
  const fits = (text) => [...text].length <= textMaxChars;
  const shown = (text) => {
    const masked = maskLiteral(text);
    if (masked === null || !fits(masked)) unshowable = true;
    return masked ?? '';
  };
  const shownAsIs = (text) => {
    const masked = maskLiteral(text);
    if (masked === null) unshowable = true;
    return masked === text && fits(text);
  };
  const toolInput = isObject(event.tool_input) ? event.tool_input : {};
  const toolName = filled(event.tool_name) ? event.tool_name : '';
  if (!toolName) await finish(0);

  const suggestionOf = (suggestion, index) => {
    if (!isObject(suggestion) || index > suggestionIndexMax || !destinations.has(suggestion.destination)) return null;
    if (suggestion.type === 'addRules') {
      const { rules } = suggestion;
      if (!behaviors.has(suggestion.behavior) || !Array.isArray(rules) || rules.length < 1 || rules.length > optionsMax) return null;
      if (!rules.every((rule) => isObject(rule) && filled(rule.toolName) && (rule.ruleContent === undefined || typeof rule.ruleContent === 'string'))) return null;
      const texts = rules.flatMap((rule) => [rule.toolName, rule.ruleContent].filter(filled));
      if (!texts.map(shownAsIs).every(Boolean)) return null;
      return { index, type: 'addRules', rules: rules.map((rule) => ({ toolName: rule.toolName, ...(typeof rule.ruleContent === 'string' ? { ruleContent: rule.ruleContent } : {}) })),
        behavior: suggestion.behavior, destination: suggestion.destination };
    }
    if (suggestion.type === 'addDirectories') {
      const { directories } = suggestion;
      if (!Array.isArray(directories) || directories.length < 1 || directories.length > optionsMax || !directories.every(filled)) return null;
      if (!directories.map(shownAsIs).every(Boolean)) return null;
      return { index, type: 'addDirectories', directories: [...directories], destination: suggestion.destination };
    }
    return null;
  };

  const permissionRequest = () => {
    const original = Array.isArray(event.permission_suggestions) ? event.permission_suggestions : [];
    const suggestions = original.map(suggestionOf).filter(Boolean).slice(0, optionsMax - 2);
    const preview = toolName === 'Bash' && typeof toolInput.command === 'string' ? toolInput.command : JSON.stringify(toolInput);
    return {
      body: { kind: 'permission', ...(filled(toolInput.description) ? { description: shown(toolInput.description) } : {}), ...(filled(preview) ? { preview: shown(preview) } : {}), suggestions },
      original,
      sent: new Set(suggestions.map((suggestion) => suggestion.index)),
    };
  };

  const questionRequest = () => {
    const { questions } = toolInput;
    if (!Array.isArray(questions) || questions.length < 1 || questions.length > questionsMax) return null;
    const valid = questions.every((item) => isObject(item) && filled(item.question) && Array.isArray(item.options) && item.options.length >= 1 && item.options.length <= optionsMax
      && item.options.every((option) => isObject(option) && filled(option.label)));
    if (!valid) return null;
    return {
      body: { kind: 'question', questions: questions.map((item) => ({ question: shown(item.question), ...(filled(item.header) ? { header: shown(item.header) } : {}),
        multiSelect: item.multiSelect === true,
        options: item.options.map((option) => ({ label: shown(option.label), ...(filled(option.description) ? { description: shown(option.description) } : {}) })) })) },
      questions,
    };
  };

  const built = action === 'permission' ? permissionRequest() : questionRequest();
  const shownToolName = shown(toolName);
  if (!built || unshowable) await finish(0);

  const marks = () => {
    const bytes = Buffer.from(token, 'utf8');
    return [cksum(bytes), createHash('sha256').update(bytes).digest('hex').slice(0, 12)];
  };
  const markedNumber = (path) => {
    const parts = (readText(path) ?? '').trim().split(/\s+/);
    const number = parts.length === 1 ? parts[0] : parts.length === 2 && marks().includes(parts[0]) ? parts[1] : '';
    return isNumber(number) && number !== '0' && number !== unknownCursor && Number.isSafeInteger(Number(number)) ? Number(number) : null;
  };
  const hintNoticeId = markedNumber(join(dir, 'pending')) ?? markedNumber(join(dir, 'cursor'));
  const sessionId = filled(event.session_id) && event.session_id.length <= sessionIdMaxChars ? event.session_id : null;
  const requestKey = randomUUID();
  const payload = JSON.stringify({ ...built.body, toolName: shownToolName, personOnly: event.permission_mode === 'auto', requestKey,
    ...(hintNoticeId !== null ? { hintNoticeId } : {}), ...(sessionId ? { sessionId } : {}) });

  const send = (method, address, body) => new Promise((resolve) => {
    let settled = false;
    let request = null;
    const settle = (answer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(answer);
    };
    const failed = () => { request?.destroy(); settle({ status: 0, value: null }); };
    const timer = setTimeout(failed, httpTimeoutMs);
    let target;
    try { target = new URL(address); } catch { failed(); return; }
    const client = target.protocol === 'https:' ? https : target.protocol === 'http:' ? http : null;
    if (!client) { failed(); return; }
    const headers = { 'User-Agent': userAgent, Authorization: `Bearer ${token}`, Accept: 'application/json' };
    if (body !== null) Object.assign(headers, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    request = client.request(target, { method, headers, agent: false }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        let value = null;
        try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
        settle({ status: response.statusCode ?? 0, value });
      });
      response.on('error', failed);
      response.on('aborted', failed);
    });
    request.on('error', failed);
    request.end(body ?? undefined);
  });
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  let created = { status: 0, value: null };
  for (let attempt = 0; attempt < postAttempts; attempt++) {
    created = await send('POST', `${url}/wake/permission-requests`, payload);
    if (created.status !== 0 && created.status < 500) break;
  }
  const opened = created.value;
  if (![200, 201].includes(created.status) || !isObject(opened) || typeof opened.id !== 'string' || !uuidPattern.test(opened.id)
    || !['open', 'answered'].includes(opened.state)) await finish(0);

  const expiresAt = Date.parse(opened.expiresAt);
  const deadline = Math.min(Number.isFinite(expiresAt) ? expiresAt + graceMs : Infinity, started + budgetMs);

  const permissionOutput = (answer, answeredBy) => {
    const effect = answer?.effect;
    let decision = null;
    if (effect?.type === 'allow') decision = { behavior: 'allow' };
    else if (effect?.type === 'deny') {
      const name = typeof answeredBy?.name === 'string' ? cutText(answeredBy.name.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim(), nameMaxChars) : '';
      if (name) decision = { behavior: 'deny', message: `Denied in the chat by ${name}.` };
    } else if (effect?.type === 'suggestion' && Number.isSafeInteger(effect.index) && built.sent.has(effect.index)) {
      decision = { behavior: 'allow', updatedPermissions: [built.original[effect.index]] };
    }
    return decision && { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } };
  };

  const questionOutput = (answer) => {
    const chosen = answer?.answers;
    if (!Array.isArray(chosen) || chosen.length !== built.questions.length) return null;
    const answers = {};
    for (const [index, item] of built.questions.entries()) {
      const keys = chosen[index]?.keys;
      if (!Array.isArray(keys) || keys.length < 1 || (item.multiSelect !== true && keys.length !== 1) || new Set(keys).size !== keys.length) return null;
      const labels = [];
      for (const key of keys) {
        const position = typeof key === 'string' && /^\d{1,3}$/.test(key) ? Number(key) : 0;
        if (position < 1 || position > item.options.length) return null;
        labels.push(item.options[position - 1].label);
      }
      answers[item.question] = labels.join(', ');
    }
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { questions: built.questions, answers } } };
  };

  let wait = opened.state === 'open';
  for (;;) {
    if (wait) {
      const left = deadline - Date.now();
      if (left <= 0) break;
      await pause(Math.min(pollMs, left));
    }
    wait = true;
    const read = await send('GET', `${url}/wake/permission-requests/${opened.id}`, null);
    if ([401, 403, 404].includes(read.status)) break;
    if (read.status !== 200 || !isObject(read.value) || read.value.state === 'open') continue;
    if (read.value.state !== 'answered') break;
    const output = action === 'permission' ? permissionOutput(read.value.answer, read.value.answeredBy) : questionOutput(read.value.answer);
    if (output) await finish(0, `${JSON.stringify(output)}\n`);
    break;
  }
  await finish(0);
}

function cksum(bytes) {
  let crc = 0;
  const step = (byte) => { crc = ((crc << 8) ^ cksumTable[((crc >>> 24) ^ byte) & 0xff]) >>> 0; };
  for (const byte of bytes) step(byte);
  for (let length = bytes.length; length > 0; length = Math.floor(length / 256)) step(length & 0xff);
  return String(~crc >>> 0);
}
