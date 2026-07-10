#!/usr/bin/env bash
# Stop and remove the Boxge launchd service.
set -euo pipefail
LABEL="com.boxge.server"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
if [ -f "$PLIST" ]; then
    launchctl unload "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    echo "✅ Boxge service removed."
else
    echo "Boxge service is not installed (no $PLIST)."
fi
