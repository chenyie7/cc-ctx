// Provider definition: model -> rates, plus that provider's own time-tier rules.
//
// Exact matching only, no wildcards. When a new model appears that the price
// table does not list, we show "no price table" rather than silently pricing it
// at an older model's rates - that silent miscalculation is the bug this project
// set out to fix.

import fs from 'node:fs';
import path from 'node:path';

import { buildSchedule } from './schedule.js';

const RATE_KEYS = ['input', 'cacheWrite', 'cacheRead', 'output'];

/** The bracket is a context-window hint (`[1M]`), not part of the pricing identity. */
export function normalizeModelId(id) {
  return String(id ?? '')
    .replace(/\[[^\]]*\]/g, '')
    .trim()
    .toLowerCase();
}

/** All four buckets must be present and finite numbers; a missing one or a non-number voids the model. */
export function normalizeRates(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  for (const key of RATE_KEYS) {
    const value = Number(raw[key]);
    if (raw[key] === undefined || raw[key] === null || raw[key] === '' || !Number.isFinite(value)) {
      return null;
    }
    out[key] = value;
  }
  return out;
}

function scaleRates(rates, multiplier) {
  const factor = Number.isFinite(multiplier) ? multiplier : 1;
  const out = {};
  for (const key of RATE_KEYS) out[key] = rates[key] * factor;
  return out;
}

export function parseProvider(doc, source = { kind: 'bundled', file: null }, { calendars } = {}) {
  if (!doc || typeof doc !== 'object') return null;
  const id = String(doc.id ?? '').trim();
  if (!id) return null;

  const models = [];
  for (const [key, raw] of Object.entries(doc.models || {})) {
    const peak = normalizeRates(raw);
    if (!peak) continue; // Half-configured rates are worse than none: skip the model outright.

    const explicit = raw.offPeak === undefined ? null : normalizeRates(raw.offPeak);
    const offPeak = explicit || scaleRates(peak, doc.offPeakMultiplier ?? 1);

    const names = [key, ...(Array.isArray(raw.aliases) ? raw.aliases : [])]
      .map(normalizeModelId)
      .filter(Boolean);
    for (const name of names) {
      models.push({ key: name, peak, offPeak });
    }
  }
  if (!models.length) return null;

  return {
    id,
    currency: doc.currency || 'CNY',
    models,
    schedule: buildSchedule(doc.schedule, { calendars }),
    source,
  };
}

/** Exact match only. No wildcards - see the file header for why. */
export function matchRates(provider, modelId) {
  const id = normalizeModelId(modelId);
  if (!provider || !id) return null;
  const hit = provider.models.find((model) => model.key === id);
  return hit ? { key: hit.key, peak: hit.peak, offPeak: hit.offPeak } : null;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** entries: [{ dir, kind }], merged in order, later entries win on a shared id. */
export function loadProviders(entries, { calendars } = {}) {
  const byId = new Map();
  for (const { dir, kind } of entries) {
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    } catch {
      continue;
    }
    for (const name of files) {
      const file = path.join(dir, name);
      const provider = parseProvider(readJson(file), { kind, file }, { calendars });
      if (provider) byId.set(provider.id, provider);
    }
  }
  return [...byId.values()];
}
