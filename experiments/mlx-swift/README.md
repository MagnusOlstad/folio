# Folio native MLX investigation

This isolated prototype tests whether Folio can run local text generation through
MLX Swift inside its Electron process tree. It does not change the production
server, API, Electron configuration, dependencies, or Ollama behavior.

## Feasibility result

The native Swift helper was built, relocated outside the checkout with its MLX
framework and Metal library, and run both directly and from an actual Electron
38.8.6 main process. Both runs generated responses from Qwen3.5-4B. The helper
continued to accept JSONL requests while stdin remained open. A local model
snapshot also generated successfully with empty Hugging Face cache variables,
showing that a user who has downloaded model files can generate offline.

The build host has Command Line Tools but no Xcode Metal compiler. The
development script stages the official `mlx-swift` 0.31.3 `Cmlx.xcframework`
release artifact and builds the Swift wrapper against a temporary patched copy
of upstream package sources. This is a developer build convenience; it does
not alter the checked-in Swift package manifest or download code at app runtime.
The end-user architecture can bundle the prebuilt helper, framework, Swift
compatibility libraries, and Metal resource in the Electron app, then download
model weights, tokenizer, and config files from Hugging Face into writable app
data. No user-installed Swift, Xcode, Python, MLX package, or separate server is
needed for this path.

The tested target is Apple Silicon on macOS 14 or newer, matching the MLX Swift
package deployment target. This prototype ran on an M2 with 16 GB RAM and
macOS 27. It did not test a clean macOS 14 host, the final signed/notarized Folio
bundle, or memory-constrained Apple Silicon hardware. Larger models have higher
and architecture-dependent memory needs.

Qwen's first Hugging Face load took about 197.5 seconds including the model
download. A cached local-directory cold load took about 1.8 seconds. In two
relocated JSONL requests, generation throughput was about 31.8 tokens/second.
These are prototype observations, not a model comparison. The English filing
preserved the decision and selected the expected folder. The Norwegian filing
preserved dates and negation but translated its title and description into
English, a clear language-preservation miss. The exact raw Qwen smoke responses
and metrics are in `Results/qwen-smoke.jsonl`.

MLX allocator active/cache snapshots and process peak RSS are separate readings;
do not add them together. `mlxPeakBytes` is the allocator's peak active memory,
not a peak of active plus cached or total system unified memory. RSS alone also
does not describe Metal/unified allocations.

## Build and staging

Run the developer build script from this directory on an arm64 Mac with Swift
6.4 Command Line Tools. It downloads the official MLX binary release and pinned
Swift package source/dependencies into ignored `.cache` and build directories,
then stages a self-contained test app at `.cache/staged/Folio.app` by default:

```sh
bash Scripts/build-native.sh
```

The inference smoke used a copy relocated outside the checkout at
`/private/tmp/folio-mlx-final/Folio.app`; the reusable build script's default
staging path remains under ignored `.cache`. To run the helper from the staged
bundle and keep the model cache in an app-data-like directory:

```sh
env -u DYLD_FRAMEWORK_PATH -u DYLD_LIBRARY_PATH \
  HF_HUB_CACHE="$PWD/.cache/hf-cache" \
  "$PWD/.cache/staged/Folio.app/Contents/MacOS/folio-mlx" \
  --model mlx-community/Qwen3.5-4B-MLX-4bit
```

For offline generation, point at an already downloaded Hugging Face snapshot.
This path uses local model and tokenizer files without hub lookup:

```sh
folio-mlx --model mlx-community/Qwen3.5-4B-MLX-4bit \
  --model-directory /path/to/hf/snapshots/<revision>
```

The helper loads one model per process, then handles one request per JSONL line.
Requests must contain exactly one non-empty `system` message and one non-empty
`user` message. `--model`, `--model-directory`, `--max-tokens`, and
`--temperature` configure the process; requests may override token count and
temperature. Qwen receives `enable_thinking: false` by default. Diagnostics go
to stderr; stdout contains only JSONL responses with timing, token, RSS, and MLX
allocator metrics. The generator accepts unconstrained text: MLX Swift LM 3.31.3
does not include the later standalone MLX Guided Generation JSON Schema product.

`Scripts/electron-smoke.mjs` launches the helper from the official Electron
38.8.6 app, keeps stdin open across two requests, and checks response IDs and
basic filing shape. It does not modify or launch the installed Folio app.
`Scripts/benchmark.py` runs the same fixtures serially against existing local
model snapshots, saves each raw response and the associated metrics, and emits
informational JSON/schema/path/kind/text checks. These checks are not a semantic
quality score; inspect the raw output for title relevance, useful links/tags,
faithful summaries, language, uncertainty, and negation. The fixtures use one
general prompt/schema across models and fixed temperature 0 / 512 max tokens.

For example, after downloading a model snapshot, run one measured pass plus a
warm-up with:

```sh
python3 Scripts/benchmark.py \
  --helper "$PWD/.cache/staged/Folio.app/Contents/MacOS/folio-mlx" \
  --model mlx-community/Qwen3.5-4B-MLX-4bit \
  --model-directory /path/to/hf/snapshots/<revision> \
  --output Results/qwen-benchmark.jsonl
```

For a broader CPU/GPU target than Apple-only MLX, bundled `llama.cpp` is a
credible alternative to evaluate: its upstream project supports Apple Silicon
through Metal and publishes binaries, and its grammar layer supports constrained
generation, including a subset of JSON Schema. This experiment did not benchmark
it. [llama.cpp](https://github.com/ggml-org/llama.cpp) ·
[grammar and JSON Schema support](https://github.com/ggml-org/llama.cpp/blob/master/grammars/README.md).

## Light model comparison

The user prioritized filing quality and precision first, memory second, then
speed. This is one pass over six synthetic filing notes and one grounded-answer
case using the same general prompt, schema, temperature 0, 512-token limit, and
no-thinking request for every model. Each helper process handled one discarded
warm-up and all seven measured requests. Model data was already cached locally;
cold-load figures below are local-directory model loads and exclude downloads.

| Model | Strict JSON | JSON body schema | Kind / path | Median filing time | Median tok/s | Median TTFT | Cached load | Max active + cache sample | Peak active | Peak RSS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Qwen3.5-4B | 6/6 | 6/6 | 5/6 · 4/6 | 5.42s | 31.70 | 1.92s | 1.64s | 6.09 GiB | 2.94 GiB | 1.85 GiB |
| Gemma 3 text 4B | 0/6 | 6/6 | 6/6 · 6/6 | 5.98s | 33.30 | 2.81s | 2.06s | 5.18 GiB | 2.86 GiB | 2.74 GiB |
| Llama 3.2 3B | 0/6 | 6/6 | 4/6 · 5/6 | 4.33s | 44.86 | 0.80s | 1.31s | 4.80 GiB | 2.21 GiB | 1.87 GiB |
| Ministral 3 3B | 0/6 | 5/6 | 5/6 · 3/6 | 4.87s | 37.47 | 1.49s | 1.05s | 4.46 GiB | 2.30 GiB | 2.00 GiB |

The measured repositories were `mlx-community/Qwen3.5-4B-MLX-4bit`,
`mlx-community/gemma-3-text-4b-it-4bit`,
`mlx-community/Llama-3.2-3B-Instruct-4bit`, and
`mlx-community/Ministral-3-3B-Instruct-2512-4bit`.

The JSON body check parses an object inside Markdown fences when the model adds
them, even if explanatory prose surrounds the fence. Strict JSON means the raw
response itself is only JSON. MLX active/cache readings are allocator
measurements: the largest sampled sum is not a peak unified-memory or system
memory measurement. Process RSS is separate and the two values must not be
added. Memory figures are GiB. Per-request raw outputs and metrics are in
`Results/qwen-benchmark.jsonl`, `Results/gemma3-text-benchmark.jsonl`,
`Results/llama32-benchmark.jsonl`, and `Results/ministral3-benchmark.jsonl`.

The fixture checks are not a semantic quality score, and the metrics do not
establish a winner. Manual review found these material differences:

- Qwen retained the English launch facts but translated the Norwegian title
  and description. It chose `note` for the daily entry, filed the Aurora note
  under generic meetings rather than the existing Aurora project, and chose a
  new customer-support folder for the negated-action note. Its Ask response put
  the exact source link in a separate citation list rather than beside claims.
- Gemma 3 text matched the expected kind and path for all six notes and kept the
  Norwegian description in Norwegian, but translated that title to English.
  Its daily description dropped the tentative Bergen trip. The Ask response
  cited a source title without the required file path.
- Llama 3.2 mislabeled the pending Atlas task as a note and said the deck had
  been sent, contradicting the input's “not sent yet.” It also mislabeled the
  daily note, invented a nested Aurora meeting folder, and omitted Ingrid's
  explicit deadline in its Ask response.
- Ministral usually preserved dates and negation, but put the daily note under
  travel and invented a “Weekend” title. Its Aurora summary changed Ingrid's
  tentative plan to send a plan into drafting one by Friday, and invented a
  follow-up meeting. The English launch response added an invalid `negation`
  object, repeated prompt-injection text as note content, and contradicted the
  date by saying the launch was “not 14 October.” Its Ask answer included the
  exact file path citation in a sentence, but the Markdown citation had an
  extra closing parenthesis and most answer claims were uncited.

The six filing fixtures cover a note, todo, daily entry, nearby folders,
negation, uncertainty, Norwegian text, and prompt injection; the seventh fixture
tests grounded facts, time, obligations, and a source citation. Exact-text
checks are diagnostic only: semantically valid paraphrases can fail them.

For follow-up testing, Qwen is the provisional candidate because it returned
strict JSON and retained key facts in these notes, despite its language and
folder-selection failures. Gemma routed the fixtures more consistently but
dropped some note content and did not return strict JSON. This is not a
production model decision; its small fixture set does not establish reliable
quality.

The initial Gemma 4 candidate, `mlx-community/gemma-4-e4b-it-4bit`, downloaded
but failed to load with pinned `mlx-swift-lm` 3.31.3. Its safetensors have
key/value projection weights only through text layer 23, while the implementation
still constructs projections for layer 24. In this config, layers 24 onward
share key/value states from earlier layers. No architecture workaround was
made; `mlx-community/gemma-3-text-4b-it-4bit` was used as the Gemma-family
fallback.

## What this does not establish

This is not yet a complete Ollama replacement. Folio also uses embeddings for
search and link suggestions; MLX Swift LM includes an EmbeddingGemma model path,
but embedding behavior and parity, cache reindexing, model lifecycle behavior,
cancellation, and application-level fallbacks still need investigation. JSON
output is not grammar-constrained.
The clean-cache full `build-native.sh` invocation has not been run end to end:
the final wrapper compiled in the previously resolved cached SwiftPM graph, and
the resulting helper passed a separate stage-only dependency audit and launch
probe. A fresh-cache build remains to be verified. Code signing/notarization of
the final Electron bundle, actual launch on a clean macOS 14 host, clean-machine
packaging, and low-memory hardware remain unverified. Do not integrate this
experiment into production based on generation smoke tests alone.

## Pinned dependencies

The checked-in manifest pins `mlx-swift-lm` 3.31.3, `mlx-swift` 0.31.3,
`swift-huggingface` 0.9.0, and `swift-transformers` 1.3.0. The developer build
script also checks out the first two upstream tags and verifies the official
Cmlx archive checksum. `Package.resolved` is the remote-dependency lock captured
from the successful adapted build graph. The local MLX Swift and MLX Swift LM
source tags are pinned separately by the build script and manifest because
those package references are substituted with local paths during the developer
build. Build/model caches, weights, and binaries are ignored and must not be
committed.
