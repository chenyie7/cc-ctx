// Rendering primitives: colour, visible width, wrapping, numbers, meters.
//
// The terminal is the medium, so everything here is built for it: labels are
// dim and values bright (that hierarchy is what makes a dense line scannable),
// groups are separated by a dim rule, and lines wrap on *visible* width so ANSI
// escapes never count against the terminal's column budget.

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const RESET = '\x1b[0m';

/** Strip SGR escape sequences. */
export function stripAnsi(text) {
  return String(text).replace(ANSI_RE, '');
}

/**
 * Display width in terminal cells. CJK and most emoji occupy two columns,
 * which matters because session names and paths routinely contain them.
 */
export function visibleWidth(text) {
  let width = 0;
  for (const ch of stripAnsi(text)) {
    const cp = ch.codePointAt(0);
    if (cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) continue; // ZWJ, variation selectors
    width += isWide(cp) ? 2 : 1;
  }
  return width;
}

function isWide(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

/** Convert a 24-bit SGR sequence to its nearest 256-colour equivalent. */
export function rgbTo256(code) {
  const m = /^38;2;(\d+);(\d+);(\d+)$/.exec(String(code));
  if (!m) return code;
  const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (r === g && g === b) {
    if (r < 8) return '38;5;16';
    if (r > 248) return '38;5;231';
    return `38;5;${Math.round(((r - 8) / 247) * 24) + 232}`;
  }
  const level = (v) => Math.round((v / 255) * 5);
  const cube = 16 + 36 * level(r) + 6 * level(g) + level(b);
  return `38;5;${cube}`;
}

function degrade(code, cfg) {
  if (!code) return null;
  if (cfg.truecolor) return code;
  return rgbTo256(code);
}

/** Wrap `text` in a colour from `cfg.colors`, honouring NO_COLOR. */
export function paint(text, colorName, cfg) {
  if (cfg.noColor || text === '' || text === undefined || text === null) {
    return String(text ?? '');
  }
  const code = degrade(cfg.colors[colorName] ?? colorName, cfg);
  if (!code) return String(text);
  return `\x1b[${code}m${text}${RESET}`;
}

/** thousand separators: 10710272 -> "10,710,272" */
export function comma(n) {
  const v = Math.round(Number(n) || 0);
  return v.toLocaleString('en-US');
}

/**
 * Compact token counts: 10710272 -> "10.7M". Used only where the width budget
 * is tight; the detailed report always shows the exact number.
 */
export function compact(n) {
  const v = Number(n) || 0;
  if (v < 1000) return String(Math.round(v));
  if (v < 1e6) return `${(v / 1e3).toFixed(v < 1e4 ? 2 : 1)}K`;
  return `${(v / 1e6).toFixed(v < 1e7 ? 2 : 1)}M`;
}

function barChars(cfg) {
  return {
    full: cfg.raw.CC_CTX_BAR_FULL || '█',
    empty: cfg.raw.CC_CTX_BAR_EMPTY_CHAR || '░',
  };
}

/** A meter that changes colour as it fills, so trouble is visible peripherally. */
export function meter(ratio, cfg) {
  const width = Math.max(1, cfg.barWidth);
  const clamped = Math.min(1, Math.max(0, Number(ratio) || 0));
  const filled = Math.round(clamped * width);
  const { full, empty } = barChars(cfg);
  const pct = clamped * 100;
  const colorName = pct >= cfg.contextHot ? 'hot' : pct >= cfg.contextWarn ? 'warn' : 'ok';
  return (
    paint(full.repeat(filled), colorName, cfg) +
    paint(empty.repeat(width - filled), 'barEmpty', cfg)
  );
}

/**
 * Truncate plain text to `width` cells.
 *  - 'end'    keep the head   ("/Users/chenyi/ai-pro…")
 *  - 'start'  keep the tail   ("…/ai-project/cc-ctx")   ← best for paths
 *  - 'middle' keep both ends
 */
export function truncate(text, width, mode = 'end') {
  const s = String(text);
  if (visibleWidth(s) <= width) return s;
  if (width <= 1) return '…';

  const budget = width - 1;
  const chars = [...s];
  const takeHead = (n) => {
    let out = '';
    let w = 0;
    for (const ch of chars) {
      const cw = isWide(ch.codePointAt(0)) ? 2 : 1;
      if (w + cw > n) break;
      out += ch;
      w += cw;
    }
    return out;
  };
  const takeTail = (n) => {
    let out = '';
    let w = 0;
    for (let i = chars.length - 1; i >= 0; i--) {
      const cw = isWide(chars[i].codePointAt(0)) ? 2 : 1;
      if (w + cw > n) break;
      out = chars[i] + out;
      w += cw;
    }
    return out;
  };

  if (mode === 'start') return '…' + takeTail(budget);
  if (mode === 'middle') {
    const head = Math.ceil(budget / 2);
    return takeHead(head) + '…' + takeTail(budget - head);
  }
  return takeHead(budget) + '…';
}

/**
 * Pack items into lines that fit `width` visible cells.
 *
 * Items in the same group are joined by `cfg.gap`; a group change inserts the
 * dim divider. A separator is never emitted at the start of a wrapped line, and
 * an item wider than the line is truncated rather than allowed to overflow.
 *
 * item: { group, text, plain?, truncate?, rerender? }
 *   text      painted string (what gets printed)
 *   plain     unpainted text, needed only if the item may be truncated
 *   rerender  (plainText) => painted string, pairs with `plain`
 */
export function wrapItems(items, width, cfg) {
  const gap = cfg.gap;
  const divider = paint(cfg.divider, 'divider', cfg);
  const lines = [];

  let current = '';
  let currentWidth = 0;
  let lastGroup = null;

  const fit = (item, available) => {
    if (visibleWidth(item.text) <= available) return item.text;
    // Composite items (a meter plus its numbers, say) cannot be truncated
    // mid-way without looking broken, so they may offer progressively shorter
    // renderings instead.
    for (const alt of item.alternates || []) {
      if (visibleWidth(alt) <= available) return alt;
    }
    // `plain` covers only the truncatable part, so whatever the item paints
    // around it (a label, say) has to be subtracted from the budget first —
    // otherwise the fitted text overshoots by exactly that much.
    const prefix = item.prefixWidth || 0;
    if (!item.plain || !item.rerender || available <= prefix) return item.text;
    const plain = truncate(item.plain, available - prefix, item.truncate || 'end');
    return item.rerender(plain);
  };

  for (const item of items) {
    if (item.text === '' || item.text === undefined || item.text === null) continue;

    if (current === '') {
      const text = fit(item, width);
      current = text;
      currentWidth = visibleWidth(text);
      lastGroup = item.group;
      continue;
    }

    const sep = item.group === lastGroup ? gap : divider;
    const sepWidth = visibleWidth(sep);
    const itemWidth = visibleWidth(item.text);

    if (currentWidth + sepWidth + itemWidth > width) {
      lines.push(current);
      const text = fit(item, width);
      current = text;
      currentWidth = visibleWidth(text);
      lastGroup = item.group;
      continue;
    }

    current += sep + item.text;
    currentWidth += sepWidth + itemWidth;
    lastGroup = item.group;
  }

  if (current !== '') lines.push(current);
  return lines;
}

function separatorBetween(previous, item, cfg) {
  if (!previous) return '';
  return previous.group === item.group ? cfg.gap : paint(cfg.divider, 'divider', cfg);
}

/** Render items[start..end] as one line, keeping their order and colours. */
function joinItems(items, start, end, cfg) {
  let out = '';
  for (let i = start; i <= end; i++) {
    out += separatorBetween(i === start ? null : items[i - 1], items[i], cfg) + items[i].text;
  }
  return out;
}

/**
 * Wrap into the minimum number of lines, then divide the items among those
 * lines as evenly as possible.
 *
 * A greedy pass gives the fewest lines; the split itself is then chosen by
 * dynamic programming over the classic linear-partition problem, minimising the
 * sum of squared line widths. Order is preserved, so fields never jump around.
 *
 * Minimising the *widest* line instead is cheaper and looks worse: it leaves one
 * line conspicuously short whenever a wide item happens to start a line.
 */
export function wrapItemsBalanced(items, width, cfg) {
  const live = items.filter((i) => i && i.text !== '' && i.text != null);
  if (live.length === 0) return [];

  const lineCount = wrapItems(live, width, cfg).length;
  if (lineCount <= 1) return wrapItems(live, width, cfg);

  const n = live.length;
  const segment = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    segment[i][i] = visibleWidth(live[i].text);
    for (let j = i + 1; j < n; j++) {
      segment[i][j] =
        segment[i][j - 1] +
        visibleWidth(separatorBetween(live[j - 1], live[j], cfg)) +
        visibleWidth(live[j].text);
    }
  }

  const INF = Number.POSITIVE_INFINITY;
  // best[m][j] = least sum of squared widths when the first j items use m lines.
  const best = Array.from({ length: lineCount + 1 }, () => new Array(n + 1).fill(INF));
  const from = Array.from({ length: lineCount + 1 }, () => new Array(n + 1).fill(-1));
  best[0][0] = 0;

  for (let m = 1; m <= lineCount; m++) {
    for (let j = 1; j <= n; j++) {
      for (let i = m - 1; i < j; i++) {
        if (best[m - 1][i] === INF) continue;
        const w = segment[i][j - 1];
        if (w > width) continue;
        const cost = best[m - 1][i] + w * w;
        if (cost < best[m][j]) {
          best[m][j] = cost;
          from[m][j] = i;
        }
      }
    }
  }

  // No valid split at that line count (an item wider than the line, say):
  // greedy still produces something, so fall back rather than fail.
  if (best[lineCount][n] === INF) return wrapItems(live, width, cfg);

  const out = [];
  let j = n;
  for (let m = lineCount; m >= 1; m--) {
    const i = from[m][j];
    out.unshift(joinItems(live, i, j - 1, cfg));
    j = i;
  }
  return out;
}

/** Prefix every line with the configured left padding. */
export function applyPadding(lines, cfg) {
  const pad = ' '.repeat(Math.max(0, cfg.padding));
  return pad ? lines.map((l) => pad + l) : lines;
}

/** Build one `label value` item: dim label, coloured value. */
export function labelledItem({ group, label, value, color = 'value', cfg, ...rest }) {
  const text =
    label === null || label === undefined || label === ''
      ? paint(value, color, cfg)
      : paint(label + cfg.labelSuffix, 'label', cfg) + paint(value, color, cfg);
  return { group, text, ...rest };
}
