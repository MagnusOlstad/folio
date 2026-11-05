# Entity evaluation

`test/fixtures/entities/corpus.json` is a versioned, fictional semantic corpus. Its `semantic.mentions` are human annotations; `runtimeParityGoldens` must contain outputs from the independently pinned reference implementation, then be compared against Folio Swift output. Capturing native output alone cannot establish parity. Never present semantic annotations as runtime-parity results.

Run the deterministic evaluator with a prediction file:

```sh
node scripts/entities/evaluate.mjs /path/to/predictions.json
```

The JSON input requires `corpusVersion`, a `metadata` record, and one prediction record per corpus case. Each case has `id` and `mentions`; optional `text` must exactly equal the canonical fixture text; every predicted slice is checked against the canonical text even when `text` is omitted. A prediction mention has `text`, `type`, `startUtf16`, `endUtf16`, and optional `identityId`. Empty predictions are written as `mentions: []`.

Required metadata: 40- or 64-character hexadecimal `modelRevision` and Folio `runtimeRevision`, matching `schemaVersion`, finite 0–1 thresholds for every type, non-empty `device` and `osVersion`, `precision` (`float16`, `bfloat16`, or `float32`), a bounded `chunkBudget` with max 512 tokens and overlap below its maximum, non-negative `warmupCount`, and positive `repeatCount`. The evaluator exits with status 2 and an explicit error when the input or measurement record is incomplete. Keep capture timing, memory, and packaged workflow measurements in a separate report; this script does not claim to measure them.

Output includes exact mention precision/recall/F1 grouped by language and type, exact text-and-boundary span scores, identity abstentions, and false-merge/false-split cluster counts. Identity metrics only use semantically labeled mentions whose predicted mention matches exact span and type. Related-note expectations are in `relatedNotesEvaluation`: shared entities are co-mention evidence only, and a dismissed suggestion must stay absent until explicitly reset.
