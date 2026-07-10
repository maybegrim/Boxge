#!/usr/bin/env bash
#
# Install Boxge as a per-user launchd service so it runs headless and restarts on login/crash.
# Run once from the repo:  ./scripts/install-service.sh
# Uninstall:               ./scripts/uninstall-service.sh
#
set -euo pipefail

BOXGE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="$(command -v node || true)"
PORT="${BOXGE_PORT:-5001}"
LABEL="com.boxge.server"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"

if [ -z "$NODE_BIN" ]; then
    echo "error: node not found on PATH. Install Node 22+ first." >&2
    exit 1
fi
NODE_DIR="$(dirname "$NODE_BIN")"

if ! command -v container >/dev/null 2>&1; then
    echo "warning: 'container' not found on PATH. Boxge needs Apple's container runtime." >&2
    echo "         See https://github.com/apple/container" >&2
fi

# Make sure deps + a built frontend exist (the production server serves frontend-dist).
if [ ! -d "$BOXGE_DIR/node_modules" ]; then
    echo "Installing dependencies…"
    ( cd "$BOXGE_DIR" && npm install )
fi
if [ ! -f "$BOXGE_DIR/frontend-dist/index.html" ]; then
    echo "Building frontend…"
    ( cd "$BOXGE_DIR" && npm run build:frontend )
fi

mkdir -p "$HOME/Library/LaunchAgents" "$BOXGE_DIR/data"

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${NODE_BIN}</string>
        <string>${BOXGE_DIR}/node_modules/.bin/tsx</string>
        <string>${BOXGE_DIR}/backend/index.ts</string>
    </array>
    <key>WorkingDirectory</key><string>${BOXGE_DIR}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>NODE_ENV</key><string>production</string>
        <key>BOXGE_PORT</key><string>${PORT}</string>
        <key>PATH</key><string>${NODE_DIR}:/usr/local/bin:/usr/bin:/bin</string>
    </dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>${BOXGE_DIR}/data/boxge.log</string>
    <key>StandardErrorPath</key><string>${BOXGE_DIR}/data/boxge.err.log</string>
</dict>
</plist>
PLIST

# (Re)load the service.
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

echo "✅ Boxge installed as a launchd service (${LABEL})."
echo "   URL:  http://localhost:${PORT}"
echo "   Logs: ${BOXGE_DIR}/data/boxge.log"
echo "   Stop: ./scripts/uninstall-service.sh"
