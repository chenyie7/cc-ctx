// Cumulative session usage, read from the conversation transcript.
//
// Why the transcript instead of the status line payload: the payload's
// `context_window.current_usage` describes the *most recent* API call, not the
// session. On a real session that understated cost by ~130x.
//
// Subagent traffic lives in sibling files (`<session>/subagents/*.jsonl`) and
// is counted here too. Sidechain records are skipped if they ever appear in the
// main transcript, so the two sources can never double-count.

import fs from 'node:fs';
import path from 'node:path';

import { isOffPeak } from './peak.js';

/**
 * A fresh accumulator. `offPeak` holds the subset of each bucket that was
 * billed outside peak hours; the top-level fields stay the plain totals so
 * everything that displays tokens is unaffected by pricing rules.
 */
export function emptyTotals() {
  return {
    input: 0,
    cacheWrite: 0,
    cacheRead: 0,
    output: 0,
    thinking: 0,
    calls: 0,
    // Metadata, not a total: the model the transcript actually ran on. Carried
    // here because it is read in the same pass, and `cc-ctx` needs it to pick a
    // price table when no status line payload is available.
    model: null,
    offPeak: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 },
  };
}

export const EMPTY_TOTALS = Object.freeze({
  ...emptyTotals(),
  offPeak: Object.freeze({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0 }),
});

/** `<proj>/<session>.jsonl` -> `<proj>/<session>/subagents` */
export function subagentDir(transcriptPath) {
  const dir = path.dirname(transcriptPath);
  const stem = path.basename(transcriptPath).replace(/\.jsonl$/, '');
  return path.join(dir, stem, 'subagents');
}

export function listSubagentFiles(transcriptPath) {
  const dir = subagentDir(transcriptPath);
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .sort()
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

function addUsage(totals, usage, model, offPeak) {
  if (model) totals.model = model;
  if (!usage || typeof usage !== 'object') return;

  const bucket = {
    input: Number(usage.input_tokens) || 0,
    cacheWrite: Number(usage.cache_creation_input_tokens) || 0,
    cacheRead: Number(usage.cache_read_input_tokens) || 0,
    output: Number(usage.output_tokens) || 0,
  };

  totals.input += bucket.input;
  totals.cacheWrite += bucket.cacheWrite;
  totals.cacheRead += bucket.cacheRead;
  totals.output += bucket.output;
  totals.thinking += Number(usage.output_tokens_details?.thinking_tokens) || 0;
  totals.calls += 1;

  if (offPeak) {
    totals.offPeak.input += bucket.input;
    totals.offPeak.cacheWrite += bucket.cacheWrite;
    totals.offPeak.cacheRead += bucket.cacheRead;
    totals.offPeak.output += bucket.output;
  }
}

/**
 * Sum every `message.usage` in one JSONL file.
 *
 * Read in chunks rather than line-by-line: a long session's transcript reaches
 * tens of megabytes and the status line has a latency budget. A partial trailing
 * line is carried over to the next chunk.
 */
export function sumUsageFile(
  file,
  { skipSidechain = true, schedule = null, seen = null } = {},
) {
  const totals = emptyTotals();
  // Claude Code writes one transcript line per content block, and every line of
  // the same assistant message repeats that message's usage verbatim. Summing
  // the lines therefore multiplies the bill by roughly three. Each API response
  // is counted once, keyed by its `message.id`, which is identical across the
  // duplicates and absent only if the provider did not supply one.
  const counted = seen || new Set();
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return totals;
  }

  try {
    const buf = Buffer.alloc(1 << 20);
    let carry = '';
    for (;;) {
      const read = fs.readSync(fd, buf, 0, buf.length);
      if (read === 0) break;
      const chunk = carry + buf.toString('utf8', 0, read);
      const lines = chunk.split('\n');
      carry = lines.pop() ?? '';
      for (const line of lines) {
        // Cheap pre-filter: the vast majority of transcript lines are tool
        // traffic with no usage block.
        if (!line.includes('"usage"')) continue;
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          continue; // a torn line (e.g. read raced a write) is not fatal
        }
        if (skipSidechain && record.isSidechain === true) continue;
        const id = record.message?.id;
        if (id) {
          if (counted.has(id)) continue;
          counted.add(id);
        }
        addUsage(
          totals,
          record.message?.usage,
          record.message?.model,
          isOffPeak(record.timestamp, schedule),
        );
      }
    }
    if (carry && carry.includes('"usage"')) {
      try {
        const record = JSON.parse(carry);
        if (!(skipSidechain && record.isSidechain === true)) {
          const id = record.message?.id;
          const duplicate = id ? counted.has(id) : false;
          if (id) counted.add(id);
          if (!duplicate) {
            addUsage(
              totals,
              record.message?.usage,
              record.message?.model,
              isOffPeak(record.timestamp, schedule),
            );
          }
        }
      } catch {
        /* trailing line was torn; ignore */
      }
    }
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* already closed */
    }
  }

  return totals;
}

export function mergeTotals(list) {
  const out = emptyTotals();
  for (const t of list) {
    out.input += t.input;
    out.cacheWrite += t.cacheWrite;
    out.cacheRead += t.cacheRead;
    out.output += t.output;
    out.thinking += t.thinking;
    out.calls += t.calls;
    if (t.offPeak) {
      out.offPeak.input += t.offPeak.input;
      out.offPeak.cacheWrite += t.offPeak.cacheWrite;
      out.offPeak.cacheRead += t.offPeak.cacheRead;
      out.offPeak.output += t.offPeak.output;
    }
    // First non-null wins, and the main transcript is always first — a subagent
    // may run on a different model and must not decide the price table.
    if (out.model === null && t.model) out.model = t.model;
  }
  return out;
}

/**
 * A change signature over every file we read. Cheap enough to compute on every
 * status line refresh: a handful of `stat` calls, no parsing.
 */
export function signature(files) {
  const parts = [];
  for (const f of files) {
    try {
      const st = fs.statSync(f);
      parts.push(`${f}:${st.mtimeMs}:${st.size}`);
    } catch {
      parts.push(`${f}:missing`);
    }
  }
  return parts.join('|');
}

/**
 * Every transcript file belonging to the session, each tagged with whether its
 * sidechain records should be skipped.
 *
 * `isSidechain` is true for *every* record inside a subagent's own transcript —
 * that file exists precisely to hold them. The flag is only a guard on the main
 * transcript, where a sidechain record would duplicate what the subagent file
 * already reports. Applying it everywhere silently discarded all subagent usage.
 */
export function sessionFiles(transcriptPath) {
  if (!transcriptPath) return [];
  return [
    { file: transcriptPath, skipSidechain: true },
    ...listSubagentFiles(transcriptPath).map((file) => ({ file, skipSidechain: false })),
  ];
}

export function sumSession(entries, schedule = null) {
  // One `seen` set for the whole session, so a response mirrored into two files
  // cannot be counted twice either.
  const seen = new Set();
  return mergeTotals(
    entries.map((e) => sumUsageFile(e.file, { skipSidechain: e.skipSidechain, schedule, seen })),
  );
}

/** Stable fingerprint of a pricing schedule, so a config change busts the cache. */
export function scheduleKey(schedule) {
  if (!schedule) return 'none';
  const windows = (schedule.windows || [])
    .map((w) => `${w.start}-${w.end}`)
    .join('.');
  const days = [...(schedule.days || [])].sort().join('');
  return `${windows}/${days}/${schedule.multiplier}`;
}

/** Unconditional recomputation, no cache. Used by the report command. */
export function computeTotals(transcriptPath, { schedule = null } = {}) {
  const entries = sessionFiles(transcriptPath);
  return {
    totals: sumSession(entries, schedule),
    files: entries.map((e) => e.file),
  };
}

/**
 * Cached recomputation. The transcript only changes as the session advances, so
 * the overwhelming majority of status line refreshes hit this and pay a few
 * `stat` calls instead of a full parse.
 */
export function computeTotalsCached(
  transcriptPath,
  cache,
  cacheKey = 'usage',
  { schedule = null } = {},
) {
  const entries = sessionFiles(transcriptPath);
  const files = entries.map((e) => e.file);
  const sig = signature(files);
  const key = `${cacheKey}:${scheduleKey(schedule)}`;
  const hit = cache?.get(key);
  if (hit && hit.signature === sig && hit.totals) {
    return { totals: hit.totals, files, cached: true };
  }
  const totals = sumSession(entries, schedule);
  cache?.set(key, { signature: sig, totals });
  return { totals, files, cached: false };
}

/**
 * Billed cost, in the price table's currency.
 * Returns null when the model has no complete price set — showing nothing is
 * correct, whereas substituting another model's rates is the bug being fixed.
 */
export function costOf(totals, prices, { offPeakMultiplier = 1 } = {}) {
  if (!prices) return null;

  const off = totals.offPeak ?? { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  const peak = {
    input: totals.input - off.input,
    cacheWrite: totals.cacheWrite - off.cacheWrite,
    cacheRead: totals.cacheRead - off.cacheRead,
    output: totals.output - off.output,
  };

  const bill = (b) =>
    b.input * prices.input +
    b.cacheWrite * prices.cacheWrite +
    b.cacheRead * prices.cacheRead +
    b.output * prices.output;

  return (bill(peak) + bill(off) * offPeakMultiplier) / 1e6;
}

/**
 * Cache read tokens as a fraction of all input tokens.
 * The denominator is every token the model had to consider: fresh input, cache
 * writes, and cache reads. Null while the session has no input at all.
 */
export function hitRate(totals) {
  const denom = totals.input + totals.cacheWrite + totals.cacheRead;
  if (denom <= 0) return null;
  return totals.cacheRead / denom;
}

/** Tokens billed at the uncached input rate, i.e. what the cache failed to save. */
export function totalInputTokens(totals) {
  return totals.input + totals.cacheWrite + totals.cacheRead;
}
