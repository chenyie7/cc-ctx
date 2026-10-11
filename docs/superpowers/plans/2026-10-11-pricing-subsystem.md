# cc-ctx 价格子系统 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把价格计算从散落三处、与 DeepSeek 强绑定的实现，换成一套独立的、加 JSON 即可扩展的供应商价格子系统，并补上中国法定节假日峰谷、当前时段显示与临近切换提醒。

**Architecture:** 新增 `src/pricing/` 子目录，只依赖 node 内置模块。供应商与日历都是 JSON 定义，三级来源（用户目录 > 远程缓存 > 内置快照）。价格与时段分属两个互不依赖的接口：`resolvePricing()` 把模型解析成两档费率，`tierAt()`/`nextTransition()` 把时刻解析成档位。价格在渲染期应用，所以改价不触发重新解析 transcript；日历内容进缓存键，因为缓存里存的是峰/谷分桶。

**Tech Stack:** Node ESM（`"type": "module"`，engines `>=18`）、`node:test`、`node:assert/strict`、`Intl.DateTimeFormat`、`node:crypto`、内置 `fetch`。**零运行时依赖。**

**Spec:** `docs/superpowers/specs/2026-10-11-pricing-subsystem-design.md`

## Global Constraints

- Node `>=18`，ESM，**零运行时依赖**（只用 `node:` 内置模块）。复制自 `package.json`。
- 测试命令：`node --test 'test/*.test.js'`；测试不得访问真实网络，远程抓取一律注入 fetch 替身。
- **状态栏绝不能崩、绝不能空**：任何异常都要降级输出，进程恒 `exitCode 0`。
- 模型匹配不到价目表 → 返回 `null`，**绝不借用别的模型的价格**。
- 未知 / 非法时间戳 → 按高峰，**永不静默打折**。
- 用户级覆盖目录是 `~/.claude/cc-ctx/providers|calendars/`，**不能**放在 `~/.claude/cc-ctx/conf/` 下（`src/setup.js:41-49` 会递归删除并重拷 `conf`）。
- 价格以 CNY 报价；报价货币 ≠ 显示货币时经 `CC_CTX_RATE` 换算（沿用 `src/report.js:34-39`、`src/statusline.js:230-234` 的现有逻辑）。
- 配置版本升到 `3`。
- 时段口径（官方原文）：高峰 = 北京时间周一至周五（不含中国法定节假日）09:00-12:00、14:00-18:00；其余（含周末与节假日全天）空闲；空闲价 = 高峰价 × 0.5。调休上班日按**高峰**（我方保守选择）。

## Review Focus

以下五类输入/故障，spec 暗含要求但最容易在真实使用中咬人。每条都在对应任务里配了测试：

1. **transcript 里的年份不在日历中**（如 2027 年或更早）→ 必须退化成「只按星期判定」，不得崩溃、不得把节假日当高峰。
2. **远程返回的不是我们期望的 JSON**（HTML 错误页、空 body、字段缺失）→ 必须静默降级到缓存/内置，不得写入坏缓存、不得崩溃。
3. **模型 id 带方括号限定符**（`deepseek-flash[1M]`）→ 归一化后仍要匹配到价目表。
4. **用户目录里放了一个语法错误的 JSON** → 忽略该文件，其余供应商/日历照常工作。
5. **`nextTransition` 不得返回已经过去的时刻**，且跨零点、跨假期、假期中都要给出正确结果。

---

### Task 0: 建立工作分支

**Files:**
- 无文件改动

**Interfaces:**
- Consumes: 无
- Produces: 分支 `feat/pricing-subsystem`，后续所有任务在此分支提交

- [ ] **Step 1: 确认工作区干净**

Run: `git status --porcelain`
Expected: 只有本计划与 spec 两个未跟踪文件（`docs/superpowers/specs/...`、`docs/superpowers/plans/...`）。

- [ ] **Step 2: 建立并切换分支**

```bash
git checkout -b feat/pricing-subsystem
```

- [ ] **Step 3: 提交 spec 与计划**

```bash
git add docs/superpowers/specs/2026-10-11-pricing-subsystem-design.md docs/superpowers/plans/2026-10-11-pricing-subsystem.md
git commit -m "docs: cc-ctx 价格子系统设计与实现计划"
```

- [ ] **Step 4: 确认现有测试基线**

Run: `node --test 'test/*.test.js' 2>&1 | tail -5`
Expected: `# pass 79`、`# fail 0`。

---

### Task 1: 节假日日历（展开、指纹、远程格式适配）

**Files:**
- Create: `src/pricing/calendar.js`
- Create: `conf/calendars/cn.json`
- Test: `test/calendar.test.js`

**Interfaces:**
- Consumes: 无
- Produces:
  - `expandDates(entries, out?) -> Set<string>` —— 把 `["2026-01-01", {from,to}]` 混排列表展开成 `YYYY-MM-DD` 集合
  - `fromHolidayCn(doc) -> { holidays: string[], workdays: string[] }` —— 适配 `NateScarlet/holiday-cn` 格式
  - `parseCalendarFile(doc, { kind, file }) -> { id, tz, years, source } | null` —— 识别两种格式
  - `mergeCalendarDefs(defs) -> Map<id, def>` —— 同 id 按年份后者覆盖前者
  - `buildCalendar(def) -> { id, tz, holidays: Set, workdays: Set, key, source }`
  - `loadCalendars(entries) -> Map<id, calendar>`，`entries` 为 `[{ dir, kind }]`，**按顺序后者覆盖前者**
  - `DEFAULT_CALENDAR_TZ = 'Asia/Shanghai'`

- [ ] **Step 1: 写失败测试**

创建 `test/calendar.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  expandDates,
  fromHolidayCn,
  parseCalendarFile,
  buildCalendar,
  loadCalendars,
} from '../src/pricing/calendar.js';

test('expandDates 展开单日与区间，忽略非法项', () => {
  const out = expandDates(['2026-01-01', { from: '2026-02-15', to: '2026-02-17' }, 'not-a-date', null]);
  assert.deepEqual([...out].sort(), ['2026-01-01', '2026-02-15', '2026-02-16', '2026-02-17']);
});

test('expandDates 的区间跨月跨年是闭区间', () => {
  assert.deepEqual([...expandDates([{ from: '2025-12-30', to: '2026-01-02' }])].sort(),
    ['2025-12-30', '2025-12-31', '2026-01-01', '2026-01-02']);
});

test('fromHolidayCn 用 isOffDay 分辨放假日与调休上班日', () => {
  const { holidays, workdays } = fromHolidayCn({
    year: 2026,
    days: [
      { name: '元旦', date: '2026-01-01', isOffDay: true },
      { name: '元旦', date: '2026-01-04', isOffDay: false },
    ],
  });
  assert.deepEqual(holidays, ['2026-01-01']);
  assert.deepEqual(workdays, ['2026-01-04']);
});

test('parseCalendarFile 同时认原生格式与 holiday-cn 格式', () => {
  const native = parseCalendarFile({ id: 'cn', tz: 'Asia/Shanghai', years: { 2026: { holidays: ['2026-01-01'] } } });
  assert.equal(native.id, 'cn');
  assert.ok(native.years['2026']);

  const adapted = parseCalendarFile({ year: 2026, days: [{ date: '2026-01-01', isOffDay: true }] });
  assert.equal(adapted.id, 'cn', 'holiday-cn 没有 id，按中国的固定 id');
  assert.deepEqual(adapted.years['2026'].holidays, ['2026-01-01']);

  assert.equal(parseCalendarFile(null), null);
  assert.equal(parseCalendarFile({ nothing: true }), null, '无法识别的格式被拒绝');
});

test('buildCalendar 合并所有年份并给出内容指纹', () => {
  const def = {
    id: 'cn',
    tz: 'Asia/Shanghai',
    years: {
      2025: { holidays: ['2025-01-01'], workdays: [] },
      2026: { holidays: ['2026-01-01'], workdays: ['2026-01-04'] },
    },
  };
  const cal = buildCalendar(def);
  assert.ok(cal.holidays.has('2025-01-01'));
  assert.ok(cal.holidays.has('2026-01-01'));
  assert.ok(cal.workdays.has('2026-01-04'));

  const other = buildCalendar({ ...def, years: { 2026: { holidays: ['2026-01-02'], workdays: [] } } });
  assert.notEqual(cal.key, other.key, '内容变了指纹必须变');
  assert.equal(buildCalendar(def).key, cal.key, '同样的内容指纹必须稳定');
});

test('loadCalendars 后者覆盖前者，坏文件被跳过', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ctx-cal-'));
  const low = path.join(base, 'low');
  const high = path.join(base, 'high');
  fs.mkdirSync(low);
  fs.mkdirSync(high);
  fs.writeFileSync(path.join(low, 'cn.json'), JSON.stringify({ id: 'cn', years: { 2026: { holidays: ['2026-01-01'] } } }));
  fs.writeFileSync(path.join(high, 'cn.json'), JSON.stringify({ id: 'cn', years: { 2026: { holidays: ['2026-01-05'] } } }));
  fs.writeFileSync(path.join(high, 'broken.json'), '{ this is not json');

  try {
    const cals = loadCalendars([{ dir: low, kind: 'bundled' }, { dir: high, kind: 'user' }]);
    const cn = cals.get('cn');
    assert.ok(cn.holidays.has('2026-01-05'), '高优先级目录覆盖低优先级');
    assert.ok(!cn.holidays.has('2026-01-01'), '被覆盖的年份不再贡献日期');
    assert.equal(cn.source.kind, 'user');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `node --test test/calendar.test.js`
Expected: FAIL —— `Cannot find module '.../src/pricing/calendar.js'`

- [ ] **Step 3: 写 `conf/calendars/cn.json`**

```json
{
  "id": "cn",
  "tz": "Asia/Shanghai",
  "years": {
    "2025": {
      "holidays": [
        "2025-01-01",
        { "from": "2025-01-28", "to": "2025-02-04" },
        { "from": "2025-04-04", "to": "2025-04-06" },
        { "from": "2025-05-01", "to": "2025-05-05" },
        { "from": "2025-05-31", "to": "2025-06-02" },
        { "from": "2025-10-01", "to": "2025-10-08" }
      ],
      "workdays": ["2025-01-26", "2025-02-08", "2025-04-27", "2025-09-28", "2025-10-11"]
    },
    "2026": {
      "holidays": [
        { "from": "2026-01-01", "to": "2026-01-03" },
        { "from": "2026-02-15", "to": "2026-02-23" },
        { "from": "2026-04-04", "to": "2026-04-06" },
        { "from": "2026-05-01", "to": "2026-05-05" },
        { "from": "2026-06-19", "to": "2026-06-21" },
        { "from": "2026-09-25", "to": "2026-09-27" },
        { "from": "2026-10-01", "to": "2026-10-07" }
      ],
      "workdays": ["2026-01-04", "2026-02-14", "2026-02-28", "2026-05-09", "2026-09-20", "2026-10-10"]
    }
  }
}
```

- [ ] **Step 4: 写 `src/pricing/calendar.js`**

```js
// 节假日日历：内置快照 / 远程缓存 / 用户文件三级合并。
//
// 两个格式都要认：
//   - 本项目的原生格式 { id, tz, years: { "2026": { holidays, workdays } } }
//   - NateScarlet/holiday-cn 的 { year, days: [{ date, isOffDay }] }
// 日期一律是「当地自然日」的 YYYY-MM-DD，节假日在中国的语境下即北京时间。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DEFAULT_CALENDAR_TZ = 'Asia/Shanghai';

const DAY_MS = 86400000;

/** "YYYY-MM-DD" -> UTC 零点的毫秒数；非法返回 null。 */
function dayMs(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text ?? '').trim());
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(ms) ? null : ms;
}

function dayKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** 把 "YYYY-MM-DD" 与 { from, to } 混排的列表展开成日期集合。 */
export function expandDates(entries, out = new Set()) {
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (typeof entry === 'string') {
      const ms = dayMs(entry);
      if (ms !== null) out.add(dayKey(ms));
      continue;
    }
    const from = dayMs(entry?.from);
    const to = entry?.to === undefined ? from : dayMs(entry.to);
    if (from === null || to === null) continue;
    for (let ms = from; ms <= to; ms += DAY_MS) out.add(dayKey(ms));
  }
  return out;
}

/** holiday-cn：isOffDay 为 true 是放假日，false 是调休上班日。 */
export function fromHolidayCn(doc) {
  const holidays = [];
  const workdays = [];
  for (const day of Array.isArray(doc?.days) ? doc.days : []) {
    const ms = dayMs(day?.date);
    if (ms === null) continue;
    (day.isOffDay === false ? workdays : holidays).push(dayKey(ms));
  }
  return { holidays, workdays };
}

/** 识别一份日历 JSON。认不出来就返回 null，由调用方跳过。 */
export function parseCalendarFile(doc, source = { kind: 'bundled', file: null }) {
  if (!doc || typeof doc !== 'object') return null;

  if (doc.years && typeof doc.years === 'object') {
    return { id: doc.id || 'cn', tz: doc.tz || DEFAULT_CALENDAR_TZ, years: doc.years, source };
  }
  if (Array.isArray(doc.days)) {
    // holiday-cn 的字段里提到了年份，年条目直接用它。
    const year = String(doc.year || '');
    if (!/^\d{4}$/.test(year)) return null;
    return {
      id: doc.id || 'cn',
      tz: doc.tz || DEFAULT_CALENDAR_TZ,
      years: { [year]: fromHolidayCn(doc) },
      source,
    };
  }
  return null;
}

/** 同 id 的多个定义合并：年份级后者覆盖前者。 */
export function mergeCalendarDefs(defs) {
  const out = new Map();
  for (const def of defs) {
    if (!def?.id) continue;
    const cur = out.get(def.id) || { id: def.id, tz: def.tz, years: {}, source: def.source };
    if (def.tz) cur.tz = def.tz;
    cur.source = def.source;
    for (const [year, entry] of Object.entries(def.years || {})) cur.years[year] = entry;
    out.set(def.id, cur);
  }
  return out;
}

/** 内容指纹：改了放假/调休日期，峰谷分桶的缓存就必须失效。 */
export function calendarKey(id, holidays, workdays) {
  const hash = crypto.createHash('sha1').update(String(id));
  for (const day of [...holidays].sort()) hash.update('h' + day);
  for (const day of [...workdays].sort()) hash.update('w' + day);
  return hash.digest('hex').slice(0, 12);
}

export function buildCalendar(def) {
  const holidays = new Set();
  const workdays = new Set();
  for (const entry of Object.values(def.years || {})) {
    expandDates(entry?.holidays, holidays);
    expandDates(entry?.workdays, workdays);
  }
  return {
    id: def.id,
    tz: def.tz || DEFAULT_CALENDAR_TZ,
    holidays,
    workdays,
    key: calendarKey(def.id, holidays, workdays),
    source: def.source,
  };
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** entries: [{ dir, kind }]，按顺序合并，靠后的优先。 */
export function loadCalendars(entries) {
  const defs = [];
  for (const { dir, kind } of entries) {
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    } catch {
      continue; // 目录不存在是正常情况（用户可能从未建过）
    }
    for (const name of files) {
      const file = path.join(dir, name);
      const def = parseCalendarFile(readJson(file), { kind, file });
      if (def) defs.push(def);
    }
  }
  const merged = mergeCalendarDefs(defs);
  const out = new Map();
  for (const [id, def] of merged) out.set(id, buildCalendar(def));
  return out;
}
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `node --test test/calendar.test.js`
Expected: PASS（6 个用例）

- [ ] **Step 6: 提交**

```bash
git add src/pricing/calendar.js conf/calendars/cn.json test/calendar.test.js
git commit -m "feat(pricing): 节假日日历与远程格式适配"
```

---

### Task 2: 时段引擎

**Files:**
- Create: `src/pricing/schedule.js`
- Test: `test/schedule.test.js`

**Interfaces:**
- Consumes: `buildCalendar`（Task 1）
- Produces:
  - `parseWindows(spec) -> [{ start, end }]`（本地分钟，含头不含尾）
  - `parseDays(spec) -> Set<number>`（ISO 1=周一 … 7=周日）
  - `localParts(instant, tz) -> { date, weekday, minutes }`
  - `zonedInstant(dateKey, minutes, tz) -> Date`
  - `buildSchedule(def, { calendars }) -> schedule | null`
  - `tierAt(instant, schedule) -> 'peak' | 'offPeak'`
  - `nextTransition(instant, schedule, { horizonDays? }) -> { at: Date, tier } | null`
  - `scheduleKey(schedule) -> string`

- [ ] **Step 1: 写失败测试**

创建 `test/schedule.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadCalendars } from '../src/pricing/calendar.js';
import {
  parseWindows,
  parseDays,
  localParts,
  zonedInstant,
  buildSchedule,
  tierAt,
  nextTransition,
  scheduleKey,
} from '../src/pricing/schedule.js';

const CALS = loadCalendars([{ dir: new URL('../conf/calendars', import.meta.url).pathname, kind: 'bundled' }]);

const DEEPSEEK = {
  tz: 'Asia/Shanghai',
  windows: '09:00-12:00,14:00-18:00',
  days: '1-5',
  calendar: 'cn',
  workdaysArePeak: true,
};
const SCHEDULE = buildSchedule(DEEPSEEK, { calendars: CALS });

test('parseWindows 读本地分钟，含头不含尾，丢弃空窗口', () => {
  assert.deepEqual(parseWindows('09:00-12:00,14:00-18:00'), [
    { start: 540, end: 720 },
    { start: 840, end: 1080 },
  ]);
  assert.deepEqual(parseWindows(''), []);
  assert.deepEqual(parseWindows('garbage'), []);
  assert.deepEqual(parseWindows('03:00-03:00'), [], '空窗口被丢弃');
});

test('parseDays 支持区间与列表', () => {
  assert.deepEqual([...parseDays('1-5')].sort(), [1, 2, 3, 4, 5]);
  assert.deepEqual([...parseDays('1,7')].sort(), [1, 7]);
  assert.deepEqual([...parseDays('1-3,7')].sort(), [1, 2, 3, 7]);
  assert.deepEqual([...parseDays('9')], [], '越界的星期被忽略');
});

test('localParts / zonedInstant 互为逆运算（北京无夏令时）', () => {
  const at = zonedInstant('2026-09-29', 600, 'Asia/Shanghai'); // 北京 10:00
  assert.equal(at.toISOString(), '2026-09-29T02:00:00.000Z');
  const p = localParts(at, 'Asia/Shanghai');
  assert.deepEqual(p, { date: '2026-09-29', weekday: 2, minutes: 600 });
});

test('工作日的高峰窗口内是高峰，窗口外是空闲', () => {
  // 2026-09-29 是周二，非节假日
  assert.equal(tierAt('2026-09-29T02:00:00Z', SCHEDULE), 'peak', '北京 10:00 在 09-12 内');
  assert.equal(tierAt('2026-09-29T07:00:00Z', SCHEDULE), 'peak', '北京 15:00 在 14-18 内');
  assert.equal(tierAt('2026-09-29T05:00:00Z', SCHEDULE), 'offPeak', '北京 13:00 在窗口间隙');
  assert.equal(tierAt('2026-09-29T23:00:00Z', SCHEDULE), 'offPeak', '北京次日 07:00，窗口外');
});

test('窗口边界含头不含尾', () => {
  assert.equal(tierAt('2026-09-29T01:00:00Z', SCHEDULE), 'peak', '北京 09:00 含头');
  assert.equal(tierAt('2026-09-29T03:59:00Z', SCHEDULE), 'peak');
  assert.equal(tierAt('2026-09-29T04:00:00Z', SCHEDULE), 'offPeak', '北京 12:00 不含尾');
  assert.equal(tierAt('2026-09-29T10:00:00Z', SCHEDULE), 'offPeak', '北京 18:00 不含尾');
});

test('周末全天空闲', () => {
  // 2026-10-03 周六、2026-10-04 周日
  assert.equal(tierAt('2026-10-03T02:00:00Z', SCHEDULE), 'offPeak');
  assert.equal(tierAt('2026-10-04T07:00:00Z', SCHEDULE), 'offPeak');
});

test('法定节假日全天空闲（含本来的工作日）', () => {
  // 2026-01-02 周五，元旦假期内；2026-02-17 周二，春节假期内
  assert.equal(tierAt('2026-01-02T02:00:00Z', SCHEDULE), 'offPeak');
  assert.equal(tierAt('2026-02-17T02:00:00Z', SCHEDULE), 'offPeak');
  // 2026-10-02 周五，国庆假期内
  assert.equal(tierAt('2026-10-02T02:00:00Z', SCHEDULE), 'offPeak');
});

test('调休上班日按高峰（我方保守口径）', () => {
  // 2026-01-04 周日是调休上班日
  assert.equal(tierAt('2026-01-04T02:00:00Z', SCHEDULE), 'peak');
  // 2026-02-14 周六是调休上班日
  assert.equal(tierAt('2026-02-14T02:00:00Z', SCHEDULE), 'peak');
});

test('workdaysArePeak 关掉后回到官方字面口径：调休日仍是周末', () => {
  const strict = buildSchedule({ ...DEEPSEEK, workdaysArePeak: false }, { calendars: CALS });
  assert.equal(tierAt('2026-01-04T02:00:00Z', strict), 'offPeak');
});

test('未知或非法时间戳一律按高峰，永不静默打折', () => {
  assert.equal(tierAt(undefined, SCHEDULE), 'peak');
  assert.equal(tierAt('', SCHEDULE), 'peak');
  assert.equal(tierAt('not a date', SCHEDULE), 'peak');
  assert.equal(tierAt('2026-09-29T02:00:00Z', null), 'peak', '没有 schedule 就是单一价目表');
});

test('日历里没有的年份退化成只按星期判定（会高估，不低估）', () => {
  // 2027-01-04 周一，元旦假期在 2027 年日历里不存在，所以按普通工作日算
  assert.equal(tierAt('2027-01-04T02:00:00Z', SCHEDULE), 'peak');
  assert.equal(tierAt('2027-01-03T02:00:00Z', SCHEDULE), 'offPeak', '周日仍空闲');
});

test('nextTransition 给出下一次翻转，且永远在未来', () => {
  const from = new Date('2026-09-29T02:30:00Z'); // 周二北京 10:30，高峰中
  const next = nextTransition(from, SCHEDULE);
  assert.ok(next.at > from, '不得返回已经过去的时刻');
  assert.equal(next.tier, 'offPeak');
  assert.equal(next.at.toISOString(), '2026-09-29T04:00:00.000Z', '北京 12:00 窗口结束');
});

test('nextTransition 从窗口间隙指向下一个窗口', () => {
  const from = new Date('2026-09-29T05:00:00Z'); // 北京 13:00，空闲
  const next = nextTransition(from, SCHEDULE);
  assert.equal(next.tier, 'peak');
  assert.equal(next.at.toISOString(), '2026-09-29T06:00:00.000Z', '北京 14:00 窗口开始');
});

test('nextTransition 跨零点：周五收工后指向下周一', () => {
  const from = new Date('2026-09-25T10:30:00Z'); // 周五北京 18:30，已经空闲
  const next = nextTransition(from, SCHEDULE);
  assert.equal(next.tier, 'peak');
  assert.equal(next.at.toISOString(), '2026-09-28T01:00:00.000Z', '周一北京 09:00');
});

test('nextTransition 从假期中指向假期结束后的第一个窗口', () => {
  const from = new Date('2026-02-18T02:00:00Z'); // 春节假期中的周四
  const next = nextTransition(from, SCHEDULE);
  assert.equal(next.tier, 'peak');
  assert.equal(next.at.toISOString(), '2026-02-24T01:00:00.000Z', '假期结束次日北京 09:00');
});

test('nextTransition 在 32 天里找不到翻转时返回 null', () => {
  // 全天都是高峰窗口（24:00 表示到当日结束），没有任何翻转点。
  const always = buildSchedule({ days: '1-7', windows: '00:00-24:00' }, { calendars: CALS });
  assert.equal(nextTransition(new Date('2026-09-29T02:00:00Z'), always), null);
});

test('scheduleKey 随日历内容变化，也随窗口与星期变化', () => {
  const a = scheduleKey(SCHEDULE);
  const b = scheduleKey(buildSchedule(DEEPSEEK, { calendars: loadCalendars([]) }));
  assert.notEqual(a, b, '日历指纹不同 → 键不同');
  const c = scheduleKey(buildSchedule({ ...DEEPSEEK, windows: '10:00-11:00' }, { calendars: CALS }));
  assert.notEqual(a, c, '窗口不同 → 键不同');
  assert.equal(scheduleKey(null), 'none');
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `node --test test/schedule.test.js`
Expected: FAIL —— `Cannot find module '.../src/pricing/schedule.js'`

- [ ] **Step 3: 写 `src/pricing/schedule.js`**

```js
// 时段引擎：把「时刻」映射到「高峰 / 空闲」。
//
// 口径来自 DeepSeek 官方：北京时间周一至周五（不含中国法定节假日）
// 09:00-12:00、14:00-18:00 为高峰，其余（含周末与节假日全天）为空闲。
// 调休上班日我方按高峰计（比官方字面口径保守），由 workdaysArePeak 控制。
//
// 判定的两个维度都是「时区内的墙上时间」：窗口看几点几分，日期看哪一天。

const DAY_MINUTES = 1440;

/** 分钟数自本地午夜起算，含头不含尾。解析不出的片段直接丢弃。 */
export function parseWindows(spec) {
  const windows = [];
  for (const part of String(spec ?? '').split(',')) {
    const m = /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(part);
    if (!m) continue;
    const start = Number(m[1]) * 60 + Number(m[2]);
    const end = Number(m[3]) * 60 + Number(m[4]);
    if (start === end) continue;
    windows.push({ start, end });
  }
  return windows;
}

/** ISO 星期（1 = 周一 … 7 = 周日）。接受 "1-5"、"1,2"、"1-5,7"。 */
export function parseDays(spec) {
  const days = new Set();
  for (const part of String(spec ?? '').split(',')) {
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

const WEEKDAY = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const formatters = new Map();

function formatterFor(tz) {
  if (!formatters.has(tz)) {
    let f = null;
    try {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        year: 'numeric', month: '2-digit', day: '2-digit',
        weekday: 'short',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      });
    } catch {
      f = null; // 未知时区：由调用方回落到 UTC
    }
    formatters.set(tz, f);
  }
  return formatters.get(tz);
}

/** 某时刻在 tz 下的 { date, weekday, minutes }。 */
export function localParts(instant, tz) {
  const f = formatterFor(tz) || formatterFor('UTC');
  const parts = f.formatToParts(instant);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    weekday: WEEKDAY[get('weekday')] ?? 0,
    // hourCycle: 'h23' 已避免 24 点，这里再取模一次以防万一。
    minutes: (Number(get('hour')) % 24) * 60 + Number(get('minute')),
  };
}

/**
 * 「本地自然日 + 当日分钟」换算成瞬时。
 * 先用 UTC 猜一次，再按当地墙上时间的偏差修正；无夏令时的时区一次即中，
 * 有夏令时的时区两步内收敛。
 */
export function zonedInstant(dateKey, minutes, tz) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const wanted = Date.UTC(y, m - 1, d) + minutes * 60000;
  let guess = wanted;
  for (let i = 0; i < 3; i++) {
    const p = localParts(new Date(guess), tz);
    const [py, pm, pd] = p.date.split('-').map(Number);
    const actual = Date.UTC(py, pm - 1, pd) + p.minutes * 60000;
    const delta = wanted - actual;
    if (delta === 0) break;
    guess += delta;
  }
  return new Date(guess);
}

// calendars 是 loadCalendars() 的产物：id -> 已构造好的日历（holidays/workdays 是 Set）。
// 不要再 buildCalendar 一次——那会读一个不存在的 years 字段，把日历静默清空。
export function buildSchedule(def, { calendars } = {}) {
  if (!def) return null;
  return {
    tz: def.tz || 'UTC',
    windows: parseWindows(def.windows),
    days: parseDays(def.days),
    workdaysArePeak: def.workdaysArePeak !== false,
    calendar: (def.calendar && calendars?.get(def.calendar)) || null,
  };
}

/**
 * 档位。未知/非法时间戳按高峰 —— 宁可高估，也不静默给出折扣。
 */
export function tierAt(instant, schedule) {
  if (!instant || !schedule) return 'peak';
  const when = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(when.getTime())) return 'peak';

  const cal = schedule.calendar;
  const win = localParts(when, schedule.tz);
  // 日历的日期口径可能与窗口时区不同（例如窗口用 UTC、节假日在当地）。
  const calDate = cal && cal.tz !== schedule.tz ? localParts(when, cal.tz).date : win.date;

  if (cal?.holidays?.has(calDate)) return 'offPeak';

  const workday = schedule.workdaysArePeak && cal?.workdays?.has(calDate) === true;
  if (!workday && !schedule.days.has(win.weekday)) return 'offPeak';

  for (const { start, end } of schedule.windows) {
    if (win.minutes >= start && win.minutes < end) return 'peak';
  }
  return 'offPeak';
}

const ALERT_HORIZON_DAYS = 32;

/**
 * 下一次档位翻转。
 *
 * 档位只可能在两类时刻改变：窗口边界（本地 09:00/12:00/14:00/18:00）与本地零点
 * （跨日会改变星期与节假日状态）。所以只需枚举这些候选时刻，按时间顺序取第一个
 * 真正翻转的即可 —— 不需要逐分钟扫描。
 *
 * 32 天足以跨过任何一次假期（最长春节 9 天）。
 */
export function nextTransition(from, schedule, { horizonDays = ALERT_HORIZON_DAYS } = {}) {
  if (!schedule) return null;
  const start = from instanceof Date ? from : new Date(from);
  if (Number.isNaN(start.getTime())) return null;

  const nowTier = tierAt(start, schedule);
  const today = localParts(start, schedule.tz).date;
  const [y, m, d] = today.split('-').map(Number);

  const candidates = [];
  for (let i = 0; i <= horizonDays; i++) {
    const dateKey = new Date(Date.UTC(y, m - 1, d + i)).toISOString().slice(0, 10);
    candidates.push(zonedInstant(dateKey, 0, schedule.tz));
    for (const { start: ws, end: we } of schedule.windows) {
      candidates.push(zonedInstant(dateKey, ws, schedule.tz));
      if (we < DAY_MINUTES) candidates.push(zonedInstant(dateKey, we, schedule.tz));
    }
  }
  candidates.sort((a, b) => a - b);

  for (const at of candidates) {
    if (at <= start) continue;
    const tier = tierAt(at, schedule);
    if (tier !== nowTier) return { at, tier };
  }
  return null;
}

/** 稳定指纹：日历内容变了，峰/谷分桶的缓存必须失效。 */
export function scheduleKey(schedule) {
  if (!schedule) return 'none';
  const windows = schedule.windows.map((w) => `${w.start}-${w.end}`).join('.');
  const days = [...schedule.days].sort().join('');
  const cal = schedule.calendar ? `/${schedule.calendar.id}:${schedule.calendar.key}` : '';
  return `${schedule.tz}|${windows}|${days}|${schedule.workdaysArePeak ? 1 : 0}${cal}`;
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `node --test test/schedule.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/pricing/schedule.js test/schedule.test.js
git commit -m "feat(pricing): 时段引擎（峰谷判定与下次切换推算）"
```

---

### Task 3: 供应商定义与匹配

**Files:**
- Create: `src/pricing/provider.js`
- Create: `conf/providers/deepseek.json`
- Test: `test/provider.test.js`

**Interfaces:**
- Consumes: 无（`schedule` 字段原样透传，由 Task 4 交给 `buildSchedule`）
- Produces:
  - `normalizeModelId(id) -> string` —— 去掉 `[..]` 限定符、小写、trim
  - `normalizeRates(raw) -> { input, cacheWrite, cacheRead, output } | null` —— 四键齐全且为有限数字，否则 null
  - `parseProvider(doc, source, { calendars }) -> { id, currency, offPeakMultiplier, models, schedule, source } | null`
  - `matchRates(provider, modelId) -> { key, peak, offPeak } | null`
  - `loadProviders(entries, { calendars }) -> provider[]` —— 带日历表；同 id 后者覆盖前者

- [ ] **Step 1: 写失败测试**

创建 `test/provider.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  normalizeModelId,
  normalizeRates,
  parseProvider,
  matchRates,
  loadProviders,
} from '../src/pricing/provider.js';
import { loadCalendars } from '../src/pricing/calendar.js';
import { tierAt } from '../src/pricing/schedule.js';

const CALS = loadCalendars([{ dir: new URL('../conf/calendars', import.meta.url).pathname, kind: 'bundled' }]);
const BUNDLED = { dir: new URL('../conf/providers', import.meta.url).pathname, kind: 'bundled' };

test('normalizeModelId 去掉方括号限定符并小写', () => {
  assert.equal(normalizeModelId('deepseek-flash[1M]'), 'deepseek-flash');
  assert.equal(normalizeModelId('  DeepSeek-V4-Pro  '), 'deepseek-v4-pro');
  assert.equal(normalizeModelId(''), '');
  assert.equal(normalizeModelId(undefined), '');
});

test('normalizeRates 要求四键齐全且为有限数字，否则整个模型作废', () => {
  const ok = normalizeRates({ input: 2, cacheWrite: 2, cacheRead: 0.04, output: 8 });
  assert.deepEqual(ok, { input: 2, cacheWrite: 2, cacheRead: 0.04, output: 8 });

  assert.equal(normalizeRates({ input: 2, cacheWrite: 2, cacheRead: 0.04 }), null, '缺一个键就作废');
  assert.equal(
    normalizeRates({ input: 2, cacheWrite: 2, cacheRead: 0.04, output: 'nope' }),
    null,
    '非数字要拒绝，不能当成 0',
  );
});

test('parseProvider 认别名，认不出就拒绝', () => {
  const p = parseProvider({
    id: 'demo',
    currency: 'USD',
    models: { 'demo-a': { aliases: ['demo-a-legacy'], input: 1, cacheWrite: 1, cacheRead: 0.1, output: 2 } },
  });
  assert.equal(p.id, 'demo');
  assert.equal(p.currency, 'USD');
  assert.deepEqual(p.models.map((m) => m.key), ['demo-a', 'demo-a-legacy']);

  assert.equal(parseProvider({ models: {} }), null, '没有 id 不能要');
  assert.equal(parseProvider({ id: 'x' }), null, '没有模型表不能要');
  assert.equal(parseProvider({ id: 'x', models: { y: { input: 1 } } }), null, '模型四键不齐不能要');
});

test('matchRates 精确匹配优先于通配，通配取最长模式', () => {
  const p = parseProvider({
    id: 'demo',
    models: {
      'demo-*': { input: 9, cacheWrite: 9, cacheRead: 9, output: 9 },
      'demo-long-*': { input: 5, cacheWrite: 5, cacheRead: 5, output: 5 },
      'demo-exact': { input: 1, cacheWrite: 1, cacheRead: 1, output: 1 },
    },
  });
  assert.equal(matchRates(p, 'demo-exact').peak.input, 1, '精确胜通配');
  assert.equal(matchRates(p, 'demo-long-thing').peak.input, 5, '更长的模式胜出');
  assert.equal(matchRates(p, 'demo-other').peak.input, 9);
  assert.equal(matchRates(p, 'nothing-here'), null);
});

test('offPeak 缺省时按 offPeakMultiplier 折算，显式给出时以显式为准', () => {
  const scaled = parseProvider({
    id: 'demo',
    offPeakMultiplier: 0.5,
    models: { 'demo-a': { input: 2, cacheWrite: 2, cacheRead: 0.04, output: 8 } },
  });
  const hit = matchRates(scaled, 'demo-a');
  assert.deepEqual(hit.offPeak, { input: 1, cacheWrite: 1, cacheRead: 0.02, output: 4 });

  const explicit = parseProvider({
    id: 'demo',
    offPeakMultiplier: 0.5,
    models: {
      'demo-a': {
        input: 2, cacheWrite: 2, cacheRead: 0.04, output: 8,
        offPeak: { input: 0.9, cacheWrite: 0.9, cacheRead: 0.01, output: 3 },
      },
    },
  });
  assert.equal(matchRates(explicit, 'demo-a').offPeak.output, 3, '显式 offPeak 覆盖折算');
});

test('内置的 deepseek.json 能匹配官方全部模型名与别名', () => {
  const providers = loadProviders([BUNDLED], { calendars: CALS });
  const deepseek = providers.find((p) => p.id === 'deepseek');
  assert.ok(deepseek, '内置的 deepseek.json 必须能载入');
  assert.equal(deepseek.currency, 'CNY');

  for (const name of ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']) {
    const hit = matchRates(deepseek, normalizeModelId(`${name}[1M]`));
    assert.ok(hit, `${name} 必须匹配得到`);
    assert.deepEqual(hit.peak, { input: 2, cacheWrite: 2, cacheRead: 0.04, output: 8 }, `${name} 走 flash 价`);
    assert.deepEqual(hit.offPeak, { input: 1, cacheWrite: 1, cacheRead: 0.02, output: 4 });
  }

  const pro = matchRates(deepseek, 'deepseek-v4-pro');
  assert.deepEqual(pro.peak, { input: 9, cacheWrite: 9, cacheRead: 0.3, output: 27 });
  assert.deepEqual(pro.offPeak, { input: 4.5, cacheWrite: 4.5, cacheRead: 0.15, output: 13.5 });

  assert.equal(matchRates(deepseek, 'deepseek-v5-ultra'), null, '不认识的模型绝不借用 flash 的价');
});

test('内置 deepseek.json 的时段规则能直接判定峰谷', () => {
  const providers = loadProviders([BUNDLED], { calendars: CALS });
  const schedule = providers.find((p) => p.id === 'deepseek').schedule;
  assert.ok(schedule, 'schedule 应当被构造出来');
  assert.equal(tierAt('2026-09-29T02:00:00Z', schedule), 'peak');
  assert.equal(tierAt('2026-01-02T02:00:00Z', schedule), 'offPeak');
});

test('loadProviders 后者覆盖同 id，坏文件被跳过', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ctx-prov-'));
  const user = path.join(base, 'user');
  fs.mkdirSync(user);
  const model = { input: 2, cacheWrite: 2, cacheRead: 0.04, output: 16 };
  fs.writeFileSync(path.join(user, 'deepseek.json'), JSON.stringify({ id: 'deepseek', currency: 'CNY', models: { 'deepseek-flash': model } }));
  fs.writeFileSync(path.join(user, 'broken.json'), 'not json at all');

  try {
    const providers = loadProviders([BUNDLED, { dir: user, kind: 'user' }], { calendars: CALS });
    const all = providers.filter((p) => p.id === 'deepseek');
    assert.equal(all.length, 1, '同 id 只应留一份');
    assert.equal(all[0].source.kind, 'user', '用户目录的版本胜出');
    assert.equal(matchRates(all[0], 'deepseek-v4-pro'), null, '被覆盖后不再有 pro');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `node --test test/provider.test.js`
Expected: FAIL —— `Cannot find module '.../src/pricing/provider.js'`

- [ ] **Step 3: 写 `conf/providers/deepseek.json`**

```json
{
  "id": "deepseek",
  "currency": "CNY",
  "offPeakMultiplier": 0.5,
  "models": {
    "deepseek-flash": {
      "aliases": ["deepseek-v4-flash", "deepseek-v4-flash-vision-exp"],
      "input": 2.00,
      "cacheWrite": 2.00,
      "cacheRead": 0.04,
      "output": 8.00,
      "offPeak": { "input": 1.00, "cacheWrite": 1.00, "cacheRead": 0.02, "output": 4.00 }
    },
    "deepseek-v4-pro": {
      "input": 9.00,
      "cacheWrite": 9.00,
      "cacheRead": 0.30,
      "output": 27.00,
      "offPeak": { "input": 4.50, "cacheWrite": 4.50, "cacheRead": 0.15, "output": 13.50 }
    }
  },
  "schedule": {
    "tz": "Asia/Shanghai",
    "windows": "09:00-12:00,14:00-18:00",
    "days": "1-5",
    "calendar": "cn",
    "workdaysArePeak": true
  }
}
```

- [ ] **Step 4: 写 `src/pricing/provider.js`**

```js
// 供应商定义：模型 -> 费率，外加该供应商自己的时段规则。
//
// 匹配不到就返回 null。绝不写 "deepseek-*" 这类兜底通配 —— 那会让新出的模型
// 静默按老模型的价计价，正是本项目当初要修的 bug。

import fs from 'node:fs';
import path from 'node:path';

import { buildSchedule } from './schedule.js';

const RATE_KEYS = ['input', 'cacheWrite', 'cacheRead', 'output'];

/** 方括号是上下文窗口的提示（`[1M]`），不属于价格身份。 */
export function normalizeModelId(id) {
  return String(id ?? '')
    .replace(/\[[^\]]*\]/g, '')
    .trim()
    .toLowerCase();
}

/** 四个桶必须齐全且为有限数字；缺一个或有一个不是数，整个模型作废。 */
export function normalizeRates(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  for (const key of RATE_KEYS) {
    const value = Number(raw[key]);
    if (raw[key] === undefined || raw[key] === null || raw[key] === '' || !Number.isFinite(value)) {
      return null;
    }
    out[key] = value;
  }
  return out;
}

function scaleRates(rates, multiplier) {
  const factor = Number.isFinite(multiplier) ? multiplier : 1;
  const out = {};
  for (const key of RATE_KEYS) out[key] = rates[key] * factor;
  return out;
}

/** "*" 通配转正则；按模式长度定优先级，长的更具体。 */
function patternToRegex(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

export function parseProvider(doc, source = { kind: 'bundled', file: null }, { calendars } = {}) {
  if (!doc || typeof doc !== 'object') return null;
  const id = String(doc.id ?? '').trim();
  if (!id) return null;

  const models = [];
  for (const [key, raw] of Object.entries(doc.models || {})) {
    const peak = normalizeRates(raw);
    if (!peak) continue; // 半价的模型不如没有，直接跳过

    const explicit = raw.offPeak === undefined ? null : normalizeRates(raw.offPeak);
    const offPeak = explicit || scaleRates(peak, doc.offPeakMultiplier ?? 1);

    const names = [key, ...(Array.isArray(raw.aliases) ? raw.aliases : [])]
      .map(normalizeModelId)
      .filter(Boolean);
    for (const name of names) {
      const glob = name.includes('*');
      models.push({
        key: name,
        glob,
        matcher: glob ? patternToRegex(name) : null,
        rank: glob ? name.replace(/\*/g, '').length : Infinity, // 精确永远第一
        peak,
        offPeak,
      });
    }
  }
  if (!models.length) return null;

  return {
    id,
    currency: doc.currency || 'CNY',
    models,
    schedule: buildSchedule(doc.schedule, { calendars }),
    source,
  };
}

/** 精确优先，其次通配按模式长度由长到短。 */
export function matchRates(provider, modelId) {
  const id = normalizeModelId(modelId);
  if (!provider || !id) return null;

  let best = null;
  for (const model of provider.models) {
    const hit = model.glob ? model.matcher.test(id) : model.key === id;
    if (!hit) continue;
    if (!best || model.rank > best.rank) best = model;
  }
  return best ? { key: best.key, peak: best.peak, offPeak: best.offPeak } : null;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** entries: [{ dir, kind }]，按顺序合并，同 id 靠后者胜出。 */
export function loadProviders(entries, { calendars } = {}) {
  const byId = new Map();
  for (const { dir, kind } of entries) {
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    } catch {
      continue;
    }
    for (const name of files) {
      const file = path.join(dir, name);
      const provider = parseProvider(readJson(file), { kind, file }, { calendars });
      if (provider) byId.set(provider.id, provider);
    }
  }
  return [...byId.values()];
}
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `node --test test/provider.test.js`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/pricing/provider.js conf/providers/deepseek.json test/provider.test.js
git commit -m "feat(pricing): 供应商定义、别名匹配与 DeepSeek 价目表"
```

---

### Task 4: 对外入口 `resolvePricing`

**Files:**
- Create: `src/pricing/index.js`
- Test: `test/pricing.test.js`

**Interfaces:**
- Consumes: `loadProviders` / `matchRates`（Task 3）、`loadCalendars`（Task 1）
- Produces:
  - `loadProviders(cfg) -> provider[]` —— 由 `cfg.providerDirs` / `cfg.calendarDirs`（`[{ dir, kind }]`）驱动
  - `resolvePricing(cfg, modelId) -> { providerId, currency, peak, offPeak, schedule, source } | null`

- [ ] **Step 1: 写失败测试**

创建 `test/pricing.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadProviders, resolvePricing } from '../src/pricing/index.js';

const root = new URL('..', import.meta.url).pathname;
const CFG = {
  providerDirs: [{ dir: path.join(root, 'conf', 'providers'), kind: 'bundled' }],
  calendarDirs: [{ dir: path.join(root, 'conf', 'calendars'), kind: 'bundled' }],
};

test('resolvePricing 端到端解析出两档费率与时段表', () => {
  const pricing = resolvePricing(CFG, 'deepseek-flash[1M]');
  assert.equal(pricing.providerId, 'deepseek');
  assert.equal(pricing.currency, 'CNY');
  assert.deepEqual(pricing.peak, { input: 2, cacheWrite: 2, cacheRead: 0.04, output: 8 });
  assert.deepEqual(pricing.offPeak, { input: 1, cacheWrite: 1, cacheRead: 0.02, output: 4 });
  assert.ok(pricing.schedule, '带时段规则');
  assert.equal(pricing.source.kind, 'bundled');
});

test('无峰谷的供应商拿到 schedule: null，且空闲价等于高峰价', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ctx-flat-'));
  const model = { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 };
  fs.writeFileSync(path.join(dir, 'flat.json'), JSON.stringify({
    id: 'flat',
    currency: 'USD',
    models: { 'flat-model': model },
  }));

  try {
    const pricing = resolvePricing(
      { providerDirs: [...CFG.providerDirs, { dir, kind: 'user' }], calendarDirs: CFG.calendarDirs },
      'flat-model',
    );
    assert.equal(pricing.schedule, null);
    assert.deepEqual(pricing.offPeak, pricing.peak, '没有时段规则时两档一致');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('认不出的模型返回 null，不借用别的供应商的价', () => {
  assert.equal(resolvePricing(CFG, 'gpt-9-turbo'), null);
  assert.equal(resolvePricing(CFG, ''), null);
  assert.equal(resolvePricing(CFG, undefined), null);
});

test('loadProviders 把日历目录一起交给供应商', () => {
  const providers = loadProviders(CFG);
  const deepseek = providers.find((p) => p.id === 'deepseek');
  assert.ok(deepseek.schedule.calendar, 'schedule 应当带上已构造的日历');
  assert.ok(deepseek.schedule.calendar.holidays.has('2026-01-01'));
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `node --test test/pricing.test.js`
Expected: FAIL —— `Cannot find module '.../src/pricing/index.js'`

- [ ] **Step 3: 写 `src/pricing/index.js`**

```js
// 价格子系统的对外入口。
//
// 三级来源由 cfg 里的目录顺序决定：用户目录 > 远程缓存 > 内置快照。

import { loadCalendars } from './calendar.js';
import { loadProviders as load, matchRates } from './provider.js';

export function loadProviders(cfg) {
  const calendars = loadCalendars(cfg?.calendarDirs || []);
  return load(cfg?.providerDirs || [], { calendars });
}

/**
 * 模型 -> 费率。认不出来就返回 null —— 显示「无价目表」才是对的，
 * 替换成别的模型的价正是本项目要修的那个 bug。
 */
export function resolvePricing(cfg, modelId) {
  const providers = loadProviders(cfg);
  for (const provider of providers) {
    const hit = matchRates(provider, modelId);
    if (!hit) continue;
    return {
      providerId: provider.id,
      currency: provider.currency,
      peak: hit.peak,
      offPeak: hit.offPeak,
      schedule: provider.schedule,
      source: provider.source,
    };
  }
  return null;
}

export { loadCalendars };
export { tierAt, nextTransition, scheduleKey } from './schedule.js';
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `node --test test/pricing.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/pricing/index.js test/pricing.test.js
git commit -m "feat(pricing): resolvePricing 对外入口"
```

---

### Task 5: 远程数据保鲜

**Files:**
- Create: `src/pricing/remote.js`
- Test: `test/remote.test.js`

**Interfaces:**
- Consumes: `parseCalendarFile`（Task 1）、`parseProvider`（Task 3）
- Produces:
  - `DEFAULT_PROVIDER_URL`、`DEFAULT_CALENDAR_URL`（含 `{id}` / `{year}` 模板）
  - `remoteRoot(installDir) -> string`
  - `readMeta(file) -> object`
  - `isStale(meta, ttlMs, now) -> boolean`
  - `refreshRemote(cfg, { fetchFn, now, log }) -> { updated: string[], failed: string[] }`
  - `remoteDirsFor(cfg) -> { providers: { dir, kind }, calendars: { dir, kind } }`

- [ ] **Step 1: 写失败测试**

创建 `test/remote.test.js`：

```js
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
        if (typeof body === 'string') throw new SyntaxError('not json'); // 模拟 HTML 错误页
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

test('isStale：没有元数据、或超过 TTL 都算过期', () => {
  const now = 1_000_000_000_000;
  assert.equal(isStale(null, 1000, now), true);
  assert.equal(isStale({ fetchedAt: now - 500 }, 1000, now), false);
  assert.equal(isStale({ fetchedAt: now - 5000 }, 1000, now), true);
});

test('refreshRemote 把远程日历写进缓存，并归一化成我们的格式', async () => {
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
    assert.equal(saved.id, 'cn', 'holiday-cn 的格式被归一化');
    assert.deepEqual(saved.years['2026'].holidays, ['2026-01-01']);
    assert.deepEqual(saved.years['2026'].workdays, ['2026-01-04']);
  } finally {
    fs.rmSync(install, { recursive: true, force: true });
  }
});

test('refreshRemote 遇到 HTML 错误页或 404 时不写坏数据、不抛异常', async () => {
  const install = tempInstall();
  try {
    const result = await refreshRemote(cfgFor(install), {
      fetchFn: fakeFetch({ 'https://example.test/2026.json': '<html>oops</html>' }),
      now: () => 0,
      years: [2026],
      providerIds: [],
    });
    assert.equal(result.updated.length, 0);
    assert.equal(result.failed.length, 1, '失败的来源要被报告出来');
    const dir = path.join(remoteRoot(install), 'calendars');
    const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    assert.equal(files.length, 0, '什么都没写进去');
  } finally {
    fs.rmSync(install, { recursive: true, force: true });
  }
});

test('refreshRemote 在 CC_CTX_REMOTE=off 时什么都不做', async () => {
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

test('refreshRemote 拉供应商并原样落盘', async () => {
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
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `node --test test/remote.test.js`
Expected: FAIL —— `Cannot find module '.../src/pricing/remote.js'`

- [ ] **Step 3: 写 `src/pricing/remote.js`**

```js
// 远程数据保鲜：把价格与节假日拉到本地缓存。
//
// 这一层是「锦上添花」，不是依赖：内置快照永远在，所以任何失败都只是保持旧数据，
// 绝不影响状态栏渲染。抓取成功才写盘，写盘走临时文件 + rename。
//
// 注意：价格的「联网」不等于自动跟踪 DeepSeek。它只是把「维护者更新本仓库的
// JSON」变成「用户自动拿到」；价格真的变了，仍需有人更新仓库里的文件。

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
 * 缺省要拉哪些年份：当前年，以及年末 30 天内把下一年也拉上（次年安排通常 11 月发布）。
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

  // 记的是「尝试时间」而非「成功时间」：失败也要退避一个 TTL，否则每渲染一次
  // 状态栏就会 fork 一个注定失败的后台进程。
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

/** 抓 JSON。任何异常（网络、超时、body 不是 JSON）都当成没拿到。 */
async function fetchJson(url, fetchFn, timeoutMs = 8000) {
  try {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res?.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `node --test test/remote.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/pricing/remote.js test/remote.test.js
git commit -m "feat(pricing): 远程数据保鲜与缓存"
```

---

### Task 6: 接线（一次接口翻转）

**为什么这是一个任务而不是四个：** `resolvePrices → resolvePricing`、`costOf(totals, prices, opts) → costOf(totals, pricing)`、状态栏/报告的选项名 `prices → pricing`，这三件事互为前提——任何一件单独落地，树都会处于不可运行状态（例如 cli 传 `pricing` 而状态栏还读 `prices`）。所以它们必须在同一个提交里完成。

**Files:**
- Modify: `src/config.js`（删 `resolvePrices` / `modelPriceKey` / `buildSchedule` 引入；新增目录与 `tierAlertMinutes` 等）
- Modify: `src/usage.js:14`（`isOffPeak` 改为 `tierAt`）、`src/usage.js:242-259`（`scheduleKey` 从 pricing 引入）、`src/usage.js:290-308`（`costOf`）
- Modify: `test/config.test.js`、`test/usage.test.js`
- Delete: `src/peak.js`、`test/peak.test.js`
- 同属本次翻转、在 6b/6c/6d 里改：`src/cli.js`、`src/statusline.js`、`src/report.js`、`conf/default.env`、`test/statusline.test.js`、`test/report.test.js`、新增 `test/cli.test.js`
- **提交在 6d 的最后一步，四段合起来才算一个可运行的改动**

**Interfaces:**
- Consumes: `tierAt` / `scheduleKey`（Task 2）
- Produces:
  - `cfg.providerDirs` / `cfg.calendarDirs`：`[{ dir, kind }]`，顺序为 `[内置, 远程, 用户]`
  - `cfg.tierAlertMinutes`、`cfg.installDir`、`cfg.remote`、`cfg.remoteTtlMs`、`cfg.providerUrl`、`cfg.calendarUrl`
  - `costOf(totals, pricing) -> number | null`

- [ ] **Step 1: 写失败测试（先改 `test/config.test.js`）**

删掉 `resolvePrices` 与 `modelPriceKey` 两个 import 及其三个测试（`modelPriceKey` 测试、`resolvePrices needs a complete set...`、`the price currency can be set globally or per model`），改为：

```js
import { parseEnvFile, loadConfig, DEFAULT_COLORS, DEFAULT_FIELDS } from '../src/config.js';
```

并在文件末尾追加：

```js
test('loadConfig 给出价格数据的三级目录与提醒阈值', () => {
  const missing = path.join(os.tmpdir(), 'cc-ctx-missing.env');
  const cfg = loadConfig({ env: {}, userEnvFile: missing });
  assert.equal(cfg.providerDirs.length, 3, '内置 / 远程 / 用户');
  assert.deepEqual(cfg.providerDirs.map((d) => d.kind), ['bundled', 'remote', 'user']);
  assert.deepEqual(cfg.calendarDirs.map((d) => d.kind), ['bundled', 'remote', 'user']);
  assert.equal(cfg.tierAlertMinutes, 20, '默认阈值 20 分钟');
  assert.equal(cfg.remote, true, '默认开启联网');
  assert.equal(cfg.remoteTtlMs, 86400000);
  assert.ok(cfg.installDir);
});

test('提醒阈值与联网开关可被覆盖', () => {
  const file = tempEnvFile('CC_CTX_TIER_ALERT_MINUTES="5"\nCC_CTX_REMOTE="off"\n');
  try {
    const cfg = loadConfig({ env: {}, userEnvFile: file });
    assert.equal(cfg.tierAlertMinutes, 5);
    assert.equal(cfg.remote, false);
  } finally {
    fs.rmSync(file, { force: true });
  }
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `node --test test/config.test.js`
Expected: FAIL —— 新增的两个用例报 `cfg.providerDirs` / `cfg.tierAlertMinutes` 为 `undefined`（`src/config.js` 还没加这些键）

- [ ] **Step 3: 改 `src/config.js`**

删除 `import { buildSchedule } from './peak.js';`（第 11 行）、`modelPriceKey()`（第 85-91 行）、`resolvePrices()`（第 93-126 行）。

在 `DEFAULT_PRICE_CURRENCY` 附近加：

```js
const PROVIDERS_BUILTIN = path.join(PLUGIN_ROOT, 'conf', 'providers');
const CALENDARS_BUILTIN = path.join(PLUGIN_ROOT, 'conf', 'calendars');
const REMOTE_PROVIDERS = path.join(INSTALL_DIR, 'remote', 'providers');
const REMOTE_CALENDARS = path.join(INSTALL_DIR, 'remote', 'calendars');
const USER_PROVIDERS = path.join(INSTALL_DIR, 'providers');
const USER_CALENDARS = path.join(INSTALL_DIR, 'calendars');
```

在 `loadConfig` 的返回对象里，替换掉 `schedule: buildSchedule(cc),` 那一行，加上：

```js
    installDir: INSTALL_DIR,
    // 顺序即优先级：靠后的覆盖靠前的。
    providerDirs: [
      { dir: PROVIDERS_BUILTIN, kind: 'bundled' },
      { dir: cc.CC_CTX_PROVIDERS_REMOTE_DIR || REMOTE_PROVIDERS, kind: 'remote' },
      { dir: cc.CC_CTX_PROVIDERS_DIR || USER_PROVIDERS, kind: 'user' },
    ],
    calendarDirs: [
      { dir: CALENDARS_BUILTIN, kind: 'bundled' },
      { dir: cc.CC_CTX_CALENDARS_REMOTE_DIR || REMOTE_CALENDARS, kind: 'remote' },
      { dir: cc.CC_CTX_CALENDARS_DIR || USER_CALENDARS, kind: 'user' },
    ],
    tierAlertMinutes: Number(cc.CC_CTX_TIER_ALERT_MINUTES || 20),
    remote: (cc.CC_CTX_REMOTE || 'on').toLowerCase() !== 'off',
    remoteTtlMs: Number(cc.CC_CTX_REMOTE_TTL_MS || 86400000),
    providerUrl: cc.CC_CTX_PROVIDER_URL || '',
    calendarUrl: cc.CC_CTX_CALENDAR_URL || '',
```

- [ ] **Step 4: 改 `src/usage.js`**

第 14 行 `import { isOffPeak } from './peak.js';` 改为：

```js
import { tierAt, scheduleKey } from './pricing/schedule.js';
```

第 138-143 行与第 155-160 行里的 `isOffPeak(record.timestamp, schedule)` 改成 `tierAt(record.timestamp, schedule) === 'offPeak'`。

删除第 242-250 行的 `scheduleKey` 定义（改由 `./pricing/schedule.js` 提供；注意不要再 `export` 同名符号，直接删掉即可，导入已在上面）。

第 285-308 行的 `costOf` 换成：

```js
/**
 * 账单金额，单位是价目表的报价货币。
 * 模型没有价目表时返回 null —— 显示不出来才是对的，换成别的模型的价正是本项目要修的 bug。
 */
export function costOf(totals, pricing) {
  if (!pricing) return null;

  const off = totals.offPeak ?? { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  const peak = {
    input: Math.max(0, totals.input - off.input),
    cacheWrite: Math.max(0, totals.cacheWrite - off.cacheWrite),
    cacheRead: Math.max(0, totals.cacheRead - off.cacheRead),
    output: Math.max(0, totals.output - off.output),
  };

  const bill = (b, r) =>
    b.input * r.input +
    b.cacheWrite * r.cacheWrite +
    b.cacheRead * r.cacheRead +
    b.output * r.output;

  return (bill(peak, pricing.peak) + bill(off, pricing.offPeak)) / 1e6;
}
```

- [ ] **Step 5: 改 `test/usage.test.js`，删除 `test/peak.test.js`、`src/peak.js`**

`test/usage.test.js` 第 21 行 `import { buildSchedule } from '../src/peak.js';` 改为：

```js
import { buildSchedule } from '../src/pricing/schedule.js';
import { loadCalendars } from '../src/pricing/calendar.js';

const CALS = loadCalendars([{ dir: new URL('../conf/calendars', import.meta.url).pathname, kind: 'bundled' }]);
const DS = { tz: 'Asia/Shanghai', windows: '09:00-12:00,14:00-18:00', days: '1-5', calendar: 'cn', workdaysArePeak: true };
const schedule = () => buildSchedule(DS, { calendars: CALS });
```

全文把 `buildSchedule({})` 换成 `schedule()`，把 `buildSchedule({ CC_CTX_OFFPEAK_MULTIPLIER: '0.25' })` 换成 `buildSchedule({ ...DS, windows: '10:00-11:00' }, { calendars: CALS })`。

`costOf` 相关测试：`prices` 字面量改成两档形状 `{ peak: {...}, offPeak: {...} }`，并把

```js
const full = costOf(totals, prices);
const discounted = costOf(totals, prices, { offPeakMultiplier: 0.5 });
```

改为：

```js
const prices = { peak: RATES, offPeak: RATES };
const discounted = { peak: RATES, offPeak: Object.fromEntries(Object.entries(RATES).map(([k, v]) => [k, v * 0.5])) };
const full = costOf(totals, prices);
const offPeakBill = 200 * 0.3 + 2000 * 0.006 + 60 * 1.2;
assert.ok(Math.abs(full - costOf(totals, discounted) - offPeakBill / 2 / 1e6) < 1e-15);
```

（`RATES` 即原来那个 `{ input: 0.3, cacheWrite: 0.3, cacheRead: 0.006, output: 1.2 }`，不再带 `currency` 字段——报价货币已移到 `pricing.currency`。）

最后：

```bash
git rm src/peak.js test/peak.test.js
```

- [ ] **Step 6: 此时先不要跑全套测试**

树在这四段全部改完之前是不可运行的（cli 会传 `pricing`，而状态栏还在读 `prices`）。跑完 6d 再验证。

---

### Task 6b: cli 接线与远程刷新子命令

**Files:**
- Modify: `src/cli.js:12`（import）、`src/cli.js:60-156`（两个命令）、`src/cli.js:170-205`（USAGE 与分发）
- Test: `test/cli.test.js`（新增）

**Interfaces:**
- Consumes: `resolvePricing`（Task 4）、`refreshRemote` / `remoteDirsFor` / `readMeta` / `isStale`（Task 5）、`computeTotalsCached` / `computeTotals`（`src/usage.js`）
- Produces: 子命令 `remote-refresh`（供后台子进程调用）；`statusline` / `report` 全程改用 `pricing`

- [ ] **Step 1: 写失败测试**

创建 `test/cli.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { projectDirFor, newestTranscript, parseArgs, USAGE } from '../src/cli.js';

test('projectDirFor 把 cwd 的斜杠换成短横线', () => {
  assert.match(projectDirFor('/home/me/proj'), /projects[\\/]-home-me-proj$/);
});

test('newestTranscript 对不存在的目录返回 null 而不抛异常', () => {
  assert.equal(newestTranscript('/definitely/not/here'), null);
});

test('parseArgs 认识带值的选项与开关', () => {
  const args = parseArgs(['report', '--transcript', '/tmp/a.jsonl', '--reset-config']);
  assert.deepEqual(args._, ['report']);
  assert.equal(args.transcript, '/tmp/a.jsonl');
  assert.equal(args['reset-config'], true);
});

test('USAGE 提到 remote-refresh 与价格配置的迁移', () => {
  assert.match(USAGE, /remote-refresh/);
  assert.match(USAGE, /providers/);
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `node --test test/cli.test.js`
Expected: FAIL —— `parseArgs` 与 `USAGE` 尚未导出

- [ ] **Step 3: 改 `src/cli.js`**

第 12 行附近，把 `import { loadConfig, resolvePrices } from './config.js';` 改成：

```js
import { loadConfig } from './config.js';
import { resolvePricing } from './pricing/index.js';
import { refreshRemote, remoteDirsFor, readMeta, isStale } from './pricing/remote.js';
```

`commandStatusline` 里，把

```js
  const modelId = input?.model?.id || input?.model?.display_name || '';
  const prices = resolvePrices(cfg.raw, modelId);
```

改成：

```js
  const modelId = input?.model?.id || input?.model?.display_name || '';
  const pricing = resolvePricing(cfg, modelId);
  maybeRefreshRemote(cfg);
```

并把后面 `computeTotalsCached(..., { schedule: cfg.schedule })` 改成 `{ schedule: pricing?.schedule ?? null }`，`renderStatusline(input, cfg, { totals, prices, balanceInfo })` 改成 `{ totals, pricing, balanceInfo }`。

`commandReport` 里同理：`const prices = resolvePrices(cfg.raw, modelId);` → `const pricing = resolvePricing(cfg, modelId);`，`{ schedule: cfg.schedule }` → `{ schedule: pricing?.schedule ?? null }`，`renderReport({ ..., prices, ... })` → `{ ..., pricing, ... }`。

新增两个函数：

```js
/**
 * 数据过期就在后台拉一次，本次渲染绝不等它。
 * 内置快照永远在，所以这里连「冷启动要不要等」的纠结都不需要 —— 永远不等。
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
    /* 后台刷新是锦上添花，失败不该影响状态栏 */
  }
}
```

（需要在文件顶部加 `import { spawn } from 'node:child_process';`。）

分发里新增：

```js
    case 'remote-refresh':
      return commandRemoteRefresh(cfg);
```

```js
async function commandRemoteRefresh(cfg) {
  if (!cfg.remote) return '';
  const { updated, failed } = await refreshRemote(cfg, { log: (m) => process.stderr.write(m + '\n') });
  if (process.env.CC_CTX_DEBUG) {
    process.stderr.write(`remote-refresh updated=[${updated}] failed=[${failed}]\n`);
  }
  return '';
}
```

`USAGE` 换成：

```js
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
```

并在文件末尾导出 `export { parseArgs, USAGE };`。

- [ ] **Step 4: 运行测试，确认通过**

Run: `node --test test/cli.test.js`
Expected: PASS

- [ ] **Step 5: 只跑 cli 自己的测试**

Run: `node --test test/cli.test.js`
Expected: PASS

---

### Task 6c: 状态栏 tier 字段与提醒

**Files:**
- Modify: `src/statusline.js`（新增 `tier` case；`cost` case 改用 `pricing`）
- Modify: `test/statusline.test.js`
- Modify: `conf/default.env`（`CC_CTX_FIELDS` 加入 `tier`）

**Interfaces:**
- Consumes: `tierAt` / `nextTransition`（Task 2）、`pricing` 对象（Task 4）
- Produces: 状态栏字段 id `tier`；`renderStatusline(input, cfg, { totals, pricing, balanceInfo })`

- [ ] **Step 1: 写失败测试**

在 `test/statusline.test.js` 里把 `const PRICES = {...}` 换成：

```js
const PEAK = { input: 2, cacheWrite: 2, cacheRead: 0.04, output: 8 };
const PRICES = {
  providerId: 'deepseek',
  currency: 'CNY',
  peak: PEAK,
  offPeak: { input: 1, cacheWrite: 1, cacheRead: 0.02, output: 4 },
  schedule: buildSchedule(
    { tz: 'Asia/Shanghai', windows: '09:00-12:00,14:00-18:00', days: '1-5', calendar: 'cn', workdaysArePeak: true },
    { calendars: loadCalendars([{ dir: new URL('../conf/calendars', import.meta.url).pathname, kind: 'bundled' }]) },
  ),
};
```

顶部加 import：

```js
import { buildSchedule } from '../src/pricing/schedule.js';
import { loadCalendars } from '../src/pricing/calendar.js';
```

`render()` 里的调用改为 `renderStatusline(PAYLOAD, cfg, { totals: TOTALS, pricing: PRICES, balanceInfo: BALANCE, env })`；第 106、116 行同理（`prices: PRICES` → `pricing: PRICES`，`prices: null` → `pricing: null`）。

追加测试：

```js
test('tier 字段显示当前时段，无 schedule 时不渲染', () => {
  const { out, cfg } = render(200, { CC_CTX_FIELDS: 'tier' });
  assert.match(stripAnsi(out), /(peak|off-peak)/, '有 schedule 时必须显示档位');

  const env = { NO_COLOR: '1', COLUMNS: '200' };
  const noSchedule = renderStatusline(PAYLOAD, cfg, {
    totals: TOTALS,
    pricing: { ...PRICES, schedule: null },
    balanceInfo: BALANCE,
    env,
  });
  assert.doesNotMatch(stripAnsi(noSchedule), /peak/, '没有 schedule 的供应商不该出现 tier 字段');
});
```

（`stripAnsi` 已从 `../src/render.js` 导入。）

- [ ] **Step 2: 运行测试，确认失败**

Run: `node --test test/statusline.test.js`
Expected: FAIL —— `prices` 选项不再被识别、`tier` 字段不渲染

- [ ] **Step 3: 改 `src/statusline.js`**

顶部加：

```js
import { tierAt, nextTransition } from './pricing/schedule.js';
```

`renderStatusline` 的签名与解构改为 `{ totals, pricing, balanceInfo, env = process.env }`，`ctx` 里带上 `pricing`。全体 `prices` 改名为 `pricing`（`formatMoney`、`cost` case、`EXPANSIONS` 无关）。

`buildItem` 的解构改为 `const { input, cfg, env, totals, pricing, balanceInfo } = ctx;`。

`cost` case 改为：

```js
    case 'cost': {
      const amount = costOf(totals, pricing);
      const value = amount === null ? '—' : formatMoney(amount, pricing, cfg);
      return labelledItem({
        group: 'stats', label: 'cost', value, color: amount === null ? 'label' : 'value', cfg,
      });
    }
```

新增 `tier` case：

```js
    case 'tier': {
      const schedule = pricing?.schedule;
      if (!schedule) return null;
      const now = new Date();
      const tier = tierAt(now, schedule);
      const label = tier === 'peak' ? 'peak' : 'off-peak';
      const next = nextTransition(now, schedule);

      let value = label;
      // 高峰本身就偏"贵"，用 warn；空闲用 ok。
      let color = tier === 'peak' ? 'warn' : 'ok';
      if (next) {
        const minutes = Math.max(0, Math.round((next.at - now) / 60000));
        if (minutes <= cfg.tierAlertMinutes) {
          const nextLabel = next.tier === 'peak' ? 'peak' : 'off-peak';
          value = `${label} · ${formatDuration(minutes * 60000)}→${nextLabel}`;
          // 马上要变贵，是最该被看见的一刻。
          color = next.tier === 'peak' ? 'hot' : 'ok';
        }
      }
      return labelledItem({ group: 'stats', label: 'tier', value, color, cfg });
    }
```

`formatMoney` 的 `prices?.currency` 改为 `pricing?.currency`（参数名一并改成 `pricing`）。

- [ ] **Step 4: 改 `conf/default.env`**

`CC_CTX_FIELDS` 改为：

```
CC_CTX_FIELDS="context dir balance cost tier effort tokens brand model session hitrate calls"
```

- [ ] **Step 5: 只跑状态栏自己的测试**

Run: `node --test test/statusline.test.js`
Expected: PASS

---

### Task 6d: 报告里的 pricing 段

**Files:**
- Modify: `src/report.js:48-150`
- Modify: `test/report.test.js`

**Interfaces:**
- Consumes: `tierAt` / `nextTransition`（Task 2）、`pricing` 对象（Task 4）
- Produces: `renderReport({ payload, totals, pricing, balanceInfo, cfg, transcriptPath, cwd })`；报告中新增 `pricing` 行

- [ ] **Step 1: 写失败测试**

在 `test/report.test.js` 里把 `const PRICES = {...}` 换成与 Task 6c 相同的两档形状（含 `offPeak` 与 `schedule`），把所有 `prices:` 改成 `pricing:`，并追加：

```js
test('报告里给出供应商、币种、当前时段与下次切换', () => {
  const out = stripAnsi(renderReport({
    payload: null, totals: TOTALS, pricing: PRICES, balanceInfo: null,
    cfg: cfg(), transcriptPath: null, cwd: '/tmp',
  }));
  assert.match(out, /deepseek/);
  assert.match(out, /CNY/);
  assert.match(out, /(peak|off-peak)/);
});

test('没有价目表时给出明确提示，不显示金额', () => {
  const out = stripAnsi(renderReport({
    payload: null, totals: TOTALS, pricing: null, balanceInfo: null,
    cfg: cfg(), transcriptPath: null, cwd: '/tmp',
  }));
  assert.match(out, /no price table/);
  assert.doesNotMatch(out, /session cost\s+¥/);
});
```

（`cfg` 是该测试文件里已有的 `loadConfig` 助手；`stripAnsi` 也已从 `../src/render.js` 导入。）

- [ ] **Step 2: 运行测试，确认失败**

Run: `node --test test/report.test.js`
Expected: FAIL —— `prices` 参数不再被识别

- [ ] **Step 3: 改 `src/report.js`**

顶部加 `import { tierAt, nextTransition } from './pricing/schedule.js';`。签名改为 `{ payload, totals, pricing, balanceInfo, cfg, transcriptPath, cwd }`，全文 `prices` 改名 `pricing`。

金额那几行的 `costOf(totals, prices, { offPeakMultiplier: ... })` 改为 `costOf(totals, pricing)`。

在金额之后追加一段：

```js
  // 价格与时段：让「用的是哪份价目表、哪份日历、现在什么档」都看得见。
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
```

并加一个本地时间格式化辅助：

```js
/** 某时刻在 tz 下的墙上时间 HH:MM。 */
function formatClock(instant, tz) {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(instant);
  } catch {
    return instant.toISOString().slice(11, 16);
  }
}
```

- [ ] **Step 4: 运行全部测试（6 的四个阶段合起来在这里第一次验证）**

Run: `node --test 'test/*.test.js' 2>&1 | tail -5`
Expected: `# fail 0`

- [ ] **Step 5: 提交 —— 一次接口翻转只留一个提交**

```bash
git add -A src/config.js src/usage.js src/cli.js src/statusline.js src/report.js conf/default.env test/
git commit -m "refactor(pricing): 价格改由供应商 JSON 提供，状态栏显示时段与提醒"
```

---

### Task 7: 配置迁移（default.env + setup 版本 3）

**Files:**
- Modify: `conf/default.env`
- Modify: `src/setup.js:80-90`
- Test: `test/config.test.js`（补一个版本号断言）

**Interfaces:**
- Consumes: 无
- Produces: `conf/default.env` 的 `CC_CTX_CONFIG_VERSION=3` 与新键；setup 的版本 3 迁移告警

- [ ] **Step 1: 改 `conf/default.env`**

顶部版本号改为：

```
#   2 — price table switched from USD to CNY. A config still holding the old
#       USD numbers would have them read as CNY, understating cost ~6.7x.
#   3 — prices and peak/off-peak rules moved out of this file into JSON
#       (conf/providers/*.json, conf/calendars/*.json). Any CC_CTX_PRICE_*
#       or CC_CTX_PEAK_* keys below are no longer read.
CC_CTX_CONFIG_VERSION="3"
```

删除 `CC_CTX_PRICE_*` 全部键、`CC_CTX_PRICE_CURRENCY`、`CC_CTX_PEAK_WINDOWS`、`CC_CTX_PEAK_DAYS`、`CC_CTX_OFFPEAK_MULTIPLIER` 及其注释块（原第 26-64 行区域），换成：

```
# ── Prices ────────────────────────────────────────────────────────────────
# Prices are JSON now, not env vars. Shipped table: conf/providers/deepseek.json
# To change a price, copy that file to ~/.claude/cc-ctx/providers/ and edit it —
# your copy wins over the shipped one and survives plugin updates.
CC_CTX_PROVIDERS_DIR=""
CC_CTX_CALENDARS_DIR=""
# Holiday calendar data: shipped snapshot + optional background refresh.
CC_CTX_REMOTE="on"
CC_CTX_REMOTE_TTL_MS="86400000"
CC_CTX_PROVIDER_URL=""
CC_CTX_CALENDAR_URL=""

# ── Peak / off-peak ───────────────────────────────────────────────────────
# The windows themselves now live in the provider JSON (deepseek.json), because
# they are part of that provider's price list.
# Minutes before a tier switch at which the status line starts counting down.
CC_CTX_TIER_ALERT_MINUTES="20"
```

- [ ] **Step 2: 改 `src/setup.js` 的版本告警**

原第 80-90 行的告警分支换成按版本给不同文案：

```js
    const userVersion = configVersion(USER_ENV);
    if (userVersion < shippedVersion) {
      say('');
      say(`WARNING  your config predates version ${shippedVersion} (it is ${userVersion || 'unversioned'}).`);
      say('         Defaults whose meaning changed are NOT applied to an existing file.');
      if (userVersion < 3) {
        say('         Version 3 moved prices and peak/off-peak rules out of this file');
        say('         into JSON. CC_CTX_PRICE_* and CC_CTX_PEAK_* are no longer read.');
        say('         The shipped conf/providers/deepseek.json now provides the prices.');
        say('         If you had custom prices, copy that file to');
        say('         ~/.claude/cc-ctx/providers/deepseek.json and edit it there.');
      } else {
        say('         Version 2 switched the price table from USD to CNY — a config still');
        say('         holding the old USD numbers will have them read as CNY, understating');
        say('         cost by roughly 6.7x.');
      }
      say(`         Review ${USER_ENV}, or run:  cc-ctx setup --reset-config`);
      say('');
    }
```

- [ ] **Step 3: 补测试**

在 `test/config.test.js` 追加：

```js
test('configVersion 是 3', () => {
  const cfg = loadConfig({ env: {}, userEnvFile: path.join(os.tmpdir(), 'cc-ctx-missing.env') });
  assert.equal(cfg.raw.CC_CTX_CONFIG_VERSION, '3');
});
```

- [ ] **Step 4: 运行测试**

Run: `node --test 'test/*.test.js' 2>&1 | tail -5`
Expected: `# fail 0`

- [ ] **Step 5: 提交**

```bash
git add conf/default.env src/setup.js test/config.test.js
git commit -m "feat(config): 版本 3 —— 价格与时段迁到 JSON，补迁移告警"
```

---

### Task 8: README 与设计文档同步

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-09-30-cc-ctx-design.md`（旧设计文档的价格一节加注）

**Interfaces:**
- Consumes: 全部
- Produces: 与实现一致的文档

- [ ] **Step 1: 改 `README.md`**

把价格/峰谷一节换成：

```markdown
## Prices

Prices and peak/off-peak rules live in JSON, not in `cc-ctx.env`:

| 位置 | 作用 |
|---|---|
| `<plugin>/conf/providers/*.json` | 随插件分发的价目表 |
| `<plugin>/conf/calendars/*.json` | 内置的节假日日历 |
| `~/.claude/cc-ctx/providers/*.json` | 你的覆盖（优先级最高，升级不丢） |
| `~/.claude/cc-ctx/calendars/*.json` | 你的日历覆盖 |
| `~/.claude/cc-ctx/remote/` | 后台联网抓下来的缓存 |

**新增一个 API** = 往 `~/.claude/cc-ctx/providers/` 放一个 JSON 文件，代码零改动。

DeepSeek 的口径是北京时间周一至周五（不含中国法定节假日）09:00–12:00、14:00–18:00
为高峰，其余（含周末与节假日全天）为空闲，空闲价是高峰价的一半。调休上班日按高峰计
（比官方字面口径保守）。

状态栏的 `tier` 字段显示当前档位；距离下次切换 20 分钟内会追加倒计时，即将进入高峰
时转成醒目颜色（阈值用 `CC_CTX_TIER_ALERT_MINUTES` 调）。

数据会在后台刷新（默认 24h 一次，`CC_CTX_REMOTE=off` 可关）；失败时静默沿用缓存或
内置快照。**注意**：价格的「联网」只是让你自动拿到仓库里的更新，不会自动跟踪
DeepSeek 的定价变化。

> 从旧版本升级：`CC_CTX_PRICE_*` / `CC_CTX_PEAK_*` 已不再读取，改由上述 JSON 提供。
```

- [ ] **Step 2: 在旧设计文档的价格一节加注**

在 `docs/superpowers/specs/2026-09-30-cc-ctx-design.md` 的「## 花费公式」一节开头插入：

```markdown
> **2026-10-11 更新**：价格与峰谷规则已迁出 `cc-ctx.env`，改由 `conf/providers/*.json`
> 与 `conf/calendars/*.json` 提供，并补上了中国法定节假日。见
> `docs/superpowers/specs/2026-10-11-pricing-subsystem-design.md`。本节其余内容为历史记录。
```

- [ ] **Step 3: 跑全部测试与一次端到端**

Run: `node --test 'test/*.test.js' 2>&1 | tail -5`
Expected: `# fail 0`

Run: `node src/cli.js --transcript test/fixtures/session.jsonl`
Expected: 打印报告，含 `session cost`、`tier`、`pricing` 三行，无异常。

- [ ] **Step 4: 提交**

```bash
git add README.md docs/superpowers/specs/2026-09-30-cc-ctx-design.md
git commit -m "docs: 同步价格子系统到 README 与旧设计文档"
```

---

## 验收演练（全部任务完成后）

1. **扩展性**：`cp conf/providers/deepseek.json ~/.claude/cc-ctx/providers/`，把 `deepseek-flash.output` 从 `8.00` 改成 `16.00`，跑 `node src/cli.js --transcript test/fixtures/session.jsonl`，金额的 output 部分翻倍；**未改任何代码**。
2. **多供应商**：往 `~/.claude/cc-ctx/providers/` 放一个无 `schedule` 的 `anthropic.json`，用它的模型 id 跑报告：能计价，且**不显示** `tier` 行。
3. **时段**：`node -e` 里直接调 `tierAt` / `nextTransition`，验证 `2026-01-02T02:00Z` 空闲、`2026-01-04T02:00Z` 高峰、周五 18:30 后指向周一 09:00。
4. **降级**：临时重命名 `conf/calendars/cn.json` 后跑报告——不崩，只是节假日不再生效；把 `conf/providers/` 清空后跑——不崩，显示 `no price table for this model`。
5. **提醒**：把 `CC_CTX_TIER_ALERT_MINUTES` 设成 `100000` 强制进入提醒分支，确认状态栏出现 `→` 倒计时文案。
