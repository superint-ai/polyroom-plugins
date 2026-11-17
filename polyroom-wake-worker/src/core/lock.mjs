import { closeSync, mkdirSync, openSync, rmSync, statSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { botIdPattern } from './chat-client.mjs';

function namedTarget({ name, file, platform, directory }) {
  if (platform === 'win32') return { kind: 'pipe', address: `\\\\.\\pipe\\${name}` };
  if (platform === 'linux') return { kind: 'abstract', address: `\0${name}` };
  return { kind: 'file', address: join(directory, `${file}.sock`), guard: join(directory, `${file}.guard`) };
}

export function lockTarget({ handle, companySlug = null, platform, directory }) {
  const address = companySlug ? `${companySlug}.${handle}` : handle;
  return namedTarget({ name: `polyroom-long-polling-${address}`, file: `poller-${address}`, platform, directory });
}

export function botLockTarget({ botId, platform, directory }) {
  if (typeof botId !== 'string' || !botIdPattern.test(botId)) throw new Error('The bot lock needs the id of the bot, as chat_polling_status shows it.');
  return namedTarget({ name: `polyroom-bot-${botId}`, file: `bot-${botId}`, platform, directory });
}

export function listenOn(address) {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => socket.destroy());
    server.once('error', reject);
    server.listen(address, () => {
      server.off('error', reject);
      server.unref();
      resolve(server);
    });
  });
}

export function probeAddress(address) {
  return new Promise((resolve) => {
    const socket = connect(address);
    socket.once('connect', () => {
      socket.destroy();
      resolve('alive');
    });
    socket.once('error', (error) => resolve(error.code === 'ECONNREFUSED' || error.code === 'ENOENT' ? 'stale' : 'unknown'));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function listenIfFree(address, listen) {
  try {
    return await listen(address);
  } catch (error) {
    if (error.code === 'EADDRINUSE') return null;
    throw error;
  }
}

function claimGuard(guard, maxAgeMs, now) {
  try {
    closeSync(openSync(guard, 'wx'));
    return true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  let modifiedAt;
  try {
    modifiedAt = statSync(guard).mtimeMs;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  if (now() - modifiedAt > maxAgeMs) rmSync(guard, { force: true });
  return false;
}

async function takeOverSocketFile(target, { guardMaxAgeMs, listen, probe, remove, now }) {
  if (!claimGuard(target.guard, guardMaxAgeMs, now)) return null;
  try {
    if (await probe(target.address) !== 'stale') return null;
    remove(target.address);
    return await listenIfFree(target.address, listen);
  } finally {
    rmSync(target.guard, { force: true });
  }
}

export async function tryAcquireLock(target, {
  guardMaxAgeMs,
  listen = listenOn,
  probe = probeAddress,
  remove = (file) => rmSync(file, { force: true }),
  now = Date.now,
} = {}) {
  if (target.kind === 'file') mkdirSync(dirname(target.address), { recursive: true });
  let server = await listenIfFree(target.address, listen);
  if (!server && target.kind === 'file') server = await takeOverSocketFile(target, { guardMaxAgeMs, listen, probe, remove, now });
  return server ? { address: target.address, release: () => closeServer(server) } : null;
}

export async function waitForLock({
  target,
  retryMs,
  wait = sleep,
  onBusy = () => {},
  onError = () => {},
  isCancelled = () => false,
  acquire = (candidate) => tryAcquireLock(candidate, { guardMaxAgeMs: retryMs }),
}) {
  let busyReported = false;
  for (;;) {
    if (isCancelled()) return null;
    try {
      const lock = await acquire(target);
      if (lock && isCancelled()) {
        await lock.release();
        return null;
      }
      if (lock) return { lock, waited: busyReported };
      if (!busyReported) {
        busyReported = true;
        onBusy();
      }
    } catch (error) {
      onError(error);
    }
    await wait(retryMs);
  }
}
