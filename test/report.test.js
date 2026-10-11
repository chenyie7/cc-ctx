import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderReport } from '../src/report.js';
import { loadConfig } from '../src/config.js';
import { stripAnsi } from '../src/render.js';
import { buildSchedule } from '../src/pricing/schedule.js';
import { loadCalendars } from '../src/pricing/calendar.js';

const MISSING_ENV = path.join(os.tmpdir(), 'cc-ctx-report-missing.env');

function cfg(env = {}) {
  return loadConfig({ env: { NO_COLOR: '1', ...env }, userEnvFile: MISSING_ENV });
}

// The shipped table is CNY, so the default path converts nothing.
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

const TOTALS = {
  input: 1000,
  cacheWrite: 0,
  cacheRead: 9000,
  output: 500,
  thinking: 0,
  calls: 12,
  model: 'deepseek-v4-flash[1M]',
};

const PAYLOAD = {
  session_id: 'abc',
  session_name: 'demo',
  model: { id: 'deepseek-v4-flash[1M]', display_name: 'deepseek-v4-flash[1M]' },
  effort: { level: 'high' },
  thinking: { enabled: true },
  workspace: { current_dir: '/tmp/demo' },
  cost: { total_duration_ms: 2520000, total_lines_added: 156, total_lines_removed: 23 },
  context_window: {
    total_input_tokens: 620000,
    context_window_size: 1000000,
    used_percentage: 62,
    current_usage: { input_tokens: 1368, cache_read_input_tokens: 49152 },
  },
};

test('a full report renders every section', () => {
  const text = stripAnsi(
    renderReport({
      payload: PAYLOAD,
      totals: TOTALS,
      pricing: PRICES,
      balanceInfo: { balance: { currency: 'CNY', total: 57.42, granted: 0, toppedUp: 57.42 }, stale: false },
      cfg: cfg(),
      transcriptPath: '/tmp/demo.jsonl',
    }),
  );

  assert.match(text, /cc-ctx · session report/);
  assert.match(text, /deepseek-v4-flash\[1M\]/);
  assert.match(text, /effort\s+high/);
  assert.match(text, /input\s+1,000/);
  assert.match(text, /cache read\s+9,000/);
  assert.match(text, /output\s+500/);
  assert.match(text, /api calls\s+12/);
  // hit rate 9000 / (1000 + 0 + 9000) = 90.00%
  assert.match(text, /hit rate\s+90\.00%/);
  // (1000*2 + 9000*0.04 + 500*8) / 1e6 = 0.00636 CNY
  assert.match(text, /session cost\s+¥0\.006360/);
  // Prices are already in the display currency, so nothing is converted and no
  // source amount is shown alongside.
  assert.doesNotMatch(text, /×/);
  assert.match(text, /balance\s+¥57\.42/);
  assert.match(text, /transcript\s+\/tmp\/demo\.jsonl/);
});

test('the context row reports the window, not the last call', () => {
  const text = stripAnsi(
    renderReport({
      payload: PAYLOAD,
      totals: TOTALS,
      pricing: PRICES,
      balanceInfo: { balance: null, stale: false },
      cfg: cfg(),
      transcriptPath: null,
    }),
  );
  // 620,000 comes from total_input_tokens. Using current_usage would print
  // 50,520 and disagree with the 62% beside it.
  assert.match(text, /620,000 \/ 1,000,000/);
  assert.doesNotMatch(text, /50,520/);
});

test('a report with no payload and no price table still renders', () => {
  // Regression: this path crashed on a missing argument, and the model could
  // not be determined at all when the status line had never run.
  const report = () =>
    renderReport({
      payload: null,
      totals: TOTALS,
      pricing: null,
      balanceInfo: { balance: null, stale: false },
      cfg: cfg(),
      transcriptPath: '/tmp/demo.jsonl',
    });

  assert.doesNotThrow(report);
  const text = stripAnsi(report());
  assert.match(text, /session cost\s+—/);
  assert.match(text, /CC_CTX_PRICE_/);
  assert.match(text, /balance\s+—/);
  assert.match(text, /input\s+1,000/, 'usage still renders without a payload');
  assert.match(text, /model\s+deepseek-v4-flash\[1M\]/, 'model comes from the transcript');
  assert.match(text, /session\s+demo/, 'session id comes from the transcript path');
  assert.doesNotMatch(text, /undefined/);
});

test('cwd is used for the directory when no payload is available', () => {
  const text = stripAnsi(
    renderReport({
      payload: null,
      totals: TOTALS,
      pricing: PRICES,
      balanceInfo: { balance: null, stale: false },
      cfg: cfg(),
      transcriptPath: '/tmp/demo.jsonl',
      cwd: '/tmp/from-cwd',
    }),
  );
  assert.match(text, /dir\s+\/tmp\/from-cwd/);
});

test('a USD price table is converted into the display currency', () => {
  const usd = {
    peak: { input: 0.3, cacheWrite: 0.3, cacheRead: 0.006, output: 1.2 },
    offPeak: { input: 0.3, cacheWrite: 0.3, cacheRead: 0.006, output: 1.2 },
    currency: 'USD',
  };
  const text = stripAnsi(
    renderReport({
      payload: null,
      totals: TOTALS,
      pricing: usd,
      balanceInfo: { balance: null, stale: false },
      cfg: cfg({ CC_CTX_RATE: '7.15' }),
      transcriptPath: null,
    }),
  );
  // (1000*0.3 + 9000*0.006 + 500*1.2) / 1e6 = 0.000954 USD -> 0.0068211 CNY
  assert.match(text, /session cost\s+¥0\.006821/);
  // Both figures are shown so the conversion is auditable.
  assert.match(text, /USD 0\.000954 × 7\.15/);
});

test('a stale balance is marked', () => {
  const text = stripAnsi(
    renderReport({
      payload: PAYLOAD,
      totals: TOTALS,
      pricing: PRICES,
      balanceInfo: { balance: { currency: 'CNY', total: 12.5, granted: 0, toppedUp: 12.5 }, stale: true },
      cfg: cfg(),
      transcriptPath: null,
    }),
  );
  assert.match(text, /¥12\.50/);
  assert.match(text, /stale/);
});

test('colour is emitted unless NO_COLOR is set', () => {
  const args = {
    payload: PAYLOAD,
    totals: TOTALS,
    prices: PRICES,
    balanceInfo: { balance: null, stale: false },
    transcriptPath: null,
  };
  assert.match(renderReport({ ...args, cfg: cfg({ NO_COLOR: '' }) }), /\x1b\[/);
  assert.doesNotMatch(renderReport({ ...args, cfg: cfg() }), /\x1b\[/);
});

test('the report shows provider, currency, current window and the next switch', () => {
  const out = stripAnsi(renderReport({
    payload: null, totals: TOTALS, pricing: PRICES, balanceInfo: null,
    cfg: cfg(), transcriptPath: null, cwd: '/tmp',
  }));
  assert.match(out, /deepseek/);
  assert.match(out, /CNY/);
  assert.match(out, /(peak|off-peak)/);
});

test('with no price table the report says so and shows no amount', () => {
  const out = stripAnsi(renderReport({
    payload: null, totals: TOTALS, pricing: null, balanceInfo: null,
    cfg: cfg(), transcriptPath: null, cwd: '/tmp',
  }));
  assert.match(out, /no price table/);
  assert.doesNotMatch(out, /session cost\s+¥/);
});
