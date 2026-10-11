# cc-ctx 价格子系统设计

日期：2026-10-11
状态：设计已确认，待评审

## 1. 背景与问题

价格计算现在散落在三处，且与 DeepSeek 强绑定：

- `src/config.js` 的 `resolvePrices()` 从 `cc-ctx.env` 的 `CC_CTX_PRICE_<KEY>_*` 读价目表；
- `src/peak.js` 把峰谷规则硬编码成「UTC 窗口 + 星期 + 单一折扣系数」，并在注释里承认**不建模中国法定节假日**——这是已知缺口，会导致高估；
- `src/usage.js` 的 `costOf()` 只会「高峰价 × 高峰 token + 高峰价 × 折扣 × 空闲 token」。

后果：换一个 API、改一次价格、补一年的节假日，都要动代码。而峰谷规则本身也没按官方原文表述（官方是北京时间，我们用 UTC；官方把「不含法定节假日」写在高*峰*的定义里，我们当成额外覆盖）。

## 2. 目标与非目标

**目标**

1. 价格成为独立、可扩展的子系统：**新增一个 API = 新增一个 JSON 文件，代码零改动**。
2. 峰谷判定严格对齐 DeepSeek 官方口径，并补上中国法定节假日。
3. 状态栏与报告能显示**当前处于高峰还是空闲**，以及**距离下次切换还有多久**，临近切换时给出提醒。
4. 价格与日历数据能保持新鲜，但不牺牲「状态栏绝不能崩、绝不能空」这条既有底线。

**非目标（本次不做）**

- 余额 API 的供应商化（`src/balance.js` 本次不动）；
- 渲染层、折行、配色的重构；
- 按子 agent 的模型分别计价（见 §10 已知近似）。

## 3. 决策记录

| # | 决策 | 依据 |
|---|---|---|
| D1 | 供应商定义用 **JSON 文件**，随插件分发 + 用户目录覆盖 | 嵌套结构用环境变量表达很别扭；「加文件」才是真正的零代码扩展 |
| D2 | 节假日日历**内置快照 + 后台联网更新**，用户文件优先 | 既是离线的兜底，又能自动跟上 |
| D3 | **调休上班日按高峰价** | 用户判断官方文档可能未随之更新；偏保守，不低估 |
| D4 | 本次交付三层：算对钱 + 时段可见 + 临近提醒 | 用户明确要求 1/2/3 全要 |
| D5 | 提醒**双向、常驻**：常显当前时段，≤阈值时追加倒计时 | 状态栏宽度宝贵，常驻时段 + 临阈倒计时兼顾信息与简洁 |
| D6 | 时段推算用 **A 方案**：即时判定 + 解析式推演 | 无横向限制（transcript 可能横跨数周），无状态，改动面最小 |

### 官方口径（原文，api-docs.deepseek.com/zh-cn/quick_start/pricing/）

> **高峰时段**：北京时间周一至周五（**不含中国法定节假日**）**9:00 - 12:00、14:00 - 18:00**
> **空闲时段**：**其余时段，包括周末及中国法定节假日全天**均为空闲时段
> **空闲时段价格为高峰时段价格的一半**

价格表（元 / 百万 tokens）：

| 模型 | 项目 | 空闲 | 高峰 |
|---|---|---|---|
| `deepseek-flash`（旧名 `deepseek-v4-flash`、`deepseek-v4-flash-vision-exp` 同价） | 输入 · 缓存命中 | 0.02 | 0.04 |
| | 输入 · 缓存未命中 | 1 | 2 |
| | 输出 | 4 | 8 |
| `deepseek-v4-pro`（DeepSeek-V4-Pro-0813） | 输入 · 缓存命中 | 0.15 | 0.30 |
| | 输入 · 缓存未命中 | 4.5 | 9.0 |
| | 输出 | 13.5 | 27.0 |

并发限制：`deepseek-flash` 2500，`deepseek-v4-pro` 500（本子系统不使用，仅记录）。

## 4. 架构

```
src/pricing/                 ← 价格子系统，只依赖 node 内置模块
  index.js      对外入口：loadProviders(cfg) / resolvePricing(cfg, modelId)
  provider.js   读 + 校验供应商 JSON；模型 id 归一化；精确匹配（含别名）
  schedule.js   时段引擎：buildSchedule() / tierAt() / nextTransition()
  calendar.js   日历：内置+远程+用户合并、区间展开、内容指纹、远程格式适配
  remote.js     远程抓取与缓存（供后台子进程调用）
conf/
  providers/deepseek.json   随插件分发的供应商定义
  calendars/cn.json         中国法定节假日 + 调休上班日
```

`src/peak.js` 删除，能力并入 `src/pricing/schedule.js`；`test/peak.test.js` 迁为 `test/schedule.test.js`。

**对外接口**——计价与时段的边界清晰，互不依赖：

```js
// 计价：模型 → 费率
resolvePricing(cfg, modelId) → {
  providerId, currency,
  peak:    { input, cacheWrite, cacheRead, output },
  offPeak: { input, cacheWrite, cacheRead, output },
  schedule,                     // 交给时段引擎；无峰谷的供应商为 null
  source                        // { kind: 'bundled'|'user'|'remote', fetchedAt? }
} | null                        // 模型无价目表 → null，绝不借用别的模型的价格

// 时段：时刻 → 档位
tierAt(instant, schedule)          → 'peak' | 'offPeak'
nextTransition(instant, schedule)  → { at: Date, tier: 'peak' | 'offPeak' } | null
```

## 5. 数据模型

### 5.1 供应商（`conf/providers/deepseek.json`）

```json
{
  "id": "deepseek",
  "currency": "CNY",
  "offPeakMultiplier": 0.5,
  "models": {
    "deepseek-flash": {
      "aliases": ["deepseek-v4-flash", "deepseek-v4-flash-vision-exp"],
      "input": 2.00, "cacheWrite": 2.00, "cacheRead": 0.04, "output": 8.00,
      "offPeak": { "input": 1.00, "cacheWrite": 1.00, "cacheRead": 0.02, "output": 4.00 }
    },
    "deepseek-v4-pro": {
      "input": 9.00, "cacheWrite": 9.00, "cacheRead": 0.30, "output": 27.00,
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

取舍：

- **`aliases` 而非把 flash 价目表抄三遍**：官方写明旧名仍在用且同价，显式声明别名关系既准确又不必重复数字。
- **只有精确匹配，没有通配**（2026-10-12 决定，原先保留的 `deepseek-*` 通配能力已移除）：通配是这里唯一能产出「静默算错」的机制——DeepSeek 出了新模型，`deepseek-*` 会让它悄悄按 Flash 的价计价，而那正是本项目当初要修的 bug。代价是多写几个模型名；收益是不存在算错却不报错的可能。匹配不到就显示「无价目表」。
- **`cacheWrite` 与 input 同价**：DeepSeek 不单独计缓存写入（Claude Code 侧该字段恒为 0），写上只为四桶齐全时校验能通过。
- **`offPeak` 可选**：缺省则按 `offPeakMultiplier` 折算。显式写出空闲价，是为了让 JSON 能直接对着官方价格表核对。

**校验规则**：`input`/`cacheWrite`/`cacheRead`/`output` 四个键必须齐全且为有限数字，否则**整个模型作废**（返回 null），不做半价、不回退到别的模型。

### 5.2 日历（`conf/calendars/cn.json`）

`holidays` = 全天空闲的日期；`workdays` = 调休上班日。区间用 `{from,to}` 写，便于对着国务院通知逐条核对。

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

数据来源：2025 年 —— 国办发明电〔2024〕12 号（2024-11-12）；2026 年 —— 国办发明电〔2025〕7 号（2025-11-04）。两份均已在中国政府网逐条核对，2026 年另与 `NateScarlet/holiday-cn` 交叉比对一致。

## 6. 时段引擎

### 6.1 判定规则

```
tierAt(instant, schedule):
  if (!instant || !schedule) → 'peak'            // 未知一律按高峰，永不静默打折
  d = new Date(instant); if (isNaN(d)) → 'peak'
  win = 按 schedule.tz 取得 { 本地日期, ISO 星期(1..7), 当日分钟 }
  cal = schedule.calendar                         // 可能为 null

  if (cal && cal.holidays.has(win.date))              → 'offPeak'   // 节假日全天空闲
  isWorkday = cal && cal.workdays.has(win.date)
  if (!isWorkday && !schedule.days.has(win.weekday))  → 'offPeak'   // 周末全天空闲
  if (schedule.windows 内有窗口命中 win.minutes)      → 'peak'
  → 'offPeak'
```

- `workdaysArePeak: true` 时，调休上班日绕过「周末即空闲」这一条，继续走窗口判定 → 高峰（D3，比官方文档保守）。
- 窗口**含头不含尾**（与现有 `parsePeakWindows` 语义一致）。
- 时区：`schedule.tz` 与 `cal.tz` 都是 `Asia/Shanghai`。中国无夏令时，所以本地↔UTC 是固定 +8；实现仍走 `Intl.DateTimeFormat`（缓存的 formatter），不硬编码偏移，以便将来接别的时区。
- 某年日历缺失 → 该年只按星期判定，等价于改动前的行为：**会高估，不会低估**。

### 6.2 下一次切换（A 方案）

时段只可能在两类时刻发生翻转：**窗口边界**（北京 09:00 / 12:00 / 14:00 / 18:00）与**本地零点**（跨日导致星期或节假日状态改变）。因此：

```
nextTransition(from, schedule):
  nowTier = tierAt(from)
  对 from 之后 horizonDays(=32) 天内的每个本地日期 D:
      候选时刻 ∪= { D 的每个窗口起点、窗口终点、D 的本地零点 }
  按时间排序，取第一个 t 使 tierAt(t) !== nowTier
  → { at: t, tier: tierAt(t) } ；枚举完仍未翻转 → null
```

- 32 天足以跨过任何假期（最长春节 9 天），且候选时刻每次渲染只有几十个，代价可忽略。
- `nextTransition` 每次渲染只调用一次；`tierAt` 才在 transcript 热路径上被逐条调用，因此 `tierAt` 保持轻量（`Intl` formatter 按 tz 缓存复用）。

## 7. 数据保鲜

### 7.1 三级优先级

```
~/.claude/cc-ctx/providers|calendars/   用户手写，永远最高
~/.claude/cc-ctx/remote/                联网缓存（含抓取时间）
<plugin>/conf/providers|calendars/      内置快照，兜底
```

### 7.2 远程源

| 数据 | 默认源 | 覆盖用配置键 |
|---|---|---|
| 价格 + 时段规则 | `https://cdn.jsdelivr.net/gh/chenyie7/cc-ctx@main/conf/providers/{id}.json` | `CC_CTX_PROVIDER_URL` |
| 节假日日历 | `https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/{year}.json` | `CC_CTX_CALENDAR_URL` |

两个 URL 都是模板：`{id}` 为供应商 id，`{year}` 为四位年份。指向自己的镜像或内网地址都行；设为空字符串即禁用该项的联网。

节假日源格式为 `{ year, papers, days: [{ name, date, isOffDay }] }`。`calendar.js` 按「是否存在 `days` 数组」自动识别两种格式：原生格式直接用；holiday-cn 格式转换为 `holidays`（`isOffDay: true`）与 `workdays`（`isOffDay: false`）。

**必须明确**：价格的「联网」**不等于**自动跟踪 DeepSeek。它的作用是把「维护者更新本仓库的 JSON」变成「用户后台自动拿到」。价格若变化，仍需有人更新仓库里的文件（或加 CI 定时核对并提交）。

### 7.3 刷新策略

- TTL `CC_CTX_REMOTE_TTL_MS`，默认 **24h**。
- 过期则 fork 一个 detached 子进程执行 `cc-ctx remote-refresh`，**当前这次渲染绝不等它**（复用 `src/balance.js:136-147` 的 `scheduleRefresh` 写法）。
- 比余额更宽松：因为我们永远有内置快照，**任何时候都不阻塞**。
- 日历只拉**当前年与下一年**。
- 开关：`CC_CTX_REMOTE=off` 完全关闭联网。
- 抓取成功才写缓存；写缓存走临时文件 + rename（与 `src/cache.js` 一致）。

### 7.4 来源可见

每个加载到的供应商/日历都带 `{ kind: 'bundled' | 'user' | 'remote', fetchedAt?, file }`。报告里显示，例如：

```
pricing   deepseek · CNY · schedule cn (remote · 2026-10-11)
```

这样「正在用旧数据」是看得见的，而不是静默算错。

## 8. 计价与缓存

### 8.1 计价

```js
costOf(totals, pricing):
  if (!pricing) → null
  peakTokens = totals - totals.offPeak        // 逐桶相减，钳到 ≥ 0
  return (Σ peakTokens·pricing.peak + Σ offTokens·pricing.offPeak) / 1e6
```

去掉现有 `costOf` 的 `offPeakMultiplier` 选项（`src/usage.js:290-308`）。

无峰谷的供应商：`schedule: null` → `tierAt` 恒为 `'peak'` → 全部 token 落在高峰桶 → 等价于单一价目表。

### 8.2 缓存键

`scheduleKey()` 必须纳入**日历内容指纹**（`holidays` + `workdays` 的排序哈希）：缓存里存的是峰/谷分桶，改了节假日表就必须让它失效。

**价格本身不进缓存键**——价格在渲染期才应用，所以改价立即生效、且不触发重新解析 transcript。这个性质要保住。

## 9. UI：tier 字段与提醒

新增字段 id `tier`，接入现有 `CC_CTX_FIELDS` 与 `buildItem()` 的 switch，默认排在 `cost` 旁。

```
tier off-peak                     平时：空闲 = ok 色，高峰 = warn 色
tier off-peak · 12m→peak          ≤ 阈值：追加倒计时与箭头
tier peak · 8m→off-peak           即将变便宜，颜色保持正常
```

- 阈值 `CC_CTX_TIER_ALERT_MINUTES`，默认 **20**；倒计时复用 `formatDuration()`（`src/statusline.js:18-25`）。
- **即将进入高峰**时整段用 hot 色——钱要变贵，是最该被看见的一刻；进入空闲不变色。
- 供应商无 schedule（如将来的 Anthropic）→ 该字段自动不渲染。
- 详情报告新增一段：供应商 / 币种 / 当前时段 / 下次切换的具体时刻（北京时间）/ 数据来源与抓取时间。

## 10. 兼容性、已知近似、失败模式

**配置迁移**：`cc-ctx.env` 里的 `CC_CTX_PRICE_*` 与 `CC_CTX_PEAK_*` 不再生效，价格与时段改由 JSON 提供。配置版本升到 **3**，沿用 `src/setup.js` 已有的版本告警机制提示迁移，`cc-ctx setup --reset-config` 可从默认值重建（会先备份）。新增键：`CC_CTX_PROVIDERS_DIR`、`CC_CTX_CALENDARS_DIR`、`CC_CTX_TIER_ALERT_MINUTES`、`CC_CTX_REMOTE`、`CC_CTX_REMOTE_TTL_MS`、`CC_CTX_PROVIDER_URL`、`CC_CTX_CALENDAR_URL`。

**用户级覆盖的位置**：必须放在 `~/.claude/cc-ctx/providers|calendars/`，**不能**放在 `~/.claude/cc-ctx/conf/` 下——`setup.js` 会递归删除并重拷 `conf`（`src/setup.js:41-49`），放在里面会被升级覆盖。与现有 `cc-ctx.env` 放在 `INSTALL_DIR` 根目录的做法一致。

**已知近似（本次不扩大范围）**：transcript 解析期只有一个 schedule，取自「当前会话模型所属的供应商」。若子 agent 跑在别的供应商上，其 token 仍落在同一套峰/谷桶里，并按主模型的价目表计价。这在本次改动之前就存在（`costOf` 一直用主模型价目表），只写进注释与 README。

**失败模式一律不变**：

- 模型无价目表 → 状态栏显示 `—`，报告写明 `no price table for this model`，绝不借用别的模型的价格；
- 远程失败 → 静默使用缓存/内置，状态栏照常渲染；
- 日历缺年 → 该年只按星期判定（高估）；
- 任何异常 → 输出上一份成功渲染结果或最小信息，进程恒 `exit 0`。

## 11. 测试

沿用 `node:test` 与 `test/fixtures/`，不测真实网络（远程抓取以注入的 fetch 替身覆盖）。

新增：

- `calendar.js`：区间展开、单日与区间混排、非法日期忽略、内容指纹随内容变化、holiday-cn 格式转换（`isOffDay` 双向）。
- `schedule.js`：窗口含头不含尾；周末全天空闲；节假日全天空闲；**调休上班日按高峰**；跨年边界；未知/非法时间戳按高峰；`workdaysArePeak: false` 时退回官方字面口径；`nextTransition` 的正确性与边界（窗口内、窗口间隙、跨零点、跨假期、假期中）。
- `provider.js`：精确匹配、别名匹配、用户目录覆盖内置、四桶不全时整个模型作废、无匹配返回 null、前缀相同但不完全相同的名字**不得**命中。
- `pricing/index.js`：`resolvePricing` 端到端（含 `offPeak` 缺省时按 `offPeakMultiplier` 折算）。
- `usage.js`：`costOf` 按两档价目表分别计价；缓存键随日历指纹失效、但**不**随价格变化失效。

用真实日期断言：

- `2026-01-02T02:00Z`（周五 10:00 北京，元旦假期内）→ 空闲
- `2026-01-04T02:00Z`（周日 10:00 北京，调休上班）→ 高峰
- `2026-02-17T02:00Z`（周二 10:00 北京，春节假期内）→ 空闲
- `2026-09-29T02:00Z`（周二 10:00 北京，非节假日）→ 高峰

## 12. 验收

1. `node --test 'test/*.test.js'` 全绿（现有 79 个用例中受影响的已迁移，加上新增用例）。
2. `cc-ctx --transcript test/fixtures/session.jsonl` 的 session cost 与手算一致。
3. **扩展性演练**：把 `deepseek.json` 复制到用户目录、改动一个价格，报告金额随之变化且**无需改任何代码**；再放一份 `anthropic.json`（无 schedule），`claude-*` 模型能被它计价且不显示 `tier` 字段。
4. **时段演练**：在受控时钟下验证 `tier` 字段与倒计时文案，含「即将进入高峰」的 hot 配色。
5. **降级演练**：断网 / 删除内置日历 / 使用无价目表的模型，三种情况下状态栏都正常渲染不崩溃。

## 13. 后续（不在本次范围）

- 余额 API 与模型识别的供应商化；
- 用 CI 定时核对 DeepSeek 价格页并自动提交 `conf/providers/deepseek.json`；
- 按子 agent 模型分别计价（需要把 token 分桶细化到模型维度）。
