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
- **Claude Code 风格连续命令折叠与思考精简**：
  - 工具调用前的中间思考自动折叠为 0 行，不打断命令流
  - 连续执行的多个工具（`read` / `edit` / `bash` / `grep` 等）自动合并为一张 2 行动态卡片，点击即可展开完整历史列表，再点击任意一步即可展开/收起该步的详细输出或 Diff
- **富文本终端 Markdown 渲染（告别原始符号）**：
  - 标题：`◆ H1`、`▎ H2`、`▸ H3`、`• H4`（无 `###`）
  - 代码块：圆角卡片边框 `╭─ lang ───` / `│ code` / `╰──────────`（无 ```` ``` ````）
  - 列表与任务：`•` / `◦` / `▪` 多级圆点与 `☑` / `☐` 任务复选框
- **Compact 后自动保留完整历史记录**：
  - `/compact` 或自动压缩后，上方完整历史对话继续保留在终端滚动区（同时只向大模型发送压缩后的精简上下文，照常省 Token），支持 `/history` 一键切换

---

### 2. 📊 双行炫彩遥测状态栏 (`extensions/pretty-footer.ts`)
- **第 1 行**：当前目录 (`📁`) + Git 分支 (`🌿`) + Plan/Subagent 状态 + 模型徽章 (`🤖`) + 思考强度徽章 (`🧠`)
- **第 2 行**：`CTX ▰▰▰▰▱▱▱▱ 24.5%` 动态变色上下文进度条 + 输入/输出 Token (`↑`/`↓`) + 缓存命中率 (`⚡`) + 累计费用 (`💰`)

---

### 3. 🧠 项目级 + 全局双层持久记忆 (`extensions/memory.ts`)
- **项目记忆**：`<项目根目录>/.pi/MEMORY.md`
- **全局记忆**：`~/.pi/agent/MEMORY.md`
- 每轮对话自动注入 System Prompt，且大模型可通过 `memory` 工具自主增删查改记忆

---

### 4. 🛠️ 精选高频扩展与无模型绑定 Subagents
| 扩展 / 模块 | 功能说明 |
| :--- | :--- |
| `plan-mode/` | 只读探索规划模式（`/plan`、`Ctrl+Alt+P`、`/plan-todos`） |
| `subagent/` + `agents/*.md` | 多子智能体委派（`scout`、`planner`、`reviewer`、`worker`，自动继承当前默认模型） |
| `questionnaire.ts` | 结构化多选/Tab 交互提问工具 |
| `todo.ts` | 会话内任务看板工具与 `/todos` 命令 |
| `handoff.ts` | `/handoff <目标>` 提炼当前上下文并无缝开启新会话 |
| `git-checkpoint.ts` | 每轮修改前自动创建 `git stash` 检查点，`/fork` 时可一键回滚代码 |
| `permission-gate.ts` | 危险命令（`rm -rf`、`sudo` 等）弹窗确认拦截 |
| `protected-paths.ts` | 禁止写入 `.env`、`.git/`、私钥等敏感路径 |
| `interactive-shell.ts` | `/shell <命令>` 切换到原生交互式终端（支持 `vim`、`htop`、`git rebase -i`） |
| `claude-rules.ts` | 自动扫描并注入 `.claude/rules/*.md` 项目规范 |
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
