// The `cc-ctx` detail report.
//
// Invoked from a terminal rather than by Claude Code, so there is no status line
// payload on stdin. The richest available snapshot is the one the status line
// last received, which it stores in the cache; when that is unavailable we fall
// back to what the transcript alone can tell us.

import { comma, paint, meter, visibleWidth, stripAnsi } from './render.js';
import { costOf, hitRate, totalInputTokens } from './usage.js';
import { formatBalance } from './balance.js';
import { tierAt, nextTransition } from './pricing/schedule.js';

function rule(width, cfg) {
  return paint('─'.repeat(Math.max(10, width)), 'divider', cfg);
}

/** Aligned `label   value` row; padding is computed from the plain label. */
function row(label, value, cfg, { color = 'value', width = 13 } = {}) {
  const pad = ' '.repeat(Math.max(1, width - visibleWidth(label)));
  return paint(label, 'label', cfg) + pad + paint(value, color, cfg);
}

/**
 * Decimals that keep the shown figures reconcilable: a converted amount must
 * visibly equal the source amount times the rate beside it. Session costs are
 * routinely fractions of a cent, so two decimals is not enough.
 */
function decimalsFor(amount) {
  const v = Math.abs(Number(amount) || 0);
  if (v < 0.01) return 6;
  if (v < 1) return 4;
  return 2;
}

function toDisplayMoney(amount, pricing, cfg) {
  if (amount === null) return null;
  const from = pricing?.currency || 'USD';
  const converted = from === cfg.currency ? amount : amount * cfg.rate;
  return { amount, converted, from, symbol: cfg.symbol, currency: cfg.currency };
}

/** `.../projects/<proj>/<session-id>.jsonl` -> `<session-id>` */
function sessionFromPath(transcriptPath) {
  if (!transcriptPath) return null;
  const base = transcriptPath.split('/').pop() || '';
  return base.replace(/\.jsonl$/, '') || null;
}

/** The wall-clock time HH:MM at `instant` in `tz`. */
function formatClock(instant, tz) {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(instant);
  } catch {
    return instant.toISOString().slice(11, 16);
  }
}

export function renderReport({ payload, totals, pricing, balanceInfo, cfg, transcriptPath, cwd }) {
  const lines = [];
  const cols = Number(process.stdout.columns) || 80;
  const innerWidth = Math.min(cols - 2, 72);

  lines.push(paint('cc-ctx', 'brand', cfg) + paint(' · session report', 'label', cfg));
  lines.push(rule(innerWidth, cfg));

  // Every field below falls back to something the transcript alone provides, so
  // the report is useful in a plain terminal even if the status line has never
  // run for this session.
  const model = payload?.model?.display_name || payload?.model?.id || totals.model;
  if (model) lines.push(row('model', model, cfg, { color: 'model' }));

  const effort = payload?.effort?.level;
  if (effort) {
    const thinking = payload?.thinking?.enabled === false ? ' · thinking off' : '';
    lines.push(row('effort', effort + thinking, cfg, { color: 'effort' }));
  }

  const dir = payload?.workspace?.current_dir || payload?.cwd || cwd;
  if (dir) lines.push(row('dir', dir, cfg, { color: 'dir', width: 13 }));

  const session =
    payload?.session_name || payload?.session_id || sessionFromPath(transcriptPath);
  if (session) lines.push(row('session', session, cfg));

  // Context window
  const cw = payload?.context_window;
  if (cw && typeof cw.used_percentage === 'number') {
    const used =
      cw.total_input_tokens ??
      totalInputTokens({
        input: cw.current_usage?.input_tokens ?? 0,
        cacheWrite: cw.current_usage?.cache_creation_input_tokens ?? 0,
        cacheRead: cw.current_usage?.cache_read_input_tokens ?? 0,
      });
    const pct = cw.used_percentage;
    const color = pct >= cfg.contextHot ? 'hot' : pct >= cfg.contextWarn ? 'warn' : 'ok';
    const meterText = meter(pct / 100, cfg);
    const sizeText = cw.context_window_size
      ? paint(`  ${comma(used)} / ${comma(cw.context_window_size)}`, 'label', cfg)
      : '';
    lines.push(row('context', '', cfg).trimEnd() + ' ' + meterText +
      ' ' + paint(`${pct.toFixed(0)}%`, color, cfg) + sizeText);
  }

  lines.push(rule(innerWidth, cfg));
  lines.push(row('input', comma(totals.input), cfg));
  // DeepSeek never reports cache writes, so a permanent "0" row is noise.
  if (totals.cacheWrite) lines.push(row('cache write', comma(totals.cacheWrite), cfg));
  lines.push(row('cache read', comma(totals.cacheRead), cfg, { color: 'ok' }));
  lines.push(row('output', comma(totals.output), cfg));
  if (totals.thinking) lines.push(row('thinking', comma(totals.thinking), cfg));

  const rate = hitRate(totals);
  if (rate !== null) {
    const pct = rate * 100;
    const color = pct >= 80 ? 'ok' : pct >= 50 ? 'warn' : 'hot';
    lines.push(row('hit rate', `${pct.toFixed(2)}%`, cfg, { color }));
  }
  if (totals.calls) lines.push(row('api calls', comma(totals.calls), cfg));

  lines.push(rule(innerWidth, cfg));

  const amount = costOf(totals, pricing);
  const money = toDisplayMoney(amount, pricing, cfg);
  if (money) {
    const digits = decimalsFor(money.converted);
    const value =
      `${money.symbol}${money.converted.toFixed(digits)}` +
      (money.from !== money.currency
        ? `   (${pricing.currency} ${money.amount.toFixed(decimalsFor(money.amount))} × ${cfg.rate})`
        : '');
    lines.push(row('session cost', value, cfg));
  } else {
    lines.push(row('session cost', '—  no price table for this model', cfg, { color: 'warn' }));
    lines.push(
      ' '.repeat(13) +
        paint('add this model to ~/.claude/cc-ctx/providers/', 'label', cfg),
    );
  }

  // Prices and windows: make visible which price table, which calendar, and
  // which tier is in effect.
  if (pricing?.schedule) {
    const now = new Date();
    const tier = tierAt(now, pricing.schedule) === 'peak' ? 'peak' : 'off-peak';
    const next = nextTransition(now, pricing.schedule);
    const nextText = next
      ? `→ ${next.tier === 'peak' ? 'peak' : 'off-peak'} @ ${formatClock(next.at, pricing.schedule.tz)}`
      : '→ no switch within 32 days';
    const source = pricing.schedule.calendar?.source;
    const provenance = source
      ? `${source.kind}${source.file ? ` ${source.file}` : ''}`
      : 'no calendar';
    lines.push(row('tier', `${tier} ${nextText}`, cfg, { color: tier === 'peak' ? 'warn' : 'ok' }));
    lines.push(
      row('pricing', `${pricing.providerId} · ${pricing.currency} · ${provenance}`, cfg, { color: 'label' }),
    );
  }

  const balanceText = formatBalance(balanceInfo?.balance, cfg, { stale: balanceInfo?.stale });
  if (balanceText) {
    const b = balanceInfo.balance;
    const detail =
      `   granted ${b.granted.toFixed(2)} · topped up ${b.toppedUp.toFixed(2)}` +
      (balanceInfo.stale ? ' · stale' : '');
    lines.push(row('balance', balanceText, cfg, { color: 'ok' }) + paint(detail, 'label', cfg));
  } else {
    lines.push(row('balance', '—  unavailable', cfg, { color: 'label' }));
  }

  if (transcriptPath) {
    lines.push('');
    lines.push(paint('  transcript  ', 'label', cfg) + paint(transcriptPath, 'label', cfg));
  }

  return lines.join('\n');
}

export { stripAnsi };
