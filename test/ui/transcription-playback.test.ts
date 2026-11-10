import { describe, expect, it, vi } from "vitest";
import { createPlaybackStore } from "../../src/features/transcription/model/playback-store.ts";
import {
  adjacentTurnStart, buildTurns, findSegmentIndex, formatClock, reassignOptions, soloStep,
  speakerDisplayName, turnCounts,
} from "../../src/features/transcription/model/playback-turns.ts";
import {
  activeTimestampIndex, parseTranscriptTimestamps, timestampBlockLines,
} from "../../src/features/transcription/model/transcript-timestamps.ts";
import { FakeAudio } from "./fake-audio.ts";

const segments = [
  { start: 0, end: 5, text: "a", speaker: 1 },
  { start: 5, end: 8, text: "b", speaker: 1 },
  { start: 8, end: 12, text: "c", speaker: 2 },
  { start: 12, end: 20, text: "d", speaker: 1 },
  { start: 20, end: 30, text: "e", speaker: 2 },
];

describe("playback turns", () => {
  const turns = buildTurns(segments);

  it("merges consecutive same-speaker segments", () => {
    expect(turns.map((turn) => [turn.speaker, turn.start, turn.end, turn.firstSegment, turn.lastSegment])).toEqual([
      [1, 0, 8, 0, 1], [2, 8, 12, 2, 2], [1, 12, 20, 3, 3], [2, 20, 30, 4, 4],
    ]);
    expect(turnCounts(turns).get(1)).toBe(2);
  });

  it("finds the current segment with a binary search", () => {
    expect(findSegmentIndex(segments, -1)).toBe(-1);
    expect(findSegmentIndex(segments, 0)).toBe(0);
    expect(findSegmentIndex(segments, 7.9)).toBe(1);
    expect(findSegmentIndex(segments, 8)).toBe(2);
    expect(findSegmentIndex(segments, 999)).toBe(4);
  });

  it("skips gaps between a speaker's turns and stops after the last one", () => {
    expect(soloStep(turns, 1, 3)).toEqual({ kind: "inside" });
    expect(soloStep(turns, 1, 9)).toEqual({ kind: "jump", to: 12 });
    expect(soloStep(turns, 1, 20.5)).toEqual({ kind: "end" });
    expect(soloStep(turns, 2, 0)).toEqual({ kind: "jump", to: 8 });
  });

  it("finds adjacent turns, optionally for one speaker", () => {
    expect(adjacentTurnStart(turns, 1, 1)).toBe(8);
    expect(adjacentTurnStart(turns, 1, 1, 1)).toBe(12);
    expect(adjacentTurnStart(turns, 14, -1, 1)).toBe(12);
    expect(adjacentTurnStart(turns, 12.5, -1)).toBe(8);
    expect(adjacentTurnStart(turns, 13.5, -1, 2)).toBe(8);
    expect(adjacentTurnStart(turns, 25, 1)).toBeNull();
  });

  it("formats clocks, names and reassignment options", () => {
    expect(formatClock(75)).toBe("1:15");
    expect(formatClock(3725)).toBe("1:02:05");
    expect(speakerDisplayName(2, new Map([[2, "Sam"]]))).toBe("Sam");
    expect(speakerDisplayName(3, null)).toBe("Speaker 3");
    expect(reassignOptions([1, 2], 1)).toEqual([2, 3]);
    expect(reassignOptions([1, 2, 3, 4], 1)).toEqual([2, 3, 4]);
  });
});

describe("transcript timestamps", () => {
  const text = "# Title\n\n[00:01] outside\n\n## Transcript\n\n**{{speaker1}}** [00:05]\nHello\n\n[01:05:09] more\r\nlong\n\n## Notes\n\n[09:00] ignored\n";

  it("parses both formats inside the Transcript section only", () => {
    const stamps = parseTranscriptTimestamps(text);
    expect(stamps.map((stamp) => stamp.seconds)).toEqual([5, 3909]);
    expect(text.slice(stamps[0].from, stamps[0].to)).toBe("[00:05]");
    expect(text.slice(stamps[1].from, stamps[1].to)).toBe("[01:05:09]");
  });

  it("handles CRLF documents", () => {
    const crlf = "## Transcript\r\n\r\n[00:10] a\r\n[00:20] b\r\n";
    const stamps = parseTranscriptTimestamps(crlf);
    expect(stamps.map((stamp) => stamp.seconds)).toEqual([10, 20]);
    expect(crlf.slice(stamps[1].from, stamps[1].to)).toBe("[00:20]");
  });

  it("locates the active block and its lines", () => {
    const stamps = parseTranscriptTimestamps(text);
    expect(activeTimestampIndex(stamps, 4)).toBe(-1);
    expect(activeTimestampIndex(stamps, 100)).toBe(0);
    const lines = text.split("\n").length;
    expect(timestampBlockLines(stamps, 0, lines, text)).toEqual({ start: 6, end: 7 });
  });
});

describe("playback store", () => {
  function setup() {
    const audio = new FakeAudio();
    const store = createPlaybackStore(() => audio as unknown as HTMLAudioElement);
    store.configure({ sourceFor: (id) => `/audio/${id}`, sessionForDraft: (id) => id === "untitled:1" ? "s1" : null });
    return { audio, store };
  }

  it("seeks a not-yet-loaded session through the resolvers and plays for editor clicks", () => {
    const { audio, store } = setup();
    expect(store.seekFromDraft("untitled:1", 83)).toBe(true);
    expect(store.getSnapshot()).toMatchObject({ sessionId: "s1", currentTime: 83, playing: true });
    expect(audio.getAttribute("src")).toBe("/audio/s1");
    expect(store.seekFromDraft("unknown", 5)).toBe(true); // falls back to the loaded recording
    expect(store.getSnapshot().currentTime).toBe(5);
  });

  it("does nothing for a draft when no recording is linked or loaded", () => {
    const { store } = setup();
    expect(store.seekFromDraft("unknown", 5)).toBe(false);
    expect(store.getSnapshot().sessionId).toBeNull();
  });

  it("plays only one speaker's turns in solo mode and pauses at the end", () => {
    const { audio, store } = setup();
    store.load("s1", "/audio/s1", 30);
    store.setTurns("s1", buildTurns(segments));
    store.setSolo(2);
    expect(audio.currentTime).toBe(8);
    store.play();
    audio.tick(12.2);
    expect(audio.currentTime).toBe(20);
    audio.tick(30.2);
    expect(audio.paused).toBe(true);
    store.skipTurn(-1);
    expect(audio.currentTime).toBe(20);
  });

  it("keeps a session's turns while another recording is loaded in between", () => {
    const { audio, store } = setup();
    store.setTurns("s1", buildTurns(segments));
    store.load("s2", "/audio/s2", 30);
    store.load("s1", "/audio/s1", 30);
    audio.currentTime = 9;
    store.seekCurrent(9);
    store.skipTurn(1);
    expect(audio.currentTime).toBe(12);
    store.clearTurns("s1");
    store.skipTurn(1);
    expect(audio.currentTime).toBe(12);
  });

  it("cycles the playback rate", () => {
    const { audio, store } = setup();
    store.load("s1", "/audio/s1");
    store.cycleRate();
    store.cycleRate();
    expect(audio.playbackRate).toBe(2);
    store.cycleRate();
    expect(store.getSnapshot().rate).toBe(1);
  });

  it("notifies subscribers only when the snapshot changes", () => {
    const { store } = setup();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.load("s1", "/audio/s1");
    store.setRate(1);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});
