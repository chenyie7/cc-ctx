// Configuration: defaults, then conf/default.env, then the user's own file.
//
// User config lives outside the plugin (~/.claude/cc-ctx/cc-ctx.env) so that
// plugin updates never overwrite a user's prices or exchange rate.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { buildSchedule } from './peak.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = path.resolve(HERE, '..');

/** Where setup() installs the stable copy the statusLine points at. */
export const INSTALL_DIR = path.join(os.homedir(), '.claude', 'cc-ctx');

/** Where the user's own overrides live; never shipped, never overwritten. */
export const USER_ENV = path.join(INSTALL_DIR, 'cc-ctx.env');

export const DEFAULT_COLORS = {
  label: '38;2;110;118;129',
  brand: '38;2;148;163;184',
  model: '38;2;198;160;246',
  effort: '38;2;250;204;21',
  dir: '38;2;56;189;248',
  value: '38;2;226;232;240',
  ok: '38;2;74;222;128',
  warn: '38;2;250;204;21',
  hot: '38;2;248;113;113',
  divider: '38;2;71;85;105',
  barEmpty: '38;2;51;65;85',
};

/** Currency the shipped price table is quoted in. */
export const DEFAULT_PRICE_CURRENCY = 'CNY';

/**
 * Order matters more than membership here: the first fields are the ones worth
 * a glance, the rest fill in behind them.
 */
export const DEFAULT_FIELDS = [
  'context', 'dir', 'balance', 'cost', 'effort', 'tokens',
  'brand', 'model', 'session', 'hitrate', 'calls',
];

/**
 * Parse a KEY=value file. Values may be double-quoted, single-quoted, or bare.
 * Blank lines and `#` comments are ignored. Unknown keys are kept — callers
 * decide what they care about.
 */
export function parseEnvFile(text) {
  const out = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2);
    if (quoted) value = value.slice(1, -1);
    if (key) out[key] = value;
  }
  return out;
}

function readEnvFile(file) {
  try {
    return parseEnvFile(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Model id -> price key fragment.
 * `deepseek-v4-flash[1M]` -> `DEEPSEEK_V4_FLASH`
 * Bracketed qualifiers like `[1M]` are context-window hints, not part of the
 * price identity, so they are dropped.
 */
export function modelPriceKey(modelId) {
  const base = String(modelId || '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return base.toUpperCase();
}

/**
 * Resolve per-million-token prices for a model. Returns null when the model has
 * no complete price set — the caller must show "unknown" rather than fall back
 * to some other model's prices, which is exactly the bug this tool exists to fix.
 */
export function resolvePrices(env, modelId) {
  const key = modelPriceKey(modelId);
  const pick = (suffix) => env[`CC_CTX_PRICE_${key}_${suffix}`];

  const rates = {
    input: pick('INPUT'),
    cacheWrite: pick('CACHE_WRITE'),
    cacheRead: pick('CACHE_READ'),
    output: pick('OUTPUT'),
  };

  const values = Object.values(rates);
  if (values.every((v) => v === undefined)) return null;
  if (values.some((v) => v === undefined || v === '' || Number.isNaN(Number(v)))) {
    return null;
  }
  // Prices ship in CNY, matching the provider's Chinese price list, so the
  // default path involves no conversion at all. A USD table still works — it is
  // converted through CC_CTX_RATE — and a single model may override the
  // currency on its own.
  return {
    currency:
      env[`CC_CTX_PRICE_${key}_CURRENCY`] || env.CC_CTX_PRICE_CURRENCY || DEFAULT_PRICE_CURRENCY,
    input: Number(rates.input),
    cacheWrite: Number(rates.cacheWrite),
    cacheRead: Number(rates.cacheRead),
    output: Number(rates.output),
  };
}

function splitList(value, fallback) {
  if (!value) return fallback;
  const parts = value.split(/[\s,]+/).filter(Boolean);
  return parts.length ? parts : fallback;
}

export function loadConfig({ env = process.env, userEnvFile = USER_ENV } = {}) {
  const defaults = readEnvFile(path.join(PLUGIN_ROOT, 'conf', 'default.env'));
  const user = readEnvFile(userEnvFile);
  // Real environment variables win over both files, so one-off overrides work.
  const cc = { ...defaults, ...user };
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith('CC_CTX_') && v !== undefined) cc[k] = v;
  }

  const colors = {};
  for (const [name, fallback] of Object.entries(DEFAULT_COLORS)) {
    const envName = `CC_CTX_COLOR_${name.replace(/[A-Z]/g, (c) => '_' + c).toUpperCase()}`;
    colors[name] = cc[envName] || fallback;
  }

  const truecolorPref = (cc.CC_CTX_TRUECOLOR || 'auto').toLowerCase();
  const colorterm = String(env.COLORTERM || '').toLowerCase();
  const truecolor =
    truecolorPref === 'on' ||
    (truecolorPref === 'auto' && /truecolor|24bit/.test(colorterm));

  const noColor =
    env.NO_COLOR !== undefined && env.NO_COLOR !== '' ? true : cc.CC_CTX_NO_COLOR === '1';

  return {
    colors,
    truecolor,
    noColor,
    fields: splitList(cc.CC_CTX_FIELDS, DEFAULT_FIELDS),
    gap: cc.CC_CTX_GAP ?? '  ',
    divider: cc.CC_CTX_DIVIDER ?? ' │ ',
    padding: Number(cc.CC_CTX_PADDING ?? 1),
    // 'balanced' evens the lines out; 'greedy' fills each line to the edge.
    wrap: (cc.CC_CTX_WRAP || 'balanced').toLowerCase(),
    labelSuffix: cc.CC_CTX_LABEL_SUFFIX ?? ' ',
    currency: cc.CC_CTX_CURRENCY || 'CNY',
    symbol: cc.CC_CTX_SYMBOL || '¥',
    rate: Number(cc.CC_CTX_RATE || 0) || 1,
    balanceTtlMs: Number(cc.CC_CTX_BALANCE_TTL_MS || 60000),
    // Past this age the status line waits for a fetch instead of showing a
    // stale figure — see resolveBalance.
    balanceBlockAfterMs: Number(cc.CC_CTX_BALANCE_BLOCK_AFTER_MS || 300000),
    // The real call takes ~160ms; this bounds the damage on a hung network.
    balanceTimeoutMs: Number(cc.CC_CTX_BALANCE_TIMEOUT_MS || 1500),
    balanceUrl: cc.CC_CTX_BALANCE_URL || 'https://api.deepseek.com/user/balance',
    contextWarn: Number(cc.CC_CTX_CONTEXT_WARN || 60),
    contextHot: Number(cc.CC_CTX_CONTEXT_HOT || 85),
    barWidth: Number(cc.CC_CTX_BAR_WIDTH || 10),
    schedule: buildSchedule(cc),
    raw: cc,
  };
}
