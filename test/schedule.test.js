import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { loadCalendars } from '../src/pricing/calendar.js';
import {
  parseWindows,
  parseDays,
  localParts,
  zonedInstant,
  buildSchedule,
  tierAt,
  nextTransition,
  scheduleKey,
} from '../src/pricing/schedule.js';

const CALS = loadCalendars([{ dir: fileURLToPath(new URL('../conf/calendars', import.meta.url)), kind: 'bundled' }]);

const DEEPSEEK = {
  tz: 'Asia/Shanghai',
  windows: '09:00-12:00,14:00-18:00',
  days: '1-5',
  calendar: 'cn',
  workdaysArePeak: true,
};
const SCHEDULE = buildSchedule(DEEPSEEK, { calendars: CALS });

test('parseWindows reads local minutes, half-open, dropping empty windows', () => {
  assert.deepEqual(parseWindows('09:00-12:00,14:00-18:00'), [
    { start: 540, end: 720 },
    { start: 840, end: 1080 },
  ]);
  assert.deepEqual(parseWindows(''), []);
  assert.deepEqual(parseWindows('garbage'), []);
  assert.deepEqual(parseWindows('03:00-03:00'), [], 'an empty window is dropped');
});

test('parseDays supports ranges and lists', () => {
  assert.deepEqual([...parseDays('1-5')].sort(), [1, 2, 3, 4, 5]);
  assert.deepEqual([...parseDays('1,7')].sort(), [1, 7]);
  assert.deepEqual([...parseDays('1-3,7')].sort(), [1, 2, 3, 7]);
  assert.deepEqual([...parseDays('9')], [], 'an out-of-range weekday is ignored');
});

test('localParts and zonedInstant round-trip (China has no DST)', () => {
  const at = zonedInstant('2026-09-29', 600, 'Asia/Shanghai'); // Beijing 10:00
  assert.equal(at.toISOString(), '2026-09-29T02:00:00.000Z');
  const p = localParts(at, 'Asia/Shanghai');
  assert.deepEqual(p, { date: '2026-09-29', weekday: 2, minutes: 600 });
});

test('a workday is peak inside a peak window and off-peak outside', () => {
  // 2026-09-29 is a Tuesday, not a holiday.
  assert.equal(tierAt('2026-09-29T02:00:00Z', SCHEDULE), 'peak', 'Beijing 10:00 is inside 09-12');
  assert.equal(tierAt('2026-09-29T07:00:00Z', SCHEDULE), 'peak', 'Beijing 15:00 is inside 14-18');
  assert.equal(tierAt('2026-09-29T05:00:00Z', SCHEDULE), 'offPeak', 'Beijing 13:00 is in the gap between windows');
  assert.equal(tierAt('2026-09-29T23:00:00Z', SCHEDULE), 'offPeak', 'Beijing 07:00 the next day, outside any window');
});

test('window edges are inclusive at the start, exclusive at the end', () => {
  assert.equal(tierAt('2026-09-29T01:00:00Z', SCHEDULE), 'peak', 'Beijing 09:00, start inclusive');
  assert.equal(tierAt('2026-09-29T03:59:00Z', SCHEDULE), 'peak');
  assert.equal(tierAt('2026-09-29T04:00:00Z', SCHEDULE), 'offPeak', 'Beijing 12:00, end exclusive');
  assert.equal(tierAt('2026-09-29T10:00:00Z', SCHEDULE), 'offPeak', 'Beijing 18:00, end exclusive');
});

test('weekends are off-peak all day', () => {
  // 2026-10-03 is a Saturday, 2026-10-04 a Sunday.
  assert.equal(tierAt('2026-10-03T02:00:00Z', SCHEDULE), 'offPeak');
  assert.equal(tierAt('2026-10-04T07:00:00Z', SCHEDULE), 'offPeak');
});

test('statutory holidays are off-peak all day (even on what would be a workday)', () => {
  // 2026-01-02 is a Friday inside the New Year holiday; 2026-02-17 a Tuesday inside Spring Festival.
  assert.equal(tierAt('2026-01-02T02:00:00Z', SCHEDULE), 'offPeak');
  assert.equal(tierAt('2026-02-17T02:00:00Z', SCHEDULE), 'offPeak');
  // 2026-10-02 is a Friday inside National Day.
  assert.equal(tierAt('2026-10-02T02:00:00Z', SCHEDULE), 'offPeak');
});

test('makeup workdays count as peak (our conservative reading)', () => {
  // 2026-01-04 is a Sunday makeup workday.
  assert.equal(tierAt('2026-01-04T02:00:00Z', SCHEDULE), 'peak');
  // 2026-02-14 is a Saturday makeup workday.
  assert.equal(tierAt('2026-02-14T02:00:00Z', SCHEDULE), 'peak');
});

test('with workdaysArePeak off, the official literal reading returns: a makeup day is still a weekend', () => {
  const strict = buildSchedule({ ...DEEPSEEK, workdaysArePeak: false }, { calendars: CALS });
  assert.equal(tierAt('2026-01-04T02:00:00Z', strict), 'offPeak');
});

test('unknown or invalid timestamps are always peak, never silently discounted', () => {
  assert.equal(tierAt(undefined, SCHEDULE), 'peak');
  assert.equal(tierAt('', SCHEDULE), 'peak');
  assert.equal(tierAt('not a date', SCHEDULE), 'peak');
  assert.equal(tierAt('2026-09-29T02:00:00Z', null), 'peak', 'no schedule means a single price table');
});

test('years missing from the calendar fall back to weekday only (overestimates, never underestimates)', () => {
  // 2027-01-04 is a Monday; the New Year holiday is absent from the 2027 calendar, so it counts as an ordinary workday.
  assert.equal(tierAt('2027-01-04T02:00:00Z', SCHEDULE), 'peak');
  assert.equal(tierAt('2027-01-03T02:00:00Z', SCHEDULE), 'offPeak', 'a Sunday is still off-peak');
});

test('nextTransition gives the next flip, always in the future', () => {
  const from = new Date('2026-09-29T02:30:00Z'); // Tuesday Beijing 10:30, mid-peak
  const next = nextTransition(from, SCHEDULE);
  assert.ok(next.at > from, 'must not return a moment already past');
  assert.equal(next.tier, 'offPeak');
  assert.equal(next.at.toISOString(), '2026-09-29T04:00:00.000Z', 'Beijing 12:00, the window ends');
});

test('nextTransition points from a window gap to the next window', () => {
  const from = new Date('2026-09-29T05:00:00Z'); // Beijing 13:00, off-peak
  const next = nextTransition(from, SCHEDULE);
  assert.equal(next.tier, 'peak');
  assert.equal(next.at.toISOString(), '2026-09-29T06:00:00.000Z', 'Beijing 14:00, the window starts');
});

test('nextTransition across midnight: after Friday close it points to next Monday', () => {
  const from = new Date('2026-09-25T10:30:00Z'); // Friday Beijing 18:30, already off-peak
  const next = nextTransition(from, SCHEDULE);
  assert.equal(next.tier, 'peak');
  assert.equal(next.at.toISOString(), '2026-09-28T01:00:00.000Z', 'Monday Beijing 09:00');
});

test('nextTransition from inside a holiday points to the first window after it ends', () => {
  const from = new Date('2026-02-18T02:00:00Z'); // a Thursday inside the Spring Festival holiday
  const next = nextTransition(from, SCHEDULE);
  assert.equal(next.tier, 'peak');
  assert.equal(next.at.toISOString(), '2026-02-24T01:00:00.000Z', 'Beijing 09:00 on the day after the holiday ends');
});

test('nextTransition returns null when no flip is found within 32 days', () => {
  // The whole day is a peak window (24:00 means through to day end), so there is no flip point.
  const always = buildSchedule({ days: '1-7', windows: '00:00-24:00' }, { calendars: CALS });
  assert.equal(nextTransition(new Date('2026-09-29T02:00:00Z'), always), null);
});

// A schedule that cannot classify anything as peak would bill every call at
// half price with no signal — the exact failure this subsystem exists to
// prevent. A silently-discounted estimate is worse than an over-estimate, so
// every one of these degenerate shapes must fall back to all-peak / the
// documented default, never to offPeak.

test('windows but no days defaults to peak on every day, not to never-peak', () => {
  // The reviewer's reachable variant: a provider JSON with windows but no days.
  // On a plain Tuesday 10:00 Beijing this must be peak, not the 50%-off fallthrough.
  const s = buildSchedule({ tz: 'Asia/Shanghai', windows: '09:00-12:00,14:00-18:00' });
  assert.ok(s, 'a valid window list is a usable schedule');
  assert.equal(tierAt('2026-09-29T02:00:00Z', s), 'peak', 'Tuesday 10:00 Beijing is peak');
  assert.equal(tierAt('2026-09-29T03:00:00Z', s), 'peak', 'Tuesday 11:00 Beijing is peak');
  assert.equal(tierAt('2026-09-29T05:00:00Z', s), 'offPeak', 'Tuesday 13:00 Beijing is in the gap');
});

test('days that parse to nothing still default to all seven days', () => {
  const s = buildSchedule({ tz: 'Asia/Shanghai', windows: '09:00-12:00', days: 'garbage' });
  assert.ok(s, 'a valid window list remains usable');
  assert.equal(tierAt('2026-09-29T02:00:00Z', s), 'peak', 'Tuesday 10:00 Beijing is peak');
  assert.equal(tierAt('2026-10-03T02:00:00Z', s), 'peak', 'Saturday 10:00 is also peak (every day)');
});

test('a schedule with unparseable windows is unusable (null), never a silent discount', () => {
  const s = buildSchedule({ tz: 'Asia/Shanghai', days: '1-5', windows: 'garbage' });
  assert.equal(s, null, 'no windows means no peak window can ever be found');
  // A null schedule means a single price table: everything at peak rates.
  assert.equal(tierAt('2026-09-29T02:00:00Z', s), 'peak');
  assert.equal(tierAt('2026-10-03T02:00:00Z', s), 'peak', 'even a weekend stays peak');
});

test('an empty schedule object is unusable (null), so everything is peak', () => {
  const s = buildSchedule({});
  assert.equal(s, null);
  assert.equal(tierAt('2026-09-29T02:00:00Z', s), 'peak');
});

test('the shipped DeepSeek provider is unchanged by the fallbacks', () => {
  // It declares both windows and days, so neither new path fires for it.
  const doc = JSON.parse(
    fs.readFileSync(fileURLToPath(new URL('../conf/providers/deepseek.json', import.meta.url)), 'utf8'),
  );
  const s = buildSchedule(doc.schedule, { calendars: CALS });
  assert.ok(s, 'the shipped schedule must still build');
  assert.equal(tierAt('2026-09-29T02:00:00Z', s), 'peak', 'Tuesday 10:00 Beijing stays peak');
  assert.equal(tierAt('2026-10-03T02:00:00Z', s), 'offPeak', 'a Saturday stays off-peak');
  assert.equal(tierAt('2026-10-02T02:00:00Z', s), 'offPeak', 'National Day stays off-peak');
  assert.equal(tierAt('2026-01-04T02:00:00Z', s), 'peak', 'a makeup workday stays peak');
});

test('scheduleKey changes with calendar content, windows, and weekdays', () => {
  const a = scheduleKey(SCHEDULE);
  const b = scheduleKey(buildSchedule(DEEPSEEK, { calendars: loadCalendars([]) }));
  assert.notEqual(a, b, 'a different calendar fingerprint yields a different key');
  const c = scheduleKey(buildSchedule({ ...DEEPSEEK, windows: '10:00-11:00' }, { calendars: CALS }));
  assert.notEqual(a, c, 'a different window yields a different key');
  assert.equal(scheduleKey(null), 'none');
});
