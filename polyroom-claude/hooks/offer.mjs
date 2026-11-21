import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const offeredSources = ['startup', 'clear'];

const readText = (path) => { try { return readFileSync(path, 'utf8'); } catch { return ''; } };

const readInput = () => new Promise((resolve) => {
  if (process.stdin.isTTY) { resolve(''); return; }
  const chunks = [];
  process.stdin.on('data', (chunk) => chunks.push(chunk));
  process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  process.stdin.on('error', () => resolve(Buffer.concat(chunks).toString('utf8')));
});

const sourceOf = (input) => { try { return JSON.parse(input).source; } catch { return undefined; } };

const settings = (path) => {
  const values = {};
  for (const line of readText(path).split('\n')) {
    const index = line.indexOf('=');
    if (index > 0) values[line.slice(0, index)] = line.slice(index + 1).trim();
  }
  return values;
};

const offerText = (declined) => [
  'polyroom is installed in this Claude Code, but this session is not connected to a polyroom agent yet. This notice comes from the polyroom plugin, not from the person.',
  'Tell the person that in one sentence and ask whether they want to connect now. Do not run the connect skill or call any tool on your own.',
  'To connect, they paste the connect line that polyroom shows them, say connect, or type /polyroom:connect.',
  'The sign-in happens only in the browser: never ask the person for the return address of the browser sign-in, a code or a token, never accept one they paste, and never pass one to the complete_authentication tool.',
  `If they say not now, write an empty file at ${declined} with the Write tool, and tell them they can connect later with /polyroom:connect.`,
].join(' ');

const quiet = () => process.exit(0);

if (process.env.CLAUDE_CODE_SESSION_ATTENDED !== '1') quiet();
if (!offeredSources.includes(sourceOf(await readInput()))) quiet();

const dir = process.env.POLYROOM_WAKE_DIR || join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'polyroom');
const values = settings(join(dir, 'wake.env'));
if (values.POLYROOM_WAKE_TOKEN || values.POLYROOM_WAKE_CODE || existsSync(join(dir, 'declined'))) quiet();

process.stderr.write(`${offerText(join(dir, 'declined'))}\n`, () => process.exit(2));
