export const secretMask = '•••';

const sensitiveName = /token|secret|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|authorization|cookie/i;
const ourPrefixes = ['s' + 'aw', 's' + 'wc', 's' + 'ac'].join('|');

const pemPrivateKey = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g;
const notAlphanumericBefore = '(?<![A-Za-z0-9])';
const ourTokens = new RegExp(`${notAlphanumericBefore}(?:${ourPrefixes})_[A-Za-z0-9_-]+`, 'g');
const tokenShapes = ['sk-[A-Za-z0-9_-]{16,}', '(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})', 'xox[bpas]-[A-Za-z0-9-]{10,}', 'AKIA[0-9A-Z]{16}(?![A-Za-z0-9])']
  .map((shape) => new RegExp(`${notAlphanumericBefore}${shape}`, 'g'));
const jwtStart = new RegExp(`${notAlphanumericBefore}eyJ`, 'g');
const jwtPart = /[A-Za-z0-9_-]/;
const urlScheme = new RegExp('(?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]{0,31}:\\/\\/', 'g');
const urlStop = /[\s"'<>`]/;
const authorityStop = /[\s"'<>`/?#]/;
const tokenLike = /^(?=.*[0-9])[A-Za-z0-9._~+=-]{16,}$/;
const urls = new RegExp('\\bhttps?:\\/\\/[^\\s"\'<>`]+', 'gi');
const signedParameters = new Set(['x-amz-signature', 'x-amz-credential', 'x-amz-security-token', 'signature', 'sig', 'token']);
const sasParameters = new Set(['se', 'sp', 'sv']);
const schemes = 'bearer|basic|digest|token';
const schemeValue = new RegExp(`\\b(${schemes})\\s+(?!•••)(?=[A-Za-z0-9._~+/=-]*[0-9._~+/=])[A-Za-z0-9._~+/=-]{8,}`, 'gi');
const identifiers = /[A-Za-z0-9_.-]+/g;
const separator = /[ \t]*[:=][ \t]*/y;
const leadingScheme = new RegExp(`(?:${schemes})[ \\t]+`, 'iy');
const yamlMapping = /^["']?[A-Za-z0-9_.-]+["']?[ \t]*:(?:[ \t]|$)/;
const literalSpan = /^[^\s$`();|&<>"'\\]*$/;

export const isLiteralSpan = (span) => literalSpan.test(span);

const isQuote = (character) => character === '"' || character === "'";

function runEnd(text, from, inside) {
  let index = from;
  while (index < text.length && inside.test(text[index])) index += 1;
  return index;
}

function stopAt(text, from, stop) {
  let index = from;
  while (index < text.length && !stop.test(text[index])) index += 1;
  return index;
}

function closingQuote(text, from, quote, beforeLineEnd) {
  for (let index = from; index < text.length; index += 1) {
    if (beforeLineEnd && (text[index] === '\n' || text[index] === '\r')) return -1;
    if (text[index] === '\\') index += 1;
    else if (text[index] === quote) return index;
  }
  return -1;
}

function maskJsonWebTokens(text, hide) {
  let output = '', copied = 0, skipUntil = 0;
  jwtStart.lastIndex = 0;
  for (let start = jwtStart.exec(text); start; start = jwtStart.exec(text)) {
    if (start.index < skipUntil) continue;
    const first = runEnd(text, start.index + 3, jwtPart);
    skipUntil = first;
    if (first === start.index + 3 || text[first] !== '.') continue;
    const second = runEnd(text, first + 1, jwtPart);
    if (second === first + 1 || text[second] !== '.') continue;
    const third = runEnd(text, second + 1, jwtPart);
    if (third === second + 1) continue;
    hide(text.slice(start.index, third));
    output += `${text.slice(copied, start.index)}${secretMask}`;
    copied = third;
    skipUntil = third;
    jwtStart.lastIndex = third;
  }
  return output + text.slice(copied);
}

function maskUserInfo(text, hide) {
  let output = '', copied = 0;
  urlScheme.lastIndex = 0;
  for (let scheme = urlScheme.exec(text); scheme; scheme = urlScheme.exec(text)) {
    const start = scheme.index + scheme[0].length;
    const authorityEnd = stopAt(text, start, authorityStop);
    const authority = text.slice(start, authorityEnd);
    let userEnd = start + authority.lastIndexOf('@');
    let resume = authorityEnd;
    if (userEnd < start) {
      const colon = authority.indexOf(':');
      if (colon < 0 || /^\d*$/.test(authority.slice(colon + 1))) { urlScheme.lastIndex = Math.max(urlScheme.lastIndex, authorityEnd); continue; }
      const addressEnd = stopAt(text, authorityEnd, urlStop);
      userEnd = text.lastIndexOf('@', addressEnd - 1);
      resume = addressEnd;
      if (userEnd < authorityEnd) { urlScheme.lastIndex = Math.max(urlScheme.lastIndex, addressEnd); continue; }
    }
    const userInfo = text.slice(start, userEnd);
    const colon = userInfo.indexOf(':');
    const hidden = colon >= 0 ? (colon + 1 < userInfo.length ? start + colon + 1 : -1) : tokenLike.test(userInfo) ? start : -1;
    if (hidden >= 0) {
      hide(text.slice(hidden, userEnd));
      output += `${text.slice(copied, hidden)}${secretMask}`;
      copied = userEnd;
    }
    urlScheme.lastIndex = Math.max(urlScheme.lastIndex, hidden >= 0 ? userEnd : resume);
  }
  return output + text.slice(copied);
}

function parameterName(raw) {
  try {
    return decodeURIComponent(raw.replaceAll('+', ' ')).toLowerCase();
  } catch {
    return null;
  }
}

function maskSignedUrl(url, hide) {
  const query = url.indexOf('?');
  if (query < 0) return url;
  const hash = url.indexOf('#', query);
  const end = hash < 0 ? url.length : hash;
  const parameters = url.slice(query + 1, end).split('&');
  const names = parameters.map((parameter) => parameterName(parameter.split('=')[0]));
  const sas = names.includes('sig');
  const masked = parameters.map((parameter, index) => {
    const equals = parameter.indexOf('=');
    const name = names[index];
    if (equals < 0 || !(name === null || signedParameters.has(name) || (sas && sasParameters.has(name)))) return parameter;
    hide(parameter.slice(equals + 1));
    return `${parameter.slice(0, equals)}=${secretMask}`;
  });
  return `${url.slice(0, query + 1)}${masked.join('&')}${url.slice(end)}`;
}

function maskedNextLine(text, valueStart) {
  let breakAt = valueStart;
  while (breakAt < text.length) {
    const bodyStart = runEnd(text, breakAt + (text.startsWith('\r\n', breakAt) ? 2 : 1), /[ \t]/);
    const lineEnd = stopAt(text, bodyStart, /[\r\n]/);
    const body = text.slice(bodyStart, lineEnd).trimEnd();
    if (body) return yamlMapping.test(body) ? null : { end: bodyStart + body.length, masked: `${text.slice(valueStart, bodyStart)}${secretMask}`, span: text.slice(valueStart, bodyStart + body.length) };
    breakAt = lineEnd;
  }
  return null;
}

function maskedValue(text, valueStart) {
  if (text[valueStart] === '\n' || text[valueStart] === '\r') return maskedNextLine(text, valueStart);
  const quote = isQuote(text[valueStart]) ? text[valueStart] : '';
  if (quote) {
    const tokenStart = valueStart + 1;
    leadingScheme.lastIndex = tokenStart;
    const scheme = leadingScheme.exec(text)?.[0] ?? '';
    const close = closingQuote(text, tokenStart, quote, false);
    return { end: close < 0 ? text.length : close + 1, masked: `${quote}${scheme}${secretMask}${close < 0 ? '' : quote}`,
      span: text.slice(tokenStart + scheme.length, close < 0 ? text.length : close) };
  }
  leadingScheme.lastIndex = valueStart;
  const scheme = leadingScheme.exec(text)?.[0] ?? '';
  const tokenStart = valueStart + scheme.length;
  if (scheme && isQuote(text[tokenStart])) {
    const close = closingQuote(text, tokenStart + 1, text[tokenStart], true);
    const end = close < 0 ? stopAt(text, tokenStart, /[\r\n]/) : close + 1;
    return { end, masked: `${scheme}${text[tokenStart]}${secretMask}${close < 0 ? '' : text[tokenStart]}`, span: text.slice(tokenStart + 1, close < 0 ? end : close) };
  }
  let end = scheme && /^digest/i.test(scheme) ? stopAt(text, tokenStart, /[\r\n]/) : stopAt(text, tokenStart, scheme ? /[\s"',;]/ : /[\s"'&,;]/);
  if (end === tokenStart) end = stopAt(text, tokenStart, /\s/);
  if (end === tokenStart) return null;
  return { end, masked: `${scheme}${secretMask}`, span: text.slice(tokenStart, end) };
}

function maskKeyValues(text, hide) {
  let output = '', copied = 0;
  identifiers.lastIndex = 0;
  for (let name = identifiers.exec(text); name; name = identifiers.exec(text)) {
    const nameEnd = name.index + name[0].length;
    const quoted = isQuote(text[name.index - 1]) && text[nameEnd] === text[name.index - 1];
    separator.lastIndex = nameEnd + (quoted ? 1 : 0);
    const found = separator.exec(text);
    if (!found || !sensitiveName.test(name[0])) continue;
    const valueStart = separator.lastIndex;
    const value = maskedValue(text, valueStart);
    if (!value) continue;
    hide(value.span);
    output += `${text.slice(copied, valueStart)}${value.masked}`;
    copied = value.end;
    identifiers.lastIndex = value.end;
  }
  return output + text.slice(copied);
}

function maskWith(text, hide) {
  const replaced = (match) => { hide(match); return secretMask; };
  let value = text.replace(pemPrivateKey, replaced).replace(ourTokens, replaced);
  for (const shape of tokenShapes) value = value.replace(shape, replaced);
  value = maskUserInfo(maskJsonWebTokens(value, hide), hide).replace(urls, (url) => maskSignedUrl(url, hide));
  return maskKeyValues(value, hide).replace(schemeValue, (match, scheme) => { hide(match.slice(scheme.length).trimStart()); return `${scheme} ${secretMask}`; });
}

export function maskSecrets(text) {
  return maskWith(text, () => {});
}

export function maskLiteral(text) {
  let literal = true;
  const masked = maskWith(text, (span) => { if (!isLiteralSpan(span)) literal = false; });
  return literal ? masked : null;
}

export function cutText(text, max) {
  const points = [...text];
  return points.length > max ? `${points.slice(0, max - 1).join('')}…` : text;
}
