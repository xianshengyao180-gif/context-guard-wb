# context-guard（WorkBuddy 版）

> **在上下文塞满之前提醒你，并把工作无缝交接给新会话。**
>
> 这是 [dsh-context-guard](https://github.com/xianshengyao180-gif/dsh-context-guard) 的 WorkBuddy 移植版：
> 能力一致，读取的会话日志格式与路径不同（WorkBuddy 是明文 JSONL，无需 zstd 解压）。

长会话上下文膨胀后，模型会开始丢内容、截断、甚至停止输出；换会话又得把目标、决策、踩过的坑从头再讲一遍。
本技能把这两件事变成一条命令：读 WorkBuddy 自己的会话日志拿到**真实**上下文占用，到线提醒，然后生成一份能直接粘贴到新会话的交接文档。

纯 Node 脚本：**零第三方依赖、零构建、零网络请求**，只读文件系统。

## 特性

| 能力 | 说明 |
| --- | --- |
| 真实占用测量 | 取会话日志里 provider 上报的 `providerData.usage.totalTokens` 作为锚点，而不是凭感觉估算 |
| 两级阈值提醒 | 提醒线 / 临界线均可配置；越线输出中文提醒块，含"距临界还差多少步 / 多少回合" |
| 提醒不刷屏 | 按「会话 + 等级」落盘去重，同级只提醒一次；`--force` 可强制再提醒 |
| 交接文档 | 自动采集最近对话、工具动作、待办、交付物、改动文件、git 分支/HEAD；判断性段落留给模型补 |
| 新会话开场白 | 一段可直接粘贴的文本，首行含 `/context-guard`，新会话会自动加载同一套协议 |
| 配置四层覆盖 | 技能默认 → 工作区文件 → 环境变量 → 命令行 |
| 跨沙箱可用 | 不依赖 git、不依赖子进程、不联网；git 不可用时改从 `.git` 目录读分支/HEAD |
| 可自动化 | `--json` 输出结构化结果；`--exit-code` 让 warn→10、critical→20 |
| **交接自检** | `--verify` 机械校验交接文档：FILL 是否补完、每个决策能否在其载体文件里 grep 到、章节/开场白/链指针是否完整。退出码 0/1，可当门禁 |
| **链式接力** | 交接文档带 `chain` / `hop` / `previous` 指针，多棒接力可回溯，且明确要求"只在缺信息时回读，不通读全链"；交接目录里维护 `LATEST` 稳定指针 |
| **跨 agent 导出** | `--portable` 生成环境无关的 `HANDOFF.md`，剥掉本机专属路径与命令，可直接交给 Claude Code / Codex / Cursor |
| **hook 接线（可选）** | `hooks/` 内置一个脚本服务 SessionStart / UserPromptSubmit 两个事件，异常一律静默退出，绝不打断会话 |

## 安装

前置条件：

| 项 | 要求 |
| --- | --- |
| Node.js | **≥ 18**（只需 `node:fs` / `node:path` 等内置模块；无 zstd 依赖）。本技能在 Node 22 上实测 |
| WorkBuddy | 需要能读到会话日志 `~/.workbuddy/projects/<项目键>/<会话 id>.jsonl`；也可用 `--log` 指向任意 JSONL |

技能是目录包，WorkBuddy 会扫描 `<技能根>/<名字>/SKILL.md`。把本目录放到任一技能根下即可：

```powershell
# 用户级：所有项目都能用（推荐）
#   把本目录复制/移动到 $env:USERPROFILE\.workbuddy\skills\context-guard-wb
# 项目级：只在某个工作区生效
#   放到 <工作区>\.workbuddy\skills\context-guard-wb
```

无需 `npm install`，也无需重启。验证安装：

```powershell
$base = "$env:USERPROFILE\.workbuddy\skills\context-guard-wb"
node "$base\scripts\context-usage.mjs" --help   # 应打印中文帮助
node "$base\scripts\context-usage.mjs"          # 应打印一行 CTX …
```

## 快速使用

```powershell
$base = "$env:USERPROFILE\.workbuddy\skills\context-guard-wb"

node "$base\scripts\context-usage.mjs"           # 一行摘要；越线时附中文提醒块
node "$base\scripts\context-usage.mjs" --json     # 机器可读的完整 JSON
node "$base\scripts\handoff.mjs"                  # 生成交接文档 + 打印新会话开场白
node "$base\scripts\handoff.mjs" --verify --doc <交接文档路径>   # 机械自检（补完 FILL 后必跑）
node "$base\scripts\handoff.mjs" --portable       # 导出跨 agent 的 HANDOFF.md
```

也可以直接在对话里说「上下文快满了」「准备交接」或用 `/context-guard` 触发。

**真实运行输出**（会话持续增长，故读数略有差异；路径已替换为占位符）：

```text
CTX 44.1% | 88k/200k | level=ok | warn@70% | critical@90% | turns=2 | steps=1123 | perStep~79
session=<会话 id 前 8 位> model=?/deepseek-v4.1-flash window=windowFallback
anchor=usage:88k@seq1232 +delta~0 (1123 surface nodes)
log=~/.workbuddy/projects/<项目键>/<会话 id>.jsonl
```

越过提醒线时多输出一段提醒块：

```text
CTX 72.3% | 145k/200k | level=warn(new) | warn@70% | critical@90% | turns=5 | steps=420 | perStep~345 | ~102stepsToCritical

⚠ 上下文已用 72.3%（145k/200k），超过提醒线 70%。
   按当前增速（约 345/步）距临界线（90%）约还有 102 步（≈20 个回合）。
   建议：只收尾当前这一步，不再开新战线；准备交接时运行 handoff 脚本（见 SKILL.md "交接"一节）。
```

## 阈值配置（四层，后者覆盖前者）

| 层 | 位置 | 例子 |
| --- | --- | --- |
| 1 技能默认 | 本目录 `config.json` | `{"warnAt": 0.7, "criticalAt": 0.9}` |
| 2 工作区 | `<工作区>/.workbuddy/context-guard.json`（只写要改的字段） | `{"warnAt": 0.6}` |
| 3 环境变量 | `WB_CTX_WARN` / `WB_CTX_CRITICAL` / `WB_CTX_WINDOW` / `WB_CTX_HANDOFF_DIR` / `WB_CTX_NO_STATE`（旧名 `DSH_CTX_*` 仍兼容） | `$env:WB_CTX_WARN="65%"` |
| 4 命令行 | `--warn` / `--critical` / `--window` | `--window 200000` |

阈值写法：`0.7` 或 `70%` = 占窗口比例；`700000` = 绝对 token 数。

**窗口从哪来**：WorkBuddy 会话日志里**没有**窗口字段，所以一律用配置值——`contextWindow`（显式指定）或 `windowFallback`（默认 **200000**）。
默认值来自实测：某 `deepseek-v4.1-flash` 会话在 199k tokens 时仍正常工作，所以照搬 DSH 的 128k 会过早报警。若你的模型路由不同，用 `--window` 校准。

## 交接工作流

1. 越线时运行 `node scripts/handoff.mjs`，它会写出 `<工作区>/.workbuddy/handoff/<时间>-<会话>.md`，并在终端打印"开场白"。
2. 模型补齐文档里的 `<!-- FILL -->` 段：目标与验收、已完成与验证方式、关键决策与约束、踩过的坑、下一步、验证命令。
3. 把开场白粘贴到**新会话**发送：

```text
/context-guard 接续上一个会话的工作：<会话标题>
交接文档：.workbuddy/handoff/2026-10-07-22-27-47-<会话id前8位>.md
先完整读它，再按 §7「下一步」第 1 条开始动手；§3/§5 里已完成的工作不要重做；§6 里失败过的做法不要重复。
动手前先跑一次 node "<技能目录>\scripts\context-usage.mjs" 确认余量；之后每个回合开头各跑一次。
```

文档留在磁盘、对话里只出现路径——这正是省上下文的关键。开场白首行的 `/context-guard` 会让新会话自动加载同一套协议。

### 自动采集的段落（无需模型补）

生成时脚本已经从日志里填好这些内容：

| 段落 | 采集来源 |
| --- | --- |
| §2 最近的人类消息 | `message` 事件中 `role: "user"` 且**非**注入包装的条目（已剔除 `<system-reminder>` / `<task-notification>` / `<conversation_history_summary>`） |
| §2 助手最后的文字产出 | `message` 事件中 `role: "assistant"` 的 `output_text` 块 |
| §2 最近的工具动作 | `function_call` 事件的 `name` + `arguments` |
| §3 / §7 待办 | `TaskCreate` / `TaskUpdate` 调用，按 taskId 保留最新状态 |
| §5 已交付 | `present_files` 调用的 `files` 列表 |
| §5 写过的文件 | `Edit` / `Write` 的 `file_path`，按文件去重并统计次数 |
| §5 Git 状态 | 只读 `git status --short` / `git diff --stat`；git 不可用时退回读 `.git/HEAD` |
| §8 环境事实 | 会话日志路径、cwd、模型、窗口来源、阈值 |

## 交接自检（为什么必须跑）

会话给自己的交接打分一定会及格，**grep 不会**。所以补完 `<!-- FILL -->` 之后必须自检：

```powershell
node "$base\scripts\handoff.mjs" --verify --doc "<交接文档路径>"
```

它只做笨而硬的检查，因此说服不了：

| 检查 | 失败时的样子 |
| --- | --- |
| 没有遗留 `<!-- FILL -->` | `仍有 6 处 <!-- FILL … --> 未补` |
| 11 个章节齐全 | `缺: ## 9. 验证命令` |
| §10 有可复制的开场白代码块 | `未找到符合格式的代码块` |
| **每条决策都能在载体文件里 grep 到** | `grep 不到「export const X」（src/a.js）` |
| 交接链 `previous` 可解析 | `指向的文件不存在: …` |
| §7 有编号步骤、§9 有验证命令 | `没有编号步骤` / `内容为空` |

退出码 `0` 通过、`1` 不通过、`2` 用法错误——可以直接当流水线门禁（`--json` 给机器读）。

## 链式接力 / 跨 agent

- 每份交接文档头带 `chain` / `hop` / `previous`，交接目录里的 `LATEST`（无扩展名）指向最新一棒：
  新会话不必猜文档在哪；需要更早的来龙去脉时按 `previous` 往回走——但**只在缺信息时回读，不要通读全链**。
- 换 agent 时 `node "$base\scripts\handoff.mjs" --portable` 写出环境无关的 `<工作区>/HANDOFF.md`
  （剥掉 WorkBuddy home、会话日志路径与专属自查命令），可直接交给 Claude Code / Codex / Cursor。

## 全自动提醒（hook，可选）

`hooks/` 一个脚本服务两个事件：`SessionStart` 注入「当前占用 + 最新交接指针 + 续接须知」，
`UserPromptSubmit` **只在等级新越线时**提醒；其它事件、坏 JSON、测不到会话一律安静退出 0。

⚠️ **默认不会生效**：WorkBuddy 默认没有挂载 Claude-Code 兼容的 hook 桥。三种启用方式（任选）：

1. **原生 hook**（若你的 WorkBuddy 版本支持）：把 `hooks/hooks.example.json` 里的命令挂进 hooks 配置。
2. **外部定时器**：用系统计划任务定期跑 `context-usage.mjs --exit-code`，越线时退出码非 0，可触发通知。
3. **手动**：直接在对话里说「上下文快满了」或 `/context-guard`。

细节见 `hooks/cordis-snippet.yml`。未挂载时技能照协议 A 的自觉检查工作，两者不冲突。

## 目录结构

```text
context-guard-wb/
├── SKILL.md                 技能协议（模型加载的指令：监控节奏、阈值、交接与续接、自检、token 纪律）
├── config.json              默认配置（warnAt 0.7 / criticalAt 0.9 / windowFallback 200000 …）
├── README.md                本文件（项目入口）
├── README.zh.md             完整文档：安装、配置、输入输出示例、FAQ、实现细节
├── hooks/                   可选：确定性注入（默认未挂载 hook 桥，见上文）
│   ├── workbuddy-context-guard-hook.mjs  SessionStart / UserPromptSubmit 两个事件共用一个脚本
│   ├── hooks.example.json                hooks 桥的配置示例
│   └── cordis-snippet.yml                把它挂进去的三种方案
└── scripts/
    ├── context-usage.mjs    测量 + 阈值判断 + 状态去重（CLI）
    ├── handoff.mjs          交接文档 / 自检 / 跨 agent 导出（CLI）
    └── lib/
        ├── cli.mjs          参数解析（唯一参数声明源，未知参数直接报错）
        ├── session-log.mjs  WorkBuddy JSONL 会话日志解析、会话定位、项目键推导
        ├── measure.mjs      配置四层合并、日志折叠、占用测量、阈值换算
        └── verify.mjs       交接文档的机械自检（FILL / 章节 / 决策 grep / 链指针）
```

运行时会在技能目录之外生成两类文件：提醒状态（`$WORKBUDDY_HOME/storages/context-guard/…`）与交接文档（`<工作区>/.workbuddy/handoff/…`）。

## 已知限制

- 测量最多**落后一个 step**：日志在请求完成后落盘，正在进行的这一步尚未计入。
- 窗口**不是** provider 声明的（日志里没有），而是配置的 `windowFallback`；它**不等于实际安全额度**，用 `--window` 校准成你信任的值。
- 没有 provider 用量锚点时（例如全新会话）退回启发式估算，输出会标 `approximate: true`。
- **压缩会重置读数**：会话被自动压缩后，注入的 `<conversation_history_summary>` 会让锚点突然变小，百分比随之下降——这是真实的（上下文确实变短了），不是 bug。
- "提醒"由模型按技能协议在每回合开头执行；想要**确定性**注入则用 `hooks/`（脚本已自测，但需要你把它挂进配置，默认未挂载）。
- 交接自检查的是**机械可验证的部分**（FILL、章节、决策能否 grep 到、链指针）；它不能判断"这个下一步是否明智"——那仍是你和模型的事。
- 交接文档的质量取决于模型补写的 `<!-- FILL -->` 段；事实段（最近对话、产物、环境）是自动采集的。

## 与上游 DSH 版的差异

| 项 | DSH 版 | 本 WorkBuddy 版 |
| --- | --- | --- |
| 日志位置 | `$DSH_HOME/sessions/<项目键>/<会话 id>/session.v<N>.jsonl.zstd` | `~/.workbuddy/projects/<项目键>/<会话 id>.jsonl` |
| 日志格式 | 多帧 Zstandard 容器（需 Node ≥ 22.15 解压） | 明文 JSONL（无 zstd，Node ≥ 18 即可） |
| 项目键 | `--c-Users-...--` 形式 | `c-Users-...` 形式（驱动器字母小写） |
| 窗口来源 | 日志里的 `request/context.contextWindow` | 配置 `windowFallback`（默认 200000） |
| 用量锚点 | `assistant/message` 的 `usage.totalTokens` | `function_call` / `message` 的 `providerData.usage.totalTokens` |
| 交接目录 | `<工作区>/.agents/handoff/` | `<工作区>/.workbuddy/handoff/` |
| 环境变量 | `DSH_CTX_*` / `DSH_HOME` | `WB_CTX_*` / `WORKBUDDY_HOME`（旧名兼容） |
| 回合计数 | 每条 `user/message` 记一回合 | 只计**真实人类消息**，剔除 harness 注入 |

## 许可证

MIT，见 [LICENSE](LICENSE)。
