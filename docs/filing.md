# Filing pipeline and model evaluation

FolioNotes treats filing as a metadata decision. The capture route separates any filing steering from the note body, then calls `runtime.classify(body, records, { steering, now, timeZone })`. Classification combines EmbeddingGemma retrieval with the current bundle’s filing and tag vocabulary, asks Gemma 4 for one validated metadata object, and retries once if that JSON is malformed. It returns kind, path, title, type, description, and tags; it does not generate a replacement note body.

After classification, application code validates the proposed destination, decides whether the result can append to an exact existing concept, and writes the note body. Source receipts retain the exact submitted body. Visible Markdown keeps FolioNotes’s legacy `<br>` to hard-break normalization; todo and daily captures use their aggregate entry format. Mention and related links are selected and rendered by deterministic filing code.

Relative-date annotation is deterministic in [relative-dates.js](../server/knowledge/relative-dates.js). It uses the supplied clock and time zone to resolve English and Norwegian phrases: today/i dag, tomorrow/i morgen, yesterday/i går, this/next week or denne/neste uke, and this/next/last weekday or neste/kommende/forrige weekday. It annotates matching phrases in the description with an ISO date, or `week of YYYY-MM-DD` using the local week’s Monday. The source phrase must occur outside quoted text, blockquotes, inline code, and fenced code, and an existing parenthesized date is left alone. The note body is never changed by this annotation.

The classifier prompt and JSON contract live in [classification-output.js](../server/knowledge/classification-output.js). Retrieval, tag candidates, date context, and the single repair attempt live in [classification.js](../server/knowledge/classification.js). Destination, append, and related-link behavior live in [filing service](../server/filing/service.js) and [capture route](../server/routes/capture.js).

## Run the native evaluation

The evaluator uses the repository’s normal `createRuntime` and MLX service with the pinned Gemma 4 and EmbeddingGemma models. Both snapshots and the native helper must already be installed. It never downloads a model or reads or writes the user’s bundle; its application data root is a temporary directory, removed on exit.

```sh
FOLIO_MODEL_ROOT=/path/to/pinned-model-cache node scripts/evaluate-filing.mjs
```

Run one case or emit a machine-readable report with `--case <case-id>` or `--json`:

```sh
FOLIO_MODEL_ROOT=/path/to/pinned-model-cache node scripts/evaluate-filing.mjs --case matched-steering-surfaces-low-ranked-folder
FOLIO_MODEL_ROOT=/path/to/pinned-model-cache node scripts/evaluate-filing.mjs --json
```

The cases and their check definitions are in [filing-evaluation-cases.js](../test/fixtures/filing-evaluation-cases.js). They cover exact continuation reuse, a new topic and concise heading, tag reuse, steering to a folder below the normal option limit, unrelated steering, fixed-date and local-midnight resolution, a multi-kilobyte note whose decisive detail is last, metadata-only output, and mention-based and semantic related links. Link cases report query/document and note/document cosine scores for the expected record and nearest unrelated embedded records. A failing acceptance check exits with status 1.

The pinned Gemma 4 E4B and EmbeddingGemma run passed all 11 fictional cases and 40 checks using the fixtures’ fixed clocks, including the Europe/Oslo midnight-boundary case. In the semantic Atlas link case, the expected document scored 0.694 against the nearest unrelated embedded note at 0.540. That one fixture is a calibration example, not evidence that the semantic thresholds will separate every real note from unrelated records. Results can vary with model revisions and runtime changes.

The evaluation does not submit a capture or confirmation request or write to a bundle. It renders capture Markdown in memory to check that the body contribution and exact source receipt survive, and calls the same deterministic relationship builder to check generated links. It does not measure filesystem destination writes or confirmation behavior end to end.

## Tune carefully

Keep the evaluation cases as authored fictional notes and fixture records. Add a case when a new behavior or regression needs an explicit acceptance signal. Keep expected checks declarative so a future model change can run the same suite, and prefer outcome checks (reuse an exact concept, preserve a deadline, ignore unrelated steering) over exact prose except where the note supplies an explicit heading or an existing exact title.

For prompt changes, adjust the instructions and metadata schema in `server/knowledge/classification-output.js`, then run the full evaluator. For retrieval changes, inspect `existingClassificationGuide`, `existingTagGuide`, and the steering candidates in `server/knowledge/classification.js`. The related-link gate in `server/filing/service.js` scores a note against candidate document and chunk embeddings: scores of at least 0.75 qualify directly; the best candidate may also qualify at 0.60 or higher when it leads the runner-up by at least 0.08. Explicit mentions and the lexical gate are separate. The classifier guide limits displayed folder options, ranks by lexical and semantic relevance, and injects an exact matching folder when the user explicitly steers to it. Keep the “unrelated steering yields to note content” case when changing that behavior. Examine failed outputs and relevant guide construction before changing acceptance checks.

## Model references

- [Gemma 4 prompt formatting](https://ai.google.dev/gemma/docs/core/prompt-formatting-gemma4) documents system and user turns and the explicit thinking control. FolioNotes’s classifier uses a system instruction and the MLX helper disables thinking for this metadata-only call.
- [EmbeddingGemma model card](https://ai.google.dev/gemma/docs/embeddinggemma/model_card) documents the retrieval query prefix `task: search result | query:` and titled document prefix `title: {title} | text:` used by FolioNotes.
- [EmbeddingGemma inference guide](https://ai.google.dev/gemma/docs/embeddinggemma/inference-embeddinggemma-with-sentence-transformers) explains task prompts at inference and query/document prompts for retrieval. The evaluator embeds fixture documents through `runtime.embedDocument`, so the application’s document prefix stays in force.
