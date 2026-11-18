#!/usr/bin/env bash
set -euo pipefail

LABEL="com.boxge.server"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
DOMAIN="gui/$(id -u)"

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true

if [ -f "$PLIST" ]; then
    rm -f "$PLIST"
    echo "✅ Boxge service removed."
else
    echo "Boxge service is not installed (no $PLIST)."
fi
