import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseEnvFile, loadConfig, DEFAULT_COLORS, DEFAULT_FIELDS } from '../src/config.js';

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

test('loadConfig provides the three price-data directory tiers and the alert threshold', () => {
  const missing = path.join(os.tmpdir(), 'cc-ctx-missing.env');
  const cfg = loadConfig({ env: {}, userEnvFile: missing });
  assert.equal(cfg.providerDirs.length, 3, 'bundled / remote / user');
  assert.deepEqual(cfg.providerDirs.map((d) => d.kind), ['bundled', 'remote', 'user']);
  assert.deepEqual(cfg.calendarDirs.map((d) => d.kind), ['bundled', 'remote', 'user']);
  assert.equal(cfg.tierAlertMinutes, 20, 'the default threshold is 20 minutes');
  assert.equal(cfg.remote, true, 'remote refresh is on by default');
  assert.equal(cfg.remoteTtlMs, 86400000);
  assert.ok(cfg.installDir);
});

test('the alert threshold and remote toggle can be overridden', () => {
  const file = tempEnvFile('CC_CTX_TIER_ALERT_MINUTES="5"\nCC_CTX_REMOTE="off"\n');
  try {
    const cfg = loadConfig({ env: {}, userEnvFile: file });
    assert.equal(cfg.tierAlertMinutes, 5);
    assert.equal(cfg.remote, false);
  } finally {
    fs.rmSync(file, { force: true });
  }
});
