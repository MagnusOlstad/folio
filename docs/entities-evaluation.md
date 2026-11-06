# Entity extraction evaluation and capture

This is the stage-7 measurement harness for the fictional corpus at `test/fixtures/entities/corpus.json` (version 2). It includes a 1,400-word chunk-boundary case so the pinned production planner must split source text beyond the 512-token input budget. The 13 cases are the only source documents used by this suite. Do not capture personal workspace notes.

## Reference and runtime revisions

Record the actual capture host (architecture, memory, macOS version/build, and CPU) in every report; do not infer support from one OS revision. The stage-1 checkpoint revision is `7b005274e82da37dcf1f5fd9d6a2ef413c6a004c`; the pinned reference implementation is `Blaizzy/mlx-vlm@4857a6b018e5e214616bbfa8f0f6da92af258ba2`. The Folio native runtime revision must be the actual commit used to build the helper and must be passed on every capture. The driver records the executable SHA-256 and marks provenance unverified unless the helper itself reports the matching runtime revision; a clean source checkout by itself does not prove binary provenance. Precision is measured only if the helper reports it; `--declared-precision` is recorded as caller-provided information and cannot make a capture complete.

The Gemma baseline is `mlx-community/gemma-4-e4b-it-4bit@475b9088d29754a3379866cf5aeb6b41acd313c2`. `gemma-baseline` runs Folio's `buildClassificationMessages` prompt builder against each corpus note with an empty fictional filing and tag guide. It measures the existing filing-classification path; filing metadata does not count toward entity precision, recall, or parity. `gemma-entity-baseline` is a separate development-only prompt that asks Gemma to emit strict JSON mention spans. Its output is checked against canonical source slices and scored against the semantic annotations, but it is not an existing product feature or independent parity reference.

`semantic.mentions` are manually annotated quality labels. `runtimeParityGoldens` must hold independent pinned-reference predictions; run the same input through the Folio Swift implementation and compare its output to those reference results. Capturing Swift output alone cannot establish parity. Keep these two data sources distinct in any report.

## Capture driver

The driver launches the helper with an explicit local snapshot directory and offline Hugging Face flags. It never downloads a model. It reports ready, case-start, repeat-complete, case-complete and final events on stderr. After readiness it atomically updates `<output>.partial.json` after every completed repeat; a failure saves its bounded helper stderr and partial results there. Warmups are excluded from request latency summaries. Cold load is measured from helper spawn to its JSONL `ready` event. Request percentiles use nearest-rank p50 and p95 over measured warm requests.

For Gemma's current filing-classification baseline:

```sh
node scripts/entities/capture.mjs \
  --mode gemma-baseline \
  --helper /Users/magnusolstad/Documents/programming/folio/experiments/mlx-swift/.cache/staged/Folio.app/Contents/MacOS/folio-mlx \
  --model-directory "/Users/magnusolstad/Library/Application Support/Folio/models/hf-cache/models--mlx-community--gemma-4-e4b-it-4bit/snapshots/475b9088d29754a3379866cf5aeb6b41acd313c2" \
  --cache-root "/Users/magnusolstad/Library/Application Support/Folio/models/hf-cache" \
  --runtime-revision "$(git rev-parse HEAD)" \
  --runtime-source /Users/magnusolstad/Documents/programming/folio \
  --declared-precision "unknown; caller-supplied if known" \
  --warmup-count 1 \
  --repeat-count 3 \
  --output /tmp/entities-gemma-baseline.json
```

For the production entity pipeline, `helper-entities` uses the canonical corpus directly. It asks the helper to plan each complete note, validates contiguous UTF-16 coverage and the configured token budget, extracts one planned chunk at a time, verifies exact per-chunk coverage/spans, applies the supplied per-type thresholds, and deduplicates exact overlapping mentions. Reports include plan time, per-chunk latency/metrics, note-level latency, aggregate request count, and the configuration hash for the labels, thresholds, schema, and chunk budget. `helper-jsonl` remains available for low-level request/transport captures and accepts a request file with the current `corpusVersion` and one `{id, request}` entry per case.

```sh
node scripts/entities/capture.mjs \
  --mode helper-entities \
  --helper /path/to/staged/folio-mlx \
  --task entities \
  --model fastino/gliner2.5-multi-v1 \
  --revision 7b005274e82da37dcf1f5fd9d6a2ef413c6a004c \
  --model-directory /path/to/local/entity/snapshot \
  --cache-root /path/to/local/hf-cache \
  --runtime-revision "$(git rev-parse HEAD)" \
  --runtime-source /Users/magnusolstad/Documents/programming/folio \
  --declared-precision "unknown; caller-supplied if known" \
  --thresholds-json '{"person":0.5,"organization":0.5,"project":0.5,"product":0.5,"location":0.5}' \
  --chunk-budget-json '{"maxTokens":512,"overlapTokens":32}' \
  --warmup-count 1 \
  --repeat-count 3 \
  --output /tmp/entities-gliner-capture.json
```

The task name and paths above must match the committed helper protocol and installed snapshot. The threshold and overlap numbers are provisional configuration values; use only values recorded from actual runtime/configuration captures. The capture records model/runtime hashes, helper SHA-256, schema, label descriptions, thresholds, reported and caller-declared precision separately, chunk budget and configuration hash, warmup/repeat counts, CPU, architecture, OS version/build, total host memory, helper and snapshot paths, and timestamp. The output includes cold-load wall time, per-note and per-chunk timing, median/p95, serial corpus notes/minute, warmup latency, first usable result latency, optional sampled helper RSS, helper high-water resident memory, and MLX active/cache peaks. `mlxPeakObservedActivePlusCache` is the largest active+cache pair reported together in a helper response; it does not add separate peak maxima. Per-request MLX peak active memory is reported only when the helper returns it. Missing per-request peak memory, unverified binary provenance or precision, or a dirty runtime worktree makes the capture explicitly incomplete. Helper high-water RSS and allocator readings are separately identified. This harness does not claim Electron-wide total memory.

Both `helper-jsonl` and `helper-entities` include an evaluator-compatible `predictions` object when every response has a `mentions` array. Before writing it, the driver sends mentions through Folio's production `server/entities/resolution.js:resolveMentions` with a clean bundle state, retaining each resolved `entityId`, ambiguity, and provenance. The production mode also retains the raw plan and per-chunk responses for diagnosis. Identity scores therefore evaluate the actual automatic resolver, while correction behavior remains covered by server lifecycle tests. Save capture reports outside the repository; do not commit model output logs by default.

## Evaluation and release evidence

Run `node scripts/entities/evaluate.mjs /path/to/predictions.json` for mention precision/recall/F1 by language and type, exact source-span scores, identity abstentions, and false merge/split clusters. Identity clusters come from the serialized production resolver output, not model-provided IDs. It requires complete revision, threshold, precision, device, OS, chunk-budget, warmup, and repeat metadata. Its results measure semantic quality against manual annotations. Compare independent pinned-reference outputs and Folio Swift outputs separately for runtime parity.

After a raw `helper-entities` capture, `node scripts/entities/calibrate-thresholds.mjs /path/to/capture.json /tmp/entity-thresholds.json` sweeps observed confidence scores against the manual span/type labels and reports the maximum exact-mention F1 threshold per type (ties choose the higher threshold). The helper inference floor is recorded in capture metadata; calibration never proposes a threshold below the score floor used during inference. Chunk-overlap duplicates are deduplicated per case before scoring, and source spans are validated against their case. This is a tuning aid, not an evaluation result; inspect false positives and language/type slices before adopting values, then capture again with the selected thresholds and record their configuration hash.

The first untuned on-device entity baseline is the fictional-corpus capture at `/private/tmp/folio-entities-release-evidence/native-f32-baseline.json` (13 notes, 18 planned chunks, float32, GLiNER checkpoint `7b005274e82da37dcf1f5fd9d6a2ef413c6a004c`, runtime `0ea390db901660e0ca62dbeef551c44780df08c7`, all thresholds 0.5, 512-token budget with 32-token overlap, one warmup and one measured repeat). It reached helper readiness in 2.914 seconds, with a 45 ms median and 954 ms p95 note latency, 336 ms p95 chunk latency, 1.314 GB helper peak resident memory, and 2.145 GB peak request-active MLX allocation. The first warmup inference took about 4.07 seconds after readiness, so first usable output was about 6.98 seconds from helper launch. Its 418 notes/minute figure is serial corpus invocation rate and does not represent server backfill throughput. This baseline is quality-untuned; the existing 13/13 and 46/46 parity result checks agreement with the pinned reference, not semantic correctness against the manually annotated corpus.

Freeze these initial performance budgets before schema or threshold tuning: helper readiness at or below 10 seconds; first usable result at or below 15 seconds; warm-note p95 at or below 2 seconds; a 512-token chunk p95 at or below 1 second; helper RSS at or below 3 GiB; observed MLX active+cache at or below 6 GiB; idle server backfill at or above 30 notes/minute; interactive wait behind one background chunk at or below 1.5 seconds; and no model reload thrash during the 30-second interactive cooldown. Electron total footprint target is at or below 12 GiB, pending an actual packaged Electron measurement. The current capture does not measure server backfill, mixed Gemma/Whisper responsiveness, or packaged Electron total footprint, so those budgets remain unverified.

Other release blockers include independent reference-vs-Swift parity for the expanded corpus, calibrated per-type semantic thresholds, cold download separately from cold load, model removal/reinstall and offline lifecycle, and the full packaged install-to-correction journey. Do not infer total process memory by adding helper RSS to MLX allocator measurements; record concurrent Electron/helper/Metal footprint directly for that gate.
