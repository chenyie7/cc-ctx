// Subcommand dispatch.
//
// `statusline` is on the hot path and must never fail visibly: Claude Code
// renders whatever we print, so an exception that reaches the top level would
// blank the status line. Everything is caught, and a previously rendered line
// is preferred over an empty one.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { loadConfig } from './config.js';
import { resolvePricing } from './pricing/index.js';
import { refreshRemote, remoteDirsFor, readMeta, isStale } from './pricing/remote.js';
import { openCache } from './cache.js';
import { computeTotalsCached, computeTotals, EMPTY_TOTALS } from './usage.js';
import { resolveBalance, refreshBalance } from './balance.js';
import { renderStatusline } from './statusline.js';
import { renderReport } from './report.js';
import { runSetup } from './setup.js';

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/** `~/.claude/projects/<cwd with slashes as dashes>/` */
export function projectDirFor(cwd) {
  const escaped = cwd.replace(/\//g, '-');
  return path.join(os.homedir(), '.claude', 'projects', escaped);
}

/** Newest transcript for a project — the session most likely to be "current". */
export function newestTranscript(cwd) {
  const dir = projectDirFor(cwd);
  try {
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => path.join(dir, f));
    if (!files.length) return null;
    return files
      .map((f) => ({ f, mtime: fs.statSync(f).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)[0].f;
  } catch {
    return null;
  }
}

async function commandStatusline(cfg) {
  const raw = readStdin();
  let input = null;
  try {
    input = JSON.parse(raw);
  } catch {
    /* handled below */
  }

  const cache = openCache();
  const cacheKey = input?.session_id ? `payload:${input.session_id}` : 'payload:last';

  // Remember the payload so `cc-ctx` can show the same rich fields from a plain
  // terminal, where there is no stdin payload to read. Written only on change.
  if (input && cache.get(cacheKey)?.raw !== raw) {
    cache.set(cacheKey, { raw, at: Date.now() });
    cache.set('lastPayloadKey', cacheKey);
  }
  cache.save();

  if (!input) {
    const last = cache.get(cache.get('lastPayloadKey') || 'payload:last');
    if (last?.rendered) return last.rendered;
    return 'cc-ctx';
  }

  const modelId = input?.model?.id || input?.model?.display_name || '';
  const pricing = resolvePricing(cfg, modelId);
  maybeRefreshRemote(cfg);

  let totals = { ...EMPTY_TOTALS };
  try {
    const result = computeTotalsCached(
      input?.transcript_path,
      cache,
      `usage:${input?.session_id || 'x'}`,
      { schedule: pricing?.schedule ?? null },
    );
    totals = result.totals;
    cache.save();
  } catch {
    /* cost and token detail are optional; the rest still renders */
  }

  let balanceInfo = { balance: null, stale: false };
  try {
    balanceInfo = await resolveBalance(cfg);
  } catch {
    /* ditto */
  }

  const rendered = renderStatusline(input, cfg, { totals, pricing, balanceInfo });

  const stored = cache.get(cacheKey);
  if (stored) {
    cache.set(cacheKey, { ...stored, rendered });
    cache.save();
  }
  return rendered;
}

async function commandReport(cfg, args) {
  const cwd = process.cwd();
  const transcriptPath =
    args.transcript ||
    (args.session
      ? path.join(projectDirFor(cwd), `${args.session}.jsonl`)
      : newestTranscript(cwd));

  const cache = openCache();
  let payload = null;
  const lastKey = cache.get('lastPayloadKey');
  if (lastKey) {
    try {
      payload = JSON.parse(cache.get(lastKey)?.raw || 'null');
    } catch {
      payload = null;
    }
  }
  // A payload from another session would be misleading; drop it.
  if (payload && transcriptPath && payload.transcript_path !== transcriptPath) {
    payload = null;
  }

  // The peak/off-peak split needs the provider's schedule, and the schedule is
  // chosen by the model. The payload names the model in the common case; with no
  // payload the model is only known after reading the transcript, so read it
  // once without a schedule and re-split if a schedule turns up.
  let modelId = payload?.model?.id || payload?.model?.display_name || '';
  let pricing = resolvePricing(cfg, modelId);

  let totals = EMPTY_TOTALS;
  if (transcriptPath) {
    totals = computeTotals(transcriptPath, { schedule: pricing?.schedule ?? null }).totals;
    if (!modelId && totals.model) {
      modelId = totals.model;
      pricing = resolvePricing(cfg, modelId);
      if (pricing?.schedule) {
        totals = computeTotals(transcriptPath, { schedule: pricing.schedule }).totals;
      }
    }
  }

  const balanceInfo = await resolveBalance(cfg);

  return renderReport({ payload, totals, pricing, balanceInfo, cfg, transcriptPath, cwd });
}

/**
 * Refresh in the background when the cached data is stale; this render never
 * waits for it. The bundled snapshot is always present, so there is no "wait on a
 * cold start" question to weigh — never wait.
 */
function maybeRefreshRemote(cfg) {
  try {
    if (!cfg.remote) return;
    const dirs = remoteDirsFor(cfg);
    const meta = readMeta(dirs.metaFile);
    if (!isStale(meta.calendars, cfg.remoteTtlMs, Date.now())) return;
    const child = spawn(process.execPath, [process.argv[1], 'remote-refresh'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch {
    /* the background refresh is a nice-to-have; a failure must not affect the status line */
  }
}

async function commandRemoteRefresh(cfg) {
  if (!cfg.remote) return '';
  const { updated, failed } = await refreshRemote(cfg, { log: (m) => process.stderr.write(m + '\n') });
  if (process.env.CC_CTX_DEBUG) {
    process.stderr.write(`remote-refresh updated=[${updated}] failed=[${failed}]\n`);
  }
  return '';
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--transcript') args.transcript = argv[++i];
    else if (a === '--session') args.session = argv[++i];
    else if (a.startsWith('--')) args[a.slice(2)] = true;
    else args._.push(a);
  }
  return args;
}

const USAGE = `cc-ctx — Claude Code session context, tokens, cost and balance

  cc-ctx              show the session report for this directory
  cc-ctx setup        install the status line (run once, per machine)
  cc-ctx statusline   render one status line (called by Claude Code)
  cc-ctx remote-refresh   refresh the cached price and holiday data

options
  --transcript <path>  report on a specific transcript
  --session <id>       report on a specific session id
  --reset-config       setup: regenerate cc-ctx.env from the shipped defaults
                       (the existing file is backed up first)

prices and holidays now live in JSON, not in cc-ctx.env:
  <plugin>/conf/providers/*.json         shipped defaults
  ~/.claude/cc-ctx/providers/*.json      your overrides (win over everything)
  ~/.claude/cc-ctx/calendars/*.json      holiday calendars
Old CC_CTX_PRICE_* keys are no longer read.
`;

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const command = args._[0] || 'report';
  const cfg = loadConfig();

  switch (command) {
    case 'statusline':
      return commandStatusline(cfg);
    case 'report':
      return commandReport(cfg, args);
    case 'remote-refresh':
      return commandRemoteRefresh(cfg);
    case 'balance-refresh':
      await refreshBalance(cfg);
      return '';
    case 'setup':
      return runSetup({ resetConfig: args['reset-config'] === true });
    case 'help':
    case '--help':
    case '-h':
      return USAGE;
    default:
      return `cc-ctx: unknown command "${command}"\n\n${USAGE}`;
  }
}

// Run the CLI only when this file is executed directly, never when it is
// imported (e.g. by the tests). `process.argv[1]` is the script path for a
// direct run, and it is exactly what `balance-refresh` / `remote-refresh`
// spawn, so the guard passes for those children too.
const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  // A status line is written to a pipe that the parent may close at any moment —
  // a terminal resize or a restarted status line is enough. Without this, Node
  // raises an unhandled 'error' event and dumps a stack trace into the very row
  // the status line occupies.
  process.stdout.on('error', (error) => {
    if (error && error.code === 'EPIPE') process.exit(0);
    throw error;
  });

  main()
    .then((output) => {
      if (output) process.stdout.write(output);
    })
    .catch((error) => {
      // The status line must degrade, not disappear.
      try {
        process.stdout.write('cc-ctx ⚠');
      } catch {
        /* nothing else we can do */
      }
      if (process.env.CC_CTX_DEBUG) {
        process.stderr.write(`${error?.stack || error}\n`);
      }
      process.exitCode = 0;
    });
}

export { parseArgs, USAGE };
