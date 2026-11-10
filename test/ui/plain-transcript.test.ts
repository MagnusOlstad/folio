import { describe, expect, it } from "vitest";
import { plainTranscriptResult } from "../../src/features/transcription/model/plain-transcript.ts";
import { mergeTranscriptionDraft } from "../../src/features/transcription/model/types.ts";
import type { TranscriptionResult } from "../../src/features/transcription/model/types.ts";

const base: TranscriptionResult = {
  summary: "",
  transcript: "**{{speaker1}}** [00:00]\nHello there.\n\n**{{speaker2}}** [00:09]\nHi.",
  speakers: true,
  speakerCount: 2,
  speakerNumbers: [1, 2],
};

describe("plainTranscriptResult", () => {
  it("joins segments into paragraphs, breaking on pauses of four seconds or more", () => {
    const result = plainTranscriptResult({
      ...base,
      segments: [
        { start: 0, end: 2, text: "Hello there.", speaker: 1 },
        { start: 2.5, end: 4, text: "Welcome.", speaker: 2 },
        { start: 8, end: 9, text: "Next topic.", speaker: 1 },
      ],
    });
    expect(result.transcript).toBe("Hello there. Welcome.\n\nNext topic.");
  });

  it("starts a new paragraph once one reaches about 480 characters", () => {
    const long = "word ".repeat(100).trim();
    const result = plainTranscriptResult({ ...base, segments: [{ start: 0, end: 1, text: long }, { start: 1, end: 2, text: "More." }] });
    expect(result.transcript).toBe(`${long}\n\nMore.`);
  });

  it("clears speaker fields so the draft gets no Speakers section", () => {
    const result = plainTranscriptResult({ ...base, segments: [{ start: 0, end: 1, text: "Hi.", speaker: 1 }] });
    expect(result).toMatchObject({ speakers: false, speakerCount: 0, speakerNumbers: [] });
    const draft = mergeTranscriptionDraft({ id: "s", state: "ready", draftId: null, durationMs: 1000, error: null, fileName: "a.wav" }, result);
    expect(draft).not.toContain("## Speakers");
    expect(draft).not.toMatch(/\{\{speaker|\[\d\d:\d\d\]/);
  });

  it("falls back to plainText, then to stripped markup", () => {
    expect(plainTranscriptResult({ ...base, plainText: "Plain words." }).transcript).toBe("Plain words.");
    expect(plainTranscriptResult(base).transcript).toBe("Hello there.\n\nHi.");
    expect(plainTranscriptResult({ ...base, transcript: "[00:01] One.\n\n[01:02:03] Two." }).transcript).toBe("One.\n\nTwo.");
  });
});
