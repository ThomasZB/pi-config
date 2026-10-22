#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# Pi Pretty Config Installer
# Usage:
#   ./install.sh          # Copy extensions, themes, agents, and prompts into ~/.pi/agent
#   ./install.sh --link   # Symlink into ~/.pi/agent (edits in this repo take effect on /reload)
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PI_AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
MODE="copy"

if [[ "${1:-}" == "--link" || "${1:-}" == "-l" ]]; then
  MODE="link"
fi

echo "🚀 正在安装 Pi 增强配置到: ${PI_AGENT_DIR} (模式: ${MODE})"
mkdir -p "${PI_AGENT_DIR}"/{extensions,themes,agents,prompts}

install_dir_items() {
  local src_dir="$1"
  local dest_dir="$2"
  for item in "${src_dir}"/*; do
    [[ -e "$item" ]] || continue
    local base
    base="$(basename "$item")"
    local target="${dest_dir}/${base}"
    rm -rf "$target"
    if [[ "$MODE" == "link" ]]; then
      ln -s "$item" "$target"
    else
      cp -R "$item" "$target"
    fi
  done
}

install_dir_items "${SCRIPT_DIR}/extensions" "${PI_AGENT_DIR}/extensions"
install_dir_items "${SCRIPT_DIR}/themes"     "${PI_AGENT_DIR}/themes"
install_dir_items "${SCRIPT_DIR}/agents"     "${PI_AGENT_DIR}/agents"
install_dir_items "${SCRIPT_DIR}/prompts"    "${PI_AGENT_DIR}/prompts"

# Safely merge theme setting into ~/.pi/agent/settings.json without touching model/provider settings
SETTINGS_FILE="${PI_AGENT_DIR}/settings.json"
if [[ ! -f "$SETTINGS_FILE" ]]; then
  cp "${SCRIPT_DIR}/settings.example.json" "$SETTINGS_FILE"
  echo "✅ 已创建默认配置文件: ${SETTINGS_FILE}"
else
  if command -v node >/dev/null 2>&1; then
    node -e '
      const fs = require("fs");
      const file = process.argv[1];
      try {
        const data = JSON.parse(fs.readFileSync(file, "utf8"));
        if (!data.theme) {
          data.theme = "catppuccin-latte/tokyo-night";
        }
        if (!data.defaultTools) {
          data.defaultTools = ["+grep", "+find", "+ls", "+codemode"];
        }
        if (!data.web) {
          data.web = { deepseekApiKeyEnv: "DEEPSEEK_API_KEY" };
        }
        fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8");
      } catch (e) {
        console.error("⚠️ 无法自动更新 settings.json，请手动设置 \"theme\": \"catppuccin-latte/tokyo-night\"");
      }
    ' "$SETTINGS_FILE"
    echo "✅ 已保留原有模型配置并更新主题配置: ${SETTINGS_FILE}"
  fi
fi

echo ""
echo "🎉 安装完成！"
echo "   - 如果正在运行 pi，直接输入: /reload"
echo "   - 如果要切换主题，输入:     /settings -> Theme (可选 tokyo-night / catppuccin-mocha / catppuccin-latte)"
