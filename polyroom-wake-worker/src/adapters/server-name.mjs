import { WorkerProblems } from './codex/config.mjs';

export const nameSource = Object.freeze({ variable: 'variable', discovered: 'discovered', fallback: 'fallback' });

export const polyroomName = 'polyroom';

export function pickName({ configured, present, missing }) {
  if (configured) return { name: configured, source: nameSource.variable };
  if (!present(polyroomName)) throw new WorkerProblems([missing(polyroomName)]);
  return { name: polyroomName, source: nameSource.discovered };
}

export function describeSource(source, variable, unset = `${variable} empty`) {
  if (source === nameSource.variable) return `set by ${variable}`;
  if (source === nameSource.discovered) return `found in the configuration, with ${unset}`;
  return `the default, with ${unset} and nothing in the configuration to look in`;
}
