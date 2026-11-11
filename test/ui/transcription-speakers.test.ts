import { describe, expect, it } from "vitest";
import {
  reconcileSpeakersSection,
  resultSpeakerNumbers,
} from "../../src/features/transcription/model/speakers.ts";
import { mergeTranscriptionDraft, type TranscriptionResult, type TranscriptionSession } from "../../src/features/transcription/model/types.ts";

const session: TranscriptionSession = { id: "s1", state: "ready", draftId: null, durationMs: 65_000, error: null, fileName: "meeting.wav" };
function result(overrides: Partial<TranscriptionResult> = {}): TranscriptionResult {
  return { summary: "", transcript: "[00:00] Hello.", ...overrides };
}
const spoken = result({
  transcript: "**{{speaker1}}** [00:00]\nHi.\n\n**{{speaker2}}** [00:04]\nHey.",
  speakers: true,
  speakerNumbers: [1, 2],
});

describe("speaker variables in transcription drafts", () => {
  it("adds a Speakers section of definition lines between Summary and Transcript", () => {
    const draft = mergeTranscriptionDraft(session, spoken);
    expect(draft).toContain("## Summary\n\nGenerate a summary from this transcript.\n\n## Speakers\n\nspeaker1:: Speaker 1\nspeaker2:: Speaker 2\n\n## Transcript\n\n**{{speaker1}}** [00:00]");
  });

  it("leaves timestamp-only transcripts without a Speakers section", () => {
    expect(mergeTranscriptionDraft(session, result())).not.toContain("## Speakers");
  });

  it("derives speaker numbers from older results", () => {
    expect(resultSpeakerNumbers(result({ speakers: true, speakerCount: 2 }))).toEqual([1, 2]);
    expect(resultSpeakerNumbers(result({ segments: [{ start: 0, end: 1, text: "a", speaker: 2 }, { start: 1, end: 2, text: "b", speaker: 1 }] }))).toEqual([1, 2]);
    expect(resultSpeakerNumbers(result({ speakers: false }))).toEqual([]);
  });

  it("uses saved speaker names when creating a fresh draft and falls back for unnamed IDs", () => {
    const named = mergeTranscriptionDraft(session, result({ ...spoken, speakerNames: { "1": "Saved Alex" } }));
    expect(named).toContain("speaker1:: Saved Alex\nspeaker2:: Speaker 2");
  });

  it("reconciles by appending only missing definitions and keeping edited lines", () => {
    const draft = "# T\n\n## Speakers\n\nspeaker1:: Alex\nNote to self\n\n## Transcript\n\nold\n";
    expect(reconcileSpeakersSection(draft, [1, 2, 3])).toBe("# T\n\n## Speakers\n\nspeaker1:: Alex\nNote to self\nspeaker2:: Speaker 2\nspeaker3:: Speaker 3\n\n## Transcript\n\nold\n");
    expect(reconcileSpeakersSection(draft, [1])).toBe(draft);
  });
});
