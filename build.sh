#!/bin/sh
# Builds prwatch.app: the menu bar app, with the prwatch CLI (compiled by Bun) inside it.
set -eu
cd "$(dirname "$0")"
VERSION="${1:-$(node -p "require('./package.json').version")}"
APP="build/prwatch.app"

rm -rf build
mkdir -p build

echo "Compiling the prwatch CLI with Bun..."
bun build bin/prwatch.ts --compile --minify --outfile build/prwatch

echo "Building the menu bar app..."
swift build -c release --package-path app

mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Helpers"
cp app/.build/release/PrwatchBar "$APP/Contents/MacOS/PrwatchBar"
cp build/prwatch "$APP/Contents/Helpers/prwatch"
sed "s/__VERSION__/$VERSION/g" app/Info.plist > "$APP/Contents/Info.plist"
codesign --force --deep --sign - "$APP"

(cd build && ditto -c -k --keepParent prwatch.app "prwatch-$VERSION-macos-$(uname -m).zip")
echo "Built $APP and build/prwatch-$VERSION-macos-$(uname -m).zip (v$VERSION)"
