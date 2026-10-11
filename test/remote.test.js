import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isStale, refreshRemote, remoteRoot } from '../src/pricing/remote.js';

const HOLIDAY_DOC = {
  year: 2026,
  days: [
    { name: '元旦', date: '2026-01-01', isOffDay: true },
    { name: '元旦', date: '2026-01-04', isOffDay: false },
  ],
};

function fakeFetch(map) {
  return async (url) => {
    if (!(url in map)) return { ok: false, status: 404, json: async () => null };
    const body = map[url];
    return {
      ok: true,
      status: 200,
      json: async () => {
        if (typeof body === 'string') throw new SyntaxError('not json'); // Stands in for an HTML error page.
        return body;
      },
    };
  };
}

function tempInstall() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ctx-remote-'));
}

function cfgFor(installDir, urls = {}) {
  return {
    installDir,
    remote: true,
    remoteTtlMs: 86400000,
    providerUrl: urls.provider ?? 'https://example.test/{id}.json',
    calendarUrl: urls.calendar ?? 'https://example.test/{year}.json',
  };
}

test('isStale treats missing metadata and an elapsed TTL as stale', () => {
  const now = 1_000_000_000_000;
  assert.equal(isStale(null, 1000, now), true);
  assert.equal(isStale({ fetchedAt: now - 500 }, 1000, now), false);
  assert.equal(isStale({ fetchedAt: now - 5000 }, 1000, now), true);
});

test('refreshRemote caches the remote calendar, normalised to our format', async () => {
  const install = tempInstall();
  try {
    const result = await refreshRemote(cfgFor(install), {
      fetchFn: fakeFetch({ 'https://example.test/2026.json': HOLIDAY_DOC }),
      now: () => 1_700_000_000_000,
      years: [2026],
      providerIds: [],
    });
    assert.deepEqual(result.failed, []);

    const dir = path.join(remoteRoot(install), 'calendars');
    const files = fs.readdirSync(dir);
    assert.equal(files.length, 1);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
    assert.equal(saved.id, 'cn', 'the holiday-cn format is normalised');
    assert.deepEqual(saved.years['2026'].holidays, ['2026-01-01']);
    assert.deepEqual(saved.years['2026'].workdays, ['2026-01-04']);
  } finally {
    fs.rmSync(install, { recursive: true, force: true });
  }
});

test('refreshRemote writes nothing and throws nothing on an HTML error page or 404', async () => {
  const install = tempInstall();
  try {
    const result = await refreshRemote(cfgFor(install), {
      fetchFn: fakeFetch({ 'https://example.test/2026.json': '<html>oops</html>' }),
      now: () => 0,
      years: [2026],
      providerIds: [],
    });
    assert.equal(result.updated.length, 0);
    assert.equal(result.failed.length, 1, 'a failed source must be reported');
    const dir = path.join(remoteRoot(install), 'calendars');
    const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    assert.equal(files.length, 0, 'nothing was written');
  } finally {
    fs.rmSync(install, { recursive: true, force: true });
  }
});

test('refreshRemote does nothing when remote fetching is off', async () => {
  const install = tempInstall();
  try {
    const cfg = { ...cfgFor(install), remote: false };
    const result = await refreshRemote(cfg, { fetchFn: fakeFetch({}), now: () => 0, years: [2026], providerIds: ['deepseek'] });
    assert.deepEqual(result.updated, []);
    assert.deepEqual(result.failed, []);
    assert.equal(fs.existsSync(remoteRoot(install)), false);
  } finally {
    fs.rmSync(install, { recursive: true, force: true });
  }
});

test('refreshRemote fetches providers and stores them as-is', async () => {
  const install = tempInstall();
  const provider = { id: 'deepseek', currency: 'CNY', models: { a: { input: 1, cacheWrite: 1, cacheRead: 0.1, output: 2 } } };
  try {
    const result = await refreshRemote(cfgFor(install), {
      fetchFn: fakeFetch({ 'https://example.test/deepseek.json': provider }),
      now: () => 42,
      years: [],
      providerIds: ['deepseek'],
    });
    assert.deepEqual(result.updated, ['provider:deepseek']);
    const saved = JSON.parse(fs.readFileSync(path.join(remoteRoot(install), 'providers', 'deepseek.json'), 'utf8'));
    assert.equal(saved.id, 'deepseek');
  } finally {
    fs.rmSync(install, { recursive: true, force: true });
  }
});
