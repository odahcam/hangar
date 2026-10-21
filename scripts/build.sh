#!/bin/sh
# Builds build/Hangar.app: the server bundled as a Node single executable (SEA) plus the Swift window around it.
set -eu
cd "$(dirname "$0")/.."

BUILD=build
APP="$BUILD/Hangar.app"
rm -rf "$BUILD"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

# 1. Server -> one CommonJS file -> SEA blob injected into a copy of the node binary.
npx esbuild server/server.js --bundle --platform=node --format=cjs --outfile="$BUILD/server.cjs" --log-level=warning
cat > "$BUILD/sea-config.json" <<EOF
{ "main": "$BUILD/server.cjs", "output": "$BUILD/sea.blob", "disableExperimentalSEAWarning": true }
EOF
node --experimental-sea-config "$BUILD/sea-config.json"
SERVER="$APP/Contents/Resources/hangar-server"
cp "$(command -v node)" "$SERVER"
chmod u+w "$SERVER"
codesign --remove-signature "$SERVER"
npx postject "$SERVER" NODE_SEA_BLOB "$BUILD/sea.blob" \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 --macho-segment-name NODE_SEA

# 2. UI and icon.
cp -R web "$APP/Contents/Resources/web"
cp macos/Hangar.icns "$APP/Contents/Resources/Hangar.icns"
cp macos/Info.plist "$APP/Contents/Info.plist"

# 3. Swift window.
swiftc -O -o "$APP/Contents/MacOS/Hangar" macos/main.swift

# 4. Ad-hoc signature (inner binary first) so macOS will run it locally.
codesign --force --sign - "$SERVER"
codesign --force --sign - "$APP"

echo "Built $APP"
