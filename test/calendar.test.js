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

test('expandDates 展开单日与区间，忽略非法项', () => {
  const out = expandDates(['2026-01-01', { from: '2026-02-15', to: '2026-02-17' }, 'not-a-date', null]);
  assert.deepEqual([...out].sort(), ['2026-01-01', '2026-02-15', '2026-02-16', '2026-02-17']);
});

test('expandDates 的区间跨月跨年是闭区间', () => {
  assert.deepEqual([...expandDates([{ from: '2025-12-30', to: '2026-01-02' }])].sort(),
    ['2025-12-30', '2025-12-31', '2026-01-01', '2026-01-02']);
});

test('fromHolidayCn 用 isOffDay 分辨放假日与调休上班日', () => {
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

test('parseCalendarFile 同时认原生格式与 holiday-cn 格式', () => {
  const native = parseCalendarFile({ id: 'cn', tz: 'Asia/Shanghai', years: { 2026: { holidays: ['2026-01-01'] } } });
  assert.equal(native.id, 'cn');
  assert.ok(native.years['2026']);

  const adapted = parseCalendarFile({ year: 2026, days: [{ date: '2026-01-01', isOffDay: true }] });
  assert.equal(adapted.id, 'cn', 'holiday-cn 没有 id，按中国的固定 id');
  assert.deepEqual(adapted.years['2026'].holidays, ['2026-01-01']);

  assert.equal(parseCalendarFile(null), null);
  assert.equal(parseCalendarFile({ nothing: true }), null, '无法识别的格式被拒绝');
});

test('buildCalendar 合并所有年份并给出内容指纹', () => {
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
  assert.notEqual(cal.key, other.key, '内容变了指纹必须变');
  assert.equal(buildCalendar(def).key, cal.key, '同样的内容指纹必须稳定');
});

test('loadCalendars 后者覆盖前者，坏文件被跳过', () => {
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
    assert.ok(cn.holidays.has('2026-01-05'), '高优先级目录覆盖低优先级');
    assert.ok(!cn.holidays.has('2026-01-01'), '被覆盖的年份不再贡献日期');
    assert.equal(cn.source.kind, 'user');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
