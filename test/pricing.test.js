import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadProviders, resolvePricing } from '../src/pricing/index.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const CFG = {
  providerDirs: [{ dir: path.join(root, 'conf', 'providers'), kind: 'bundled' }],
  calendarDirs: [{ dir: path.join(root, 'conf', 'calendars'), kind: 'bundled' }],
};

test('resolvePricing end-to-end resolves both rate tiers and the schedule', () => {
  const pricing = resolvePricing(CFG, 'deepseek-flash[1M]');
  assert.equal(pricing.providerId, 'deepseek');
  assert.equal(pricing.currency, 'CNY');
  assert.deepEqual(pricing.peak, { input: 2, cacheWrite: 2, cacheRead: 0.04, output: 8 });
  assert.deepEqual(pricing.offPeak, { input: 1, cacheWrite: 1, cacheRead: 0.02, output: 4 });
  assert.ok(pricing.schedule, 'has time-tier rules');
  assert.equal(pricing.source.kind, 'bundled');
});

test('a provider with no peak/off-peak tiers gets schedule: null and an offPeak equal to peak', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ctx-flat-'));
  const model = { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 };
  fs.writeFileSync(path.join(dir, 'flat.json'), JSON.stringify({
    id: 'flat',
    currency: 'USD',
    models: { 'flat-model': model },
  }));

  try {
    const pricing = resolvePricing(
      { providerDirs: [...CFG.providerDirs, { dir, kind: 'user' }], calendarDirs: CFG.calendarDirs },
      'flat-model',
    );
    assert.equal(pricing.schedule, null);
    assert.deepEqual(pricing.offPeak, pricing.peak, 'both tiers are equal when there is no schedule');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an unrecognised model returns null and does not borrow another provider price', () => {
  assert.equal(resolvePricing(CFG, 'gpt-9-turbo'), null);
  assert.equal(resolvePricing(CFG, ''), null);
  assert.equal(resolvePricing(CFG, undefined), null);
});

test('loadProviders hands the calendar directory to the providers too', () => {
  const providers = loadProviders(CFG);
  const deepseek = providers.find((p) => p.id === 'deepseek');
  assert.ok(deepseek.schedule.calendar, 'the schedule should carry the built calendar');
  assert.ok(deepseek.schedule.calendar.holidays.has('2026-01-01'));
});
