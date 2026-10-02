#!/bin/bash
set -euo pipefail

# Build the MLX helper with the upstream Swift sources and the official Cmlx
# binary release. All generated sources, dependencies, and products stay in
# the ignored experiment cache.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXPERIMENT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CACHE_DIR="$EXPERIMENT_DIR/.cache"
UPSTREAM_DIR="$CACHE_DIR/upstream"
LOCAL_PACKAGES_DIR="$CACHE_DIR/local-packages"
RELEASE_DIR="$CACHE_DIR/release"
BUILD_DIR="$CACHE_DIR/native-build"
STAGE_ROOT="$CACHE_DIR/staged"
DEFAULT_APP_DIR="$STAGE_ROOT/Folio.app"
APP_DIR="${MLX_NATIVE_APP_OUTPUT:-$DEFAULT_APP_DIR}"
STAGE_ONLY=0
STAGE_ONLY_PRODUCTS=""

die() {
    printf 'build-native: %s\n' "$*" >&2
    exit 1
}

while (($#)); do
    case "$1" in
        --stage-only)
            [[ $# -ge 2 ]] || die "usage: $0 [--stage-only PRODUCTS_DIR] [--output APP_DIR]"
            STAGE_ONLY=1
            STAGE_ONLY_PRODUCTS="$2"
            shift 2
            ;;
        --output)
            [[ $# -ge 2 ]] || die "usage: $0 [--stage-only PRODUCTS_DIR] [--output APP_DIR]"
            APP_DIR="$2"
            shift 2
            ;;
        *) die "unknown argument: $1" ;;
    esac
done

MLX_SWIFT_VERSION=0.31.3
MLX_SWIFT_LM_VERSION=3.31.3
MLX_AUDIO_SWIFT_REVISION=8d86630ade569728aaea3dc1a29fc44e2efa719b
CMLX_URL="https://github.com/ml-explore/mlx-swift/releases/download/$MLX_SWIFT_VERSION/Cmlx.xcframework.zip"
# SHA-256 of the official 0.31.3 release archive.
CMLX_SHA256=e0fa04cb5bb2da239691c62c441b1742ff53d701267ba0612bfc8a6b81396d61

require_command() {
    command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

for command_name in curl ditto file git install_name_tool lipo otool python3 shasum xcrun; do
    require_command "$command_name"
done

[[ "$(uname -s)" == Darwin ]] || die "this build requires macOS"
[[ "$(uname -m)" == arm64 ]] || die "build on an Apple Silicon arm64 host"
[[ -f "$EXPERIMENT_DIR/Package.swift" && -f "$EXPERIMENT_DIR/Package.resolved" ]] \
    || die "the pinned experiment Package.swift and Package.resolved are required"
[[ -f "$SCRIPT_DIR/prepare-prebuilt-build.py" ]] || die "prepare-prebuilt-build.py is missing"

if (( STAGE_ONLY == 0 )); then
    selected_developer_dir="${DEVELOPER_DIR:-$(xcode-select -p 2>/dev/null || printf 'unavailable')}"
    if ! swiftpm_version="$(xcrun swift package --version 2>&1)"; then
        first_error_line="${swiftpm_version%%$'\n'*}"
        printf 'build-native: SwiftPM preflight failed using xcrun-selected Swift.\n' >&2
        printf 'Selected developer directory: %s\n' "$selected_developer_dir" >&2
        printf 'Selected toolchain: %s\n' "${TOOLCHAINS:-default}" >&2
        printf 'SwiftPM error: %s\n' "$first_error_line" >&2
        if [[ "$swiftpm_version" == *dyld* || "$swiftpm_version" == *'Symbol not found'* || "$swiftpm_version" == *'image not found'* ]]; then
            printf 'The selected swift-package cannot load a required Swift framework; this is a broken or mismatched SwiftPM installation.\n' >&2
        fi

        full_xcode_developer_dir=""
        for candidate in /Applications/Xcode*.app/Contents/Developer "${HOME:-/nonexistent}"/Applications/Xcode*.app/Contents/Developer; do
            if [[ -d "$candidate" ]]; then
                full_xcode_developer_dir="$candidate"
                break
            fi
        done
        if [[ -n "$full_xcode_developer_dir" ]]; then
            printf 'Try this build with the installed full Xcode (without changing the global selection):\n' >&2
            printf '  DEVELOPER_DIR=%q npm run build:mlx\n' "$full_xcode_developer_dir" >&2
            printf 'Verify the same selection first with: DEVELOPER_DIR=%q xcrun swift package --version\n' "$full_xcode_developer_dir" >&2
        else
            printf 'Update or repair Command Line Tools through macOS Software Update or Apple Developer downloads, then verify `xcrun swift package --version` before retrying.\n' >&2
        fi
        exit 1
    fi
fi

APP_DIR="$(python3 -c 'import os,sys; print(os.path.abspath(sys.argv[1]))' "$APP_DIR")"
DEFAULT_APP_DIR="$(python3 -c 'import os,sys; print(os.path.abspath(sys.argv[1]))' "$DEFAULT_APP_DIR")"
if [[ "$APP_DIR" != "$DEFAULT_APP_DIR" && ( -e "$APP_DIR" || -L "$APP_DIR" ) ]]; then
    die "custom output already exists; choose an unused --output path: $APP_DIR"
fi

mkdir -p "$STAGE_ROOT"

clone_tag() {
    local repository="$1"
    local version="$2"
    local destination="$3"
    local url="https://github.com/$repository.git"

    if [[ -d "$destination/.git" ]]; then
        local checked_out_tag
        checked_out_tag="$(git -C "$destination" describe --tags --exact-match HEAD 2>/dev/null || true)"
        if [[ "$checked_out_tag" == "$version" ]]; then
            return
        fi
        rm -rf "$destination"
    elif [[ -e "$destination" ]]; then
        rm -rf "$destination"
    fi

    git clone --depth 1 --recurse-submodules --branch "$version" "$url" "$destination"
    [[ "$(git -C "$destination" describe --tags --exact-match HEAD)" == "$version" ]] \
        || die "$repository did not check out the requested $version tag"
}

clone_revision() {
    local repository="$1"
    local revision="$2"
    local destination="$3"
    local url="https://github.com/$repository.git"

    if [[ -d "$destination/.git" && "$(git -C "$destination" rev-parse HEAD 2>/dev/null || true)" == "$revision" ]]; then
        return
    fi
    if [[ -e "$destination" ]]; then
        rm -rf "$destination"
    fi

    git clone --filter=blob:none "$url" "$destination"
    git -C "$destination" checkout --detach "$revision"
    [[ "$(git -C "$destination" rev-parse HEAD)" == "$revision" ]] \
        || die "$repository did not check out the requested revision"
}

if (( STAGE_ONLY == 0 )); then
mkdir -p "$UPSTREAM_DIR" "$RELEASE_DIR" "$LOCAL_PACKAGES_DIR" "$BUILD_DIR"

clone_tag ml-explore/mlx-swift "$MLX_SWIFT_VERSION" "$UPSTREAM_DIR/mlx-swift"
clone_tag ml-explore/mlx-swift-lm "$MLX_SWIFT_LM_VERSION" "$UPSTREAM_DIR/mlx-swift-lm"
clone_revision Blaizzy/mlx-audio-swift "$MLX_AUDIO_SWIFT_REVISION" "$UPSTREAM_DIR/mlx-audio-swift"

ARCHIVE="$CACHE_DIR/Cmlx.xcframework.zip"
if [[ -f "$ARCHIVE" ]]; then
    archive_sha="$(shasum -a 256 "$ARCHIVE" | awk '{print $1}')"
    if [[ "$archive_sha" != "$CMLX_SHA256" ]]; then
        rm -f "$ARCHIVE"
    fi
fi
if [[ ! -f "$ARCHIVE" ]]; then
    curl --fail --location --retry 3 "$CMLX_URL" --output "$ARCHIVE"
fi
archive_sha="$(shasum -a 256 "$ARCHIVE" | awk '{print $1}')"
[[ "$archive_sha" == "$CMLX_SHA256" ]] || die "Cmlx release archive checksum mismatch"

if [[ ! -d "$RELEASE_DIR/Cmlx.xcframework" ]]; then
    ditto -x -k "$ARCHIVE" "$RELEASE_DIR"
fi
python3 - "$RELEASE_DIR/Cmlx.xcframework/Info.plist" <<'PY'
import plistlib
import sys
from pathlib import Path

info_path = Path(sys.argv[1])
if not info_path.is_file():
    raise SystemExit(f"missing official Cmlx XCFramework metadata: {info_path}")
with info_path.open("rb") as stream:
    info = plistlib.load(stream)
matches = [
    library
    for library in info.get("AvailableLibraries", [])
    if library.get("SupportedPlatform") == "macos"
    and not library.get("SupportedPlatformVariant")
    and "arm64" in library.get("SupportedArchitectures", [])
]
if len(matches) != 1:
    raise SystemExit("official Cmlx archive has no unique macOS arm64 framework slice")
framework = info_path.parent / matches[0]["LibraryIdentifier"] / matches[0]["LibraryPath"]
if not (framework / "Cmlx").is_file():
    raise SystemExit(f"Cmlx framework binary is missing: {framework / 'Cmlx'}")
if not (framework / "Resources/default.metallib").is_file():
    raise SystemExit(f"Cmlx Metal shader is missing: {framework / 'Resources/default.metallib'}")
PY

# The helper copies the original pinned sources into ignored local-package and
# build directories, adapting only the Cmlx target to the official binary.
python3 "$SCRIPT_DIR/prepare-prebuilt-build.py"
[[ -f "$LOCAL_PACKAGES_DIR/mlx-swift/Package.swift" ]] || die "prepared mlx-swift package is missing"
[[ -f "$LOCAL_PACKAGES_DIR/mlx-swift-lm/Package.swift" ]] || die "prepared mlx-swift-lm package is missing"
[[ -L "$LOCAL_PACKAGES_DIR/mlx-swift/Cmlx.xcframework" ]] \
    || die "prepared mlx-swift package does not reference the official Cmlx binary"

# Gemma 4 E4B uses shared K/V tails absent from older checkpoint conversion
# logic. Apply the small reviewed backport to this ignored package copy only.
GEMMA4_PATCH="$EXPERIMENT_DIR/Patches/gemma4-text-pinned-3.31.3.patch"
[[ -f "$GEMMA4_PATCH" ]] || die "the pinned Gemma 4 compatibility patch is missing"
if patch --dry-run -R --forward -p1 -d "$LOCAL_PACKAGES_DIR/mlx-swift-lm" < "$GEMMA4_PATCH" >/dev/null 2>&1; then
    : # already applied in a reusable ignored source tree
elif patch --dry-run --forward -p1 -d "$LOCAL_PACKAGES_DIR/mlx-swift-lm" < "$GEMMA4_PATCH" >/dev/null 2>&1; then
    patch --forward -p1 -d "$LOCAL_PACKAGES_DIR/mlx-swift-lm" < "$GEMMA4_PATCH"
else
    die "the Gemma 4 compatibility patch does not apply to the pinned mlx-swift-lm source"
fi

# EmbeddingGemma's upstream Gemma 3 embedder initializer assigns wrapped
# submodules through ModuleInfo's guarded setter. Initialize the wrappers
# directly so the first pinned model load does not hit that fatal setter.
EMBEDDINGGEMMA_PATCH="$EXPERIMENT_DIR/Patches/embeddinggemma-moduleinfo-pinned-3.31.3.patch"
[[ -f "$EMBEDDINGGEMMA_PATCH" ]] || die "the EmbeddingGemma compatibility patch is missing"
if patch --dry-run -R --forward -p1 -d "$LOCAL_PACKAGES_DIR/mlx-swift-lm" < "$EMBEDDINGGEMMA_PATCH" >/dev/null 2>&1; then
    : # already applied in a reusable ignored source tree
elif patch --dry-run --forward -p1 -d "$LOCAL_PACKAGES_DIR/mlx-swift-lm" < "$EMBEDDINGGEMMA_PATCH" >/dev/null 2>&1; then
    patch --forward -p1 -d "$LOCAL_PACKAGES_DIR/mlx-swift-lm" < "$EMBEDDINGGEMMA_PATCH"
else
    die "the EmbeddingGemma compatibility patch does not apply to the pinned mlx-swift-lm source"
fi

# SwiftPM resolves remote transitive packages from the checked-in lockfile.
cp "$EXPERIMENT_DIR/Package.resolved" "$BUILD_DIR/Package.resolved"
xcrun swift package --package-path "$BUILD_DIR" resolve
xcrun swift build --package-path "$BUILD_DIR" --configuration release --arch arm64
PRODUCTS_DIR="$(xcrun swift build --package-path "$BUILD_DIR" --configuration release --arch arm64 --show-bin-path)"
else
    [[ -n "$STAGE_ONLY_PRODUCTS" && -d "$STAGE_ONLY_PRODUCTS" ]] \
        || die "--stage-only requires an existing SwiftPM products directory"
    PRODUCTS_DIR="$(cd "$STAGE_ONLY_PRODUCTS" && pwd)"
fi
PRODUCT="$PRODUCTS_DIR/folio-mlx"
FRAMEWORK_SOURCE="$PRODUCTS_DIR/Cmlx.framework"
[[ -f "$PRODUCT" ]] || die "SwiftPM did not produce folio-mlx"
[[ -d "$FRAMEWORK_SOURCE" ]] || die "SwiftPM did not produce the Cmlx framework"

# Stage in the ignored cache and publish only after the full tree passes its
# audits. MLX_NATIVE_APP_OUTPUT can point to a separate unused location.
STAGE_TMP="$STAGE_ROOT/.Folio.app.tmp.$$"
rm -rf "$STAGE_TMP"
trap 'rm -rf "$STAGE_TMP"' EXIT
CONTENTS="$STAGE_TMP/Contents"
MACOS_DIR="$CONTENTS/MacOS"
FRAMEWORKS_DIR="$CONTENTS/Frameworks"
RESOURCES_DIR="$CONTENTS/Resources"
mkdir -p "$MACOS_DIR" "$FRAMEWORKS_DIR" "$RESOURCES_DIR"
cp "$PRODUCT" "$MACOS_DIR/folio-mlx"
cp -R "$FRAMEWORK_SOURCE" "$FRAMEWORKS_DIR/"
bundle_count=0
for bundle in "$PRODUCTS_DIR"/*.bundle; do
    [[ -d "$bundle" ]] || continue
    [[ -f "$bundle/Contents/Info.plist" ]] || die "SwiftPM resource bundle is missing Info.plist: $bundle"
    cp -R "$bundle" "$RESOURCES_DIR/"
    bundle_count=$((bundle_count + 1))
done
(( bundle_count > 0 )) || die "SwiftPM did not produce the required resource bundles"

cat > "$CONTENTS/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>folio-mlx</string>
<key>CFBundleIdentifier</key><string>no.okf.folio.mlx-experiment</string>
<key>CFBundleName</key><string>Folio</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
</dict></plist>
PLIST

EXECUTABLE="$MACOS_DIR/folio-mlx"
FRAMEWORK_BINARY="$FRAMEWORKS_DIR/Cmlx.framework/Versions/A/Cmlx"
[[ -f "$FRAMEWORK_BINARY" ]] || die "staged Cmlx framework binary is missing"
[[ -f "$FRAMEWORKS_DIR/Cmlx.framework/Resources/default.metallib" ]] \
    || die "staged Cmlx Metal shader is missing"
[[ "$(lipo -archs "$EXECUTABLE")" == *arm64* ]] || die "staged helper is not arm64"
[[ "$(lipo -archs "$FRAMEWORK_BINARY")" == *arm64* ]] || die "staged Cmlx is not arm64"

# Remove build-machine search paths, then make the embedded framework resolvable.
while IFS= read -r rpath; do
    case "$rpath" in
        /Library/Developer/*|*/.build/*|/opt/homebrew/*|/Users/*|/private/*)
            install_name_tool -delete_rpath "$rpath" "$EXECUTABLE"
            ;;
    esac
done < <(otool -l "$EXECUTABLE" | awk '/cmd LC_RPATH/{getline; getline; print $2}')
install_name_tool -add_rpath @executable_path/../Frameworks "$EXECUTABLE"

# Copy compatibility shims required by the compiler while leaving system Swift
# libraries to the macOS 14+ runtime. Some Command Line Tools releases report
# required shims through --print but omit them from --copy, so close that gap.
SWIFT_RUNTIME_PATHS="$(xcrun swift-stdlib-tool --print --scan-executable "$EXECUTABLE" --platform macosx)"
xcrun swift-stdlib-tool --copy --scan-executable "$EXECUTABLE" \
    --destination "$FRAMEWORKS_DIR" --platform macosx
while IFS= read -r runtime_path; do
    [[ -n "$runtime_path" ]] || continue
    [[ -f "$runtime_path" ]] || die "Swift runtime tool reported a missing library: $runtime_path"
    runtime_name="$(basename "$runtime_path")"
    [[ "$runtime_name" == libswiftCompatibility*.dylib ]] \
        || die "unexpected non-compatibility Swift runtime in bundle-copy list: $runtime_name"
    [[ -f "$FRAMEWORKS_DIR/$runtime_name" ]] || cp "$runtime_path" "$FRAMEWORKS_DIR/$runtime_name"
done <<< "$SWIFT_RUNTIME_PATHS"

NATIVE_BINARIES=("$EXECUTABLE" "$FRAMEWORK_BINARY")
while IFS= read -r -d '' runtime_binary; do
    NATIVE_BINARIES+=("$runtime_binary")
done < <(find "$FRAMEWORKS_DIR" -type f -name '*.dylib' -print0)

for binary in "${NATIVE_BINARIES[@]}"; do
    [[ "$(lipo -archs "$binary")" == *arm64* ]] \
        || die "staged native dependency is not arm64: $binary"
    file "$binary"
done

if ! otool -l "$EXECUTABLE" | grep -Fq 'path @executable_path/../Frameworks'; then
    die "helper is missing the app Frameworks runpath"
fi
python3 - "$CONTENTS" "$EXECUTABLE" "${NATIVE_BINARIES[@]}" <<'PY'
import re
import subprocess
import sys
from pathlib import Path

contents = Path(sys.argv[1]).resolve()
executable = Path(sys.argv[2]).resolve()
frameworks = (contents / "Frameworks").resolve()

def output(*args: str) -> str:
    return subprocess.check_output(args, text=True)

def contained(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root)
        return True
    except ValueError:
        return False

def anchored_path(value: str, prefix: str, root: Path):
    if value == prefix:
        return root
    if value.startswith(prefix + "/"):
        return root / value[len(prefix) + 1:]
    return None

def rpaths(binary: Path) -> list[str]:
    return re.findall(r"^\s*path (.*?) \(offset \d+\)$", output("otool", "-l", str(binary)), re.MULTILINE)

def install_ids(binary: Path) -> set[str]:
    if binary == executable:
        return set()
    try:
        lines = output("otool", "-D", str(binary)).splitlines()[1:]
    except subprocess.CalledProcessError:
        return set()
    return {line.split(" (architecture", 1)[0].strip() for line in lines if line.strip()}

executable_rpaths = rpaths(executable)
for raw_binary in sys.argv[3:]:
    binary = Path(raw_binary).resolve()
    binary_rpaths = rpaths(binary)
    for rpath in binary_rpaths:
        if any(fragment in rpath for fragment in ("/Users/", "/private/", "/opt/homebrew/", "/Library/Developer/", "/.build/", "/.cache/")):
            raise SystemExit(f"build-machine LC_RPATH remains in {binary}: {rpath}")
        if rpath.startswith("/"):
            if not (rpath.startswith("/usr/lib/") or rpath.startswith("/System/Library/")):
                raise SystemExit(f"unexpected absolute LC_RPATH in {binary}: {rpath}")
        elif rpath == "@executable_path" or rpath.startswith("@executable_path/"):
            expanded = anchored_path(rpath, "@executable_path", executable.parent)
            if not contained(expanded, contents):
                raise SystemExit(f"LC_RPATH escapes app bundle in {binary}: {rpath}")
        elif rpath == "@loader_path" or rpath.startswith("@loader_path/"):
            expanded = anchored_path(rpath, "@loader_path", binary.parent)
            if not contained(expanded, contents):
                raise SystemExit(f"LC_RPATH escapes app bundle in {binary}: {rpath}")
        else:
            raise SystemExit(f"unrecognized LC_RPATH in {binary}: {rpath}")

    dependency_lines = output("otool", "-L", str(binary)).splitlines()[1:]
    own_install_ids = install_ids(binary)
    for line in dependency_lines:
        item = line.strip()
        if not item or item.endswith(":"):
            continue
        dependency = item.split(" (compatibility version", 1)[0].strip()
        if dependency in own_install_ids:
            continue
        if dependency.startswith(("/System/Library/", "/usr/lib/")):
            continue
        if dependency.startswith("@rpath/"):
            relative = dependency.removeprefix("@rpath/")
            staged_target = frameworks / relative
            if not staged_target.is_file() or not contained(staged_target, frameworks):
                raise SystemExit(f"unresolved staged @rpath dependency in {binary}: {dependency}")
            candidates = []
            search_rpaths = [(rpath, binary) for rpath in binary_rpaths]
            if binary != executable:
                search_rpaths.extend((rpath, executable) for rpath in executable_rpaths)
            for rpath, owner in search_rpaths:
                if rpath == "@executable_path" or rpath.startswith("@executable_path/"):
                    base = anchored_path(rpath, "@executable_path", executable.parent)
                elif rpath == "@loader_path" or rpath.startswith("@loader_path/"):
                    base = anchored_path(rpath, "@loader_path", owner.parent)
                else:
                    continue
                candidate = base / relative
                if contained(candidate, frameworks) and candidate.is_file():
                    candidates.append(candidate)
            if not candidates:
                raise SystemExit(f"no LC_RPATH resolves {dependency} inside Frameworks for {binary}")
        elif dependency.startswith(("@loader_path/", "@executable_path/")):
            prefix, relative = dependency.split("/", 1)
            base = binary.parent if prefix == "@loader_path" else executable.parent
            target = base / relative
            if not target.is_file() or not contained(target, contents):
                raise SystemExit(f"unresolved app-relative dependency in {binary}: {dependency}")
        else:
            raise SystemExit(f"unexpected non-system dependency in {binary}: {dependency}")
PY

for index in "${!NATIVE_BINARIES[@]}"; do
    binary="${NATIVE_BINARIES[$index]}"
    build_info="$(xcrun vtool -show-build "$binary")"
    printf '%s\n' "$build_info" | grep -q 'platform MACOS' \
        || die "unexpected non-macOS platform in $binary"
    min_os_values="$(printf '%s\n' "$build_info" | awk '/minos/{print $2}')"
    [[ -n "$min_os_values" ]] || die "missing macOS deployment target in $binary"
    if (( index < 2 )); then
        python3 - "$min_os_values" <<'PY'
import sys
values = sys.argv[1].splitlines()
version = lambda value: tuple((list(map(int, value.split("."))) + [0, 0, 0])[:3])
if any(version(value) != (14, 0, 0) for value in values):
    raise SystemExit(f"helper/framework deployment targets must be macOS 14.0: {values}")
PY
    else
        python3 - "$min_os_values" <<'PY'
import sys
values = sys.argv[1].splitlines()
version = lambda value: tuple((list(map(int, value.split("."))) + [0, 0, 0])[:3])
if any(version(value) > (14, 0, 0) for value in values):
    raise SystemExit(f"Swift compatibility runtime requires newer than macOS 14: {values}")
PY
    fi
done

mkdir -p "$(dirname "$APP_DIR")"
if [[ "$APP_DIR" == "$DEFAULT_APP_DIR" && -e "$APP_DIR" ]]; then
    BACKUP_DIR="$STAGE_ROOT/.Folio.app.previous.$$"
    mv "$APP_DIR" "$BACKUP_DIR"
    if mv "$STAGE_TMP" "$APP_DIR"; then
        rm -rf "$BACKUP_DIR"
    else
        mv "$BACKUP_DIR" "$APP_DIR"
        die "could not publish the staged app"
    fi
else
    mv "$STAGE_TMP" "$APP_DIR"
fi
trap - EXIT

printf 'Staged native helper: %s\n' "$APP_DIR"
file "$APP_DIR/Contents/MacOS/folio-mlx"
otool -L "$APP_DIR/Contents/MacOS/folio-mlx"
