#!/usr/bin/env bash
# Deploy herdr-mcp to a macOS host over SSH: build locally, sync the server,
# install a launchd agent, and health-check it.
#
#   REMOTE=me@server PUBLIC_URL=https://mcp.example.com ./deploy/install.sh
#
# Optional: REMOTE_DIR (default: herdr-mcp), PORT (18790), LABEL (com.herdr-mcp),
#           NODE_BIN (auto-detected on the remote host).
set -euo pipefail

: "${REMOTE:?set REMOTE=user@host}"
: "${PUBLIC_URL:?set PUBLIC_URL=https://your-public-host (must match the URL clients use)}"
REMOTE_DIR="${REMOTE_DIR:-herdr-core-mcp}"
PORT="${PORT:-18790}"
LABEL="${LABEL:-com.herdr-core-mcp}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

REMOTE_HOME="$(ssh "$REMOTE" 'printf %s "$HOME"')"
REPO_PATH="$REMOTE_HOME/$REMOTE_DIR"
NODE_BIN="${NODE_BIN:-$(ssh "$REMOTE" 'command -v node || true')}"
if [ -z "$NODE_BIN" ]; then
  echo "node not found on $REMOTE; set NODE_BIN=/absolute/path/to/node" >&2
  exit 1
fi

npm run build >/dev/null

ssh "$REMOTE" "mkdir -p \"$REPO_PATH\" \"$REMOTE_HOME/Library/Logs/herdr-mcp\" \"$REMOTE_HOME/Library/LaunchAgents\""

rsync -a --delete \
  --exclude node_modules \
  --exclude .git \
  "$ROOT/" "$REMOTE:$REMOTE_DIR/"

ssh "$REMOTE" "cd \"$REPO_PATH\" && npm ci --omit=dev --no-fund --no-audit >/dev/null && echo 'deps ok'"

RENDERED="$(mktemp)"
trap 'rm -f "$RENDERED"' EXIT
sed \
  -e "s|__LABEL__|$LABEL|g" \
  -e "s|__NODE__|$NODE_BIN|g" \
  -e "s|__REPO__|$REPO_PATH|g" \
  -e "s|__PORT__|$PORT|g" \
  -e "s|__PUBLIC_URL__|$PUBLIC_URL|g" \
  -e "s|__HOME__|$REMOTE_HOME|g" \
  "$ROOT/deploy/com.herdr-core-mcp.plist.template" > "$RENDERED"

scp "$RENDERED" "$REMOTE:Library/LaunchAgents/$LABEL.plist" >/dev/null
ssh "$REMOTE" "launchctl bootout gui/\$(id -u)/$LABEL 2>/dev/null || true; \
  launchctl bootstrap gui/\$(id -u) \"\$HOME/Library/LaunchAgents/$LABEL.plist\"; \
  launchctl kickstart -k gui/\$(id -u)/$LABEL; \
  sleep 2; \
  curl -fsS \"http://127.0.0.1:$PORT/healthz\"; echo"
