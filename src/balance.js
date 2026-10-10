// Provider account balance, with a cache so the status line never waits on the
// network.
//
// DeepSeek exposes no per-session or per-day spend API — only the account's
// total balance — so this is the one number we cannot derive from the
// transcript. The refresh is deliberately detached: a stale value is shown
// immediately and a background process updates the cache for next time.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { INSTALL_DIR, PLUGIN_ROOT } from './config.js';

const DEFAULT_URL = 'https://api.deepseek.com/user/balance';

/** Read the API key from Claude Code's settings, where the DeepSeek key lives. */
export function readApiKey(env = process.env) {
  if (env.CC_CTX_BALANCE_KEY) return env.CC_CTX_BALANCE_KEY;
  if (env.ANTHROPIC_AUTH_TOKEN) return env.ANTHROPIC_AUTH_TOKEN;
  if (env.ANTHROPIC_API_KEY) return env.ANTHROPIC_API_KEY;

  const settingsFile = path.join(os.homedir(), '.claude', 'settings.json');
  try {
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    const fromEnv = settings?.env ?? {};
    return fromEnv.ANTHROPIC_AUTH_TOKEN || fromEnv.ANTHROPIC_API_KEY || null;
  } catch {
    return null;
  }
}

/** Normalise the provider's response into {currency, total, granted, toppedUp}. */
export function parseBalance(payload) {
  const info = payload?.balance_infos?.[0];
  if (!info) return null;
  const total = Number(info.total_balance);
  if (!Number.isFinite(total)) return null;
  return {
    currency: info.currency || 'CNY',
    total,
    granted: Number(info.granted_balance) || 0,
    toppedUp: Number(info.topped_up_balance) || 0,
    available: payload.is_available !== false,
  };
}

export async function fetchBalance({ url = DEFAULT_URL, key, timeoutMs = 8000 } = {}) {
  if (!key) return null;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return parseBalance(await res.json());
  } catch {
    return null;
  }
}

function cacheFile() {
  return path.join(INSTALL_DIR, 'balance.json');
}

export function readBalanceCache(file = cacheFile()) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function writeBalanceCache(entry, file = cacheFile()) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(entry));
    fs.renameSync(tmp, file);
  } catch {
    /* a cache we cannot write is not worth failing over */
  }
}

/**
 * Balance for display, in three tiers.
 *
 *   fresh      — inside the TTL, use the cache and touch nothing.
 *   warm-stale — TTL expired but the cache is recent. Show the old figure with
 *                a stale marker and refresh in the background, so an active
 *                session never waits on the network.
 *   cold       — the cache is old or absent, which in practice means a session
 *                is starting after a break. Wait for the fetch: a status line
 *                that opens showing a days-old figure looks broken, and one
 *                ~160ms wait at startup is not noticeable.
 *
 * Returns { balance, stale }.
 */
export async function resolveBalance(
  cfg,
  {
    readCache = readBalanceCache,
    writeCache = writeBalanceCache,
    fetchFn = fetchBalance,
    spawn = scheduleRefresh,
    now = Date.now,
  } = {},
) {
  const cached = readCache();
  const ttl = cfg?.balanceTtlMs ?? 60000;
  const coldAfter = cfg?.balanceBlockAfterMs ?? 300000;
  const age = cached ? now() - (cached.fetchedAt || 0) : Infinity;

  if (cached && age < ttl) return { balance: cached.balance, stale: false };

  if (!cached || age >= coldAfter) {
    const fresh = await fetchFn({
      url: cfg?.balanceUrl,
      key: readApiKey(),
      timeoutMs: cfg?.balanceTimeoutMs ?? 2500,
    });
    if (fresh) {
      writeCache({ fetchedAt: now(), balance: fresh });
      return { balance: fresh, stale: false };
    }
    // Fall through: a failed fetch should still show the last known figure.
  }

  spawn();
  if (cached) return { balance: cached.balance, stale: true };
  return { balance: null, stale: false };
}

/** Fork a background refresh so this process can exit immediately. */
export function scheduleRefresh() {
  try {
    const child = spawn(
      process.execPath,
      [path.join(PLUGIN_ROOT, 'src', 'cli.js'), 'balance-refresh'],
      { detached: true, stdio: 'ignore' },
    );
    child.unref();
  } catch {
    /* best effort */
  }
}

/** Entry point for the detached child. */
export async function refreshBalance(cfg) {
  const key = readApiKey();
  const balance = await fetchBalance({
    url: cfg?.balanceUrl || DEFAULT_URL,
    key,
  });
  if (balance) writeBalanceCache({ fetchedAt: Date.now(), balance });
  return balance;
}

/** Format for display, e.g. "¥57.42" or "¥57.42?" when the value is stale. */
export function formatBalance(balance, cfg, { stale = false } = {}) {
  if (!balance) return null;
  const symbol = balance.currency === (cfg?.currency || 'CNY') ? cfg.symbol : '';
  const amount = balance.total.toFixed(2);
  return `${symbol}${amount}${stale ? '?' : ''}`;
}
