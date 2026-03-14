#!/usr/bin/env bash
# setup.sh — curl 一键安装入口
#
# 用法:
#   curl -fsSL https://raw.githubusercontent.com/hgj2025/openoctopus/main/setup.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/hgj2025/openoctopus/main/setup.sh | bash -s -- --no-onboard
#   curl -fsSL https://raw.githubusercontent.com/hgj2025/openoctopus/main/setup.sh | bash -s -- --dir ~/mydir
#
# 环境变量:
#   OPENOCTOPUS_GIT_REPO   覆盖默认 git 仓库地址
#   OPENOCTOPUS_DIR        覆盖默认安装目录

set -euo pipefail

# ── 配置（与 install.sh 保持一致）────────────────────────────────────────────
GIT_REPO="${OPENOCTOPUS_GIT_REPO:-https://github.com/hgj2025/openoctopus.git}"
RAW_BASE="${OPENOCTOPUS_RAW_BASE:-https://raw.githubusercontent.com/hgj2025/openoctopus/main}"
INSTALL_SCRIPT_URL="${RAW_BASE}/install.sh"
TMP_SCRIPT="$(mktemp /tmp/openoctopus-install-XXXXXX.sh)"

# ── 颜色 ──────────────────────────────────────────────────────────────────────
if [ -t 1 ]; then
  RED="\033[0;31m"; GREEN="\033[0;32m"; YELLOW="\033[1;33m"
  CYAN="\033[0;36m"; BOLD="\033[1m"; RESET="\033[0m"
else
  RED=""; GREEN=""; YELLOW=""; CYAN=""; BOLD=""; RESET=""
fi

log()  { printf "${CYAN}[setup]${RESET} %s\n" "$*"; }
ok()   { printf "${GREEN}[setup]${RESET} %s\n" "$*"; }
die()  { printf "${RED}[setup] ERROR:${RESET} %s\n" "$*" >&2; exit 1; }

# ── 检测下载工具 ──────────────────────────────────────────────────────────────
download() {
  local url="$1" dest="$2"
  if command -v curl &>/dev/null; then
    curl -fsSL "$url" -o "$dest"
  elif command -v wget &>/dev/null; then
    wget -qO "$dest" "$url"
  else
    die "需要 curl 或 wget，请先安装其中一个"
  fi
}

cleanup() { rm -f "$TMP_SCRIPT"; }
trap cleanup EXIT

# ── 主流程 ────────────────────────────────────────────────────────────────────
printf "\n${BOLD}OpenOctopus 一键安装${RESET}\n\n"

log "下载安装脚本..."
download "$INSTALL_SCRIPT_URL" "$TMP_SCRIPT"
chmod +x "$TMP_SCRIPT"
ok "下载完成"

log "启动安装..."
# 透传所有参数，并注入 GIT_REPO
export OPENOCTOPUS_GIT_REPO="$GIT_REPO"
bash "$TMP_SCRIPT" "$@"
