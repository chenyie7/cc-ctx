// Remote data freshness: pull prices and holidays into a local cache.
//
// This layer is a nice-to-have, never a dependency: the bundled snapshot is always
// there, so any failure just means keeping the old data and never affects status
// line rendering. Only a successful fetch writes to disk, and writes go through a
// temp file plus rename.
//
// Note: "going online" for prices does not mean tracking DeepSeek automatically.
// It only turns "the maintainer updates this repo's JSON" into "the user gets it
// automatically"; prices actually changing still needs someone to update the files
// in the repo.

import fs from 'node:fs';
import path from 'node:path';

import { parseCalendarFile } from './calendar.js';

export const DEFAULT_PROVIDER_URL =
  'https://cdn.jsdelivr.net/gh/chenyie7/cc-ctx@main/conf/providers/{id}.json';
export const DEFAULT_CALENDAR_URL =
  'https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/{year}.json';

export function remoteRoot(installDir) {
  return path.join(installDir, 'remote');
}

export function remoteDirsFor(cfg) {
  const root = remoteRoot(cfg.installDir);
  return {
    providers: { dir: path.join(root, 'providers'), kind: 'remote' },
    calendars: { dir: path.join(root, 'calendars'), kind: 'remote' },
    metaFile: path.join(root, 'meta.json'),
  };
}

export function readMeta(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function isStale(meta, ttlMs, now) {
  if (!meta || !Number.isFinite(meta.fetchedAt)) return true;
  return now - meta.fetchedAt >= ttlMs;
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

/**
 * Which years to fetch by default: the current one, plus the next one within 30
 * days of year end (next year's schedule is usually published in November).
 */
export function defaultYears(now = Date.now()) {
  const d = new Date(now);
  const year = d.getUTCFullYear();
  return d.getUTCMonth() === 11 && d.getUTCDate() > 1 ? [year, year + 1] : [year];
}

export async function refreshRemote(
  cfg,
  { fetchFn = fetch, now = Date.now, log = () => {}, years, providerIds } = {},
) {
  const updated = [];
  const failed = [];
  if (!cfg?.remote) return { updated, failed };

  const dirs = remoteDirsFor(cfg);
  const stamp = now();

  const wantedYears = years || defaultYears(stamp);
  const wantedProviders = providerIds || ['deepseek'];

  for (const year of wantedYears) {
    const url = String(cfg.calendarUrl || DEFAULT_CALENDAR_URL).replace('{year}', String(year));
    const doc = await fetchJson(url, fetchFn);
    const parsed = doc ? parseCalendarFile(doc, { kind: 'remote', file: null }) : null;
    if (!parsed) {
      failed.push(`calendar:${year}`);
      continue;
    }
    try {
      writeJsonAtomic(path.join(dirs.calendars.dir, `${parsed.id}-${year}.json`), {
        ...parsed,
        source: undefined,
      });
      updated.push(`calendar:${parsed.id}:${year}`);
    } catch (error) {
      failed.push(`calendar:${year}`);
      log(`calendar ${year}: ${error.message}`);
    }
  }

  for (const id of wantedProviders) {
    const url = String(cfg.providerUrl || DEFAULT_PROVIDER_URL).replace('{id}', String(id));
    const doc = await fetchJson(url, fetchFn);
    if (!doc || typeof doc !== 'object' || !doc.id) {
      failed.push(`provider:${id}`);
      continue;
    }
    try {
      writeJsonAtomic(path.join(dirs.providers.dir, `${id}.json`), doc);
      updated.push(`provider:${id}`);
    } catch (error) {
      failed.push(`provider:${id}`);
      log(`provider ${id}: ${error.message}`);
    }
  }

  // The recorded time is the attempt time, not the success time: a failure must
  // still back off for one TTL, otherwise every status line render would fork a
  // background process that is certain to fail again.
  const meta = readMeta(dirs.metaFile);
  for (const key of updated) meta[key] = { fetchedAt: stamp, ok: true };
  if (wantedYears.length) {
    meta.calendars = { fetchedAt: stamp, ok: !failed.some((f) => f.startsWith('calendar:')) };
  }
  if (wantedProviders.length) {
    meta.providers = { fetchedAt: stamp, ok: !failed.some((f) => f.startsWith('provider:')) };
  }

  try {
    writeJsonAtomic(dirs.metaFile, meta);
  } catch (error) {
    log(`meta: ${error.message}`);
  }

  return { updated, failed };
}

/** Fetch JSON. Any failure (network, timeout, body is not JSON) counts as nothing. */
async function fetchJson(url, fetchFn, timeoutMs = 8000) {
  try {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res?.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
