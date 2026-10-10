import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  parseEnvFile,
  modelPriceKey,
  resolvePrices,
  loadConfig,
  DEFAULT_COLORS,
  DEFAULT_FIELDS,
} from '../src/config.js';

test('parseEnvFile reads quoted, bare, commented and blank values', () => {
  const parsed = parseEnvFile(
    [
      '# a comment',
      '',
      'PLAIN=value',
      'QUOTED="two words"',
      "SINGLE='also two'",
      'EMPTY=',
      '  INDENTED = spaced  ',
      'NOT_A_PAIR',
    ].join('\n'),
  );
  assert.equal(parsed.PLAIN, 'value');
  assert.equal(parsed.QUOTED, 'two words');
  assert.equal(parsed.SINGLE, 'also two');
  assert.equal(parsed.EMPTY, '');
  assert.equal(parsed.INDENTED, 'spaced');
  assert.equal(parsed.NOT_A_PAIR, undefined);
});

test('modelPriceKey normalises ids and drops context-window qualifiers', () => {
  assert.equal(modelPriceKey('deepseek-v4-flash[1M]'), 'DEEPSEEK_V4_FLASH');
  assert.equal(modelPriceKey('deepseek-flash'), 'DEEPSEEK_FLASH');
  assert.equal(modelPriceKey('claude-sonnet-4-6'), 'CLAUDE_SONNET_4_6');
  assert.equal(modelPriceKey(''), '');
});

test('resolvePrices needs a complete set and never borrows another model', () => {
  const env = {
    CC_CTX_PRICE_DEEPSEEK_V4_FLASH_INPUT: '0.30',
    CC_CTX_PRICE_DEEPSEEK_V4_FLASH_CACHE_WRITE: '0.30',
    CC_CTX_PRICE_DEEPSEEK_V4_FLASH_CACHE_READ: '0.006',
    CC_CTX_PRICE_DEEPSEEK_V4_FLASH_OUTPUT: '1.20',
  };
  // The shipped table is quoted in CNY, matching the provider's Chinese list.
  const prices = resolvePrices(env, 'deepseek-v4-flash[1M]');
  assert.deepEqual(prices, {
    currency: 'CNY',
    input: 0.3,
    cacheWrite: 0.3,
    cacheRead: 0.006,
    output: 1.2,
  });

  // An unknown model must resolve to null, not to some other model's rates —
  // that substitution is exactly the bug this project exists to fix.
  assert.equal(resolvePrices(env, 'some-other-model'), null);

  // A partially specified model is also refused rather than half-priced.
  const partial = { ...env };
  delete partial.CC_CTX_PRICE_DEEPSEEK_V4_FLASH_OUTPUT;
  assert.equal(resolvePrices(partial, 'deepseek-v4-flash[1M]'), null);

  const broken = { ...env, CC_CTX_PRICE_DEEPSEEK_V4_FLASH_OUTPUT: 'not-a-number' };
  assert.equal(resolvePrices(broken, 'deepseek-v4-flash[1M]'), null);
});

test('the price currency can be set globally or per model', () => {
  const base = {
    CC_CTX_PRICE_DEEPSEEK_V4_FLASH_INPUT: '2',
    CC_CTX_PRICE_DEEPSEEK_V4_FLASH_CACHE_WRITE: '2',
    CC_CTX_PRICE_DEEPSEEK_V4_FLASH_CACHE_READ: '0.04',
    CC_CTX_PRICE_DEEPSEEK_V4_FLASH_OUTPUT: '8',
  };
  assert.equal(resolvePrices(base, 'deepseek-v4-flash').currency, 'CNY', 'CNY by default');
  assert.equal(
    resolvePrices({ ...base, CC_CTX_PRICE_CURRENCY: 'USD' }, 'deepseek-v4-flash').currency,
    'USD',
  );
  assert.equal(
    resolvePrices(
      { ...base, CC_CTX_PRICE_CURRENCY: 'USD', CC_CTX_PRICE_DEEPSEEK_V4_FLASH_CURRENCY: 'CNY' },
      'deepseek-v4-flash',
    ).currency,
    'CNY',
    'a per-model currency wins',
  );
});

function tempEnvFile(contents) {
  const file = path.join(os.tmpdir(), `cc-ctx-env-${process.pid}-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(file, contents);
  return file;
}

test('loadConfig ships usable defaults when no user file exists', () => {
  const cfg = loadConfig({
    env: {},
    userEnvFile: path.join(os.tmpdir(), 'cc-ctx-definitely-missing.env'),
  });
  assert.deepEqual(cfg.fields, DEFAULT_FIELDS);
  assert.equal(cfg.gap, '  ');
  assert.equal(cfg.divider, ' │ ');
  assert.equal(cfg.currency, 'CNY');
  for (const [name, value] of Object.entries(DEFAULT_COLORS)) {
    assert.equal(cfg.colors[name], value);
  }
});

test('the user file overrides shipped defaults', () => {
  const file = tempEnvFile('CC_CTX_CURRENCY="USD"\nCC_CTX_SYMBOL="$"\nCC_CTX_GAP=" "\n');
  try {
    const cfg = loadConfig({ env: {}, userEnvFile: file });
    assert.equal(cfg.currency, 'USD');
    assert.equal(cfg.symbol, '$');
    assert.equal(cfg.gap, ' ');
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('real environment variables win over both files', () => {
  const file = tempEnvFile('CC_CTX_CURRENCY="USD"\n');
  try {
    const cfg = loadConfig({ env: { CC_CTX_CURRENCY: 'JPY' }, userEnvFile: file });
    assert.equal(cfg.currency, 'JPY');
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('CC_CTX_FIELDS selects and orders what renders', () => {
  const file = tempEnvFile('CC_CTX_FIELDS="model cost"\n');
  try {
    const cfg = loadConfig({ env: {}, userEnvFile: file });
    assert.deepEqual(cfg.fields, ['model', 'cost']);
  } finally {
    fs.rmSync(file, { force: true });
  }

  const blank = tempEnvFile('CC_CTX_FIELDS=""\n');
  try {
    const cfg = loadConfig({ env: {}, userEnvFile: blank });
    assert.deepEqual(cfg.fields, DEFAULT_FIELDS, 'an empty list falls back to defaults');
  } finally {
    fs.rmSync(blank, { force: true });
  }
});

test('truecolour detection follows COLORTERM unless forced', () => {
  const missing = path.join(os.tmpdir(), 'cc-ctx-missing.env');
  assert.equal(loadConfig({ env: { COLORTERM: 'truecolor' }, userEnvFile: missing }).truecolor, true);
  assert.equal(loadConfig({ env: { COLORTERM: '24bit' }, userEnvFile: missing }).truecolor, true);
  assert.equal(loadConfig({ env: { COLORTERM: '' }, userEnvFile: missing }).truecolor, false);

  const forced = tempEnvFile('CC_CTX_TRUECOLOR="off"\n');
  try {
    assert.equal(
      loadConfig({ env: { COLORTERM: 'truecolor' }, userEnvFile: forced }).truecolor,
      false,
    );
  } finally {
    fs.rmSync(forced, { force: true });
  }
});

test('NO_COLOR disables colour output', () => {
  const missing = path.join(os.tmpdir(), 'cc-ctx-missing.env');
  assert.equal(loadConfig({ env: { NO_COLOR: '1' }, userEnvFile: missing }).noColor, true);
  assert.equal(loadConfig({ env: {}, userEnvFile: missing }).noColor, false);
});
