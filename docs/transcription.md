# Transcription

Audio is transcribed on-device with Whisper through the bundled MLX helper (`folio-mlx`). Nothing leaves the machine.

## Transcript format

Whisper runs with timestamp tokens enabled and reports one segment per timestamped span (`start`, `end`, `text`, in seconds from the start of the file). The helper transcribes the audio in 30 second windows and offsets every segment by its window start. The server turns the segments into Markdown under `## Transcript`:

```markdown
[01:23] First paragraph of speech, grouped from several segments.

[01:51] Next paragraph, started after a long run or a pause of about 4 seconds.
```

Past one hour the prefix is `[h:mm:ss]`. If a helper build returns no segments, the plain text is kept as before.

## Speaker labels (optional)

"Identify speakers" is a per-transcription choice in the Transcription tab, shown for both imports and recordings and off by default. The choice is saved on the session (`identifySpeakers` in `session.json`), so a retry uses the same setting; it can be changed per item whenever the session is not transcribing, including before a re-transcription (below).

- Speaker recognition uses NVIDIA's Sortformer through `MLXAudioVAD` (`mlx-community/diar_streaming_sortformer_4spk-v2.1-fp16`), a separate download that happens only on request. It is pinned to Hugging Face commit `e23e6404bd9859e93edbf94a740eb1c7fc58f12e` (`config.json` and `model.safetensors`, about 236 MB) and supports up to 4 speakers.
- It runs after Whisper has finished, in its own MLX model slot, so Whisper is unloaded first and both models are not resident together.
- Each Whisper segment goes to the speaker with the greatest time overlap (a nearby turn, then the neighbouring segment, when nothing overlaps). Speakers are numbered by first appearance, and consecutive segments from one speaker merge into a turn:

```markdown
**{{speaker1}}** [01:23]
Welcome to the review.

**{{speaker2}}** [01:31]
Thanks for having me.
```

- Speaker names are note variables. The stored transcript references `{{speakerN}}`, and the draft gets a `## Speakers` section (between `## Summary` and `## Transcript`) with one definition line per speaker. Rename a speaker by editing its line; every reference in the note follows:

```markdown
## Speakers

speaker1:: Alex
speaker2:: Speaker 2
```

- `result.json` lists the speakers that appear in `speakerNumbers` (for example `[1, 2]`); `speakers` stays a boolean. Timestamp-only transcripts have no Speakers section.

- If the speaker pass fails or finds no turns, the timestamped transcript is kept and `result.speakerWarning` explains why. Cancelling still cancels the whole job.
- Summaries are generated from the `## Transcript` section of the draft. The client resolves `{{speakerN}}` through the draft's `## Speakers` lines before sending it, so the summary uses the real names (`Speaker N` for a speaker without a usable line).
- The semantic index drops timestamps and speaker headers (`server/knowledge/transcript-markup.js`) so they do not affect embeddings.

## Re-transcribe

A ready session keeps its audio, so it can be transcribed again (for example with a different Whisper model selected, or with speaker labels switched on). The Transcription tab offers **Re-transcribe** on ready items; it asks for inline confirmation and shows the per-session "Identify speakers" toggle first.

- API: `POST /api/transcriptions/:id/process` with `{ "retranscribe": true }`. Without the flag a ready session still returns its stored result unchanged. `POST /api/transcriptions/:id/options` now also accepts a ready session (it is rejected only while the session is transcribing).
- The run uses the currently selected Whisper model and the session's `identifySpeakers`. `result.json` is replaced only on success; on failure or cancellation the previous result and the `ready` state are kept.
- A successful run replaces only the `## Transcript` section of the linked open draft. In `## Speakers` every existing `speakerN::` line is kept (including names you edited), definitions for newly appearing speakers are appended, and the section is created before `## Transcript` if the draft had none. The title, summary, and other text are untouched. With no open linked draft, a new draft is created as "Open draft" does. The merge is `applyRetranscription` in `src/features/transcription/model/retranscribe.ts`.

## Playback and speaker correction

- `GET /api/transcriptions/:id/audio` streams the stored recording with HTTP Range support (`206`, `Accept-Ranges: bytes`, `416` when unsatisfiable) and an audio `Content-Type` from the file extension. It is `Cache-Control: no-store` because the audio can be replaced. The bundle can be passed as `?bundle=` so an `<audio src>` works. `400` for an invalid ID, `404` when the session or recording is missing.
- `POST /api/transcriptions/:id/segments/speaker` with `{ "index": 3, "speaker": 2 }` reassigns one segment (0-based `index`) to speaker 1-4 and returns `{ "result" }`, the full updated `result.json`. `transcript`, `speakerNumbers`, `speakerCount` and `speakers` are rebuilt from the segments; `plainText`, `summary` and other fields are kept. Speakers are not renumbered, so `speakerN::` names in the note stay valid and a new number (for example 3) can appear. `400` for a bad body, an out-of-range index or speaker, or a result without speaker labels; `404` for a missing session or result; `409` while the session is transcribing.

## Native patches

The pinned `mlx-audio-swift` revision `8d86630` is patched when the helper is built (`experiments/mlx-swift/Patches/`): `whisper-language-detection-pinned-8d86630.patch`, then `whisper-timestamps-pinned-8d86630.patch`, which adds opt-in `WhisperModel.timestampsEnabled` (OpenAI's timestamp rules and per-segment output). Upstream behaviour is unchanged unless it is switched on.
