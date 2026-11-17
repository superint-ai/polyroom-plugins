import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from '../state.mjs';
import { createWait } from '../wait.mjs';
import { skillFolderName, withSkillName } from './names.mjs';

export const skillMarkerFile = '.polyroom-skill.json';

export function skillsStateFile(directory, handle, botId) {
  return join(directory, `skills-${handle}.${botId}.json`);
}

const temporaryName = (name) => `.${name}.${randomBytes(4).toString('hex')}.tmp`;

class NotOwned extends Error {
  constructor() {
    super('the folder is not owned by the sync of this bot');
    this.code = 'NOT_OWNED';
  }
}

export function createSkillsSync({ config, client, dataDirectory, handle, log, clock, fs: { rename = renameSync } = {}, writeState = writeJsonAtomic, writeRetry }) {
  const wait = createWait(clock);
  const report = { state: 'idle', dir: config.dir, lastSyncAt: null, problems: [] };
  let botId = null;
  let file = null;
  let written = {};
  let loop = null;
  let stopped = false;

  const markerOf = (folder) => {
    try { return JSON.parse(readFileSync(join(config.dir, folder, skillMarkerFile), 'utf8')); }
    catch { return null; }
  };
  const ours = (marker) => marker?.company === config.companySlug && marker?.botId === botId;

  function replaceFile(folder, name, data) {
    const temporary = join(config.dir, folder, temporaryName(name));
    writeFileSync(temporary, data);
    try { rename(temporary, join(config.dir, folder, name)); }
    catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
  }

  function markerData(name, sha256) {
    return JSON.stringify({ company: config.companySlug, botId, name, sha256 });
  }

  function create(folder, name) {
    const temporary = join(config.dir, temporaryName(folder));
    mkdirSync(temporary);
    try {
      writeFileSync(join(temporary, skillMarkerFile), markerData(name, null));
      rename(temporary, join(config.dir, folder));
    } catch (error) {
      rmSync(temporary, { recursive: true, force: true });
      throw error;
    }
  }

  function write(folder, skill) {
    const content = withSkillName(skill.content, folder);
    if (!existsSync(join(config.dir, folder))) create(folder, skill.name);
    else if (!ours(markerOf(folder))) throw new NotOwned();
    replaceFile(folder, 'SKILL.md', content);
    replaceFile(folder, skillMarkerFile, markerData(skill.name, skill.sha256));
  }

  function remove(folder) {
    const doomed = join(config.dir, temporaryName(folder));
    rename(join(config.dir, folder), doomed);
    rmSync(doomed, { recursive: true, force: true });
  }

  function save() {
    writeState(file, { botId, savedAt: new Date(clock.now()).toISOString(), folders: written }, writeRetry);
  }

  function load(id) {
    botId = id;
    file = skillsStateFile(dataDirectory, handle, id);
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      if (saved?.botId === id && saved.folders && typeof saved.folders === 'object' && !Array.isArray(saved.folders)) written = saved.folders;
    } catch (error) {
      if (error.code !== 'ENOENT') log(`skills: ${file} could not be read (${error.code ?? error.name}); the sync starts without the list of written folders and deletes nothing it does not find marked`);
    }
    report.state = 'running';
  }

  async function tick() {
    const listed = await client.skills();
    if (stopped) return;
    if (listed === null) {
      report.state = 'unsupported';
      report.problems = ['the polyroom server does not offer skill_list yet; nothing was synced'];
      return;
    }
    report.state = 'running';
    const problems = [];
    const wanted = new Map(listed.map((skill) => [skillFolderName(config.companySlug, skill.name), skill]));
    const listedNames = new Set(listed.map((skill) => skill.name));
    const published = new Set();
    if (!existsSync(config.dir)) {
      mkdirSync(config.dir, { recursive: true });
      if (config.target === 'claude') {
        report.notice = `the skills folder ${config.dir} was created now; in a session that was already open, run /reload-skills to see the skills`;
        log(`skills: ${report.notice}`);
      }
    }
    for (const [folder, skill] of wanted) {
      if (stopped) return;
      const marker = markerOf(folder);
      const untouched = () => problems.push(`${folder} in ${config.dir} was not written by the sync of this bot, so it was left untouched`);
      if (existsSync(join(config.dir, folder)) && !ours(marker)) {
        untouched();
        continue;
      }
      if (marker?.sha256 === skill.sha256 && existsSync(join(config.dir, folder, 'SKILL.md'))) {
        written[folder] = { name: skill.name, sha256: skill.sha256 };
        published.add(skill.name);
        continue;
      }
      let fetched;
      try { fetched = await client.skill(skill.name); }
      catch (error) {
        problems.push(`${folder} could not be read from polyroom (${error.code ?? error.name}); the previous copy, if any, was kept`);
        continue;
      }
      if (stopped) return;
      if (!written[folder]) {
        written[folder] = { name: skill.name, sha256: null };
        try { save(); }
        catch (error) {
          delete written[folder];
          throw error;
        }
      }
      try {
        write(folder, fetched);
        written[folder] = { name: fetched.name, sha256: fetched.sha256 };
        published.add(skill.name);
      } catch (error) {
        if (error.code === 'NOT_OWNED') untouched();
        else problems.push(`${folder} could not be written (${error.code ?? error.name}); the previous copy, if any, was kept`);
      }
    }
    for (const folder of Object.keys(written)) {
      if (wanted.has(folder)) continue;
      if (listedNames.has(written[folder].name) && !published.has(written[folder].name)) continue;
      try {
        if (existsSync(join(config.dir, folder)) && ours(markerOf(folder))) remove(folder);
        delete written[folder];
      } catch (error) {
        problems.push(`${folder} could not be deleted (${error.code ?? error.name})`);
      }
    }
    save();
    report.problems = problems;
    report.lastSyncAt = new Date(clock.now()).toISOString();
    for (const problem of problems) log(`skills: ${problem}`);
  }

  async function run() {
    while (!stopped) {
      try { await tick(); }
      catch (error) {
        report.problems = [`the skills round failed (${error.code ?? error.name})`];
        log(`skills: ${report.problems[0]}`);
      }
      if (!stopped) await wait(config.intervalMs);
    }
  }

  return {
    load,
    tick,
    start(id) {
      if (loop || stopped) return;
      load(id);
      loop = run();
    },
    async stop() {
      stopped = true;
      wait.cancel();
      await loop;
      if (['running', 'idle', 'unsupported'].includes(report.state)) report.state = 'stopped';
    },
    status() {
      const { problems, notice, ...rest } = report;
      return { ...rest, skills: Object.keys(written).length, ...(notice ? { notice } : {}), ...(problems.length ? { problems } : {}) };
    },
  };
}
