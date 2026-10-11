import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  sumUsageFile,
  computeTotals,
  computeTotalsCached,
  EMPTY_TOTALS,
  hitRate,
  costOf,
  totalInputTokens,
  subagentDir,
  listSubagentFiles,
  sessionFiles,
  signature,
} from '../src/usage.js';
import { buildSchedule } from '../src/pricing/schedule.js';
import { loadCalendars } from '../src/pricing/calendar.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SESSION = path.join(HERE, 'fixtures', 'session.jsonl');

const CALS = loadCalendars([
  { dir: fileURLToPath(new URL('../conf/calendars', import.meta.url)), kind: 'bundled' },
]);
const DS = {
  tz: 'Asia/Shanghai',
  windows: '09:00-12:00,14:00-18:00',
  days: '1-5',
  calendar: 'cn',
  workdaysArePeak: true,
};
const schedule = () => buildSchedule(DS, { calendars: CALS });

// DeepSeek's peak rates, in CNY per 1,000,000 tokens.
const RATES = { input: 0.3, cacheWrite: 0.3, cacheRead: 0.006, output: 1.2 };

// The fixture is built so a hand count is auditable:
//   main    input 100+200=300, cache write 10, cache read 1000+2000=3000,
//           output 50+60=110, thinking 5, calls 2
//   subagent input 7, cache read 70, output 9, calls 1
//   plus one broken line (skipped) and one sidechain record (must be skipped)
const EXPECTED = {
  input: 307,
  cacheWrite: 10,
  cacheRead: 3070,
  output: 119,
  thinking: 5,
  calls: 3,
  model: 'fixture-model',
  // No schedule is passed, so every call is priced as peak.
  offPeak: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 },
};

test('sumUsageFile accumulates the buckets in a transcript', () => {
  const totals = sumUsageFile(SESSION);
  assert.equal(totals.input, 300);
  assert.equal(totals.cacheWrite, 10);
  assert.equal(totals.cacheRead, 3000);
  assert.equal(totals.output, 110);
  assert.equal(totals.thinking, 5);
  assert.equal(totals.calls, 2);
});

test('a message written once per content block is billed once', () => {
  // Regression: Claude Code emits one transcript line per content block, and
  // every line of the same assistant message repeats its usage verbatim. On a
  // real session that inflated every token bucket by ~2.9x.
  // The fixture holds msg_a three times and msg_b once.
  const totals = sumUsageFile(SESSION);
  assert.equal(totals.calls, 2, 'two distinct messages, not four lines');
  assert.equal(totals.input, 100 + 200);
  assert.equal(totals.output, 50 + 60);
  assert.equal(totals.cacheRead, 1000 + 2000);
});

test('a shared seen-set stops a transcript being counted twice', () => {
  const seen = new Set();
  const first = sumUsageFile(SESSION, { seen });
  const second = sumUsageFile(SESSION, { seen });
  assert.equal(first.calls, 2);
  assert.equal(second.calls, 0, 'the second read must contribute nothing');
  assert.equal(second.input, 0);
});

test('the same message id in two files is counted once session-wide', () => {
  // Subagent transcripts repeat their own messages the same way, and the shared
  // seen-set also guards against a response mirrored into two files.
  const entries = sessionFiles(SESSION);
  const seen = new Set();
  const totals = entries.map((e) =>
    sumUsageFile(e.file, { skipSidechain: e.skipSidechain, seen }),
  );
  const calls = totals.reduce((n, t) => n + t.calls, 0);
  assert.equal(calls, 3, 'msg_a, msg_b, msg_sub');
});

test('sumUsageFile skips sidechain records so subagents are not double counted', () => {
  const withSidechain = sumUsageFile(SESSION, { skipSidechain: false });
  // The fixture's sidechain record adds 9999 input and 9999 output.
  assert.equal(withSidechain.input, 300 + 9999);
  assert.equal(withSidechain.output, 110 + 9999);
  assert.equal(withSidechain.calls, 3);
});

test('sumUsageFile tolerates a broken line and a missing file', () => {
  const totals = sumUsageFile(SESSION);
  assert.equal(totals.calls, 2, 'the malformed line must not be counted');
  assert.deepEqual(sumUsageFile(path.join(HERE, 'fixtures', 'does-not-exist.jsonl')), {
    ...EMPTY_TOTALS,
  });
});

test('the model is taken from the main transcript, not a subagent', () => {
  // The fixture's subagent runs on a different model. Letting it win would pick
  // the wrong price table.
  const { totals } = computeTotals(SESSION);
  assert.equal(totals.model, 'fixture-model');
});

test('subagent transcripts are discovered next to the session file', () => {
  assert.equal(subagentDir(SESSION), path.join(HERE, 'fixtures', 'session', 'subagents'));
  const found = listSubagentFiles(SESSION);
  assert.equal(found.length, 1);
  assert.match(found[0], /agent-a\.jsonl$/);
});

test('sidechain records inside a subagent transcript are still counted', () => {
  // Regression: every record in a subagent's own transcript carries
  // isSidechain:true, because that file exists to hold them. Skipping them
  // there discarded all subagent usage. The flag only guards the main
  // transcript, where such a record would duplicate the subagent file.
  const entries = sessionFiles(SESSION);
  const main = entries.find((e) => e.file === SESSION);
  const sub = entries.find((e) => e.file !== SESSION);
  assert.equal(main.skipSidechain, true);
  assert.equal(sub.skipSidechain, false);

  const subTotals = sumUsageFile(sub.file, { skipSidechain: sub.skipSidechain });
  assert.equal(subTotals.calls, 1);
  assert.equal(subTotals.input, 7);
  assert.equal(subTotals.cacheRead, 70);
});

test('computeTotals merges the main transcript with every subagent', () => {
  const { totals, files } = computeTotals(SESSION);
  assert.equal(files.length, 2, 'main transcript plus one subagent');
  assert.deepEqual(totals, EXPECTED);
});

test('hitRate uses every input token in the denominator', () => {
  const rate = hitRate(EXPECTED);
  // 3070 / (307 + 10 + 3070)
  assert.ok(Math.abs(rate - 3070 / 3387) < 1e-12);
  assert.equal(hitRate({ input: 0, cacheWrite: 0, cacheRead: 0 }), null);
});

test('totalInputTokens counts uncached, cache writes and cache reads', () => {
  assert.equal(totalInputTokens(EXPECTED), 307 + 10 + 3070);
});

test('off-peak calls land in their own bucket, leaving the totals intact', () => {
  // The fixture's 11:00Z record is outside every peak window; the 02:00Z and
  // 02:30Z records are inside one.
  const { totals } = computeTotals(SESSION, { schedule: schedule() });
  assert.deepEqual(totals.offPeak, {
    input: 200,
    cacheWrite: 0,
    cacheRead: 2000,
    output: 60,
  });
  assert.equal(totals.input, 307, 'the displayed totals must not change');
  assert.equal(totals.output, 119);
});

test('the off-peak discount applies only to off-peak traffic', () => {
  const prices = { peak: RATES, offPeak: RATES };
  const discounted = {
    peak: RATES,
    offPeak: Object.fromEntries(Object.entries(RATES).map(([k, v]) => [k, v * 0.5])),
  };
  const { totals } = computeTotals(SESSION, { schedule: schedule() });

  const full = costOf(totals, prices);

  // The off-peak portion is 200*0.3 + 2000*0.006 + 60*1.2 = 144 units; halving
  // it must remove exactly half of that from the total.
  const offPeakBill = 200 * 0.3 + 2000 * 0.006 + 60 * 1.2;
  assert.ok(Math.abs(full - costOf(totals, discounted) - offPeakBill / 2 / 1e6) < 1e-15);

  // And with no schedule everything is peak, so the discount is a no-op.
  const allPeak = computeTotals(SESSION).totals;
  assert.ok(Math.abs(costOf(allPeak, discounted) - costOf(allPeak, prices)) < 1e-15);
});

test('costOf prices each bucket separately and returns null without a price table', () => {
  const prices = { peak: RATES, offPeak: RATES };
  const expected =
    (307 * 0.3 + 10 * 0.3 + 3070 * 0.006 + 119 * 1.2) / 1e6;
  assert.ok(Math.abs(costOf(EXPECTED, prices) - expected) < 1e-12);
  assert.equal(costOf(EXPECTED, null), null, 'an unknown model must not borrow another price');
});

test('cache reads are priced far below uncached input', () => {
  const prices = { peak: RATES, offPeak: RATES };
  const cached = costOf({ input: 0, cacheWrite: 0, cacheRead: 1e6, output: 0, thinking: 0, calls: 1 }, prices);
  const fresh = costOf({ input: 1e6, cacheWrite: 0, cacheRead: 0, output: 0, thinking: 0, calls: 1 }, prices);
  assert.ok(Math.abs(cached - 0.006) < 1e-12);
  assert.ok(Math.abs(fresh - 0.3) < 1e-12);
});

test('the mtime+size signature changes when a transcript is appended to', () => {
  const before = signature([SESSION]);
  const copy = path.join(os.tmpdir(), `cc-ctx-sig-${process.pid}.jsonl`);
  fs.copyFileSync(SESSION, copy);
  try {
    const same = signature([copy]);
    assert.notEqual(same, before, 'a different file must not share a signature');
    fs.appendFileSync(copy, '{"message":{"usage":{"input_tokens":1}}}\n');
    assert.notEqual(signature([copy]), same, 'appending must invalidate the signature');
  } finally {
    fs.rmSync(copy, { force: true });
  }
});

test('computeTotalsCached reuses a valid entry and recomputes when stale', () => {
  const store = new Map();
  const cache = {
    get: (k) => store.get(k),
    set: (k, v) => store.set(k, v),
  };

  const first = computeTotalsCached(SESSION, cache, 'usage');
  assert.equal(first.cached, false);
  assert.deepEqual(first.totals, EXPECTED);

  const second = computeTotalsCached(SESSION, cache, 'usage');
  assert.equal(second.cached, true, 'an unchanged transcript must hit the cache');
  assert.deepEqual(second.totals, EXPECTED);

  // Invalidate by pretending the file changed underneath us.
  for (const key of store.keys()) store.set(key, { signature: 'stale', totals: { input: 1 } });
  const third = computeTotalsCached(SESSION, cache, 'usage');
  assert.equal(third.cached, false);
  assert.deepEqual(third.totals, EXPECTED);
});

test('changing the pricing schedule invalidates the cache', () => {
  // A cached total carries peak/off-peak buckets, so a config change must not
  // be served a stale split.
  const store = new Map();
  const cache = { get: (k) => store.get(k), set: (k, v) => store.set(k, v) };

  computeTotalsCached(SESSION, cache, 'usage', { schedule: schedule() });
  const same = computeTotalsCached(SESSION, cache, 'usage', { schedule: schedule() });
  assert.equal(same.cached, true);

  const changed = computeTotalsCached(SESSION, cache, 'usage', {
    schedule: buildSchedule({ ...DS, windows: '10:00-11:00' }, { calendars: CALS }),
  });
  assert.equal(changed.cached, false, 'a different multiplier is a different cache entry');
});
