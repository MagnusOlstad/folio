#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXPERIMENT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TEMP_PACKAGE="$(mktemp -d "${TMPDIR:-/tmp}/folio-audio-window.XXXXXX")"
trap 'rm -rf "$TEMP_PACKAGE"' EXIT

mkdir -p "$TEMP_PACKAGE/Sources/FolioMLXAudio" "$TEMP_PACKAGE/Sources/AudioWindowReaderTests"
cp "$EXPERIMENT_DIR/Sources/FolioMLXAudio/AudioWindowReader.swift" \
    "$TEMP_PACKAGE/Sources/FolioMLXAudio/"
cp "$EXPERIMENT_DIR/Tests/FolioMLXAudioTests/AudioWindowReaderTests.swift" \
    "$TEMP_PACKAGE/Sources/AudioWindowReaderTests/main.swift"

cat > "$TEMP_PACKAGE/Package.swift" <<'PACKAGE'
// swift-tools-version: 6.1
import PackageDescription

let package = Package(
    name: "FolioMLXAudio",
    platforms: [.macOS(.v14)],
    targets: [
        .target(name: "FolioMLXAudio"),
        .executableTarget(name: "AudioWindowReaderTests", dependencies: ["FolioMLXAudio"]),
    ]
)
PACKAGE

xcrun swift run --package-path "$TEMP_PACKAGE" AudioWindowReaderTests
