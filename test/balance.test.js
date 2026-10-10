import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveBalance, parseBalance, formatBalance } from '../src/balance.js';

const CFG = {
  balanceTtlMs: 60_000,
  balanceBlockAfterMs: 300_000,
  balanceTimeoutMs: 2500,
  currency: 'CNY',
  symbol: '¥',
};

const NOW = 1_700_000_000_000;
const BALANCE = { currency: 'CNY', total: 42.5, granted: 0, toppedUp: 42.5 };

/** A harness recording what resolveBalance did. */
function harness({ cached, fetched = BALANCE } = {}) {
  const calls = { fetch: 0, spawn: 0, written: null };
  return {
    calls,
    options: {
      readCache: () => cached ?? null,
      writeCache: (entry) => {
        calls.written = entry;
      },
      fetchFn: async () => {
        calls.fetch += 1;
        return fetched;
      },
      spawn: () => {
        calls.spawn += 1;
      },
      now: () => NOW,
    },
  };
}

const cacheAge = (ms) => ({ fetchedAt: NOW - ms, balance: BALANCE });

test('a fresh cache is used as-is', async () => {
  const h = harness({ cached: cacheAge(10_000) });
  const result = await resolveBalance(CFG, h.options);
  assert.deepEqual(result, { balance: BALANCE, stale: false });
  assert.equal(h.calls.fetch, 0, 'must not touch the network inside the TTL');
  assert.equal(h.calls.spawn, 0);
});

test('a warm-but-expired cache shows stale and refreshes in the background', async () => {
  const h = harness({ cached: cacheAge(120_000) });
  const result = await resolveBalance(CFG, h.options);
  assert.deepEqual(result, { balance: BALANCE, stale: true });
  assert.equal(h.calls.fetch, 0, 'must not block an active session on the network');
  assert.equal(h.calls.spawn, 1, 'a detached refresh keeps the next render fresh');
});

test('a cold cache blocks once and returns the fresh value', async () => {
  // Regression: starting a session after a break used to render the days-old
  // figure, which reads as "the balance never updates".
  const h = harness({ cached: cacheAge(8 * 24 * 3600 * 1000) });
  const result = await resolveBalance(CFG, h.options);
  assert.deepEqual(result, { balance: BALANCE, stale: false });
  assert.equal(h.calls.fetch, 1, 'a cold start should wait for the real number');
  assert.equal(h.calls.spawn, 0, 'no background refresh needed');
  assert.equal(h.calls.written.fetchedAt, NOW, 'the result is cached for later renders');
});

test('no cache at all also blocks', async () => {
  const h = harness({ cached: null });
  const result = await resolveBalance(CFG, h.options);
  assert.deepEqual(result, { balance: BALANCE, stale: false });
  assert.equal(h.calls.fetch, 1);
});

test('a failed fetch falls back to the stale value rather than nothing', async () => {
  const h = harness({ cached: cacheAge(8 * 24 * 3600 * 1000), fetched: null });
  const result = await resolveBalance(CFG, h.options);
  assert.deepEqual(result, { balance: BALANCE, stale: true });
  assert.equal(h.calls.written, null, 'nothing to cache');
  assert.equal(h.calls.spawn, 1);
});

test('a failed fetch with no cache yields nothing to show', async () => {
  const h = harness({ cached: null, fetched: null });
  const result = await resolveBalance(CFG, h.options);
  assert.deepEqual(result, { balance: null, stale: false });
});

test('BLOCK_AFTER_MS=0 always waits, and a huge value never does', async () => {
  const always = harness({ cached: cacheAge(61_000) });
  await resolveBalance({ ...CFG, balanceBlockAfterMs: 0 }, always.options);
  assert.equal(always.calls.fetch, 1);

  const never = harness({ cached: cacheAge(61_000) });
  await resolveBalance({ ...CFG, balanceBlockAfterMs: Number.MAX_SAFE_INTEGER }, never.options);
  assert.equal(never.calls.fetch, 0);
  assert.equal(never.calls.spawn, 1);
});

test('parseBalance normalises the provider payload', () => {
  const parsed = parseBalance({
    is_available: true,
    balance_infos: [{ currency: 'CNY', total_balance: '57.42', granted_balance: '0.00', topped_up_balance: '57.42' }],
  });
  assert.deepEqual(parsed, { currency: 'CNY', total: 57.42, granted: 0, toppedUp: 57.42, available: true });
  assert.equal(parseBalance({}), null);
  assert.equal(parseBalance({ balance_infos: [{ total_balance: 'abc' }] }), null);
});

test('formatBalance marks a stale figure', () => {
  assert.equal(formatBalance(BALANCE, CFG), '¥42.50');
  assert.equal(formatBalance(BALANCE, CFG, { stale: true }), '¥42.50?');
  assert.equal(formatBalance(null, CFG), null);
});
