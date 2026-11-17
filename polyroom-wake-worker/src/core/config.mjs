export const processingLeaseMaxMs = 86_400_000;

const numericVariables = [
  ['POLYROOM_POLL_WAIT_SECONDS', 'waitSeconds', 1, 600],
  ['POLYROOM_POLL_LIMIT', 'limit', 1, 10_000],
  ['POLYROOM_RETRY_MIN_MS', 'retryMinMs', 1, 3_600_000],
  ['POLYROOM_RETRY_MAX_MS', 'retryMaxMs', 1, 3_600_000],
  ['POLYROOM_INITIALIZE_TIMEOUT_MS', 'initializeTimeoutMs', 1, 600_000],
  ['POLYROOM_POLL_MARGIN_MS', 'pollMarginMs', 0, 600_000],
  ['POLYROOM_REDELIVERY_STEP_MS', 'redeliveryStepMs', 1, 3_600_000],
  ['POLYROOM_REDELIVERY_MAX_ATTEMPTS', 'redeliveryMaxAttempts', 0, 100],
  ['POLYROOM_LOCK_RETRY_MS', 'lockRetryMs', 1, 3_600_000],
  ['POLYROOM_BACKLOG_HOURS', 'backlogHours', 1, 720],
  ['POLYROOM_PENDING_MAX', 'pendingMax', 1, 10_000],
  ['POLYROOM_QUEUE_MAX', 'queueMax', 1, 1_000_000],
  ['POLYROOM_QUEUE_RESUME_BELOW', 'queueResumeBelow', 0, 1_000_000],
  ['POLYROOM_ACKNOWLEDGED_MAX', 'acknowledgedMax', 1, 1_000_000],
  ['POLYROOM_ACK_REPORT_MAX', 'ackReportMax', 1, 1000],
  ['POLYROOM_WRITE_RETRY_ATTEMPTS', 'writeRetryAttempts', 1, 20],
  ['POLYROOM_WRITE_RETRY_MS', 'writeRetryMs', 1, 10_000],
  ['POLYROOM_PROCESSING_LEASE_MS', 'processingLeaseMs', 1000, processingLeaseMaxMs],
  ['POLYROOM_PROCESSING_CUT_TOLERANCE_MS', 'processingCutToleranceMs', 0, 3_600_000],
  ['POLYROOM_STATUS_EVENTS_MAX', 'statusEventsMax', 1, 100_000],
];

const botPath = /^(?:\/company\/([a-z][a-z0-9-]{1,39}))?\/bots\/([a-z][a-z0-9_-]{1,39})\/mcp\/?$/;

export const identityMissingProblem = 'the session started without the bot identity: the polyroom-long-polling MCP entry in the profile .claude.json needs POLYROOM_MCP_URL and POLYROOM_MCP_AUTHORIZATION.';

export function numericVariable(name) {
  return numericVariables.find(([variable]) => variable === name);
}

export function text(env, name) {
  return typeof env[name] === 'string' ? env[name].trim() : '';
}

export function integer(env, name, min, max, problems) {
  const raw = text(env, name);
  if (!raw) {
    problems.push(`${name} must be set in the apps/mcp-long-polling .env.`);
    return undefined;
  }
  const value = /^-?\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    problems.push(`${name} must be an integer between ${min} and ${max}.`);
    return undefined;
  }
  return value;
}

function botAddress(url, problems) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    problems.push('POLYROOM_MCP_URL must be a valid URL.');
    return { handle: null, companySlug: null };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    problems.push('POLYROOM_MCP_URL must use http or https.');
    return { handle: null, companySlug: null };
  }
  const match = parsed.pathname.match(botPath);
  if (!match) problems.push('POLYROOM_MCP_URL must end in /company/<workspace>/bots/<handle>/mcp.');
  return { handle: match?.[2] ?? null, companySlug: match?.[1] ?? null };
}

export function readConfig(env) {
  const url = text(env, 'POLYROOM_MCP_URL');
  const authorization = text(env, 'POLYROOM_MCP_AUTHORIZATION');
  if (url.includes('${') || authorization.includes('${') || url.includes('/bots//') || /^bearer$/i.test(authorization)) {
    return { ok: false, state: 'stopped_identity', handle: null, problems: [identityMissingProblem] };
  }
  const problems = [];
  if (!url) problems.push('POLYROOM_MCP_URL must be set in the MCP entry.');
  if (!authorization) problems.push('POLYROOM_MCP_AUTHORIZATION must be set in the MCP entry.');
  const { handle, companySlug } = url ? botAddress(url, problems) : { handle: null, companySlug: null };
  const userAgent = text(env, 'POLYROOM_USER_AGENT');
  if (!userAgent) problems.push('POLYROOM_USER_AGENT must be set in the apps/mcp-long-polling .env.');
  const config = { url, authorization, userAgent, handle, companySlug };
  for (const [name, key, min, max] of numericVariables) config[key] = integer(env, name, min, max, problems);
  if (config.retryMinMs !== undefined && config.retryMaxMs !== undefined && config.retryMinMs > config.retryMaxMs) {
    problems.push('POLYROOM_RETRY_MIN_MS must be less than or equal to POLYROOM_RETRY_MAX_MS.');
  }
  if (config.queueResumeBelow !== undefined && config.queueMax !== undefined && config.queueResumeBelow >= config.queueMax) {
    problems.push('POLYROOM_QUEUE_RESUME_BELOW must be less than POLYROOM_QUEUE_MAX.');
  }
  if (problems.length) return { ok: false, state: 'stopped_config', handle, problems };
  return { ok: true, config };
}
