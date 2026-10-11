// Holiday calendar: merges a bundled snapshot, a remote cache, and user files,
// in that priority order.
//
// Two on-disk formats are recognised:
//   - this project's native { id, tz, years: { "2026": { holidays, workdays } } }
//   - NateScarlet/holiday-cn's { year, days: [{ date, isOffDay }] }
// Dates are always local calendar days in YYYY-MM-DD; for China a holiday means
// Beijing time.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DEFAULT_CALENDAR_TZ = 'Asia/Shanghai';

const DAY_MS = 86400000;

/** "YYYY-MM-DD" -> milliseconds at UTC midnight; null when invalid. */
function dayMs(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text ?? '').trim());
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(ms) ? null : ms;
}

function dayKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Expands a list mixing "YYYY-MM-DD" and { from, to } into a set of days. */
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

/** holiday-cn: isOffDay true is a day off, false is a makeup workday. */
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

/** Recognises a calendar JSON. Returns null (caller skips it) when unrecognised. */
export function parseCalendarFile(doc, source = { kind: 'bundled', file: null }) {
  if (!doc || typeof doc !== 'object') return null;

  if (doc.years && typeof doc.years === 'object') {
    return { id: doc.id || 'cn', tz: doc.tz || DEFAULT_CALENDAR_TZ, years: doc.years, source };
  }
  if (Array.isArray(doc.days)) {
    // holiday-cn names its year field; use it for the year entry directly.
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

/** Merges defs sharing an id: later defs win at the year level. */
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

/** Content fingerprint: changing a day off must invalidate peak/off-peak caches. */
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

/** entries: [{ dir, kind }], merged in order, later entries win. */
export function loadCalendars(entries) {
  const defs = [];
  for (const { dir, kind } of entries) {
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    } catch {
      continue; // A missing directory is normal (the user may never have made one).
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
