// Configuration: defaults, then conf/default.env, then the user's own file.
//
// User config lives outside the plugin (~/.claude/cc-ctx/cc-ctx.env) so that
// plugin updates never overwrite the user's display and layout settings. Prices
// and peak/off-peak rules are not env at all — they live in JSON under
// conf/providers/ and conf/calendars/.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

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

// Where price and holiday JSON is read from, built-in first so user files win.
const PROVIDERS_BUILTIN = path.join(PLUGIN_ROOT, 'conf', 'providers');
const CALENDARS_BUILTIN = path.join(PLUGIN_ROOT, 'conf', 'calendars');
const REMOTE_PROVIDERS = path.join(INSTALL_DIR, 'remote', 'providers');
const REMOTE_CALENDARS = path.join(INSTALL_DIR, 'remote', 'calendars');
const USER_PROVIDERS = path.join(INSTALL_DIR, 'providers');
const USER_CALENDARS = path.join(INSTALL_DIR, 'calendars');

/**
 * Order matters more than membership here: the first fields are the ones worth
 * a glance, the rest fill in behind them.
 */
export const DEFAULT_FIELDS = [
  'context', 'dir', 'balance', 'cost', 'tier', 'effort', 'tokens',
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
    installDir: INSTALL_DIR,
    // Order is priority: later entries win over earlier ones.
    providerDirs: [
      { dir: PROVIDERS_BUILTIN, kind: 'bundled' },
      { dir: cc.CC_CTX_PROVIDERS_REMOTE_DIR || REMOTE_PROVIDERS, kind: 'remote' },
      { dir: cc.CC_CTX_PROVIDERS_DIR || USER_PROVIDERS, kind: 'user' },
    ],
    calendarDirs: [
      { dir: CALENDARS_BUILTIN, kind: 'bundled' },
      { dir: cc.CC_CTX_CALENDARS_REMOTE_DIR || REMOTE_CALENDARS, kind: 'remote' },
      { dir: cc.CC_CTX_CALENDARS_DIR || USER_CALENDARS, kind: 'user' },
    ],
    tierAlertMinutes: Number(cc.CC_CTX_TIER_ALERT_MINUTES || 20),
    remote: (cc.CC_CTX_REMOTE || 'on').toLowerCase() !== 'off',
    remoteTtlMs: Number(cc.CC_CTX_REMOTE_TTL_MS || 86400000),
    providerUrl: cc.CC_CTX_PROVIDER_URL || '',
    calendarUrl: cc.CC_CTX_CALENDAR_URL || '',
    raw: cc,
  };
}
