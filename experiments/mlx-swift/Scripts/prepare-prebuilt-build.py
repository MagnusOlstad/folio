#!/usr/bin/env python3
"""Prepare an ignored SwiftPM workspace using the official prebuilt Cmlx framework."""

from pathlib import Path
import shutil
import subprocess
import sys


def copy_tree(source: Path, destination: Path) -> None:
    if destination.exists():
        shutil.rmtree(destination)
    shutil.copytree(source, destination, ignore=shutil.ignore_patterns(".git"))


def main() -> None:
    experiment = Path(__file__).resolve().parents[1]
    cache = experiment / ".cache"
    upstream = cache / "upstream"
    local = cache / "local-packages"
    build = cache / "native-build"

    upstream_mlx = upstream / "mlx-swift"
    upstream_lm = upstream / "mlx-swift-lm"
    upstream_audio = upstream / "mlx-audio-swift"
    framework = cache / "release" / "Cmlx.xcframework"
    for source in (upstream_mlx, upstream_lm, upstream_audio):
        if not (source / "Package.swift").is_file():
            raise SystemExit(f"required pinned package source is missing: {source}")
    if (upstream_audio / ".git").is_dir():
        revision = subprocess.check_output(
            ["git", "-C", str(upstream_audio), "rev-parse", "HEAD"], text=True
        ).strip()
        if revision != "8d86630ade569728aaea3dc1a29fc44e2efa719b":
            raise SystemExit("mlx-audio-swift is not at the required pinned revision")
    if not (framework / "Info.plist").is_file():
        raise SystemExit(f"official Cmlx binary framework is missing: {framework}")
    mlx_source_manifest = (upstream_mlx / "Package.swift").read_text()
    if "let cmlx = Target.target(" not in mlx_source_manifest or "let package = Package(" not in mlx_source_manifest:
        raise SystemExit("upstream mlx-swift package manifest changed; refusing to patch it")
    lm_source_manifest = (upstream_lm / "Package.swift").read_text()
    remote_mlx_dependency = '.package(url: "https://github.com/ml-explore/mlx-swift", .upToNextMinor(from: "0.31.3"))'
    if remote_mlx_dependency not in lm_source_manifest:
        raise SystemExit("upstream mlx-swift-lm manifest changed; refusing to patch it")
    source_dir = experiment / "Sources"
    if not source_dir.is_dir():
        raise SystemExit(f"helper source directory is missing: {source_dir}")

    copy_tree(upstream / "mlx-swift", local / "mlx-swift")
    copy_tree(upstream / "mlx-swift-lm", local / "mlx-swift-lm")
    copy_tree(upstream / "mlx-audio-swift", local / "mlx-audio-swift")
    (local / "mlx-swift" / "Cmlx.xcframework").symlink_to(
        framework, target_is_directory=True
    )

    mlx_manifest = local / "mlx-swift" / "Package.swift"
    text = mlx_manifest.read_text()
    start = text.index("let cmlx = Target.target(")
    end = text.index("let package = Package(", start)
    text = text[:start] + 'let cmlx = Target.binaryTarget(name: "Cmlx", path: "Cmlx.xcframework")\n\n' + text[end:]
    mlx_manifest.write_text(text)

    lm_manifest = local / "mlx-swift-lm" / "Package.swift"
    text = lm_manifest.read_text()
    lm_manifest.write_text(text.replace(remote_mlx_dependency, '.package(path: "../mlx-swift")'))

    audio_manifest = local / "mlx-audio-swift" / "Package.swift"
    text = audio_manifest.read_text()
    audio_dependencies = {
        '.package(url: "https://github.com/ml-explore/mlx-swift.git", .upToNextMajor(from: "0.30.6"))':
            '.package(path: "../mlx-swift")',
        '.package(url: "https://github.com/ml-explore/mlx-swift-lm.git", .upToNextMajor(from: "3.31.3"))':
            '.package(path: "../mlx-swift-lm")',
    }
    for original, replacement in audio_dependencies.items():
        if original not in text:
            raise SystemExit(f"Pinned mlx-audio-swift manifest changed; expected {original}")
        text = text.replace(original, replacement)
    audio_manifest.write_text(text)

    whisper_patch = experiment / "Patches" / "whisper-language-detection-pinned-8d86630.patch"
    if not whisper_patch.is_file():
        raise SystemExit(f"pinned Whisper language detection patch is missing: {whisper_patch}")
    with whisper_patch.open("rb") as patch_file:
        subprocess.run(
            ["patch", "--forward", "-p1", "-d", str(local / "mlx-audio-swift")],
            stdin=patch_file,
            check=True,
        )

    build.mkdir(parents=True, exist_ok=True)
    (build / "Sources").mkdir(exist_ok=True)
    copy_tree(experiment / "Sources", build / "Sources")
    manifest = (experiment / "Package.swift").read_text()
    replacements = {
        '.package(url: "https://github.com/ml-explore/mlx-swift-lm", exact: "3.31.3")':
            '.package(path: "../local-packages/mlx-swift-lm")',
        '.package(url: "https://github.com/ml-explore/mlx-swift", exact: "0.31.3")':
            '.package(path: "../local-packages/mlx-swift")',
        '.package(url: "https://github.com/Blaizzy/mlx-audio-swift.git", revision: "8d86630ade569728aaea3dc1a29fc44e2efa719b")':
            '.package(path: "../local-packages/mlx-audio-swift")',
    }
    for original, replacement in replacements.items():
        if original not in manifest:
            raise SystemExit(f"Pinned Folio package manifest changed; expected {original}")
        manifest = manifest.replace(original, replacement)
    (build / "Package.swift").write_text(manifest)


if __name__ == "__main__":
    main()
