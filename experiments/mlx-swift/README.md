# Folio's Swift MLX helper

This directory contains the pinned native helper source and reproducible
developer build. Release packaging embeds the resulting `Folio.app/Contents`
tree into Electron resources. Model weights remain in the user's data folder
and are downloaded only after they start an installation in Folio.

## Supported runtime

The helper requires Apple Silicon and macOS 14 or newer. It uses MLX Swift
0.31.3 and MLX Swift LM 3.31.3, resolved in `Package.resolved`. The Gemma 4
E4B support backport is in `Patches/gemma4-text-pinned-3.31.3.patch`. The
EmbeddingGemma initializer fix is in
`Patches/embeddinggemma-moduleinfo-pinned-3.31.3.patch`; both are applied to
ignored source copies during the build and do not alter upstream package
checkouts. It initializes `ModuleInfo` children through the supported module
update API and defines this checkpoint's projection head as 768→3072→768. The
checkpoint's packed dense tensors establish those dimensions; its config's
`intermediate_size` (1152) describes the transformer feed-forward layers, so
the projection shape is deliberately fixed to the selected snapshot. MLX's
loader converts these linear layers to 4-bit quantized modules from the
checkpoint scales before applying their weights.

The two pinned model snapshots are:

- `mlx-community/gemma-4-e4b-it-4bit` at
  `475b9088d29754a3379866cf5aeb6b41acd313c2` for generation.
- `mlx-community/embeddinggemma-300m-4bit` at
  `5d9ef074df3957afc5c77127f208fddbc3c54187` for semantic embeddings.

## Build

On an arm64 Mac with working SwiftPM from Xcode Command Line Tools or Xcode, run:

```sh
npm run build:mlx
```

The build fetches the pinned Swift sources and verified Cmlx framework into
the ignored `.cache` directory, compiles the helper, then stages a relocatable
app tree at `.cache/staged/Folio.app`. This builds the runtime only; it does
not download either model. `npm run desktop` and the macOS packaging scripts
run this build before launching or packaging Folio.
The package declares Swift tools version 6.1; this build has been validated with
Swift 6.4. The preflight verifies that the selected SwiftPM launches and leaves
manifest and compiler compatibility checks to SwiftPM itself.

The build uses `xcrun swift` throughout, respecting per-command `DEVELOPER_DIR`
and `TOOLCHAINS` settings. Before creating its cache or fetching sources, it
checks that the selected Swift Package Manager can run with
`xcrun swift package --version`. If this fails with a `dyld` or missing-symbol
error, repair or update Command Line Tools through macOS Software Update or
Apple Developer downloads, then verify that command before retrying. If a full
Xcode installation is available, select it for one build without changing the
global selection:

```sh
DEVELOPER_DIR="/path/to/Xcode.app/Contents/Developer" xcrun swift package --version
DEVELOPER_DIR="/path/to/Xcode.app/Contents/Developer" npm run build:mlx
```

## Helper protocol

The Node service starts one helper process per model with `--task generation`
or `--task embedding`, plus the pinned repository and revision. When a verified
local snapshot exists, it also passes `--model-directory`; this prevents model
loading from silently resolving an unpinned or remote snapshot.

The helper reports a JSON `ready` event on stdout and then accepts one JSON
object per stdin line. Generation requests provide a system and user message;
embedding requests provide an array of non-empty strings. Each response carries
the request id, generated text or embedding vectors, and allocator memory
readings. `status` and `shutdown` operations support lifecycle management.
Diagnostics go to stderr. A fresh generation session is released and MLX's
allocator cache is cleared after every request, including failures; the model
remains loaded until the service's keep-alive expires or the user stops it.
