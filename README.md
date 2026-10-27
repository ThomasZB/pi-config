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

### 3. 🧠 项目级 + 全局双层持久记忆 & Auto Memory (`extensions/memory.ts`)
- **项目记忆**：`<项目根目录>/.pi/MEMORY.md`
- **全局记忆**：`~/.pi/agent/MEMORY.md`
- **Claude Code 同款 Auto Memory 机制**：
  - 模型在对话中自动记录**用户纠正/反馈（feedback）**、**非显而易见的项目构建/架构特殊约定（project）**与**个人偏好（user）**，不记录易过期的代码模块总结
  - **200 行 / 25KB 启动加载上限**：每次新会话仅加载前 200 行（或 25KB），写入自动去重，接近或超出上限时自动提醒模型合并精简旧条目

---

### 4. 🛠️ 精选高频扩展与主/轻量双层模型架构
| 扩展 / 模块 | 功能说明 |
| :--- | :--- |
| `compaction-model.ts` | **统一轻量模型配置 (`/fast-model`)**：对标 Claude Code 的主模型（`/model`）+ 轻量模型（`/fast-model`，如 Haiku / Flash）双层架构。配一次自动接管：**上下文压缩 (`/compact`)**、**代码探索子 Agent (`scout`)**、**分支摘要 (`/tree`)** 与 **Auto Mode 安全审核** |
| `subagent/` + `agents/*.md` | **多子智能体委派与 `scout` (Explore) 自动分流**：当主模型需要跨多文件搜索或理清未知模块调用链时，自动派发给绑定轻量模型、极速无扩展启动（`--no-extensions --no-context-files`）且支持 `codemode` 批量检索的 `scout` 子进程，仅将浓缩结论返回主上下文 |
| `session-recall.ts` | 压缩前历史回溯 + 同项目跨会话记忆召回 + **Cache-Aware 微压缩**（`session_recall` + `/recall`），默认空闲 ≥ 6 分钟趁缓存过期自动为旧大工具输出瘦身，并支持随时按 `#seq` 无损翻查原文 |
| `permission-gate.ts` | **Claude Code 风格 Auto Mode 智能安全审核 (`/auto-mode`)**：日常命令 0ms 直通；遇到 `rm -rf`、`git reset --hard`、`sudo` 等敏感命令时，自动结合当前工作目录与用户最近对话意图交由 `/fast-model` 秒级审核，项目内合规清理自动放行，越界或未知高危操作弹窗确认（`rm -rf /`、`~`、`.git` 等绝对红线强制拦截） |
| `plan-mode/` | 只读探索规划模式（`/plan`、`Ctrl+Alt+P`、`/plan-todos`） |
| `web.ts` | 原生联网搜索与网页抓取工具（`web_search` + `web_fetch`，基于 DeepSeek Search/Fetch API，支持 Tavily / 直连自动兜底） |
| `questionnaire.ts` | 结构化多选/Tab 交互提问工具 |
| `todo.ts` | 会话内任务看板工具与 `/todos` 命令 |
| `handoff.ts` | `/handoff <目标>` 提炼当前上下文并无缝开启新会话 |
| `git-checkpoint.ts` | 每轮修改前自动创建 `git stash` 检查点，`/fork` 时可一键回滚代码 |
| `protected-paths.ts` | 禁止写入 `.env`、`.git/`、私钥等敏感路径 |
| `interactive-shell.ts` | `/shell <命令>` 切换到原生交互式终端（支持 `vim`、`htop`、`git rebase -i`） |
| `claude-rules.ts` | 自动扫描并按需引导读取 `.claude/rules/*.md` 项目规范 |
| `notify.ts` / `titlebar-spinner.ts` | 任务完成桌面通知 & 终端标题栏运行动画 |

---

### 5. 🎨 三套精选无底色污染主题 (`themes/`)
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
| `/handoff <目标>` | 将当前会话上下文提炼移交到新会话 |
| `/tree` | 打开完整会话历史树（支持全文搜索与回溯分支） |
