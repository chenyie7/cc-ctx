import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  normalizeModelId,
  normalizeRates,
  parseProvider,
  matchRates,
  loadProviders,
} from '../src/pricing/provider.js';
import { loadCalendars } from '../src/pricing/calendar.js';
import { tierAt } from '../src/pricing/schedule.js';

const CALS = loadCalendars([{ dir: fileURLToPath(new URL('../conf/calendars', import.meta.url)), kind: 'bundled' }]);
const BUNDLED = { dir: fileURLToPath(new URL('../conf/providers', import.meta.url)), kind: 'bundled' };

test('normalizeModelId strips the bracket qualifier and lowercases', () => {
  assert.equal(normalizeModelId('deepseek-flash[1M]'), 'deepseek-flash');
  assert.equal(normalizeModelId('  DeepSeek-V4-Pro  '), 'deepseek-v4-pro');
  assert.equal(normalizeModelId(''), '');
  assert.equal(normalizeModelId(undefined), '');
});

test('normalizeRates requires all four buckets to be finite numbers, otherwise the model is void', () => {
  const ok = normalizeRates({ input: 2, cacheWrite: 2, cacheRead: 0.04, output: 8 });
  assert.deepEqual(ok, { input: 2, cacheWrite: 2, cacheRead: 0.04, output: 8 });

  assert.equal(normalizeRates({ input: 2, cacheWrite: 2, cacheRead: 0.04 }), null, 'a missing key voids the model');
  assert.equal(
    normalizeRates({ input: 2, cacheWrite: 2, cacheRead: 0.04, output: 'nope' }),
    null,
    'a non-number must be rejected, not treated as 0',
  );
});

test('parseProvider accepts aliases and rejects what it cannot recognise', () => {
  const p = parseProvider({
    id: 'demo',
    currency: 'USD',
    models: { 'demo-a': { aliases: ['demo-a-legacy'], input: 1, cacheWrite: 1, cacheRead: 0.1, output: 2 } },
  });
  assert.equal(p.id, 'demo');
  assert.equal(p.currency, 'USD');
  assert.deepEqual(p.models.map((m) => m.key), ['demo-a', 'demo-a-legacy']);

  assert.equal(parseProvider({ models: {} }), null, 'a missing id is rejected');
  assert.equal(parseProvider({ id: 'x' }), null, 'a missing model table is rejected');
  assert.equal(parseProvider({ id: 'x', models: { y: { input: 1 } } }), null, 'a model with an incomplete bucket set is rejected');
});

test('matchRates matches concrete model names only and returns null otherwise', () => {
  const p = parseProvider({
    id: 'demo',
    models: {
      'demo-a': { input: 1, cacheWrite: 1, cacheRead: 1, output: 1 },
      'demo-b': { input: 2, cacheWrite: 2, cacheRead: 2, output: 2 },
    },
  });
  assert.equal(matchRates(p, 'demo-a').peak.input, 1);
  assert.equal(matchRates(p, 'demo-b').peak.input, 2);
  assert.equal(matchRates(p, 'demo-long-thing'), null, 'no wildcards: a shared prefix is not a match');
  assert.equal(matchRates(p, 'nothing-here'), null);
});

test('a missing offPeak is derived from offPeakMultiplier; an explicit offPeak wins', () => {
  const scaled = parseProvider({
    id: 'demo',
    offPeakMultiplier: 0.5,
    models: { 'demo-a': { input: 2, cacheWrite: 2, cacheRead: 0.04, output: 8 } },
  });
  const hit = matchRates(scaled, 'demo-a');
  assert.deepEqual(hit.offPeak, { input: 1, cacheWrite: 1, cacheRead: 0.02, output: 4 });

  const explicit = parseProvider({
    id: 'demo',
    offPeakMultiplier: 0.5,
    models: {
      'demo-a': {
        input: 2, cacheWrite: 2, cacheRead: 0.04, output: 8,
        offPeak: { input: 0.9, cacheWrite: 0.9, cacheRead: 0.01, output: 3 },
      },
    },
  });
  assert.equal(matchRates(explicit, 'demo-a').offPeak.output, 3, 'an explicit offPeak overrides the derived one');
});

test('the bundled deepseek.json matches every official model name and alias', () => {
  const providers = loadProviders([BUNDLED], { calendars: CALS });
  const deepseek = providers.find((p) => p.id === 'deepseek');
  assert.ok(deepseek, 'the bundled deepseek.json must load');
  assert.equal(deepseek.currency, 'CNY');

  for (const name of ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']) {
    const hit = matchRates(deepseek, normalizeModelId(`${name}[1M]`));
    assert.ok(hit, `${name} must match`);
    assert.deepEqual(hit.peak, { input: 2, cacheWrite: 2, cacheRead: 0.04, output: 8 }, `${name} uses the flash price`);
    assert.deepEqual(hit.offPeak, { input: 1, cacheWrite: 1, cacheRead: 0.02, output: 4 });
  }

  const pro = matchRates(deepseek, 'deepseek-v4-pro');
  assert.deepEqual(pro.peak, { input: 9, cacheWrite: 9, cacheRead: 0.3, output: 27 });
  assert.deepEqual(pro.offPeak, { input: 4.5, cacheWrite: 4.5, cacheRead: 0.15, output: 13.5 });

  assert.equal(matchRates(deepseek, 'deepseek-v5-ultra'), null, 'an unknown model never borrows the flash price');
});

test('the bundled deepseek.json schedule decides peak and off-peak directly', () => {
  const providers = loadProviders([BUNDLED], { calendars: CALS });
  const schedule = providers.find((p) => p.id === 'deepseek').schedule;
  assert.ok(schedule, 'the schedule should be built');
  assert.equal(tierAt('2026-09-29T02:00:00Z', schedule), 'peak');
  assert.equal(tierAt('2026-01-02T02:00:00Z', schedule), 'offPeak');
});

test('loadProviders lets a later entry override a shared id and skips broken files', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ctx-prov-'));
  const user = path.join(base, 'user');
  fs.mkdirSync(user);
  const model = { input: 2, cacheWrite: 2, cacheRead: 0.04, output: 16 };
  fs.writeFileSync(path.join(user, 'deepseek.json'), JSON.stringify({ id: 'deepseek', currency: 'CNY', models: { 'deepseek-flash': model } }));
  fs.writeFileSync(path.join(user, 'broken.json'), 'not json at all');

  try {
    const providers = loadProviders([BUNDLED, { dir: user, kind: 'user' }], { calendars: CALS });
    const all = providers.filter((p) => p.id === 'deepseek');
    assert.equal(all.length, 1, 'a shared id leaves only one entry');
    assert.equal(all[0].source.kind, 'user', 'the user directory version wins');
    assert.equal(matchRates(all[0], 'deepseek-v4-pro'), null, 'after being overridden there is no pro any more');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
