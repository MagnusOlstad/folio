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

"Identify speakers" is a per-transcription choice in the Transcription tab, shown for both imports and recordings and off by default. The choice is saved on the session (`identifySpeakers` in `session.json`), so a retry uses the same setting; it can be changed per item until transcription starts.

- Speaker recognition uses NVIDIA's Sortformer through `MLXAudioVAD` (`mlx-community/diar_streaming_sortformer_4spk-v2.1-fp16`), a separate download that happens only on request. It supports up to 4 speakers.
- It runs after Whisper has finished, in its own MLX model slot, so Whisper is unloaded first and both models are not resident together.
- Each Whisper segment goes to the speaker with the greatest time overlap (a nearby turn, then the neighbouring segment, when nothing overlaps). Speakers are numbered by first appearance, and consecutive segments from one speaker merge into a turn:

```markdown
**Speaker 1** [01:23]
Welcome to the review.

**Speaker 2** [01:31]
Thanks for having me.
```

- If the speaker pass fails or finds no turns, the timestamped transcript is kept and `result.speakerWarning` explains why. Cancelling still cancels the whole job.
- Summaries are generated from the `## Transcript` section of the draft, so they see the labels.
- The semantic index drops timestamps and speaker headers (`server/knowledge/transcript-markup.js`) so they do not affect embeddings.

### Pinning the Sortformer revision

`DIARIZATION_MODELS.sortformer.revision` in `server/transcription/models.js` (and `SortformerVariant.unresolvedRevision` in `experiments/mlx-swift/Sources/folio-mlx/main.swift`) hold the placeholder `UNRESOLVED-SORTFORMER-REVISION`. While it is a placeholder, installation and diarization are refused and the UI says speaker labels are unavailable. Replace both with the 40-character Hugging Face commit hash, and verify `requiredFiles` and `downloadSizeBytes`, before release.

## Native patches

The pinned `mlx-audio-swift` revision `8d86630` is patched when the helper is built (`experiments/mlx-swift/Patches/`): `whisper-language-detection-pinned-8d86630.patch`, then `whisper-timestamps-pinned-8d86630.patch`, which adds opt-in `WhisperModel.timestampsEnabled` (OpenAI's timestamp rules and per-segment output). Upstream behaviour is unchanged unless it is switched on.
