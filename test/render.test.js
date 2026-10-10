import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  stripAnsi,
  visibleWidth,
  rgbTo256,
  paint,
  comma,
  compact,
  meter,
  truncate,
  wrapItems,
  wrapItemsBalanced,
  applyPadding,
  labelledItem,
} from '../src/render.js';
import { DEFAULT_COLORS } from '../src/config.js';

/** A minimal colour-capable config; tests override individual knobs. */
function cfg(overrides = {}) {
  return {
    colors: { ...DEFAULT_COLORS },
    truecolor: true,
    noColor: false,
    gap: '  ',
    divider: ' │ ',
    padding: 1,
    labelSuffix: ' ',
    barWidth: 10,
    contextWarn: 60,
    contextHot: 85,
    raw: {},
    ...overrides,
  };
}

test('stripAnsi removes SGR sequences', () => {
  assert.equal(stripAnsi('\x1b[38;2;1;2;3mhi\x1b[0m'), 'hi');
});

test('visibleWidth ignores escapes and counts wide characters as two', () => {
  assert.equal(visibleWidth('abc'), 3);
  assert.equal(visibleWidth(paint('abc', 'model', cfg())), 3, 'colour must not add width');
  assert.equal(visibleWidth('中文'), 4);
  assert.equal(visibleWidth('a中b'), 4);
  assert.equal(visibleWidth(''), 0);
});

test('rgbTo256 degrades truecolour to a 256-colour index', () => {
  assert.equal(rgbTo256('38;2;0;0;0'), '38;5;16');
  assert.equal(rgbTo256('38;2;255;255;255'), '38;5;231');
  assert.match(rgbTo256('38;2;56;189;248'), /^38;5;\d+$/);
  assert.equal(rgbTo256('38;5;42'), '38;5;42', 'non-truecolour passes through');
});

test('paint emits truecolour when enabled and 256-colour when not', () => {
  assert.equal(paint('x', 'model', cfg()), '\x1b[38;2;198;160;246mx\x1b[0m');
  assert.match(paint('x', 'model', cfg({ truecolor: false })), /^\x1b\[38;5;\d+mx\x1b\[0m$/);
});

test('paint honours NO_COLOR and leaves empty text alone', () => {
  assert.equal(paint('x', 'model', cfg({ noColor: true })), 'x');
  assert.equal(paint('', 'model', cfg()), '');
});

test('comma groups thousands and compact shortens for tight budgets', () => {
  assert.equal(comma(10710272), '10,710,272');
  assert.equal(comma(0), '0');
  assert.equal(comma(999), '999');
  assert.equal(compact(999), '999');
  assert.equal(compact(1500), '1.50K');
  assert.equal(compact(10710272), '10.7M');
});

test('meter fills proportionally and shifts colour as it fills', () => {
  const c = cfg();
  assert.equal(stripAnsi(meter(0, c)), '░'.repeat(10));
  assert.equal(stripAnsi(meter(1, c)), '█'.repeat(10));
  assert.equal(stripAnsi(meter(0.5, c)), '█'.repeat(5) + '░'.repeat(5));
  assert.equal(stripAnsi(meter(2, c)), '█'.repeat(10), 'over-full clamps');

  // Colour must change at the configured thresholds.
  assert.ok(meter(0.3, c).includes(DEFAULT_COLORS.ok));
  assert.ok(meter(0.7, c).includes(DEFAULT_COLORS.warn));
  assert.ok(meter(0.95, c).includes(DEFAULT_COLORS.hot));
});

test('truncate keeps the tail for paths and the head otherwise', () => {
  assert.equal(truncate('/a/very/long/path', 10, 'start'), '…long/path');
  assert.equal(truncate('/a/very/long/path', 10, 'end'), '/a/very/l…');
  assert.equal(truncate('short', 10), 'short', 'no truncation when it fits');
  assert.ok(visibleWidth(truncate('中文路径很长很长', 5, 'start')) <= 5);
});

test('wrapItems breaks on width and drops the separator at a line start', () => {
  const c = cfg();
  const items = [
    { group: 'a', text: 'aaaa' },
    { group: 'a', text: 'bbbb' },
    { group: 'b', text: 'cccc' },
  ];
  const lines = wrapItems(items, 100, c);
  assert.equal(lines.length, 1);
  assert.equal(stripAnsi(lines[0]), 'aaaa  bbbb │ cccc');

  const narrow = wrapItems(items, 10, c);
  assert.ok(narrow.length > 1, 'must wrap when it does not fit');
  for (const line of narrow) {
    assert.ok(visibleWidth(line) <= 10, `line exceeds width: ${JSON.stringify(stripAnsi(line))}`);
  }
  for (const line of narrow) {
    assert.ok(!stripAnsi(line).startsWith('│'), 'a wrapped line must not start with a divider');
  }
});

test('wrapItems truncates an item that cannot fit even alone', () => {
  const c = cfg();
  const item = {
    group: 'a',
    plain: '/Users/chenyi/ai-project/a-very-long-directory-name',
    truncate: 'start',
    rerender: (t) => paint(t, 'dir', c),
    text: paint('/Users/chenyi/ai-project/a-very-long-directory-name', 'dir', c),
  };
  const [line] = wrapItems([item], 20, c);
  assert.ok(visibleWidth(line) <= 20);
  assert.ok(stripAnsi(line).startsWith('…'), 'a path should keep its tail');
});

test('balanced wrapping keeps the line count and evens the lines out', () => {
  const c = cfg();
  const items = [
    { group: 'a', text: 'a'.repeat(30) },
    { group: 'a', text: 'b'.repeat(30) },
    { group: 'b', text: 'c'.repeat(30) },
    { group: 'c', text: 'd'.repeat(30) },
    { group: 'c', text: 'e'.repeat(30) },
  ];
  const greedy = wrapItems(items, 100, c);
  const balanced = wrapItemsBalanced(items, 100, c);

  assert.equal(balanced.length, greedy.length, 'balancing must not add lines');
  const widest = (ls) => Math.max(...ls.map(visibleWidth));
  assert.ok(
    widest(balanced) <= widest(greedy),
    `balanced (${widest(balanced)}) should not be wider than greedy (${widest(greedy)})`,
  );
  for (const line of balanced) assert.ok(visibleWidth(line) <= 100);
});

test('balanced wrapping makes the lines close to equal length', () => {
  const c = cfg();
  // Six 30-cell items, one group: 180 cells of content plus five 2-cell gaps.
  const items = Array.from({ length: 6 }, (_, i) => ({ group: 'g', text: String(i).repeat(30) }));
  const widths = wrapItemsBalanced(items, 100, c).map(visibleWidth);
  const spread = Math.max(...widths) - Math.min(...widths);
  assert.ok(
    spread <= 4,
    `lines should be near-equal, got ${widths.join(' / ')} (spread ${spread})`,
  );
});

test('balanced wrapping never splits a group that greedy kept whole', () => {
  const c = cfg();
  const items = [
    { group: 'a', text: 'a'.repeat(40) },
    { group: 'a', text: 'b'.repeat(40) },
    { group: 'b', text: 'c'.repeat(40) },
  ];
  const lines = wrapItemsBalanced(items, 90, c).map(stripAnsi);
  // The first group is 40+2+40 = 82, which fits in a 90-column line, so the
  // balanced pass must not break it just because it narrowed the budget.
  assert.equal(lines[0], 'a'.repeat(40) + '  ' + 'b'.repeat(40));
});

test('balanced wrapping falls back to greedy for a single line', () => {
  const c = cfg();
  const items = [{ group: 'a', text: 'x' }, { group: 'a', text: 'y' }];
  assert.deepEqual(
    wrapItemsBalanced(items, 80, c).map(stripAnsi),
    wrapItems(items, 80, c).map(stripAnsi),
  );
});

test('balanced wrapping still truncates an item wider than the line', () => {
  const c = cfg();
  const wide = {
    group: 'a',
    plain: 'x'.repeat(200),
    truncate: 'start',
    rerender: (t) => paint(t, 'dir', c),
    text: paint('x'.repeat(200), 'dir', c),
  };
  const lines = wrapItemsBalanced([wide, { group: 'b', text: 'tail' }], 40, c);
  for (const line of lines) assert.ok(visibleWidth(line) <= 40);
});

test('wrapItems skips null and empty items', () => {
  const c = cfg();
  const lines = wrapItems(
    [{ group: 'a', text: 'x' }, { group: 'a', text: null }, { group: 'a', text: '' },
     { group: 'a', text: 'y' }],
    80,
    c,
  );
  assert.deepEqual(lines.map(stripAnsi), ['x  y']);
});

test('applyPadding indents every line', () => {
  assert.deepEqual(applyPadding(['a', 'b'], cfg({ padding: 2 })), ['  a', '  b']);
  assert.deepEqual(applyPadding(['a'], cfg({ padding: 0 })), ['a']);
});

test('labelledItem dims the label and colours the value', () => {
  const c = cfg();
  const item = labelledItem({ group: 'g', label: 'input', value: '241,687', color: 'value', cfg: c });
  assert.equal(stripAnsi(item.text), 'input 241,687');
  assert.ok(item.text.includes(DEFAULT_COLORS.label));
  assert.ok(item.text.includes(DEFAULT_COLORS.value));

  const bare = labelledItem({ group: 'g', label: null, value: 'cc-ctx', color: 'brand', cfg: c });
  assert.equal(stripAnsi(bare.text), 'cc-ctx');
});
