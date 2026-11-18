#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
REPO="$(cd ../.. && pwd)"
APP="build/Boxge.app"
INSTALL_DIR="$HOME/Applications"
VERSION="$(/usr/bin/plutil -extract version raw -o - "$REPO/package.json")"

rm -rf build
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

swiftc -O -target arm64-apple-macos26.0 Sources/*.swift -o "$APP/Contents/MacOS/Boxge"

cp Info.plist "$APP/Contents/Info.plist"
/usr/bin/plutil -replace CFBundleShortVersionString -string "$VERSION" "$APP/Contents/Info.plist"

ICON_SOURCE="$REPO/frontend/public/icon-512x512.png"
if [ -f "$ICON_SOURCE" ]; then
    ICONSET="build/AppIcon.iconset"
    mkdir -p "$ICONSET"
    for size in 16 32 128 256; do
        /usr/bin/sips -z "$size" "$size" "$ICON_SOURCE" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
        /usr/bin/sips -z "$((size * 2))" "$((size * 2))" "$ICON_SOURCE" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
    done
    /usr/bin/iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"
    rm -rf "$ICONSET"
fi

/usr/bin/codesign --force --sign - "$APP" >/dev/null 2>&1

echo "Built $(pwd)/$APP"

if [ "${1:-}" = "--install" ]; then
    /usr/bin/pkill -x Boxge 2>/dev/null || true
    mkdir -p "$INSTALL_DIR"
    rm -rf "$INSTALL_DIR/Boxge.app"
    cp -R "$APP" "$INSTALL_DIR/Boxge.app"
    /usr/bin/open "$INSTALL_DIR/Boxge.app"
    echo "Installed and started $INSTALL_DIR/Boxge.app"
fi
