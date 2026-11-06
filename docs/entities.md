# Entities

Folio can identify people, organizations, projects, and products or tools in note text. Entity extraction is an optional, per-bundle background feature. It runs after a note has been saved or imported and never delays the save. Turn it on from the entity settings in the app; the GLiNER model must be installed and available on the device. Removing the model pauses work while preserving the bundle's setting and corrections.

## What entity results mean

An extracted mention is a candidate span in the note's normalized body. The server checks its exact UTF-16 range against the current body before committing it. Mentions are resolved conservatively: full names and confirmed aliases can identify an entity, while ambiguous or first-name-only person matches remain unresolved. Users can rename or retype identities, add aliases, merge or split identities, reassign or dismiss mentions, restore dismissed mentions, link notes, and undo corrections. Corrections and identity records are stored per bundle and survive re-extraction, restart, and backup restore.

Entity matches are useful for finding notes and suggesting connections. A co-mention alone does not prove a relationship or fact. Search excerpts and Ask context are hydrated from current Markdown and retain the original wording, including negation. Ask should use that source wording as evidence.

## Search and Ask

`GET /api/search?entityIds=id1,id2&includeScope=true` restricts results to notes containing every selected entity. `entityIds` is a comma-separated list of at most 20 IDs. A scoped response is `{ items, scope }`; without `includeScope=true`, the existing array response is retained. Search text and tags filter inside the entity intersection. A valid scope with no current matches returns no results; it never widens to unrelated notes.

`POST /api/ask` accepts an optional `entityIds` array and adds scope metadata to its response when scoped. An explicitly supplied malformed, unknown, cross-bundle, or unavailable scope returns an error instead of silently falling back to an unscoped request. Entity extraction does not run during search or Ask. Existing embedding and answer-generation behavior may still run. Entity-name query boosting is disabled because the current fixed evaluation is not enough to justify changing ranking.

The entity jobs API is bundle-scoped through `x-folio-bundle`. `POST /api/entities/jobs` admits manual extraction work; `GET /api/entities/jobs` returns job state and coverage; job details support pause, resume, and cancel actions. The entity API returns `503` with a recovery diagnostic if its durable state cannot be read.

## Background work and recovery

Save, capture, import, transcription, OCR, history restore, and path moves can request extraction when analysis is enabled. These hooks enqueue or invalidate work without waiting for inference. Jobs process one bounded text chunk at a time, yield between chunks, and commit only if the source generation still matches. Repeated requests for an unchanged note reuse successful results, including successful empty results. Disabled settings, unavailable models, stale source, cancellation, and extraction failures remain distinct states.

Entity metadata and correction history are stored with the bundle's application state and included in the versioned `.folio` metadata attachment during backup. Job queue state is local derived state and is rebuilt from notes if its file is damaged. Damaged correction metadata is preserved and reported; it is never silently replaced with an empty ledger. Keep the damaged file before taking recovery action, then use the diagnostic returned by the entity API to quarantine or restore the metadata attachment. Notes remain browseable if entity state recovery fails.

## Evaluation evidence

The checked-in retrieval fixture uses fictional English and Norwegian notes and runs the production entity scope preparation, search ranking, Ask temporal ranking, source projection, and current-file validation. For the two scoped query cases, unscoped lexical search returned 5 notes with 2 relevant (precision 0.40, recall 1.00) for the English Atlas case and 2 notes with 1 relevant (precision 0.50, recall 1.00) for Norwegian Nordlys. Entity intersection returned 2/2 relevant (precision 1.00, recall 1.00) and 1/1 relevant (precision 1.00, recall 1.00), respectively. In the temporal Ask fixture, unscoped retrieval returned 2 notes with 1 relevant (precision 0.50); entity-scoped retrieval returned 1/1 relevant (precision 1.00). These are deterministic lexical note-relevance fixtures, not a broad quality benchmark.

The same suite checks that an ambiguous `Priya` query does not choose between Priya Sharma and Priya Shah, that a full name resolves uniquely, that rejected/negated source language is preserved, that current source spans match their text, and that an externally changed note is excluded while scope is marked incomplete. It does not measure generated answer truth, model-assisted retrieval, broad language coverage, or production archive throughput. The baseline and entity-aware results differ in candidate eligibility, so the scoped precision gain is evidence for explicit intersection behavior, not evidence to turn on free-query entity boosting.
