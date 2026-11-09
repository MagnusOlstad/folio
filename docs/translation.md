# Note translation

Filed bundle notes are translated between Norwegian and English in the background so the UI can show a read-only translated view instantly.

## Behavior

- The text translated is the cleaned body the app shows and indexes (`indexedConceptContent`): capture markers, the generated `# Captured note` / `# Summary` heading and the generated related section are removed, so they never appear in views or exports. A standalone `<!-- ... -->` comment line is a passthrough item and never swallows the paragraph after it.
- Each note is split into paragraph-level blocks (headings, paragraphs, list items, blockquote groups) plus its title and description. Markers, indentation, checkbox prefixes and `>` prefixes stay outside the translated text.
- Fenced code, HTML blocks, tables, horizontal rules, reference definitions and blank lines are never translated.
- Inline code, URLs, link targets, `[[wikilinks]]` and image references are replaced by `<xN/>` placeholders before translation and restored afterwards. If the model drops or invents a placeholder, the block's translation is rejected.
- The selected generation model returns one JSON object `{"source":"no"|"en"|"other","translation":"..."|null}` per block. Norwegian becomes English, English becomes Norwegian Bokmål, anything else is `other` and shown unchanged. Malformed output is retried once; after a second failure the block falls back to the original text (retried later only with a different model).
- For target `en` the view shows English blocks unchanged and the translation of Norwegian blocks; target `no` is the reverse.

## Note language

`GET /api/note/translation` additionally returns `noteLanguage: 'no' | 'en' | null` and `noteLanguageSource: 'frontmatter' | 'detected' | null`. A `language:` frontmatter key (written when the note is filed) wins. Otherwise the language is 'detected' from the cached main-entry `source` values of the body blocks, weighted by text length (ignoring `other` and failed entries; a tie gives `null`). `null` means nothing is cached yet. `GET /api/note/language?id=` returns `{ id, noteLanguage, noteLanguageSource }` with the same rules (400/404 like the other routes) and never triggers model work.

## Scheduling

A single serial queue per bundle processes one block per `generate` call and waits between blocks while any other model work (Ask, filing, transcription, embeddings) is active. Background work is per note: only notes with auto translate switched on are queued. Saves, moves, refiles and filing enqueue such a note (2 s debounce); switching a note on prioritizes it immediately and switching it off removes it from the queue. After bundle initialization or reindex an idle backfill translates the auto-on notes (raw captures are skipped) and prunes cache entries no note references. Nothing runs for notes with auto translate off or when no generation model is installed; models are never downloaded or force-loaded for this.

## Cache

`<bundle>/.folio/translations.json` is a derived, content-addressed cache and is safe to delete:

```json
{ "version": 1, "entries": { "<sha256 of normalized text>": { "source": "no", "translation": "...", "modelId": "gemma4", "translatedAt": "ISO date" } } }
```

Writes are atomic (temp file + rename). Because entries are keyed by text hash, they survive note moves and renames. Auto translate is a **per-note flag, off by default for every note**. It is stored per bundle in `<bundle>/.folio/translation-notes.json` (`{ "version": 1, "notes": { "<note id>": { "autoTranslate": true, "since": "ISO date" } } }`, atomic writes) and never in the note's frontmatter, so toggling never rewrites the note. The entry follows moves, refiles and renames and is dropped when the note or its folder is deleted. Explicit exports and language detection on filing do not depend on it.

## API

- `GET /api/note/translation?id=<note id>&target=en|no` returns `{ id, target, status, translatedBlocks, totalBlocks, title, description, content }`. `status` is `ready`, `pending`, `disabled` (auto translate is off for this note and it is not fully cached; nothing is started) or `unavailable` (no installed model and incomplete). Untranslated blocks show the original text; a pending auto-on note is prioritized. The response also carries `autoTranslate: boolean`. 400 for an invalid target or non-bundle id, 404 for a missing note.
- `POST /api/note/translation/prioritize` with `{ id }` returns 202 `{ queued: true }`.
- `GET /api/translation/settings` returns `{ available }` (a generation model is installed); there is no global switch.
- `PUT /api/note/translation/auto` with `{ id, enabled }` returns `{ id, autoTranslate, available }`; 400 for a non-boolean or non-bundle id, 404 for a missing note.
- `GET /api/note/language` also returns `autoTranslate`.

## Translated export

An explicit, on-demand export translates one filed note into `en` (English), `no` (Norwegian Bokmål), `de` (German), `es` (Spanish), `fr` (French), `it` (Italian), `sv` (Swedish) or `da` (Danish). It works even when background translation is switched off, but still needs an installed, selected generation model and never downloads anything.

- `POST /api/note/translation/export` with `{ id, target }` returns 202 `{ jobId, id, target, status: 'running', translatedBlocks, totalBlocks }`. An identical running job is returned instead of starting another. 400 for an invalid target or non-bundle id, 404 for a missing note, 503 when no generation model is installed.
- `GET /api/note/translation/export/:jobId` returns the job with `status` `running|done|failed|cancelled` and additive `phase` (`queued` behind another export, `waiting` for user-facing model work or model load, `translating`, `finishing`, then the final status), `lastTranslated` (plain text of the most recent translated block, at most 160 characters, or `null`; also on the POST response) and `failedBlocks` (blocks that fell back to the original after retries); `title`, `description` and `content` (Markdown body) appear only when `done`, `error` only when `failed`. 404 for unknown or expired jobs (kept 10 minutes after finishing).
- `DELETE /api/note/translation/export/:jobId` cancels between blocks and returns `{ jobId, status: 'cancelled' }` (idempotent, 404 if unknown). A job that already finished keeps its `done`/`failed` status, which the response reports.

Jobs are in memory, run one at a time per bundle (FIFO) and take priority over the background queue, which pauses meanwhile; they still wait for user-facing model work. `en` and `no` reuse the main cache with the same detect-and-translate path. Other languages pivot through English: the main-cache entry is ensured first, then the English text (the original for English blocks, the cached English translation for Norwegian ones, or the original without a source label for `other`/failed blocks) is translated with a prompt that names the source language. Placeholders are re-protected on the English text and restored exactly. Entries record `pivot: 'en' | null`, and language entries without a `pivot` field are treated as stale and redone, and are cached in the same file as `<hash>:<lang>` entries (`{ translation, modelId, translatedAt, failed? }`). After one retry an invalid block falls back to the original text. Pruning keeps language entries whose base hash is still referenced.

## Privacy

Everything runs on the local MLX model. Local drafts live client-side and are never sent. Only notes already filed in the bundle are read.
