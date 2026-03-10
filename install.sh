#!/usr/bin/env bash
# install.sh — 一键安装/升级 openoctopus (自托管替代 openclaw.ai/install.sh)
#
# 用法:
#   bash install.sh                    # 安装或升级
#   bash install.sh --restart          # 重启 gateway 服务
#   bash install.sh --no-onboard       # 安装但跳过 onboard
#   bash install.sh --dir ~/mydir      # 指定安装目录
#   bash install.sh --help

set -euo pipefail

# ── 配置 ──────────────────────────────────────────────────────────────────────
# 修改这里指向你自己的 git 仓库
GIT_REPO="${OPENOCTOPUS_GIT_REPO:-https://github.com/hgj2025/openoctopus.git}"
DEFAULT_DIR="${HOME}/openoctopus"
BIN_DIR="${HOME}/.local/bin"
BIN_NAME="openclaw"

# ── 颜色 ──────────────────────────────────────────────────────────────────────
if [ -t 1 ]; then
  RED="\033[0;31m"; GREEN="\033[0;32m"; YELLOW="\033[1;33m"
  CYAN="\033[0;36m"; BOLD="\033[1m"; RESET="\033[0m"
else
  RED=""; GREEN=""; YELLOW=""; CYAN=""; BOLD=""; RESET=""
fi

log()  { printf "${CYAN}[install]${RESET} %s\n" "$*"; }
ok()   { printf "${GREEN}[install]${RESET} %s\n" "$*"; }
warn() { printf "${YELLOW}[install]${RESET} %s\n" "$*" >&2; }
die()  { printf "${RED}[install] ERROR:${RESET} %s\n" "$*" >&2; exit 1; }

# ── 参数解析 ──────────────────────────────────────────────────────────────────
INSTALL_DIR=""
NO_ONBOARD=0
RESTART_ONLY=0
NO_BUILD=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir|-d)       INSTALL_DIR="$2"; shift 2 ;;
    --no-onboard)   NO_ONBOARD=1; shift ;;
    --restart)      RESTART_ONLY=1; shift ;;
    --no-build)     NO_BUILD=1; shift ;;
    --help|-h)
      cat <<EOF
用法: bash install.sh [选项]

选项:
  --dir <path>      安装目录 (默认: ${DEFAULT_DIR})
  --no-onboard      跳过 openclaw onboard
  --restart         仅重启 gateway 服务，不重新安装
  --no-build        跳过构建步骤（适用于已构建的场景）
  --help            显示此帮助

环境变量:
  OPENOCTOPUS_GIT_REPO   git 仓库地址 (必须设置，或在脚本顶部配置)
  OPENOCTOPUS_DIR        安装目录
EOF
      exit 0
      ;;
    *) die "未知参数: $1。运行 bash install.sh --help 查看用法" ;;
  esac
done

INSTALL_DIR="${INSTALL_DIR:-${OPENOCTOPUS_DIR:-${DEFAULT_DIR}}}"

# ── 仅重启模式 ────────────────────────────────────────────────────────────────
if [ "$RESTART_ONLY" = "1" ]; then
  log "重启 gateway 服务..."
  OPENCLAW_BIN="${BIN_DIR}/${BIN_NAME}"
  if [ ! -x "$OPENCLAW_BIN" ]; then
    die "找不到 ${OPENCLAW_BIN}，请先运行安装"
  fi
  "$OPENCLAW_BIN" gateway restart || die "重启失败，请运行: openclaw doctor"
  ok "gateway 重启完成"
  exit 0
fi

# ── 检查 git 仓库配置 ─────────────────────────────────────────────────────────
if [ -z "$GIT_REPO" ]; then
  die "未配置 git 仓库。请设置 OPENOCTOPUS_GIT_REPO 环境变量，或编辑 install.sh 顶部的 GIT_REPO 变量
示例: OPENOCTOPUS_GIT_REPO=https://github.com/hgj2025/openoctopus.git bash install.sh"
fi

# ── 工具检测 ──────────────────────────────────────────────────────────────────
need_cmd() {
  command -v "$1" &>/dev/null || die "需要 $1 但未找到，请先安装"
}

# ── 查找/安装 Node.js ─────────────────────────────────────────────────────────
find_node() {
  # 1. 已在 PATH
  if command -v node &>/dev/null; then
    echo "$(command -v node)"; return
  fi
  # 2. nvm
  local nvm_dir="${NVM_DIR:-${HOME}/.nvm}"
  if [ -s "${nvm_dir}/nvm.sh" ]; then
    # shellcheck disable=SC1091
    source "${nvm_dir}/nvm.sh" --no-use 2>/dev/null || true
    if command -v node &>/dev/null; then
      echo "$(command -v node)"; return
    fi
    # 解析 nvm default 别名
    local alias="default"
    for _ in 1 2 3; do
      local resolved
      resolved=$(cat "${nvm_dir}/alias/${alias}" 2>/dev/null | tr -d '[:space:]') || break
      [ -z "$resolved" ] && break
      alias="$resolved"
    done
    local node_bin
    node_bin=$(ls "${nvm_dir}/versions/node/"*"${alias#v}"*/bin/node 2>/dev/null | sort -V | tail -1)
    if [ -z "$node_bin" ]; then
      node_bin=$(ls "${nvm_dir}/versions/node/"*/bin/node 2>/dev/null | sort -V | tail -1)
    fi
    if [ -n "$node_bin" ] && [ -x "$node_bin" ]; then
      echo "$node_bin"; return
    fi
  fi
  echo ""
}

ensure_node() {
  local node_bin
  node_bin=$(find_node)

  if [ -n "$node_bin" ]; then
    local ver
    ver=$("$node_bin" --version 2>/dev/null | sed 's/v//')
    local major
    major=$(echo "$ver" | cut -d. -f1)
    if [ "$major" -ge 22 ] 2>/dev/null; then
      NODE="$node_bin"
      export PATH="$(dirname "$NODE"):${PATH}"
      ok "Node.js v${ver} ($(dirname "$NODE"))"
      return
    fi
    warn "Node.js v${ver} < 22，尝试安装更新版本..."
  else
    log "未找到 Node.js，正在安装..."
  fi

  local os
  os="$(uname -s)"
  case "$os" in
    Darwin)
      if command -v brew &>/dev/null; then
        log "通过 Homebrew 安装 Node.js 22..."
        brew install node@22 || die "Homebrew 安装 Node.js 失败"
        brew link --overwrite node@22 2>/dev/null || true
      elif command -v nvm &>/dev/null || [ -s "${HOME}/.nvm/nvm.sh" ]; then
        # shellcheck disable=SC1091
        source "${HOME}/.nvm/nvm.sh" 2>/dev/null || true
        nvm install 22 && nvm use 22
      else
        die "请先安装 Homebrew (brew.sh) 或 nvm，然后重新运行"
      fi
      ;;
    Linux)
      if command -v apt-get &>/dev/null; then
        log "通过 NodeSource 安装 Node.js 22 (apt)..."
        curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
        sudo apt-get install -y nodejs
      elif command -v dnf &>/dev/null; then
        log "通过 NodeSource 安装 Node.js 22 (dnf)..."
        curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
        sudo dnf install -y nodejs
      elif command -v yum &>/dev/null; then
        log "通过 NodeSource 安装 Node.js 22 (yum)..."
        curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
        sudo yum install -y nodejs
      else
        die "无法自动安装 Node.js，请手动安装 Node.js 22+ 后重试"
      fi
      ;;
    *)
      die "不支持的系统: ${os}，请手动安装 Node.js 22+"
      ;;
  esac

  node_bin=$(find_node)
  [ -n "$node_bin" ] || die "Node.js 安装后仍未找到"
  NODE="$node_bin"
  export PATH="$(dirname "$NODE"):${PATH}"
  ok "Node.js 已安装: $(node --version)"
}

# ── 查找/安装 pnpm ────────────────────────────────────────────────────────────
ensure_pnpm() {
  if command -v pnpm &>/dev/null; then
    ok "pnpm $(pnpm --version)"
    return
  fi
  log "安装 pnpm..."
  npm install -g pnpm || die "pnpm 安装失败"
  ok "pnpm $(pnpm --version)"
}

# ── 确保 git ──────────────────────────────────────────────────────────────────
ensure_git() {
  if command -v git &>/dev/null; then return; fi
  log "安装 git..."
  local os
  os="$(uname -s)"
  case "$os" in
    Darwin)
      command -v brew &>/dev/null && brew install git || \
        die "请安装 git: https://git-scm.com"
      ;;
    Linux)
      if command -v apt-get &>/dev/null; then
        sudo apt-get install -y git
      elif command -v dnf &>/dev/null; then
        sudo dnf install -y git
      elif command -v yum &>/dev/null; then
        sudo yum install -y git
      else
        die "请手动安装 git"
      fi
      ;;
    *) die "请手动安装 git" ;;
  esac
}

# ── clone / pull 仓库 ─────────────────────────────────────────────────────────
sync_repo() {
  if [ -d "${INSTALL_DIR}/.git" ]; then
    log "更新仓库 ${INSTALL_DIR}..."
    git -C "$INSTALL_DIR" fetch --quiet
    git -C "$INSTALL_DIR" pull --ff-only --quiet || {
      warn "git pull 失败（可能有本地修改），跳过更新"
    }
  else
    log "克隆仓库到 ${INSTALL_DIR}..."
    mkdir -p "$(dirname "$INSTALL_DIR")"
    git clone --depth=1 "$GIT_REPO" "$INSTALL_DIR" || die "git clone 失败"
  fi
}

# ── 构建 ──────────────────────────────────────────────────────────────────────
build_project() {
  if [ "$NO_BUILD" = "1" ]; then
    warn "跳过构建步骤 (--no-build)"
    return
  fi
  log "安装依赖 (pnpm install)..."
  pnpm install --frozen-lockfile --dir "$INSTALL_DIR" || \
    pnpm install --dir "$INSTALL_DIR"

  log "构建项目 (pnpm build)..."
  pnpm --dir "$INSTALL_DIR" build || die "构建失败，请检查错误信息"
  ok "构建完成"
}

# ── 安装 wrapper 到 PATH ──────────────────────────────────────────────────────
install_wrapper() {
  mkdir -p "$BIN_DIR"
  local wrapper="${BIN_DIR}/${BIN_NAME}"

  cat > "$wrapper" <<WRAPPER
#!/usr/bin/env bash
# Auto-generated by install.sh — do not edit
REPO_DIR="${INSTALL_DIR}"
NODE=\$(command -v node 2>/dev/null || ls "\${HOME}/.nvm/versions/node/"*/bin/node 2>/dev/null | sort -V | tail -1)
[ -z "\$NODE" ] && { echo "openclaw: node not found" >&2; exit 1; }
exec "\$NODE" "\${REPO_DIR}/openclaw.mjs" "\$@"
WRAPPER
  chmod +x "$wrapper"
  ok "已安装 wrapper: ${wrapper}"

  # 检查 BIN_DIR 是否在 PATH
  if [[ ":${PATH}:" != *":${BIN_DIR}:"* ]]; then
    warn "${BIN_DIR} 不在 PATH 中"
    local shell_rc=""
    case "${SHELL:-}" in
      */zsh)  shell_rc="${HOME}/.zshrc" ;;
      */bash) shell_rc="${HOME}/.bashrc" ;;
    esac
    if [ -n "$shell_rc" ]; then
      local export_line="export PATH=\"${BIN_DIR}:\${PATH}\""
      if ! grep -qF "$export_line" "$shell_rc" 2>/dev/null; then
        echo "" >> "$shell_rc"
        echo "# openoctopus" >> "$shell_rc"
        echo "$export_line" >> "$shell_rc"
        warn "已写入 ${shell_rc}，请运行: source ${shell_rc}"
      fi
    else
      warn "请手动将 ${BIN_DIR} 加入 PATH"
    fi
  fi
}

# ── 运行 doctor / onboard ─────────────────────────────────────────────────────
post_install() {
  local openclaw_bin="${BIN_DIR}/${BIN_NAME}"

  # 运行 doctor（最优尝试）
  log "运行 openclaw doctor..."
  "$openclaw_bin" doctor --non-interactive 2>/dev/null || true

  if [ "$NO_ONBOARD" = "1" ]; then
    warn "跳过 onboard (--no-onboard)"
    return
  fi

  # 仅在 TTY 下运行 onboard
  if [ -t 0 ] && [ -t 1 ]; then
    log "运行 openclaw onboard..."
    "$openclaw_bin" onboard || true
  else
    warn "非交互模式，跳过 onboard。请手动运行: ${BIN_NAME} onboard"
  fi
}

# ── 主流程 ────────────────────────────────────────────────────────────────────
main() {
  printf "\n${BOLD}openoctopus 安装脚本${RESET}\n\n"
  log "安装目录: ${INSTALL_DIR}"
  log "可执行文件: ${BIN_DIR}/${BIN_NAME}"
  echo ""

  ensure_git
  ensure_node
  ensure_pnpm
  sync_repo
  build_project
  install_wrapper
  post_install

  echo ""
  ok "安装完成！"
  printf "\n  使用: ${BOLD}${BIN_NAME} --help${RESET}\n"
  printf "  重启 gateway: ${BOLD}bash install.sh --restart${RESET}\n\n"
}

main
