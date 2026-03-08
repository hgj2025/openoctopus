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

# ── Dispatch ───────────────────────────────────────────────────────────────────
if [ "$1" = "ctl" ]; then
  shift
  exec "$NODE" "$SCRIPT_DIR/scripts/dev-ctl.mjs" "$@"
fi

exec "$NODE" "$SCRIPT_DIR/scripts/dev-all.mjs" "$@"
