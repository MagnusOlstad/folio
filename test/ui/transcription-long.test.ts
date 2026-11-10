import { describe, expect, it } from "vitest";
import { barPercent, keyboardSeekTarget, laneBars } from "../../src/features/transcription/model/lane-bars.ts";
import {
  adjacentTurnStart, buildTurns, findSegmentIndex, formatClock, soloStep,
} from "../../src/features/transcription/model/playback-turns.ts";
import { parseTranscriptTimestamps, timestampsInRange } from "../../src/features/transcription/model/transcript-timestamps.ts";
import type { TranscriptionSegment } from "../../src/features/transcription/model/types.ts";

/** 4 hours: 5,000 segments of 2.88 s, speakers alternating every 3 segments. */
function fourHours(): TranscriptionSegment[] {
  return Array.from({ length: 5000 }, (_, index) => ({
    start: index * 2.88, end: (index + 1) * 2.88, text: `Sentence ${index}.`, speaker: (Math.floor(index / 3) % 2) + 1,
  }));
}

describe("long recordings", () => {
  const segments = fourHours();
  const turns = buildTurns(segments);

  it("finds the current segment by binary search at any point of 4 hours", () => {
    expect(turns).toHaveLength(Math.ceil(5000 / 3));
    for (const index of [0, 1, 2499, 4999]) expect(findSegmentIndex(segments, index * 2.88 + 1)).toBe(index);
    expect(findSegmentIndex(segments, 99_999)).toBe(4999);
    // A linear scan would touch thousands of items; count property reads on a proxy to prove it does not.
    let reads = 0;
    const counted = new Proxy(segments, { get(target, key, receiver) { if (typeof key === "string" && /^\d+$/.test(key)) reads += 1; return Reflect.get(target, key, receiver); } });
    findSegmentIndex(counted, 7000);
    expect(reads).toBeLessThan(40);
  });

  it("looks up neighbouring turns without scanning every turn", () => {
    const at = turns[800].start + 3;
    expect(adjacentTurnStart(turns, at, 1)).toBe(turns[801].start);
    expect(adjacentTurnStart(turns, at, -1)).toBe(turns[800].start);
    expect(adjacentTurnStart(turns, turns[800].start + 0.5, -1)).toBe(turns[799].start);
    expect(adjacentTurnStart(turns, at, 1, 1)).toBe(turns[802].start);
    expect(adjacentTurnStart(turns, turns[800].start + 0.5, -1, 1)).toBe(turns[798].start);
    expect(adjacentTurnStart(turns, 99_999, 1)).toBeNull();
    expect(adjacentTurnStart(turns, 0, -1)).toBe(0);
    let reads = 0;
    const counted = new Proxy(turns, { get(target, key, receiver) { if (typeof key === "string" && /^\d+$/.test(key)) reads += 1; return Reflect.get(target, key, receiver); } });
    adjacentTurnStart(counted, at, 1);
    adjacentTurnStart(counted, at, -1);
    soloStep(counted, 2, at);
    expect(reads).toBeLessThan(60);
  });

  it("steps solo playback across hour-scale data", () => {
    const first = turns.find((turn) => turn.speaker === 2)!;
    expect(soloStep(turns, 2, 0)).toEqual({ kind: "jump", to: first.start });
    expect(soloStep(turns, 2, first.start + 1)).toEqual({ kind: "inside" });
    expect(soloStep(turns, 1, 99_999)).toEqual({ kind: "end" });
  });

  it("coalesces near-adjacent turns into a bounded number of bars with a CSS-sized minimum", () => {
    const duration = 5000 * 2.88;
    const bars = laneBars(turns, [1, 2], duration);
    // Gaps between one speaker's turns (~8.6 s) are below 0.15% of 4 h (21.6 s): each lane collapses to one bar.
    expect(bars.get(1)).toHaveLength(1);
    expect(bars.get(2)).toHaveLength(1);
    const spaced = laneBars([
      { start: 0, end: 10, speaker: 1, firstSegment: 0, lastSegment: 0 },
      { start: 5000, end: 5010, speaker: 1, firstSegment: 1, lastSegment: 1 },
      { start: 5011, end: 5012, speaker: 1, firstSegment: 2, lastSegment: 2 },
    ], [1], 14_400);
    expect(spaced.get(1)).toEqual([{ start: 0, end: 10 }, { start: 5000, end: 5012 }]);
    expect(barPercent({ start: 0, end: 0.001 }, 14_400).width).toBeLessThan(0.0001);
    expect(barPercent({ start: 3600, end: 7200 }, 14_400)).toEqual({ left: 25, width: 25 });
  });

  it("formats and parses clocks past one hour", () => {
    expect(formatClock(3600)).toBe("1:00:00");
    expect(formatClock(12_345)).toBe("3:25:45");
    const stamps = parseTranscriptTimestamps("## Transcript\n\n**{{speaker1}}** [1:02:03]\nHi\n\n[0:05]\nok\n");
    expect(stamps.map((stamp) => stamp.seconds)).toEqual([3723, 5]);
    const text = Array.from({ length: 3000 }, (_, i) => `**{{speaker1}}** [${formatClock(i * 5)}]\nx`).join("\n\n");
    const all = parseTranscriptTimestamps(`## Transcript\n\n${text}`);
    expect(all).toHaveLength(3000);
    expect(all[2999].seconds).toBe(14_995);
    const window = timestampsInRange(all, all[1000].from, all[1010].from);
    expect(window.map((stamp) => stamp.seconds)).toEqual(Array.from({ length: 10 }, (_, i) => (1000 + i) * 5));
  });

  it("maps arrow, shift and Home/End keys to seek targets", () => {
    expect(keyboardSeekTarget("ArrowRight", false, 100, 3600)).toBe(105);
    expect(keyboardSeekTarget("ArrowLeft", true, 100, 3600)).toBe(70);
    expect(keyboardSeekTarget("ArrowLeft", false, 2, 3600)).toBe(0);
    expect(keyboardSeekTarget("End", false, 0, 3600)).toBe(3600);
    expect(keyboardSeekTarget("Home", false, 50, 3600)).toBe(0);
    expect(keyboardSeekTarget("a", false, 50, 3600)).toBeNull();
  });
});
