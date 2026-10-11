# cc-ctx — Claude Code 会话状态栏与花费统计插件

日期：2026-09-30
状态：已确认，开始实现

## 目标

把 `~/.claude/statusline-context-stats.sh`（2026-09-02 写的）替换为一个可分发插件，在状态栏显示：

- 当前模型、思考强度（effort）
- 工作目录、会话名、时长、代码增删行
- context 使用量与进度条
- token 明细：input / cache write / cache read / output（全词，不缩写）
- **缓存命中率**（自算，含子 agent）
- **本次会话累计花费**（自算，DeepSeek 真实价）
- **DeepSeek 账户余额**

同时提供终端命令 `cc-ctx` 查看详情报告。

## 背景：现有脚本的三个错误

现有脚本用 `.context_window.current_usage` 取 token，用硬编码的 Claude 价格档位算钱。实测本次会话：

| | 真实值 | 现有脚本 | Claude Code `cost.total_cost_usd` |
|---|---|---|---|
| input（未命中） | 241,687 | 1,368 | — |
| cache read | **10,710,272** | **未计** | — |
| output | 130,111 | 285 | — |
| 命中率 | 97.8% | 不显示 | 不显示 |
| 花费 | **≈$0.293** | ≈$0.0022（**差约 130 倍**） | ≈$4.46（**高约 15 倍**） |

三个 bug：

1. **价格表错误** — `deepseek-v4-flash` 匹配不到任何 Claude 档位，落进 `*)` 默认按 Haiku（$0.8/$4.0）计价
2. **公式漏 cache** — cache read 是 input 的 44 倍，整个未计入
3. **口径错误** — `current_usage` 是「最近一次 API 调用」，不是会话累计

## 关键决策与依据

### 用 Node

实测数据（本机）：

| 运行时 | 启动开销 | 状态栏最小环境可用 |
|---|---|---|
| bash / jq / curl | <1ms | ✅ `/usr/bin` |
| python3 | 21ms | ⚠️ Xcode CLT 跳板，3.9 |
| node | 30ms | ❌ **不在 PATH**（nvm 装，需 .zshrc） |

选 Node 的理由：原生 JSON（不需 jq）、内置 fetch（不需 curl）、`node:test` 可写真单测。
7MB transcript 实测解析 34.7ms，端到端 79ms，与 jq 的 74ms 持平。

**PATH 问题用 POSIX sh 垫片解决**：`bin/cc-ctx` 是 shell 脚本，运行时先 `command -v node`，失败则遍历 `~/.nvm/versions/node/*/bin/node` 取最高版本，再 `exec`。垫片是 shell（永远可用），node 路径每台机器自行解析。

### 花费留在状态栏，用 mtime+size 缓存

```
读 transcript_path → 解析 JSONL 累加 usage → 乘价目表 → 结果写 cache.json
                     ↑ 先比 {mtime, size}，没变直接用缓存（~1ms）
```

**不用增量字节偏移解析。** transcript 只在会话推进时变化，绝大多数刷新命中缓存。

### 同时统计子 agent

子 agent 用量记在 `<session_id>/subagents/*.jsonl`（全盘 164 个）。不统计会漏。

### 插件无法自带 statusLine

插件 manifest 的 `settings` 键只承认 `agent` 和 `subagentStatusLine`，其余加载时丢弃（文档与二进制白名单 `["agent","subagentStatusLine"]` 双重确认）。因此 `cc-ctx setup` 必须跑一次，负责接线。

### 锚定稳定路径

`${CLAUDE_PLUGIN_ROOT}` 在插件更新后变化，statusLine 写死会失效。`setup` 把 `bin/` + `src/` + `conf/` 复制到 `~/.claude/cc-ctx/`，settings.json 指向那里。

## 架构

```
cc-ctx/
├── .claude-plugin/{plugin.json,marketplace.json}
├── bin/cc-ctx              POSIX sh 垫片：定位 node → exec src/cli.js
├── src/
│   ├── cli.js              子命令分发
│   ├── config.js           配置加载 + 默认价目表
│   ├── usage.js            transcript 累加 + 计价 + 命中率
│   ├── balance.js          DeepSeek 余额查询 + 缓存
│   ├── render.js           颜色 / 可见宽度 / 千分位 / 折行
│   ├── statusline.js       状态栏渲染
│   ├── report.js           详情报告渲染
│   └── setup.js            接线 settings.json
├── conf/default.env        价目表默认值（兜底）
├── test/
└── README.md
```

## 数据流

```
Claude Code ──stdin JSON──> bin/cc-ctx statusline
                              ├─ 直取：model / dir / session / effort
                              │        context% / ctx_size / prompt_cache
                              │        duration / lines / COLUMNS
                              ├─ usage.js：transcript(+subagents) → 累计 token + 花费 + 命中率
                              │        （mtime+size 命中则读 cache.json）
                              └─ balance.js：余额缓存（60s TTL，过期后台刷新）
                                        ↓
                                  render.js 折行上色
```

## 配置

`~/.claude/cc-ctx/cc-ctx.env`（**不进插件**，更新插件不覆盖）：

```bash
CC_CTX_CURRENCY="CNY"; CC_CTX_SYMBOL="¥"; CC_CTX_RATE="7.15"
CC_CTX_PRICE_DEEPSEEK_V4_FLASH_INPUT="0.30"
CC_CTX_PRICE_DEEPSEEK_V4_FLASH_CACHE_READ="0.006"
CC_CTX_PRICE_DEEPSEEK_V4_FLASH_CACHE_WRITE="0.30"
CC_CTX_PRICE_DEEPSEEK_V4_FLASH_OUTPUT="1.20"
CC_CTX_FIELDS="model effort cache dir duration lines context tokens hitrate cost balance"
CC_CTX_GAP="  "; CC_CTX_DIVIDER=" │ "; CC_CTX_PADDING="1"
CC_CTX_TRUECOLOR="auto"; CC_CTX_THEME="dark"
CC_CTX_COLOR_LABEL="38;2;110;118;129"
CC_CTX_COLOR_MODEL="38;2;198;160;246"
CC_CTX_COLOR_EFFORT="38;2;250;204;21"
CC_CTX_COLOR_DIR="38;2;56;189;248"
CC_CTX_COLOR_VALUE="38;2;226;232;240"
CC_CTX_COLOR_OK="38;2;74;222;128"
CC_CTX_COLOR_WARN="38;2;250;204;21"
CC_CTX_COLOR_HOT="38;2;248;113;113"
CC_CTX_COLOR_DIVIDER="38;2;71;85;105"
CC_CTX_COLOR_BAR_EMPTY="38;2;51;65;85"
```

## 视觉设计

- **层次**：标签暗灰、值高亮 —— 可扫读性的关键
- **分组**：组内 2 空格，组间暗色 `│` + 两侧 3 空格
- **真彩色** `38;2;R;G;B`；`TRUECOLOR=auto` 时检测 `COLORTERM`
- **折行**：按 `COLUMNS` 去掉 ANSI 后的可见宽度贪心装填
- 遵守 `NO_COLOR`

```
 cc-ctx   deepseek-v4-flash[1M]   effort high   cache warm
 dir /Users/chenyi/ai-project/cc-ctx   session 42m
 context ▓▓▓▓▓▓░░░░ 62%   620,000 / 1,000,000
 input 241,687  │  cache write 0  │  cache read 10,710,272  │  output 130,111
 hit rate 97.8%  │  calls 144  │  cost $0.2929  │  balance ¥57.42
```

## 花费公式

> **2026-10-11 更新**：价格与峰谷规则已迁出 `cc-ctx.env`，改由 `conf/providers/*.json`
> 与 `conf/calendars/*.json` 提供，并补上了中国法定节假日。见
> `docs/superpowers/specs/2026-10-11-pricing-subsystem-design.md`。本节其余内容为历史记录。

```
cost = (input·P_input + cache_write·P_write + cache_read·P_read + output·P_output) / 1e6
命中率 = cache_read / (input + cache_write + cache_read)
```

价格以 USD/M 计（DeepSeek 官方页），展示时按 `RATE` 换算成 `CURRENCY`。

> 注意：DeepSeek 的 `prompt_tokens` 语义上包含 cache hit，但 Claude Code 写入 transcript 时已归一化为不重叠分桶（`input_tokens` / `cache_creation_input_tokens` / `cache_read_input_tokens` 三者相加才是总输入，见官方 `used_percentage` 公式）。实现时需以 fixture 验证不重复计算。

## 错误处理

状态栏**绝不能崩、绝不能空**：

- 任何异常 → 输出上一份成功渲染结果 + `⚠`；再不行输出最小信息
- 余额查不到 → 显示上次值 + stale 标记；从未成功 → `¥—`
- transcript 不存在/不可读 → 省略花费字段，其余照常
- 进程恒 `exit 0`

## 测试

`node:test`，覆盖：

- `usage.js` — 累加、分桶不重叠、子 agent 合并、mtime+size 缓存命中与失效、损坏行跳过
- `render.js` — 可见宽度（含 ANSI）、折行边界、千分位、颜色降级、NO_COLOR
- `config.js` — 默认值、env 覆盖、缺失字段兜底
- `balance.js` — 响应解析、新鲜度、失败回退

不测真实网络和真实 transcript，全部用 `test/fixtures/` 文件。

## 分发

**无法进入 Anthropic 官方市场**（名字保留、官方策展）。自有 GitHub 仓库可行：

```
/plugin marketplace add <user>/cc-ctx
/plugin install cc-ctx@<marketplace-name>
cc-ctx setup
```

## 验收

1. `node --test` 全绿
2. `cc-ctx` 在终端输出详情报告，数字与手工核算一致
3. `cc-ctx setup` 后状态栏显示新格式，且旧脚本被备份
4. 本会话实测：cache read ≈ 10.7M、命中率 ≈ 97.8%、花费 ≈ $0.29
