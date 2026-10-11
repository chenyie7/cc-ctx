# cc-ctx

Claude Code 状态栏：context 用量、token 明细、缓存命中率、本次会话花费、账户余额。

```
 cc-ctx  deepseek-v4-flash[1M]  effort high  cache warm
 dir /Users/chenyi/ai-project/cc-ctx  session cc-ctx  duration 42m  lines +156/-23
 context ██████░░░░ 62% 620,000 / 1,000,000
 input 268,199  cache write 0  cache read 24,772,992  output 288,767
 hit rate 98.9%  calls 229  cost ¥4.12  balance ¥56.24  tier off-peak
```

宽度不够时自动换行；颜色、字段、顺序、分隔符都可配。

## 为什么需要它

Claude Code 状态栏输入里的 `context_window.current_usage` 是**最近一次 API 调用**的量，不是会话累计。直接拿它当"本次会话花费"会严重失真 —— 实测同一次会话：

| | 真实值 | 只看 `current_usage` |
|---|---|---|
| input（未命中） | 241,687 | 1,368 |
| cache read | 10,710,272 | 未计 |
| output | 130,111 | 285 |
| **花费** | **≈$0.293** | ≈$0.0022（**差约 130 倍**） |

Claude Code 自带的 `cost.total_cost_usd` 对第三方模型会用兜底价（实测 $5/$25 每百万），比 DeepSeek 真实价高约 15 倍，且自己会标注 `costBasis: "unknown"`。

cc-ctx 改为**从 transcript 累加真实用量**，按你自己配的价目表计价，并把子 agent 的消耗一并计入。

## 安装

需要 **Node.js 18+**（垫片会在 PATH 找不到 node 时，自动去 nvm / fnm / asdf / volta 的常见位置找）。

```
/plugin marketplace add chenyie7/cc-ctx
/plugin install cc-ctx@cc-ctx-marketplace
```

然后在 Claude Code 里跑一次接线：

```
!cc-ctx setup
```

> 若提示找不到 `cc-ctx`，用这条兜底：
> `!$(ls -d ~/.claude/plugins/cache/*/cc-ctx/*/bin/cc-ctx | tail -1) setup`

**重启 Claude Code 生效。**

`setup` 做四件事，全部可逆：

1. 把运行时复制到 `~/.claude/cc-ctx/`（插件更新会换目录，statusLine 不能直接指向插件位置）
2. 生成 `~/.claude/cc-ctx/cc-ctx.env`（已存在则不动，你的单价和配色不会被覆盖）
3. 软链 `~/.local/bin/cc-ctx`，这样你自己的终端也能用
4. 备份并改写 `~/.claude/settings.json` 的 `statusLine`

> **为什么必须有这一步**：插件**无法**自带 statusLine。manifest 的 `settings` 键只有 `agent` 和 `subagentStatusLine` 生效，其余在加载时被丢弃。这是 Claude Code 的硬限制。

### 升级

插件更新后需要重跑一次 `cc-ctx setup`，把新版本代码刷到 `~/.claude/cc-ctx/`：

```
/plugin            # 更新插件
!cc-ctx setup      # 刷新运行时
```

配置（`cc-ctx.env`）不会被覆盖。

## 用法

```
cc-ctx               本次会话详情报告
cc-ctx setup         安装 / 重新安装（升级后重跑可刷新脚本）
cc-ctx statusline    渲染一行状态栏（由 Claude Code 调用）
```

选项：`--transcript <path>`、`--session <id>`。

## 配置

编辑 `~/.claude/cc-ctx/cc-ctx.env`。这个文件**不随插件更新**，所以你的字段与配色不会丢。

```bash
CC_CTX_CURRENCY="CNY"; CC_CTX_SYMBOL="¥"
CC_CTX_FIELDS="brand model effort cache dir session duration lines context tokens hitrate calls cost balance"
```

价格与峰谷规则不在这个文件里，见下文「Prices」。**没有匹配到价目表时显示 `—`，不会拿别的模型的价格顶上。** 这是刻意的。

### 币种换算

```bash
CC_CTX_RATE="6.67"    # 价目表币种 → CC_CTX_CURRENCY
```

只有当**价目表币种 ≠ 展示币种**时才换算；价目表币种由供应商 JSON 的 `currency` 字段给出。

> ⚠️ **别用市场汇率换算 DeepSeek 的英文价目。** 英文页的 `$0.30` 对应中文页的 `¥2.00`，比值是 **6.67**，不是 7.15。用市场汇率会让结果偏高约 7%。人民币数字请直接用中文页的。

### 字段

| id | 含义 |
|---|---|
| `brand` | 前缀标识（`CC_CTX_BRAND`） |
| `model` / `effort` / `cache` | 模型、思考强度、prompt cache 冷热 |
| `dir` / `session` / `duration` / `lines` | 目录、会话名、时长、代码增删 |
| `context` | 进度条 + 百分比 + 已用/总量 |
| `tokens` | 展开为 input / cache write / cache read / output |
| `hitrate` / `calls` / `cost` / `balance` | 命中率、API 调用数、本次花费、余额 |

### 配色

真彩色 `38;2;R;G;B`，在 `COLORTERM` 未声明时自动降级为 256 色。`CC_CTX_TRUECOLOR=off` 强制 256 色。遵守 `NO_COLOR`。

```bash
CC_CTX_COLOR_LABEL="38;2;110;118;129"     # 标签
CC_CTX_COLOR_MODEL="38;2;198;160;246"
CC_CTX_COLOR_EFFORT="38;2;250;204;21"
CC_CTX_COLOR_DIR="38;2;56;189;248"
CC_CTX_COLOR_VALUE="38;2;226;232;240"
CC_CTX_COLOR_OK="38;2;74;222;128"         # 绿
CC_CTX_COLOR_WARN="38;2;250;204;21"       # 黄
CC_CTX_COLOR_HOT="38;2;248;113;113"       # 红
CC_CTX_COLOR_DIVIDER="38;2;71;85;105"
CC_CTX_COLOR_BAR_EMPTY="38;2;51;65;85"
```

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

## 口径

```
花费   = [高峰部分按高峰价，低谷部分按低谷价] / 1e6
命中率 = cache_read / (input + cache_write + cache_read)
```

分母是模型实际需要处理的全部输入 token。与 Claude Code 计算 `used_percentage` 的口径一致。

统计范围：主 transcript + `<session>/subagents/*.jsonl`。主 transcript 里若出现 `isSidechain` 记录会被跳过，避免与子 agent 文件重复计数。

每条 API 记录按**它自己的时间戳**判定时段、分别计价；时间戳缺失或无法解析时一律按**高峰**计价，绝不会静默打折。

## 余额

调用 `GET https://api.deepseek.com/user/balance`，key 从 `~/.claude/settings.json` 的 `env.ANTHROPIC_AUTH_TOKEN` 读取（可用 `CC_CTX_BALANCE_KEY` 覆盖）。

结果缓存 60 秒（`CC_CTX_BALANCE_TTL_MS`）。过期时**先显示旧值加 `?`**，同时在后台进程刷新 —— 状态栏永远不会为了一个网络请求卡住。

## 性能

transcript 最长见过 7.1 MB / 237 个文件。全量解析约 35 ms，但**只在文件变化时才解析**：缓存记 `{mtime, size}`，没变就直接复用（几次 `stat`，约 1 ms）。没有增量字节偏移那套东西。

## 测试

```
npm test
```

33 个用例，覆盖累加与分桶、子 agent 合并、缓存命中与失效、损坏行容忍、颜色降级、折行边界、宽字符宽度、价格表解析与拒绝兜底。

## 已知边界

- **不在 Anthropic 官方插件市场** —— 那些名字保留给官方策展。这里通过 GitHub 仓库分发。
- 余额接口是 **DeepSeek 专有**的；换 provider 需改 `CC_CTX_BALANCE_URL`，其他厂商的响应格式不同，需自行适配。
- 价格默认人民币，与展示币种一致，不做换算；换成美元价目表时才用 `CC_CTX_RATE`，汇率不会自动更新。
- 调休上班日按高峰计价（见上文「Prices」），比官方字面口径保守。
- `cost` 统计的是 transcript 里全部记录，**不随 `/clear` 归零**（Claude Code 自带的 `cost.total_cost_usd` 会归零）。
- **成本是估算不是账单**。依据是官方价目页；DeepSeek 没有按会话查费的接口，只有账户总余额。余额本身有结算滞后，不足以把价格校验到 ±20% 以内。
