#!/bin/bash
# Build VoxtralHTTPServer and deploy binary + Metal shaders to bin/
set -e

cd "$(dirname "$0")"

echo "Building VoxtralHTTPServer..."
xcodebuild -scheme VoxtralHTTPServer -configuration Release \
  -derivedDataPath .build/xcode -destination 'platform=macOS' build 2>&1 \
  | grep -E "BUILD|error:|warning:.*VoxtralHTTPServer" | head -20

PRODUCTS=".build/xcode/Build/Products/Release"

mkdir -p bin
cp "$PRODUCTS/VoxtralHTTPServer" bin/VoxtralHTTPServer
cp -R "$PRODUCTS/mlx-swift_Cmlx.bundle" bin/
chmod +x bin/VoxtralHTTPServer

echo "Deployed to bin/"
ls -lh bin/VoxtralHTTPServer
