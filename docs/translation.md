# Note translation

Filed bundle notes are translated between Norwegian and English in the background so the UI can show a read-only translated view instantly.

## Behavior

- Each note is split into paragraph-level blocks (headings, paragraphs, list items, blockquote groups) plus its title and description. Markers, indentation, checkbox prefixes and `>` prefixes stay outside the translated text.
- Fenced code, HTML blocks, tables, horizontal rules, reference definitions and blank lines are never translated.
- Inline code, URLs, link targets, `[[wikilinks]]` and image references are replaced by `<xN/>` placeholders before translation and restored afterwards. If the model drops or invents a placeholder, the block's translation is rejected.
- The selected generation model returns one JSON object `{"source":"no"|"en"|"other","translation":"..."|null}` per block. Norwegian becomes English, English becomes Norwegian Bokmål, anything else is `other` and shown unchanged. Malformed output is retried once; after a second failure the block falls back to the original text (retried later only with a different model).
- For target `en` the view shows English blocks unchanged and the translation of Norwegian blocks; target `no` is the reverse.

## Scheduling

A single serial queue per bundle processes one block per `generate` call and waits between blocks while any other model work (Ask, filing, transcription, embeddings) is active. Saves, moves and refiles enqueue the note (2 s debounce); opening a note via the API prioritizes it. After bundle initialization or reindex an idle backfill translates all notes (raw captures are skipped) and prunes cache entries no note references. Nothing runs if translation is disabled or no generation model is installed; models are never downloaded or force-loaded for this.

## Cache

`<bundle>/.folio/translations.json` is a derived, content-addressed cache and is safe to delete:

```json
{ "version": 1, "entries": { "<sha256 of normalized text>": { "source": "no", "translation": "...", "modelId": "gemma4", "translatedAt": "ISO date" } } }
```

Writes are atomic (temp file + rename). Because entries are keyed by text hash, they survive note moves and renames. The app-wide `enabled` setting lives in `<modelRoot>/translation-settings.json` beside the generation-model selection.

## API

- `GET /api/note/translation?id=<note id>&target=en|no` returns `{ id, target, status, translatedBlocks, totalBlocks, title, description, content }`. `status` is `ready`, `pending`, `disabled` (always when switched off) or `unavailable` (no installed model and incomplete). Untranslated blocks show the original text; a pending note is prioritized. 400 for an invalid target or non-bundle id, 404 for a missing note.
- `POST /api/note/translation/prioritize` with `{ id }` returns 202 `{ queued: true }`.
- `GET|PUT /api/translation/settings` returns/accepts `{ enabled }` and returns `{ enabled, available }`; `PUT` requires a boolean.

## Privacy

Everything runs on the local MLX model. Local drafts live client-side and are never sent. Only notes already filed in the bundle are read.
