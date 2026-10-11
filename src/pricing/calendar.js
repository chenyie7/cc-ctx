// 节假日日历：内置快照 / 远程缓存 / 用户文件三级合并。
//
// 两个格式都要认：
//   - 本项目的原生格式 { id, tz, years: { "2026": { holidays, workdays } } }
//   - NateScarlet/holiday-cn 的 { year, days: [{ date, isOffDay }] }
// 日期一律是「当地自然日」的 YYYY-MM-DD，节假日在中国的语境下即北京时间。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DEFAULT_CALENDAR_TZ = 'Asia/Shanghai';

const DAY_MS = 86400000;

/** "YYYY-MM-DD" -> UTC 零点的毫秒数；非法返回 null。 */
function dayMs(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text ?? '').trim());
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(ms) ? null : ms;
}

function dayKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** 把 "YYYY-MM-DD" 与 { from, to } 混排的列表展开成日期集合。 */
export function expandDates(entries, out = new Set()) {
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (typeof entry === 'string') {
      const ms = dayMs(entry);
      if (ms !== null) out.add(dayKey(ms));
      continue;
    }
    const from = dayMs(entry?.from);
    const to = entry?.to === undefined ? from : dayMs(entry.to);
    if (from === null || to === null) continue;
    for (let ms = from; ms <= to; ms += DAY_MS) out.add(dayKey(ms));
  }
  return out;
}

/** holiday-cn：isOffDay 为 true 是放假日，false 是调休上班日。 */
export function fromHolidayCn(doc) {
  const holidays = [];
  const workdays = [];
  for (const day of Array.isArray(doc?.days) ? doc.days : []) {
    const ms = dayMs(day?.date);
    if (ms === null) continue;
    (day.isOffDay === false ? workdays : holidays).push(dayKey(ms));
  }
  return { holidays, workdays };
}

/** 识别一份日历 JSON。认不出来就返回 null，由调用方跳过。 */
export function parseCalendarFile(doc, source = { kind: 'bundled', file: null }) {
  if (!doc || typeof doc !== 'object') return null;

  if (doc.years && typeof doc.years === 'object') {
    return { id: doc.id || 'cn', tz: doc.tz || DEFAULT_CALENDAR_TZ, years: doc.years, source };
  }
  if (Array.isArray(doc.days)) {
    // holiday-cn 的字段里提到了年份，年条目直接用它。
    const year = String(doc.year || '');
    if (!/^\d{4}$/.test(year)) return null;
    return {
      id: doc.id || 'cn',
      tz: doc.tz || DEFAULT_CALENDAR_TZ,
      years: { [year]: fromHolidayCn(doc) },
      source,
    };
  }
  return null;
}

/** 同 id 的多个定义合并：年份级后者覆盖前者。 */
export function mergeCalendarDefs(defs) {
  const out = new Map();
  for (const def of defs) {
    if (!def?.id) continue;
    const cur = out.get(def.id) || { id: def.id, tz: def.tz, years: {}, source: def.source };
    if (def.tz) cur.tz = def.tz;
    cur.source = def.source;
    for (const [year, entry] of Object.entries(def.years || {})) cur.years[year] = entry;
    out.set(def.id, cur);
  }
  return out;
}

/** 内容指纹：改了放假/调休日期，峰谷分桶的缓存就必须失效。 */
export function calendarKey(id, holidays, workdays) {
  const hash = crypto.createHash('sha1').update(String(id));
  for (const day of [...holidays].sort()) hash.update('h' + day);
  for (const day of [...workdays].sort()) hash.update('w' + day);
  return hash.digest('hex').slice(0, 12);
}

export function buildCalendar(def) {
  const holidays = new Set();
  const workdays = new Set();
  for (const entry of Object.values(def.years || {})) {
    expandDates(entry?.holidays, holidays);
    expandDates(entry?.workdays, workdays);
  }
  return {
    id: def.id,
    tz: def.tz || DEFAULT_CALENDAR_TZ,
    holidays,
    workdays,
    key: calendarKey(def.id, holidays, workdays),
    source: def.source,
  };
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** entries: [{ dir, kind }]，按顺序合并，靠后的优先。 */
export function loadCalendars(entries) {
  const defs = [];
  for (const { dir, kind } of entries) {
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    } catch {
      continue; // 目录不存在是正常情况（用户可能从未建过）
    }
    for (const name of files) {
      const file = path.join(dir, name);
      const def = parseCalendarFile(readJson(file), { kind, file });
      if (def) defs.push(def);
    }
  }
  const merged = mergeCalendarDefs(defs);
  const out = new Map();
  for (const [id, def] of merged) out.set(id, buildCalendar(def));
  return out;
}
