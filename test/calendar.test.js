import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  expandDates,
  fromHolidayCn,
  parseCalendarFile,
  buildCalendar,
  loadCalendars,
} from '../src/pricing/calendar.js';

test('expandDates expands single days and ranges, ignoring invalid entries', () => {
  const out = expandDates(['2026-01-01', { from: '2026-02-15', to: '2026-02-17' }, 'not-a-date', null]);
  assert.deepEqual([...out].sort(), ['2026-01-01', '2026-02-15', '2026-02-16', '2026-02-17']);
});

test('expandDates ranges are closed across months and years', () => {
  assert.deepEqual([...expandDates([{ from: '2025-12-30', to: '2026-01-02' }])].sort(),
    ['2025-12-30', '2025-12-31', '2026-01-01', '2026-01-02']);
});

test('fromHolidayCn uses isOffDay to tell days off from makeup workdays', () => {
  const { holidays, workdays } = fromHolidayCn({
    year: 2026,
    days: [
      { name: '元旦', date: '2026-01-01', isOffDay: true },
      { name: '元旦', date: '2026-01-04', isOffDay: false },
    ],
  });
  assert.deepEqual(holidays, ['2026-01-01']);
  assert.deepEqual(workdays, ['2026-01-04']);
});

test('parseCalendarFile accepts both the native and holiday-cn formats', () => {
  const native = parseCalendarFile({ id: 'cn', tz: 'Asia/Shanghai', years: { 2026: { holidays: ['2026-01-01'] } } });
  assert.equal(native.id, 'cn');
  assert.ok(native.years['2026']);

  const adapted = parseCalendarFile({ year: 2026, days: [{ date: '2026-01-01', isOffDay: true }] });
  assert.equal(adapted.id, 'cn', 'holiday-cn has no id, defaults to the fixed China id');
  assert.deepEqual(adapted.years['2026'].holidays, ['2026-01-01']);

  assert.equal(parseCalendarFile(null), null);
  assert.equal(parseCalendarFile({ nothing: true }), null, 'an unrecognised format is rejected');
});

test('buildCalendar merges all years and yields a content fingerprint', () => {
  const def = {
    id: 'cn',
    tz: 'Asia/Shanghai',
    years: {
      2025: { holidays: ['2025-01-01'], workdays: [] },
      2026: { holidays: ['2026-01-01'], workdays: ['2026-01-04'] },
    },
  };
  const cal = buildCalendar(def);
  assert.ok(cal.holidays.has('2025-01-01'));
  assert.ok(cal.holidays.has('2026-01-01'));
  assert.ok(cal.workdays.has('2026-01-04'));

  const other = buildCalendar({ ...def, years: { 2026: { holidays: ['2026-01-02'], workdays: [] } } });
  assert.notEqual(cal.key, other.key, 'the fingerprint must change when the content changes');
  assert.equal(buildCalendar(def).key, cal.key, 'the fingerprint stays stable for identical content');
});

test('loadCalendars lets later entries win and skips broken files', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ctx-cal-'));
  const low = path.join(base, 'low');
  const high = path.join(base, 'high');
  fs.mkdirSync(low);
  fs.mkdirSync(high);
  fs.writeFileSync(path.join(low, 'cn.json'), JSON.stringify({ id: 'cn', years: { 2026: { holidays: ['2026-01-01'] } } }));
  fs.writeFileSync(path.join(high, 'cn.json'), JSON.stringify({ id: 'cn', years: { 2026: { holidays: ['2026-01-05'] } } }));
  fs.writeFileSync(path.join(high, 'broken.json'), '{ this is not json');

  try {
    const cals = loadCalendars([{ dir: low, kind: 'bundled' }, { dir: high, kind: 'user' }]);
    const cn = cals.get('cn');
    assert.ok(cn.holidays.has('2026-01-05'), 'a higher-priority directory overrides a lower one');
    assert.ok(!cn.holidays.has('2026-01-01'), 'an overridden year no longer contributes days');
    assert.equal(cn.source.kind, 'user');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
