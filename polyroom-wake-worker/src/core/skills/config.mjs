import { isAbsolute } from 'node:path';
import { integer, text } from '../config.mjs';

export const legacyAddressProblem = 'The skills sync needs the MCP address with the company, /company/<slug>/bots/<handle>/mcp: the legacy /bots/<handle>/mcp address does not say which company the skills belong to. Use the address that polyroom shows on the bot page.';

const directoryKeys = { claude: 'POLYROOM_SKILLS_CLAUDE_DIR', codex: 'POLYROOM_SKILLS_CODEX_DIR' };

export function readSkillsConfig(env, { companySlug }, target) {
  const key = directoryKeys[target];
  const dir = text(env, key);
  if (!dir) return { enabled: false, problems: [] };
  const problems = [];
  if (!isAbsolute(dir)) problems.push(`${key} must be the absolute path of the skills folder, written in full with %USERPROFILE% or ~ already expanded, the ${target === 'codex' ? '.agents/skills' : '.claude/skills'} folder inside your user folder.`);
  if (!companySlug) problems.push(legacyAddressProblem);
  const intervalMs = integer(env, 'POLYROOM_SKILLS_SYNC_INTERVAL_MS', 60_000, 86_400_000, problems);
  return problems.length ? { enabled: false, problems } : { enabled: true, config: { dir, companySlug, intervalMs, target }, problems };
}
