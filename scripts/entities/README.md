# Entity evaluation

`test/fixtures/entities/corpus.json` is a versioned, fictional semantic corpus. Its `semantic.mentions` are human annotations; `runtimeParityGoldens` remain pending until pinned native runtime output has been captured. Never present these annotations as measured model parity.

Run the deterministic evaluator with a prediction file:

```sh
node scripts/entities/evaluate.mjs /path/to/predictions.json
```

The JSON input requires `corpusVersion`, a `metadata` record, and one prediction record per corpus case. Each case has `id` and `mentions`; optional `text` lets the evaluator check each predicted slice against source. A prediction mention has `text`, `type`, `startUtf16`, `endUtf16`, and optional `identityId`. Empty predictions are written as `mentions: []`.

Required metadata: `modelRevision`, `runtimeRevision`, `schemaVersion`, per-type `thresholds`, `device`, `osVersion`, `precision`, `chunkBudget`, `warmupCount`, and `repeatCount`. The evaluator exits with status 2 and an explicit error when the input or measurement record is incomplete. Keep capture timing, memory, and packaged workflow measurements in a separate report; this script does not claim to measure them.

Output includes exact mention precision/recall/F1 grouped by language and type, exact text-and-boundary span scores, identity abstentions, and false-merge/false-split cluster counts. Identity metrics only use semantically labeled mentions whose predicted mention matches exact span and type. Related-note expectations are in `relatedNotesEvaluation`: shared entities are co-mention evidence only, and a dismissed suggestion must stay absent until explicitly reset.
