import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parsePeakWindows,
  parsePeakDays,
  isOffPeak,
  buildSchedule,
} from '../src/peak.js';

const SCHEDULE = buildSchedule({});

test('parsePeakWindows reads the documented windows', () => {
  assert.deepEqual(parsePeakWindows('01:00-04:00,06:00-10:00'), [
    { start: 60, end: 240 },
    { start: 360, end: 600 },
  ]);
  assert.deepEqual(parsePeakWindows(''), []);
  assert.deepEqual(parsePeakWindows('garbage'), []);
  assert.deepEqual(parsePeakWindows('03:00-03:00'), [], 'an empty window is dropped');
});

test('parsePeakDays understands ranges and lists', () => {
  assert.deepEqual([...parsePeakDays('1-5')].sort(), [1, 2, 3, 4, 5]);
  assert.deepEqual([...parsePeakDays('1,7')].sort(), [1, 7]);
  assert.deepEqual([...parsePeakDays('1-3,7')].sort(), [1, 2, 3, 7]);
  assert.deepEqual([...parsePeakDays('')], []);
  assert.deepEqual([...parsePeakDays('9')], [], 'out-of-range days are ignored');
});

test('buildSchedule defaults to the published DeepSeek windows', () => {
  assert.deepEqual(SCHEDULE.windows, [
    { start: 60, end: 240 },
    { start: 360, end: 600 },
  ]);
  assert.equal(SCHEDULE.multiplier, 0.5);
  assert.ok(SCHEDULE.days.has(3), 'Wednesday is a peak day');
  assert.ok(!SCHEDULE.days.has(7), 'Sunday is not');
});

test('peak and off-peak are decided per call, from its own timestamp', () => {
  // Wednesday 2026-09-30. Peak windows are 01:00-04:00 and 06:00-10:00 UTC.
  assert.equal(isOffPeak('2026-09-30T02:00:00.000Z', SCHEDULE), false, 'inside 01-04');
  assert.equal(isOffPeak('2026-09-30T07:30:00.000Z', SCHEDULE), false, 'inside 06-10');
  assert.equal(isOffPeak('2026-09-30T11:00:00.000Z', SCHEDULE), true, 'between windows');
  assert.equal(isOffPeak('2026-09-30T00:30:00.000Z', SCHEDULE), true, 'before the first window');
  assert.equal(isOffPeak('2026-09-30T23:59:00.000Z', SCHEDULE), true);
});

test('window boundaries are inclusive at the start and exclusive at the end', () => {
  assert.equal(isOffPeak('2026-09-30T01:00:00.000Z', SCHEDULE), false);
  assert.equal(isOffPeak('2026-09-30T03:59:00.000Z', SCHEDULE), false);
  assert.equal(isOffPeak('2026-09-30T04:00:00.000Z', SCHEDULE), true);
  assert.equal(isOffPeak('2026-09-30T10:00:00.000Z', SCHEDULE), true);
});

test('weekends are off-peak all day', () => {
  // 2026-10-03 is a Saturday, 2026-10-04 a Sunday.
  assert.equal(isOffPeak('2026-10-03T02:00:00.000Z', SCHEDULE), true);
  assert.equal(isOffPeak('2026-10-04T07:30:00.000Z', SCHEDULE), true);
});

test('an unknown timestamp is priced as peak, never discounted', () => {
  // Unknown must not silently halve the estimate.
  assert.equal(isOffPeak(undefined, SCHEDULE), false);
  assert.equal(isOffPeak('', SCHEDULE), false);
  assert.equal(isOffPeak('not a date', SCHEDULE), false);
  assert.equal(isOffPeak('2026-09-30T11:00:00.000Z', null), false);
});

test('a custom schedule is honoured', () => {
  const custom = buildSchedule({
    CC_CTX_PEAK_WINDOWS: '00:00-23:59',
    CC_CTX_PEAK_DAYS: '1-7',
    CC_CTX_OFFPEAK_MULTIPLIER: '1',
  });
  assert.equal(isOffPeak('2026-09-30T11:00:00.000Z', custom), false, 'always peak');
  assert.equal(custom.multiplier, 1);
});
