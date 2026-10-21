#!/bin/sh
# Builds native/bin/VoiceScribeHelper, a universal (arm64 + x86_64) binary, with
# the Swift compiler of the Xcode command line tools. `--test` runs the self-test.
set -eu
cd "$(dirname "$0")"
mkdir -p ../bin build
for arch in arm64 x86_64; do
  swiftc -O -target "$arch-apple-macos12" -framework AppKit -framework ApplicationServices \
    VoiceScribeHelper.swift -o "build/VoiceScribeHelper-$arch"
done
lipo -create build/VoiceScribeHelper-arm64 build/VoiceScribeHelper-x86_64 -output ../bin/VoiceScribeHelper
echo "Built $(cd ../bin && pwd)/VoiceScribeHelper"
if [ "${1:-}" = "--test" ]; then
  ../bin/VoiceScribeHelper --diagnostics
  ../bin/VoiceScribeHelper --self-test
fi
