# Entity extraction evaluation and capture

This is the stage-7 measurement harness for the fictional corpus at `test/fixtures/entities/corpus.json`. The 13 cases are the only source documents used by this suite. Do not capture personal workspace notes.

## Reference and runtime revisions

The measurement target is the Apple Silicon 16 GiB host running macOS 27.2, build 26B123. The stage-1 checkpoint revision is `7b005274e82da37dcf1f5fd9d6a2ef413c6a004c`; the pinned reference implementation is `Blaizzy/mlx-vlm@4857a6b018e5e214616bbfa8f0f6da92af258ba2`. The Folio native runtime revision must be the actual commit used to build the helper and must be passed on every capture. Captures from a dirty Folio worktree or a host outside this target are marked incomplete.

The existing Gemma baseline is `mlx-community/gemma-4-e4b-it-4bit@475b9088d29754a3379866cf5aeb6b41acd313c2`. Its capture runs Folio's `buildClassificationMessages` prompt builder against each corpus note with an empty fictional filing and tag guide. It records the existing filing-classification path as a runtime/product baseline; filing metadata is not entity-span output and does not count toward entity precision, recall, or parity.

`semantic.mentions` are manually annotated quality labels. `runtimeParityGoldens` must hold independent pinned-reference predictions; run the same input through the Folio Swift implementation and compare its output to those reference results. Capturing Swift output alone cannot establish parity. Keep these two data sources distinct in any report.

## Capture driver

The driver launches the helper with an explicit local snapshot directory and offline Hugging Face flags. It never downloads a model. It sends one warmup request per configured warmup count, then every corpus case serially for each repeat. Warmups are excluded from request latency summaries. Cold load is measured from helper spawn to its JSONL `ready` event. Request percentiles use nearest-rank p50 and p95 over measured warm requests.

For Gemma's current filing-classification baseline:

```sh
node scripts/entities/capture.mjs \
  --mode gemma-baseline \
  --helper /Users/magnusolstad/Documents/programming/folio/experiments/mlx-swift/.cache/staged/Folio.app/Contents/MacOS/folio-mlx \
  --model-directory "/Users/magnusolstad/Library/Application Support/Folio/models/hf-cache/models--mlx-community--gemma-4-e4b-it-4bit/snapshots/475b9088d29754a3379866cf5aeb6b41acd313c2" \
  --cache-root "/Users/magnusolstad/Library/Application Support/Folio/models/hf-cache" \
  --runtime-revision "$(git rev-parse HEAD)" \
  --precision float16 \
  --warmup-count 1 \
  --repeat-count 3 \
  --output /tmp/entities-gemma-baseline.json
```

For the entity helper, `helper-jsonl` accepts a request file with `corpusVersion: 1` and one `{id, request}` entry per corpus case. Each `request` is the exact JSONL request object for the pinned helper protocol. The native extraction operation and payload are intentionally not guessed here while the Swift protocol is being completed. Pass the actual configured per-type thresholds and chunk budget; the driver rejects missing or invalid values rather than choosing defaults.

```sh
node scripts/entities/capture.mjs \
  --mode helper-jsonl \
  --helper /path/to/staged/folio-mlx \
  --task TASK_AS_DEFINED_BY_THE_COMMITTED_SWIFT_HELPER \
  --model fastino/gliner2.5-multi-v1 \
  --revision 7b005274e82da37dcf1f5fd9d6a2ef413c6a004c \
  --model-directory /path/to/local/entity/snapshot \
  --cache-root /path/to/local/hf-cache \
  --runtime-revision "$(git rev-parse HEAD)" \
  --precision float16 \
  --thresholds-json '{"person":0.5,"organization":0.5,"project":0.5,"product":0.5,"location":0.5}' \
  --chunk-budget-json '{"maxTokens":512,"overlapTokens":64}' \
  --requests /path/to/entities-requests.json \
  --warmup-count 1 \
  --repeat-count 3 \
  --output /tmp/entities-gliner-capture.json
```

The task name and paths above are placeholders until the entity helper protocol and installed snapshot are committed. The threshold and overlap numbers illustrate CLI shape only; they are not approved calibration values or release budgets. Use values recorded from the actual runtime/configuration. The capture records the model and runtime hashes, schema, thresholds, precision, chunk budget, warmup/repeat counts, CPU, architecture, OS version/build, total host memory, helper and snapshot paths, and timestamp. The output includes cold-load wall time, per-request wall time and helper metrics, median/p95, serial corpus invocation rate, optional sampled helper RSS, helper high-water resident memory, and MLX active/cache peaks. Per-request MLX peak active memory is reported only when the helper returns it. Missing per-request peak memory or a dirty runtime worktree makes the capture explicitly incomplete. Helper high-water RSS and allocator readings are separately identified. This harness does not claim Electron-wide total memory.

`helper-jsonl` includes an evaluator-compatible `predictions` object when every response has a `mentions` array. The driver also retains every raw response and repeat. Save capture reports outside the repository; do not commit model output logs by default.

## Evaluation and release evidence

Run `node scripts/entities/evaluate.mjs /path/to/predictions.json` for mention precision/recall/F1 by language and type, exact source-span scores, identity abstentions, and false merge/split clusters. It requires complete revision, threshold, precision, device, OS, chunk-budget, warmup, and repeat metadata. Its results measure semantic quality against the manual annotations. Compare independent pinned-reference outputs and Folio Swift outputs separately for runtime parity.

No latency or memory budget has been measured or frozen yet. A first on-device baseline must be captured and reviewed before any release budgets are written. The following remain unmeasured and explicit release blockers: cold download separately from cold load; mixed-model Gemma/Whisper contention; backfill notes per minute through the real server scheduler; Electron/helper/MLX total peak memory; responsiveness during generation and transcription; packaged Electron behavior; model removal/reinstall and offline lifecycle; and independent reference-vs-Swift parity. The serial capture's invocation rate is not a server backfill throughput measurement.
