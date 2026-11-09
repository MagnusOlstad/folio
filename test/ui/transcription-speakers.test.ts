import { describe, expect, it } from "vitest";
import { applyRetranscription } from "../../src/features/transcription/model/retranscribe.ts";
import {
  parseSpeakerNames,
  reconcileSpeakersSection,
  resolveSpeakerNames,
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

  it("reads names from the Speakers section only and resolves references", () => {
    const draft = [
      "# T", "", "speaker1:: Outside", "", "## Speakers", "", "speaker1:: Alex", "Speaker2::  Sam Jones ", "speaker1:: Ignored", "speaker3::", "", "## Transcript", "", "speaker2:: Not here",
    ].join("\n");
    const names = parseSpeakerNames(draft);
    expect([...names]).toEqual([[1, "Alex"], [2, "Sam Jones"]]);
    expect(resolveSpeakerNames("**{{speaker1}}** and {{ speaker2 }} and {{speaker3}}", names)).toBe("**Alex** and Sam Jones and Speaker 3");
  });

  it("reconciles by appending only missing definitions and keeping edited lines", () => {
    const draft = "# T\n\n## Speakers\n\nspeaker1:: Alex\nNote to self\n\n## Transcript\n\nold\n";
    expect(reconcileSpeakersSection(draft, [1, 2, 3])).toBe("# T\n\n## Speakers\n\nspeaker1:: Alex\nNote to self\nspeaker2:: Speaker 2\nspeaker3:: Speaker 3\n\n## Transcript\n\nold\n");
    expect(reconcileSpeakersSection(draft, [1])).toBe(draft);
  });
});

describe("applyRetranscription", () => {
  const original = mergeTranscriptionDraft(session, spoken)
    .replace("speaker1:: Speaker 1", "speaker1:: Alex")
    .replace("Generate a summary from this transcript.", "- Edited summary");

  it("replaces only the transcript and keeps user-edited speaker names and the summary", () => {
    const next = applyRetranscription(original, result({ transcript: "**{{speaker1}}** [00:00]\nNew.\n\n**{{speaker3}}** [00:09]\nThird.", speakerNumbers: [1, 3], speakers: true }));
    expect(next).toContain("- Edited summary");
    expect(next).toContain("speaker1:: Alex\nspeaker2:: Speaker 2\nspeaker3:: Speaker 3");
    expect(next).toContain("## Transcript\n\n**{{speaker1}}** [00:00]\nNew.");
    expect(next).not.toContain("Hey.");
    expect(next.startsWith("# meeting.wav transcript\n")).toBe(true);
  });

  it("creates the Speakers section before the transcript when the draft had none", () => {
    const plain = mergeTranscriptionDraft(session, result());
    const next = applyRetranscription(plain, spoken);
    expect(next).toContain("Generate a summary from this transcript.\n\n## Speakers\n\nspeaker1:: Speaker 1\nspeaker2:: Speaker 2\n\n## Transcript\n\n**{{speaker1}}**");
  });

  it("does not delete speaker lines when the new transcript has no speakers", () => {
    const next = applyRetranscription(original, result({ transcript: "[00:00] Plain." }));
    expect(next).toContain("speaker1:: Alex");
    expect(next).toContain("## Transcript\n\n[00:00] Plain.");
  });
});
