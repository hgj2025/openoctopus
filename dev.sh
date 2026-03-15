#!/usr/bin/env bash
# Dev launcher — initializes nvm and starts frontend + backend.
# Run directly: bash dev.sh
# Control from another terminal: bash dev.sh ctl <r|b|f|q>

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ── Find node ──────────────────────────────────────────────────────────────────
find_node() {
  # 1. Already in PATH
  if command -v node &>/dev/null; then
    command -v node
    return
  fi
  # 2. Load nvm and use default
  local nvm_dir="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$nvm_dir/nvm.sh" ]; then
    # shellcheck disable=SC1091
    source "$nvm_dir/nvm.sh" --no-use
    if command -v node &>/dev/null; then
      command -v node
      return
    fi
  fi
  # 3. Resolve nvm default alias manually
  if [ -d "${NVM_DIR:-$HOME/.nvm}/versions/node" ]; then
    local nvm_dir="${NVM_DIR:-$HOME/.nvm}"
    local alias="default"
    # Follow alias chain (default → stable → lts/* → version)
    for _ in 1 2 3; do
      local resolved
      resolved=$(cat "$nvm_dir/alias/$alias" 2>/dev/null | tr -d '[:space:]') || break
      [ -z "$resolved" ] && break
      alias="$resolved"
    done
    # Try exact version match
    local node_bin
    node_bin=$(ls "$nvm_dir/versions/node/"*"${alias#v}"*/bin/node 2>/dev/null | sort -V | tail -1)
    if [ -z "$node_bin" ]; then
      # Fall back to newest installed version
      node_bin=$(ls "$nvm_dir/versions/node/"*/bin/node 2>/dev/null | sort -V | tail -1)
    fi
    if [ -n "$node_bin" ] && [ -x "$node_bin" ]; then
      echo "$node_bin"
      return
    fi
  fi
  echo "Error: cannot find node binary. Install Node.js via nvm or homebrew." >&2
  exit 1
}

NODE=$(find_node)
export PATH="$(dirname "$NODE"):$PATH"

# ── Kill existing openclaw processes ───────────────────────────────────────────
kill_existing() {
  local killed=0

  # Stop supervised gateway gracefully (handles launchd/systemd managed instances)
  if command -v openclaw &>/dev/null; then
    openclaw gateway stop 2>/dev/null && { echo "[dev.sh] 已停止 supervised gateway"; killed=1; } || true
  fi

  # Kill ALL previous dev-all.mjs launchers and their entire process trees
  # (dev-all.mjs spawns run-node→openclaw→openclaw-gateway + ui.js→pnpm→vite)
  local all_pids
  all_pids=$(pgrep -f "dev-all\.mjs|openclaw-gateway|openclaw|run-node\.mjs.*gateway|vite/bin/vite|scripts/ui\.js|pnpm run dev" 2>/dev/null || true)
  if [ -n "$all_pids" ]; then
    echo "[dev.sh] 停止已有进程: $(echo $all_pids | tr '\n' ' ')"
    echo "$all_pids" | xargs kill -9 2>/dev/null || true
    killed=1
  fi

  [ "$killed" = "1" ] && sleep 1
}

kill_existing

# ── Dispatch ───────────────────────────────────────────────────────────────────
if [ "$1" = "ctl" ]; then
  shift
  exec "$NODE" "$SCRIPT_DIR/scripts/dev-ctl.mjs" "$@"
fi

exec "$NODE" "$SCRIPT_DIR/scripts/dev-all.mjs" "$@"
