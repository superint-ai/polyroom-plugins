export const standardTier = 'standard';
export const longPromptTier = 'long-prompt';

const hourMs = 3_600_000;

export function hourOf(ms) {
  return new Date(ms - (ms % hourMs)).toISOString();
}

export function minuteOf(ms) {
  return new Date(ms).toISOString().slice(0, 16);
}

export function priceTier(model, promptTokens, longPromptTiers) {
  const threshold = longPromptTiers.get(model);
  return threshold !== undefined && promptTokens > threshold ? longPromptTier : standardTier;
}

export function parseLongPromptTiers(raw) {
  const tiers = new Map();
  for (const part of raw.split(',').map((item) => item.trim()).filter(Boolean)) {
    const match = part.match(/^([A-Za-z0-9._-]+):(\d+)$/);
    if (!match) return null;
    tiers.set(match[1], Number(match[2]));
  }
  return tiers;
}

export const count = (value) => (Number.isSafeInteger(value) && value > 0 ? value : 0);
