#!/usr/bin/env bash
set -euo pipefail

BOXGE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="$(command -v node || true)"
PORT="${BOXGE_PORT:-5001}"
LABEL="com.boxge.server"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
DOMAIN="gui/$(id -u)"

if [ -z "$NODE_BIN" ]; then
    echo "error: node not found on PATH. Install Node 22+ first." >&2
    exit 1
fi
NODE_DIR="$(dirname "$NODE_BIN")"

if ! command -v container >/dev/null 2>&1; then
    echo "warning: 'container' not found on PATH. Boxge needs Apple's container runtime." >&2
    echo "         See https://github.com/apple/container" >&2
fi

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
        <key>PATH</key><string>${NODE_DIR}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    </dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>${BOXGE_DIR}/data/boxge.log</string>
    <key>StandardErrorPath</key><string>${BOXGE_DIR}/data/boxge.err.log</string>
</dict>
</plist>
PLIST

if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    for _ in $(seq 1 50); do
        launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || break
        sleep 0.2
    done
fi
launchctl bootstrap "$DOMAIN" "$PLIST"

echo "✅ Boxge installed as a launchd service (${LABEL})."
echo "   URL:      http://localhost:${PORT}"
echo "   Logs:     ${BOXGE_DIR}/data/boxge.log"
echo "   Stop:     ./scripts/uninstall-service.sh"
echo "   Menu bar: ./extra/menubar/build.sh --install"
