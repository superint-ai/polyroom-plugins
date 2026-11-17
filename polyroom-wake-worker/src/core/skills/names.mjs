import { createHash } from 'node:crypto';

const folderMax = 64;
const cutLength = 57;
const hashLength = 6;

export function skillFolderName(companySlug, name) {
  const full = `polyroom-${companySlug}-${name}`.replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
  if (full.length <= folderMax) return full;
  const hash = createHash('sha256').update(`${companySlug}/${name}`).digest('hex').slice(0, hashLength);
  return `${full.slice(0, cutLength).replace(/-+$/, '')}-${hash}`;
}

export function withSkillName(content, folder) {
  const lines = content.split('\n');
  if (lines[0].replace(/\r$/, '') !== '---') throw new Error('the SKILL.md has no header');
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index].replace(/\r$/, '');
    if (line === '---') break;
    if (/^name\s*:/.test(line)) {
      lines[index] = `name: ${folder}${lines[index].endsWith('\r') ? '\r' : ''}`;
      return lines.join('\n');
    }
  }
  throw new Error('the SKILL.md header has no name');
}
