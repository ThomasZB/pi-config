# Pi Pretty Config (`pi-pretty-config`)

一套开箱即用的 **Pi Coding Agent (`@earendil-works/pi-coding-agent`)** 终端美化与高阶工作流配置包。

---

## ✨ 核心特性一览

### 1. 🎨 终端 UI 深度美化 (`extensions/pretty-ui.ts`)
- **动态彩色输入引导符 (`❯ `)**：
  - 普通对话：`❯ `（主题高亮色）
  - 斜杠命令（`/plan`、`/reload`）：`❯ `（琥珀黄）
  - Shell 命令（`!ls`、`!!pwd`）：`❯ `（命令橙）
  - 多行换行自动对齐为 `· `
- **24-bit Truecolor 流光呼吸灯动画（空闲时 0% CPU 占用）**：
  - **思考中**：`◉ 思考中 ••• <最新推理摘要>`（紫罗兰 ↔ 冰青色正弦波渐变光球 + 3 点相位流光波浪）
  - **执行命令中**：`▸ ▰▰▰ ◉ 正在执行命令 ...`（琥珀金 ↔ 冰青色 3 格流光进度块 + 实时跳动计时器，覆盖本地执行与等待模型下一步指令的完整周期）
  - **输入框联动**：AI 工作期间，输入框上下边框与 `❯ ` 提示符同步柔和呼吸
- **鼠标悬停（Hover）即时高亮反馈**：
  - 鼠标移到折叠思考行、单条命令、连续命令组卡片、展开后的某一步历史命令、压缩分割线或输入框上，均有独立的边框/箭头点亮与 `[ ✦ 点击... ]` 徽章提示
- **Claude Code 风格连续命令折叠与文件变更（Write/Edit）独立 Diff 展示**：
  - 工具调用前的中间思考自动折叠为 0 行，不打断命令流
  - 连续执行的探索类工具（`read` / `bash` / `grep` / `find` / `codemode` 等）自动合并为一张 2 行动态卡片，点击即可展开完整历史列表
  - **文件修改（`write` / `edit`）始终作为独立卡片展示**：实时显示修改文件路径、`+N -M` 行数统计及语法高亮 Diff 预览（默认展示前 10 行变更，左键点击卡片即可随时展开/收起完整 Diff）
- **富文本终端 Markdown 渲染（告别原始符号）**：
  - 标题：`◆ H1`、`▎ H2`、`▸ H3`、`• H4`（无 `###`）
  - 代码块：圆角卡片边框 `╭─ lang ───` / `│ code` / `╰──────────`（无 ```` ``` ````）
  - 列表与任务：`•` / `◦` / `▪` 多级圆点与 `☑` / `☐` 任务复选框
- **Claude Code 风格大段用户输入/粘贴日志自动折叠与缩放**：
  - **输入框内（发送前）**：粘贴超过 5 行或 400 字符的日志（含 `Cmd+V` 与 `Ctrl+V`）自动收拢为高亮胶囊 `[paste #1 +N lines]`；点击胶囊、点击输入框上边框右侧按钮或按 `Ctrl+Alt+F`（`/fold`）可随时在输入框内展开编辑、再次点击一键折回
  - **对话流内（发送后）**：超过 6 行的长用户输入/报错日志自动折叠为 3 行预览 + `▸ 📋 已折叠 M 行用户输入 (点击或 Ctrl+O 展开)`；鼠标悬停点亮流光提示，左键点击任意多行用户消息即可随时展开或收起
- **Compact 后自动保留完整历史记录**：
  - `/compact` 或自动压缩后，上方完整历史对话继续保留在终端滚动区（同时只向大模型发送压缩后的精简上下文，照常省 Token），支持 `/history` 一键切换

---

### 2. 📊 双行炫彩遥测状态栏与 `/context` 拆解面板 (`extensions/pretty-footer.ts`)
- **第 1 行**：当前目录 (`📁`) + Git 分支 (`🌿`) + Plan/Subagent 状态 + 模型徽章 (`🤖`) + 思考强度徽章 (`🧠`)
- **第 2 行**：`CTX ▰▰▰▰▱▱▱▱ 24.5%` 动态变色上下文进度条 + 输入/输出 Token (`↑`/`↓`) + 缓存命中率 (`⚡`) + 累计费用 (`💰`)
- **`/context` 上下文可视化拆解面板**：
  - 基于最近一轮 API 真实 Token 数精确校准，展示多色分段进度条
  - 拆解 6 大分类（`System & Memory`、`Tool Definitions`、`Messages`、`Tool Outputs`、`Autocompact Buffer`、`Free Space`）并统计**微压缩已节省的 Token 数**
  - 列出当前上下文窗口中占用最大的 **Top 5 Context Consumers**（带 `#seq` 序号）

---

### 3. 🧠 三层记忆与无损上下文引擎 (`memory.ts` + `session-recall.ts`)

#### ① 项目级 + 全局双层持久记忆 & Auto Memory (`extensions/memory.ts`)
- **项目记忆**：`<项目根目录>/.pi/MEMORY.md`
- **全局记忆**：`~/.pi/agent/MEMORY.md`
- **Claude Code 同款 Auto Memory 机制**：
  - 模型在对话中主动记录**用户纠正/反馈（feedback）**、**非显而易见的项目构建/架构特殊约定（project）**与**个人偏好（user）**，不记录易过期的代码模块总结
  - **200 行 / 25KB 启动加载上限**：每次新会话仅加载前 200 行（或 25KB），写入自动去重，接近或超出上限时自动提醒模型合并精简旧条目

#### ② 无损历史回溯 + 跨会话项目连续性 + Cache-Aware 微压缩 (`extensions/session-recall.ts`)
- **跨会话项目连续性（Cross-Session Continuity）**：
  - 自动索引同一项目目录（`cwd`）下最近的多个历史会话摘要（首尾问题 + 会话 ID）注入 `<project_session_continuity>`
  - 当你新开窗口说“继续之前的工作”或询问上次改了什么时，模型会自动调用 `session_recall(session_id: "previous" | scope: "project")` 检索或读取历史会话记录
- **Compact 后无损原文回溯（Post-Compaction Recall）**：
  - 当会话触发 `/compact` 或自动压缩后，自动生成确定性的 `#1..#N` 压缩前历史时间线目录，模型需要具体报错、行号或代码细节时可随时按 `#seq` 精确调取原始记录，彻底解决压缩失忆问题
- **保护缓存命中率的微压缩（Cache-Aware Micro-Compaction）**：
  - **热缓存期间零扰动**：连续对话时（空闲 `< 6` 分钟且旧工具输出未超 `30k` tokens）绝不修改历史消息，100% 保护云端 Prompt Cache 命中率
  - **趁缓存过期免费瘦身**：当你离开 ≥ 6 分钟再发消息（云端 5 分钟缓存已自然过期）或旧工具堆积超 `30k` tokens 时，自动把距离当前 > 6 步的大体积旧工具输出（`read` / `bash` / `grep` / `codemode` / `web_fetch`）折叠为 `[Head 10 行 + Tail 8 行 + #seq 回溯指针]`，大幅削减重传 Token 成本

---

### 4. ⚡ 主模型 / 轻量模型双层架构与 `scout` 探索分流 (`compaction-model.ts` + `subagent/` + `permission-gate.ts`)
- **统一轻量模型 (`/fast-model`)**：
  - 对标 Claude Code 的双模型设计：平时编码用主模型（`/model`），高频辅助任务统一配置一个便宜快速的轻量模型（`/fast-model`，如 Haiku / Flash，默认强制 `thinking: off`）
  - **一处配置，四处共用**：
    1. **上下文压缩**（`/compact` 与自动压缩）
    2. **代码库探索子 Agent**（`scout` / Explore）
    3. **敏感命令安全审核**（`permission-gate.ts` 的 Auto Mode）
    4. **分支历史摘要**（`/tree` 切换分支时）
- **`scout` (Explore) 轻量探索子 Agent**：
  - 当主模型需要跨多文件搜索或理清未知调用链时，自动派发给 `scout` 在隔离上下文中探索（支持多任务并行 `tasks`），主对话只接收几百 Token 的 `{文件 + 行号 + 核心签名}` 浓缩结论
  - 子进程自动以极速模式启动（`--no-extensions --no-mcp --no-context-files`），并内置 `codemode` 支持单轮批量检索

---

### 5. 🛠️ 全部内置扩展、Subagents 与工作流模板一览
| 扩展 / 模块 | 功能说明 |
| :--- | :--- |
| `pretty-ui.ts` | 24-bit 流光呼吸灯、连续工具折叠、Write/Edit 独立 Diff 卡片、长粘贴/长输入折叠、富文本 Markdown、Compact 历史保留 |
| `pretty-footer.ts` | 双行炫彩遥测状态栏 + `/context` 上下文 Token 拆解与微压缩省流统计面板 |
| `session-recall.ts` | 压缩前 `#seq` 原文回溯 + 同项目跨会话历史检索 + Cache-Aware 微压缩（`session_recall` 工具 + `/recall` 命令） |
| `compaction-model.ts` | 统一轻量模型配置（`/fast-model`），自动驱动压缩、`scout` 探索、分支摘要与 Auto Mode |
| `memory.ts` | 项目级（`.pi/MEMORY.md`）+ 全局（`~/.pi/agent/MEMORY.md`）持久记忆与 Auto Memory（200 行上限） |
| `subagent/` + `agents/*.md` | 4 个专职子智能体：`scout`（轻量只读探索）、`planner`（架构规划）、`worker`（独立上下文执行）、`reviewer`（代码审查） |
| `prompts/*.md` | 3 个组合工作流模板命令：`/scout-and-plan`（探索+规划）、`/implement`（探索+规划+实现）、`/implement-and-review`（实现+审查） |
| `permission-gate.ts` | Claude Code 风格 **Auto Mode 智能安全审核 (`/auto-mode`)**：结合工作目录与用户意图由 `/fast-model` 自动放行项目内合规清理，拦截越界或高危未知命令 |
| `plan-mode/` | 只读探索规划模式（`/plan`、`Ctrl+Alt+P`、`/plan-todos`） |
| `web.ts` | 原生联网搜索与网页抓取工具（`web_search` + `web_fetch`，基于 DeepSeek Search/Fetch API，支持 Tavily / 直连自动兜底） |
| `questionnaire.ts` | 结构化多选/Tab 交互提问工具（`questionnaire`） |
| `todo.ts` | 会话内任务看板工具与 `/todos` 命令 |
| `handoff.ts` | `/handoff <目标>` 提炼当前上下文并无缝开启新会话 |
| `git-checkpoint.ts` | 每轮修改前自动创建 `git stash` 检查点，`/fork` 时可一键回滚代码 |
| `protected-paths.ts` | 禁止写入 `.env`、`.git/`、私钥等敏感路径 |
| `interactive-shell.ts` | `/shell <命令>` 切换到原生交互式终端（支持 `vim`、`htop`、`git rebase -i`） |
| `claude-rules.ts` | 自动扫描并按需引导读取 `.claude/rules/*.md` 项目规范 |
| `notify.ts` / `titlebar-spinner.ts` | 任务完成桌面通知 & 终端标题栏运行动画 |

---

### 6. 🎨 三套精选无底色污染主题 (`themes/`)
- `tokyo-night`（深邃蓝紫暗色主题）
- `catppuccin-mocha`（柔和暖调暗色主题）
- `catppuccin-latte`（清爽护眼亮色主题）

---

## 🚀 给其他 Pi 安装使用的两种方式

### 方式一：一键脚本完整安装（推荐，包含 Subagents 与默认主题配置）

把本目录发给其他机器或同事（或推送到 Git 仓库后 `git clone`），进入目录执行：

```bash
# 复制模式安装（将 extensions / themes / agents / prompts 安装到 ~/.pi/agent）
./install.sh

# 或者：软链接模式安装（直接修改本仓库代码后在 pi 里 /reload 即可生效）
./install.sh --link
```
> 💡 `install.sh` **不会覆盖**目标机器原有的 `auth.json`、`defaultProvider` 或 `defaultModel`，只会安全地注入扩展、主题、智能体配置与默认主题项。

---

### 方式二：使用 Pi 原生包管理器安装 (`pi install`)

本目录已包含标准的 `package.json`（含 `"pi"` 清单），在其他机器上可直接运行：

```bash
# 从本地路径安装
pi install /path/to/pi_config

# 或推送到 Git 仓库后从远程安装
pi install git+https://github.com/ThomasZB/pi-config.git
```

---

## ⌨️ 常用快捷命令速查

| 命令 / 快捷键 | 作用 |
| :--- | :--- |
| `/reload` | 热重载所有扩展、主题、智能体与配置（并恢复完整历史视图） |
| `/fast-model` | 交互式选择或查看全局轻量模型（统一用于 `/compact` 上下文压缩、`scout` 代码探索、`/tree` 分支摘要与 Auto Mode 审核） |
| `/context` | 打开彩色上下文占用拆解面板（查看 System / Tools / Messages / Tool Outputs 占比、微压缩节省 Token 数及 Top 5 占用项） |
| `/auto-mode` | 查看或开关敏感命令 Auto Mode 智能审核（`on` / `off` / `status`） |
| `/recall` | 查看回溯与微压缩状态（`/recall ttl <分钟>` 设置缓存过期微压缩时间，默认 6 分钟；`/recall compact` 立即手动瘦身旧工具输出） |
| `/fold` (`Ctrl+Alt+F`) | 一键展开/折叠输入框内的粘贴日志块，或展开/折叠对话中的多行用户输入 |
| `/history` | 切换「保留 Compact 前完整历史记录」vs「仅显示压缩后精简视图」 |
| `/compact-tools` | 切换「Claude 风格连续命令折叠 + 呼吸灯视图」vs「默认输出」 |
| `/pretty-md` | 切换「富文本终端 Markdown 卡片渲染」vs「原始 Markdown」 |
| `/footer` | 切换「双行炫彩进度条状态栏」vs「单行极简状态栏」 |
| `/remember <内容>` | 写入当前项目记忆（加 `-g` 写入全局记忆） |
| `/memory` | 查看当前生效记忆（`/memory edit` 打开编辑器修改） |
| `/plan` (`Ctrl+Alt+P`) | 切换只读规划模式（Plan Mode） |
| `/todos` | 查看当前 Todo 列表 |
| `/shell <命令>` | 打开原生交互式终端执行命令（如 `vim`、`htop`） |
| `/scout-and-plan <任务>` | 启动 `scout` 探索代码库并交由 `planner` 生成实施计划 |
| `/implement <任务>` | 自动串联 `scout -> planner -> worker` 完成探索、规划与代码实现 |
| `/implement-and-review <任务>` | 自动串联 `worker -> reviewer` 完成代码实现与独立审查 |
| `/handoff <目标>` | 将当前会话上下文提炼移交到新会话 |
| `/tree` | 打开完整会话历史树（支持全文搜索与回溯分支） |
