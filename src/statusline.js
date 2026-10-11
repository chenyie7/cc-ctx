// Build the status line from the payload Claude Code pipes to us.

import {
  comma,
  labelledItem,
  meter,
  paint,
  truncate,
  visibleWidth,
  wrapItems,
  wrapItemsBalanced,
  applyPadding,
} from './render.js';
import { costOf, hitRate, totalInputTokens } from './usage.js';
import { formatBalance } from './balance.js';
import { tierAt, nextTransition } from './pricing/schedule.js';

export function formatDuration(ms) {
  const totalMinutes = Math.floor((Number(ms) || 0) / 60000);
  if (totalMinutes < 1) return '<1m';
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes ? `${hours}h${String(minutes).padStart(2, '0')}m` : `${hours}h`;
}

function ratioColor(pct, cfg) {
  if (pct === null) return 'label';
  if (pct >= cfg.contextHot) return 'hot';
  if (pct >= cfg.contextWarn) return 'warn';
  return 'ok';
}

/**
 * Fields that expand into several items, in the order they should appear.
 * `cachewrite` is deliberately not among them: DeepSeek reports
 * cache_creation_input_tokens as 0 on every call, so it would always render a
 * meaningless "cache write 0". It is still a valid field id on its own, so a
 * provider that does report cache writes can list `cachewrite` directly.
 */
const EXPANSIONS = {
  tokens: ['input', 'cacheread', 'output'],
};

function contextItem(input, cfg) {
  const cw = input?.context_window ?? {};
  const pct = typeof cw.used_percentage === 'number' ? cw.used_percentage : null;
  const size = cw.context_window_size;
  // `total_input_tokens` is documented as the tokens currently in the context
  // window and already sums the three input buckets; fall back to the
  // per-component breakdown when it is absent.
  const used =
    cw.total_input_tokens ??
    totalInputTokens({
      input: cw.current_usage?.input_tokens ?? 0,
      cacheWrite: cw.current_usage?.cache_creation_input_tokens ?? 0,
      cacheRead: cw.current_usage?.cache_read_input_tokens ?? 0,
    });

  const parts = [paint('context', 'label', cfg)];
  if (pct !== null) {
    parts.push(meter(pct / 100, cfg));
    parts.push(paint(`${pct.toFixed(0)}%`, ratioColor(pct, cfg), cfg));
  }
  const withoutTotals = parts.join(' ');
  if (size) {
    parts.push(paint(`${comma(used)} / ${comma(size)}`, 'label', cfg));
  }
  const full = parts.join(' ');
  return {
    group: 'context',
    text: full,
    // Dropping the used/total pair keeps the meter and the percentage, which is
    // what actually matters when the terminal is too narrow for both.
    alternates: size ? [withoutTotals] : [],
  };
}

function buildItem(id, ctx) {
  const { input, cfg, env, totals, pricing, balanceInfo } = ctx;
  const cw = input?.context_window ?? {};
  const cost = input?.cost ?? {};
  const cache = input?.prompt_cache ?? {};

  switch (id) {
    case 'brand':
      return { group: 'identity', text: paint(cfg.raw.CC_CTX_BRAND || 'cc-ctx', 'brand', cfg) };

    case 'model': {
      const name = input?.model?.display_name || input?.model?.id || 'unknown';
      return { group: 'identity', text: paint(name, 'model', cfg) };
    }

    case 'effort': {
      const level = input?.effort?.level || env.CLAUDE_EFFORT || null;
      if (!level) return null;
      const thinking = input?.thinking?.enabled === false ? ' (thinking off)' : '';
      return labelledItem({
        group: 'identity',
        label: 'effort',
        value: level + thinking,
        color: 'effort',
        cfg,
      });
    }

    case 'cache': {
      if (cache.caching_observed === false) {
        return labelledItem({ group: 'identity', label: 'cache', value: 'off', color: 'label', cfg });
      }
      if (cache.warm === undefined) return null;
      return labelledItem({
        group: 'identity',
        label: 'cache',
        value: cache.warm ? 'warm' : 'cold',
        color: cache.warm ? 'ok' : 'warn',
        cfg,
      });
    }

    case 'dir': {
      const dir = input?.workspace?.current_dir || input?.cwd;
      if (!dir) return null;
      const label = 'dir ';
      return {
        group: 'place',
        plain: dir,
        prefixWidth: visibleWidth(label),
        truncate: 'start', // keep the tail: the last path segment identifies the project
        rerender: (t) => paint(label, 'label', cfg) + paint(t, 'dir', cfg),
        text: paint(label, 'label', cfg) + paint(dir, 'dir', cfg),
      };
    }

    case 'session': {
      const name = input?.session_name;
      if (!name) return null;
      return labelledItem({ group: 'place', label: 'session', value: name, color: 'value', cfg });
    }

    case 'duration': {
      if (!cost.total_duration_ms) return null;
      return labelledItem({
        group: 'place',
        label: 'duration',
        value: formatDuration(cost.total_duration_ms),
        color: 'value',
        cfg,
      });
    }

    case 'lines': {
      const added = cost.total_lines_added || 0;
      const removed = cost.total_lines_removed || 0;
      if (!added && !removed) return null;
      return labelledItem({
        group: 'place',
        label: 'lines',
        value: `+${comma(added)}/-${comma(removed)}`,
        color: 'value',
        cfg,
      });
    }

    case 'context':
      return contextItem(input, cfg);

    case 'tokens':
      return null; // placeholder; expanded by the caller

    case 'input':
      return labelledItem({
        group: 'tokens', label: 'input', value: comma(totals.input), color: 'value', cfg,
      });

    case 'cachewrite':
      return labelledItem({
        group: 'tokens', label: 'cache write', value: comma(totals.cacheWrite), color: 'value', cfg,
      });

    case 'cacheread':
      return labelledItem({
        group: 'tokens', label: 'cache read', value: comma(totals.cacheRead), color: 'ok', cfg,
      });

    case 'output':
      return labelledItem({
        group: 'tokens', label: 'output', value: comma(totals.output), color: 'value', cfg,
      });

    case 'hitrate': {
      const rate = hitRate(totals);
      if (rate === null) return null;
      const pct = rate * 100;
      const color = pct >= 80 ? 'ok' : pct >= 50 ? 'warn' : 'hot';
      return labelledItem({
        group: 'stats', label: 'hit rate', value: `${pct.toFixed(1)}%`, color, cfg,
      });
    }

    case 'calls': {
      if (!totals.calls) return null;
      return labelledItem({
        group: 'stats', label: 'calls', value: comma(totals.calls), color: 'value', cfg,
      });
    }

    case 'cost': {
      const amount = costOf(totals, pricing);
      const value = amount === null ? '—' : formatMoney(amount, pricing, cfg);
      return labelledItem({
        group: 'stats', label: 'cost', value, color: amount === null ? 'label' : 'value', cfg,
      });
    }

    case 'tier': {
      const schedule = pricing?.schedule;
      if (!schedule) return null;
      const now = new Date();
      const tier = tierAt(now, schedule);
      const label = tier === 'peak' ? 'peak' : 'off-peak';
      const next = nextTransition(now, schedule);

      let value = label;
      // Peak is the expensive side, so it gets warn; off-peak gets ok.
      let color = tier === 'peak' ? 'warn' : 'ok';
      if (next) {
        const minutes = Math.max(0, Math.round((next.at - now) / 60000));
        if (minutes <= cfg.tierAlertMinutes) {
          const nextLabel = next.tier === 'peak' ? 'peak' : 'off-peak';
          value = `${label} · ${formatDuration(minutes * 60000)}→${nextLabel}`;
          // About to get more expensive is the moment most worth noticing.
          color = next.tier === 'peak' ? 'hot' : 'ok';
        }
      }
      return labelledItem({ group: 'stats', label: 'tier', value, color, cfg });
    }

    case 'balance': {
      const text = formatBalance(balanceInfo?.balance, cfg, { stale: balanceInfo?.stale });
      if (text === null) return null;
      return labelledItem({ group: 'stats', label: 'balance', value: text, color: 'ok', cfg });
    }

    default:
      return null;
  }
}

/** Convert a cost in the price table's currency into the display currency. */
export function formatMoney(amount, pricing, cfg) {
  const from = pricing?.currency || 'USD';
  const converted = from === cfg.currency ? amount : amount * cfg.rate;
  return `${cfg.symbol}${converted.toFixed(2)}`;
}

export function renderStatusline(input, cfg, { totals, pricing, balanceInfo, env = process.env } = {}) {
  const ctx = { input, cfg, env, totals, pricing, balanceInfo };
  const items = [];

  for (const field of cfg.fields) {
    const expanded = EXPANSIONS[field];
    if (expanded) {
      for (const id of expanded) {
        const item = buildItem(id, ctx);
        if (item) items.push(item);
      }
      continue;
    }
    const item = buildItem(field, ctx);
    if (item) items.push(item);
  }

  // Padding is added after wrapping, so it has to come out of the budget —
  // otherwise every line renders `padding` cells too wide.
  const columns = Number(env.COLUMNS) || 100;
  const width = Math.max(20, columns - Math.max(0, cfg.padding));
  const layout = cfg.wrap === 'greedy' ? wrapItems : wrapItemsBalanced;
  return applyPadding(layout(items, width, cfg), cfg).join('\n');
}

export { visibleWidth, truncate };
