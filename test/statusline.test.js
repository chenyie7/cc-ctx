import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderStatusline } from '../src/statusline.js';
import { visibleWidth, stripAnsi } from '../src/render.js';
import { loadConfig } from '../src/config.js';
import { buildSchedule } from '../src/pricing/schedule.js';
import { loadCalendars } from '../src/pricing/calendar.js';

const MISSING_ENV = path.join(os.tmpdir(), 'cc-ctx-statusline-missing.env');

const PAYLOAD = {
  session_id: 'abc',
  session_name: 'demo',
  model: { id: 'deepseek-v4-flash[1M]', display_name: 'deepseek-v4-flash[1M]' },
  effort: { level: 'high' },
  thinking: { enabled: true },
  workspace: { current_dir: '/Users/chenyi/ai-project/cc-ctx' },
  cost: { total_duration_ms: 2520000, total_lines_added: 156, total_lines_removed: 23 },
  context_window: {
    total_input_tokens: 620000,
    context_window_size: 1000000,
    used_percentage: 62,
    current_usage: { input_tokens: 1368, cache_read_input_tokens: 49152 },
  },
  prompt_cache: { warm: true, caching_observed: true },
};

const TOTALS = {
  input: 1189342,
  cacheWrite: 0,
  cacheRead: 133410432,
  output: 705019,
  thinking: 0,
  calls: 799,
  model: 'deepseek-v4-flash[1M]',
  offPeak: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 },
};

const PEAK = { input: 2, cacheWrite: 2, cacheRead: 0.04, output: 8 };
const PRICES = {
  providerId: 'deepseek',
  currency: 'CNY',
  peak: PEAK,
  offPeak: { input: 1, cacheWrite: 1, cacheRead: 0.02, output: 4 },
  schedule: buildSchedule(
    { tz: 'Asia/Shanghai', windows: '09:00-12:00,14:00-18:00', days: '1-5', calendar: 'cn', workdaysArePeak: true },
    { calendars: loadCalendars([{ dir: fileURLToPath(new URL('../conf/calendars', import.meta.url)), kind: 'bundled' }]) },
  ),
};
const BALANCE = { balance: { currency: 'CNY', total: 54.87, granted: 0, toppedUp: 54.87 }, stale: false };

function render(columns, overrides = {}) {
  const env = { NO_COLOR: '1', COLUMNS: String(columns) };
  const cfg = loadConfig({ env: { ...env, ...overrides }, userEnvFile: MISSING_ENV });
  const out = renderStatusline(PAYLOAD, cfg, { totals: TOTALS, pricing: PRICES, balanceInfo: BALANCE, env });
  return { out, lines: out.split('\n'), widths: out.split('\n').map(visibleWidth), cfg };
}

test('no rendered line ever exceeds the terminal width', () => {
  // Regression: padding is added after wrapping, so it must come out of the
  // wrap budget. Miss that and every line renders one cell too wide — which
  // only shows up once a line is already near the limit.
  for (const columns of [200, 160, 140, 120, 110, 100, 90, 80, 72, 64, 56, 48, 40, 32, 24]) {
    const { widths } = render(columns);
    const over = widths.filter((w) => w > columns);
    assert.deepEqual(over, [], `COLUMNS=${columns}: lines ${widths.join(', ')} exceed the width`);
  }
});

test('a tight terminal degrades a composite item instead of overflowing', () => {
  // The context item is a meter plus numbers and cannot be truncated mid-way,
  // so it carries a shorter form for when it has a line to itself.
  const { lines } = render(40);
  const contextLine = lines.find((l) => stripAnsi(l).includes('context'));
  assert.ok(contextLine, 'the context field should still be present');
  assert.ok(visibleWidth(contextLine) <= 40);
  assert.ok(!stripAnsi(contextLine).includes('/ 1,000,000'), 'the totals pair is dropped first');
});

test('the same payload stays within a comfortable width too', () => {
  const { widths } = render(100);
  // The default field set now carries `tier`, which fills the 100-column wrap
  // budget (99 content + 1 padding cell). Lines must still never exceed it.
  assert.ok(Math.max(...widths) <= 99, `expected lines within the wrap budget, got ${widths.join(', ')}`);
});

test('padding is configurable and still respected', () => {
  const { lines, cfg } = render(100, { CC_CTX_PADDING: '4' });
  assert.equal(cfg.padding, 4);
  for (const line of lines) assert.ok(line.startsWith('    '), 'every line carries the padding');
});

test('greedy wrapping is still available and also fits', () => {
  for (const columns of [100, 64, 40]) {
    const { widths } = render(columns, { CC_CTX_WRAP: 'greedy' });
    assert.deepEqual(widths.filter((w) => w > columns), [], `COLUMNS=${columns}`);
  }
});

test('fields can be selected and ordered', () => {
  const { out } = render(120, { CC_CTX_FIELDS: 'model cost' });
  // A group change inserts the divider, so these two are not merely spaced.
  assert.equal(stripAnsi(out).trim(), 'deepseek-v4-flash[1M] │ cost ¥13.36');

  const narrow = render(120, { CC_CTX_FIELDS: 'brand model' });
  assert.equal(stripAnsi(narrow.out).trim(), 'cc-ctx  deepseek-v4-flash[1M]');
});

test('a missing transcript yields a placeholder rather than a wrong number', () => {
  const env = { NO_COLOR: '1', COLUMNS: '100' };
  const cfg = loadConfig({ env, userEnvFile: MISSING_ENV });
  const empty = {
    input: 0, cacheWrite: 0, cacheRead: 0, output: 0, thinking: 0, calls: 0,
    model: null, offPeak: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 },
  };
  const out = stripAnsi(
    renderStatusline(PAYLOAD, cfg, { totals: empty, pricing: PRICES, balanceInfo: BALANCE, env }),
  );
  assert.match(out, /cost ¥0\.00/);
  assert.doesNotMatch(out, /NaN|undefined/);
});

test('an unknown model shows a dash for cost, never another model price', () => {
  const env = { NO_COLOR: '1', COLUMNS: '100' };
  const cfg = loadConfig({ env, userEnvFile: MISSING_ENV });
  const out = stripAnsi(
    renderStatusline(PAYLOAD, cfg, { totals: TOTALS, pricing: null, balanceInfo: BALANCE, env }),
  );
  assert.match(out, /cost —/);
});

test('the tier field shows the current window and is absent without a schedule', () => {
  const { out, cfg } = render(200, { CC_CTX_FIELDS: 'tier' });
  assert.match(stripAnsi(out), /(peak|off-peak)/, 'a schedule must render a tier');

  const env = { NO_COLOR: '1', COLUMNS: '200' };
  const noSchedule = renderStatusline(PAYLOAD, cfg, {
    totals: TOTALS,
    pricing: { ...PRICES, schedule: null },
    balanceInfo: BALANCE,
    env,
  });
  assert.doesNotMatch(stripAnsi(noSchedule), /peak/, 'a provider without a schedule must not show a tier');
});
