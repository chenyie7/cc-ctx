// Time-of-day pricing windows.
//
// DeepSeek halves its rates outside peak hours, so a session spanning an
// off-peak window costs half what peak-only pricing would report. Pricing is
// decided per API call, from that record's own timestamp, rather than guessed
// for the session as a whole.
//
// Known gap: DeepSeek also treats Chinese public holidays as off-peak. There is
// no reliable offline source for those dates, so holiday traffic is priced at
// the peak rate — a deliberate over-estimate rather than a silent guess.

/** Minutes since UTC midnight, inclusive start / exclusive end. */
export function parsePeakWindows(spec) {
  const windows = [];
  for (const part of String(spec || '').split(',')) {
    const m = /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(part);
    if (!m) continue;
    const start = Number(m[1]) * 60 + Number(m[2]);
    const end = Number(m[3]) * 60 + Number(m[4]);
    if (start === end) continue;
    windows.push({ start, end });
  }
  return windows;
}

/**
 * ISO weekdays (1 = Monday … 7 = Sunday) that are peak.
 * Accepts "1-5", "1,2,3", or a mix like "1-5,7".
 */
export function parsePeakDays(spec) {
  const days = new Set();
  for (const part of String(spec || '').split(',')) {
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

/** JS getUTCDay() is 0 = Sunday; ISO is 7 = Sunday. */
function isoWeekday(date) {
  const day = date.getUTCDay();
  return day === 0 ? 7 : day;
}

/**
 * True when a call at `timestamp` is billed at the off-peak rate.
 * An unparseable or missing timestamp is treated as peak, so an unknown call
 * never silently discounts the estimate.
 */
export function isOffPeak(timestamp, schedule) {
  if (!timestamp || !schedule) return false;
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  if (Number.isNaN(date.getTime())) return false;

  if (!schedule.days.has(isoWeekday(date))) return true;

  const minutes = date.getUTCHours() * 60 + date.getUTCMinutes();
  for (const { start, end } of schedule.windows) {
    if (minutes >= start && minutes < end) return false;
  }
  return true;
}

/**
 * Build a schedule from configuration. Defaults match DeepSeek's published
 * rule: peak 01:00-04:00 and 06:00-10:00 UTC, Monday to Friday.
 */
export function buildSchedule(env = {}) {
  return {
    windows: parsePeakWindows(env.CC_CTX_PEAK_WINDOWS ?? '01:00-04:00,06:00-10:00'),
    days: parsePeakDays(env.CC_CTX_PEAK_DAYS ?? '1-5'),
    multiplier: Number(env.CC_CTX_OFFPEAK_MULTIPLIER ?? 0.5),
  };
}
