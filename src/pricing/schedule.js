// Schedule engine: maps an instant to peak or off-peak.
//
// The rule is DeepSeek's: Beijing time, Monday to Friday (excluding Chinese
// statutory holidays), 09:00-12:00 and 14:00-18:00 are peak; everything else
// (including all of weekends and holidays) is off-peak. Makeup workdays count
// as peak on our more conservative reading, controlled by workdaysArePeak.
//
// Both dimensions are wall-clock time inside the zone: the window is decided by
// hour and minute, the day by calendar date.

const DAY_MINUTES = 1440;

/** Minutes since local midnight, half-open. Unparseable fragments are dropped. */
export function parseWindows(spec) {
  const windows = [];
  for (const part of String(spec ?? '').split(',')) {
    const m = /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(part);
    if (!m) continue;
    const start = Number(m[1]) * 60 + Number(m[2]);
    const end = Number(m[3]) * 60 + Number(m[4]);
    if (start === end) continue;
    windows.push({ start, end });
  }
  return windows;
}

/** ISO weekday (1 = Monday ... 7 = Sunday). Accepts "1-5", "1,2", "1-5,7". */
export function parseDays(spec) {
  const days = new Set();
  for (const part of String(spec ?? '').split(',')) {
    const range = /^\s*(\d)\s*-\s*(\d)\s*$/.exec(part);
    if (range) {
      const [from, to] = [Number(range[1]), Number(range[2])];
      for (let d = Math.min(from, to); d <= Math.max(from, to); d++) {
        if (d >= 1 && d <= 7) days.add(d);
      }
      continue;
    }
    const single = Number(part.trim());
    if (single >= 1 && single <= 7) days.add(single);
  }
  return days;
}

const WEEKDAY = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const formatters = new Map();

function formatterFor(tz) {
  if (!formatters.has(tz)) {
    let f = null;
    try {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        year: 'numeric', month: '2-digit', day: '2-digit',
        weekday: 'short',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      });
    } catch {
      f = null; // Unknown timezone: the caller falls back to UTC.
    }
    formatters.set(tz, f);
  }
  return formatters.get(tz);
}

/** { date, weekday, minutes } for an instant in tz. */
export function localParts(instant, tz) {
  const f = formatterFor(tz) || formatterFor('UTC');
  const parts = f.formatToParts(instant);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    weekday: WEEKDAY[get('weekday')] ?? 0,
    // hourCycle: 'h23' already avoids the 24th hour; modulo again just in case.
    minutes: (Number(get('hour')) % 24) * 60 + Number(get('minute')),
  };
}

/**
 * Converts "local calendar day + minute of day" into an instant.
 * Guess once in UTC, then correct by the offset between the guessed wall time
 * and the target. A zone without DST settles in one pass; a DST zone converges
 * within two.
 */
export function zonedInstant(dateKey, minutes, tz) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const wanted = Date.UTC(y, m - 1, d) + minutes * 60000;
  let guess = wanted;
  for (let i = 0; i < 3; i++) {
    const p = localParts(new Date(guess), tz);
    const [py, pm, pd] = p.date.split('-').map(Number);
    const actual = Date.UTC(py, pm - 1, pd) + p.minutes * 60000;
    const delta = wanted - actual;
    if (delta === 0) break;
    guess += delta;
  }
  return new Date(guess);
}

// calendars is what loadCalendars() returns: id -> an already-built calendar
// (holidays/workdays are Sets). Do not buildCalendar it again — that reads a
// nonexistent years field and silently empties the calendar.
export function buildSchedule(def, { calendars } = {}) {
  if (!def) return null;
  const windows = parseWindows(def.windows);
  // A schedule whose windows do not parse (or that declares no windows at all)
  // can never classify anything as peak: tierAt would fall through to off-peak
  // and bill every call at half price with no signal. Treat it as unusable — a
  // null schedule means a single price table, everything at peak rates, which
  // is the conservative direction (overestimate, never silently discount).
  if (windows.length === 0) return null;
  const days = parseDays(def.days);
  return {
    tz: def.tz || 'UTC',
    windows,
    // No `days` (or an unparseable one) means "peak during these hours, every
    // day", not "never peak" — default to all seven ISO weekdays.
    days: days.size ? days : new Set([1, 2, 3, 4, 5, 6, 7]),
    workdaysArePeak: def.workdaysArePeak !== false,
    calendar: (def.calendar && calendars?.get(def.calendar)) || null,
  };
}

/**
 * The tier. Unknown or invalid timestamps count as peak - overestimate rather
 * than silently hand out a discount.
 */
export function tierAt(instant, schedule) {
  if (!instant || !schedule) return 'peak';
  const when = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(when.getTime())) return 'peak';

  const cal = schedule.calendar;
  const win = localParts(when, schedule.tz);
  // The calendar's date axis may differ from the window zone (e.g. windows in
  // UTC, holidays local).
  const calDate = cal && cal.tz !== schedule.tz ? localParts(when, cal.tz).date : win.date;

  if (cal?.holidays?.has(calDate)) return 'offPeak';

  const workday = schedule.workdaysArePeak && cal?.workdays?.has(calDate) === true;
  if (!workday && !schedule.days.has(win.weekday)) return 'offPeak';

  for (const { start, end } of schedule.windows) {
    if (win.minutes >= start && win.minutes < end) return 'peak';
  }
  return 'offPeak';
}

const ALERT_HORIZON_DAYS = 32;

/**
 * The next tier flip.
 *
 * The tier can only change at two kinds of moment: a window edge (local
 * 09:00/12:00/14:00/18:00) or local midnight (crossing a day changes the weekday
 * and the holiday state). So enumerating those candidates and taking the first
 * one that truly flips is enough — no minute-by-minute scan needed.
 *
 * 32 days clears any holiday (Spring Festival is at most 9 days).
 */
export function nextTransition(from, schedule, { horizonDays = ALERT_HORIZON_DAYS } = {}) {
  if (!schedule) return null;
  const start = from instanceof Date ? from : new Date(from);
  if (Number.isNaN(start.getTime())) return null;

  const nowTier = tierAt(start, schedule);
  const today = localParts(start, schedule.tz).date;
  const [y, m, d] = today.split('-').map(Number);

  const candidates = [];
  for (let i = 0; i <= horizonDays; i++) {
    const dateKey = new Date(Date.UTC(y, m - 1, d + i)).toISOString().slice(0, 10);
    candidates.push(zonedInstant(dateKey, 0, schedule.tz));
    for (const { start: ws, end: we } of schedule.windows) {
      candidates.push(zonedInstant(dateKey, ws, schedule.tz));
      if (we < DAY_MINUTES) candidates.push(zonedInstant(dateKey, we, schedule.tz));
    }
  }
  candidates.sort((a, b) => a - b);

  for (const at of candidates) {
    if (at <= start) continue;
    const tier = tierAt(at, schedule);
    if (tier !== nowTier) return { at, tier };
  }
  return null;
}

/** Stable fingerprint: when calendar content changes, the peak/off-peak bucket cache must invalidate. */
export function scheduleKey(schedule) {
  if (!schedule) return 'none';
  const windows = schedule.windows.map((w) => `${w.start}-${w.end}`).join('.');
  const days = [...schedule.days].sort().join('');
  const cal = schedule.calendar ? `/${schedule.calendar.id}:${schedule.calendar.key}` : '';
  return `${schedule.tz}|${windows}|${days}|${schedule.workdaysArePeak ? 1 : 0}${cal}`;
}
