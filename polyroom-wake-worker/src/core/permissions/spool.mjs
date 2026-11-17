import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

let sequence = 0;

export function spoolDirectory(dataDirectory, env) {
  const configDirectory = resolve(env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude'));
  return join(dataDirectory, 'permission-hooks', createHash('sha256').update(configDirectory).digest('hex').slice(0, 16));
}

export function sessionSpool(dataDirectory, env, sessionId) {
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) return null;
  return join(spoolDirectory(dataDirectory, env), sessionId);
}

export function writeSpoolEntry(directory, entry) {
  mkdirSync(directory, { recursive: true });
  sequence += 1;
  const name = `${String(Date.now()).padStart(15, '0')}-${String(sequence).padStart(9, '0')}-${process.pid}-${randomBytes(4).toString('hex')}`;
  const temporary = join(directory, `${name}.tmp`);
  writeFileSync(temporary, JSON.stringify(entry));
  renameSync(temporary, join(directory, `${name}.json`));
}

export function readSpoolEntries(directory) {
  let names;
  try { names = readdirSync(directory).filter((name) => name.endsWith('.json')).sort(); }
  catch { return []; }
  const entries = [];
  for (const name of names) {
    const file = join(directory, name);
    try { entries.push(JSON.parse(readFileSync(file, 'utf8'))); }
    catch {}
    rmSync(file, { force: true });
  }
  return entries;
}
