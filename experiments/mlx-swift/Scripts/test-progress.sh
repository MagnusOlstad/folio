#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXPERIMENT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TEMP_PACKAGE="$(mktemp -d "${TMPDIR:-/tmp}/folio-mlx-progress.XXXXXX")"
trap 'rm -rf "$TEMP_PACKAGE"' EXIT

mkdir -p \
    "$TEMP_PACKAGE/Sources/FolioMLXProgress" \
    "$TEMP_PACKAGE/Tests/FolioMLXProgressTests"
cp "$EXPERIMENT_DIR/Sources/FolioMLXProgress/DownloadProgressBytes.swift" \
    "$TEMP_PACKAGE/Sources/FolioMLXProgress/"
cp "$EXPERIMENT_DIR/Tests/FolioMLXProgressTests/DownloadProgressBytesTests.swift" \
    "$TEMP_PACKAGE/Tests/FolioMLXProgressTests/"

cat > "$TEMP_PACKAGE/Package.swift" <<'PACKAGE'
// swift-tools-version: 6.1
import PackageDescription

let package = Package(
    name: "FolioMLXProgress",
    targets: [
        .target(name: "FolioMLXProgress"),
        .testTarget(name: "FolioMLXProgressTests", dependencies: ["FolioMLXProgress"]),
    ]
)
PACKAGE

xcrun swift test --package-path "$TEMP_PACKAGE"
