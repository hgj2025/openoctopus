#!/usr/bin/env bash
# setup.sh — curl 一键安装入口
#
# 用法:
#   curl -fsSL https://raw.githubusercontent.com/hgj2025/openoctopus/main/setup.sh | bash
#   curl -fsSL .../setup.sh | bash -s -- --no-onboard
#   curl -fsSL .../setup.sh | bash -s -- --dir ~/mydir
#   curl -fsSL .../setup.sh | bash -s -- --force-install   # 强制全新安装
#
# 已安装时自动走快速升级流程：git pull → pnpm install → build → gateway restart
#
# 无法访问 GitHub 时（服务器离线/内网）：
#   先手动传代码到服务器，再本地安装：
#   bash setup.sh --local
#   或
#   bash install.sh --local
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
warn() { printf "${YELLOW}[setup]${RESET} %s\n" "$*" >&2; }
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

# ── 已安装检测 ──────────────────────────────────────────────────────────────────
INSTALL_DIR="${OPENOCTOPUS_DIR:-${HOME}/openoctopus}"
OPENCLAW_BIN="${HOME}/.local/bin/openclaw"

is_installed() {
  [ -x "$OPENCLAW_BIN" ] && [ -d "${INSTALL_DIR}/.git" ]
}

# ── 快速升级+重启 ──────────────────────────────────────────────────────────────
quick_upgrade() {
  printf "\n${BOLD}OpenOctopus 快速升级${RESET}\n\n"
  ok "检测到已安装: ${INSTALL_DIR}"

  log "拉取最新代码..."
  git -C "$INSTALL_DIR" fetch --quiet
  git -C "$INSTALL_DIR" pull --ff-only --quiet || {
    warn "git pull 失败（可能有本地修改），尝试 reset..."
    git -C "$INSTALL_DIR" reset --hard origin/main --quiet
  }
  ok "代码已更新"

  log "安装依赖..."
  (cd "$INSTALL_DIR" && pnpm install --frozen-lockfile 2>/dev/null || pnpm install)
  ok "依赖安装完成"

  log "构建项目..."
  (cd "$INSTALL_DIR" && pnpm build) || die "构建失败"
  ok "构建完成"

  log "重启 gateway..."
  "$OPENCLAW_BIN" gateway restart || die "重启失败，请运行: openclaw doctor"
  ok "gateway 已重启"

  echo ""
  ok "升级完成！"
}

# ── 主流程 ────────────────────────────────────────────────────────────────────
# 如果已安装且没有传 --force-install 参数，走快速升级+重启
if is_installed && [[ ! " $* " =~ " --force-install " ]]; then
  quick_upgrade
  exit 0
fi

printf "\n${BOLD}OpenOctopus 一键安装${RESET}\n\n"

log "下载安装脚本..."
download "$INSTALL_SCRIPT_URL" "$TMP_SCRIPT"
chmod +x "$TMP_SCRIPT"
ok "下载完成"

log "启动安装..."
# 透传所有参数（过滤掉 --force-install），并注入 GIT_REPO
export OPENOCTOPUS_GIT_REPO="$GIT_REPO"
bash "$TMP_SCRIPT" "${@/--force-install/}"
