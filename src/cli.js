// Subcommand dispatch.
//
// `statusline` is on the hot path and must never fail visibly: Claude Code
// renders whatever we print, so an exception that reaches the top level would
// blank the status line. Everything is caught, and a previously rendered line
// is preferred over an empty one.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { loadConfig, resolvePrices } from './config.js';
import { openCache } from './cache.js';
import { computeTotalsCached, computeTotals, EMPTY_TOTALS } from './usage.js';
import { resolveBalance, refreshBalance } from './balance.js';
import { renderStatusline } from './statusline.js';
import { renderReport } from './report.js';
import { runSetup } from './setup.js';

// A status line is written to a pipe that the parent may close at any moment —
// a terminal resize or a restarted status line is enough. Without this, Node
// raises an unhandled 'error' event and dumps a stack trace into the very row
// the status line occupies.
process.stdout.on('error', (error) => {
  if (error && error.code === 'EPIPE') process.exit(0);
  throw error;
});

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
  const prices = resolvePrices(cfg.raw, modelId);

  let totals = { ...EMPTY_TOTALS };
  try {
    const result = computeTotalsCached(
      input?.transcript_path,
      cache,
      `usage:${input?.session_id || 'x'}`,
      { schedule: cfg.schedule },
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

  const rendered = renderStatusline(input, cfg, { totals, prices, balanceInfo });

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

  const { totals } = transcriptPath
    ? computeTotals(transcriptPath, { schedule: cfg.schedule })
    : { totals: EMPTY_TOTALS };

  // Prefer the payload's model. Fall back to the model the transcript was
  // actually written with, so the report works in a plain terminal even when
  // the status line has never run for this session.
  const modelId =
    payload?.model?.id || payload?.model?.display_name || totals.model || '';
  const prices = resolvePrices(cfg.raw, modelId);
  const balanceInfo = await resolveBalance(cfg);

  return renderReport({ payload, totals, prices, balanceInfo, cfg, transcriptPath, cwd });
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

options
  --transcript <path>  report on a specific transcript
  --session <id>       report on a specific session id
  --reset-config       setup: regenerate cc-ctx.env from the shipped defaults
                       (the existing file is backed up first)
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
