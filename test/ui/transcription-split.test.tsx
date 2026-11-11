import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NowSpeaking } from "../../src/features/transcription/components/NowSpeaking.tsx";
import type { ReassignOutcome } from "../../src/features/transcription/hooks/speakerReassign.ts";
import { nearestBoundary, sentenceWords } from "../../src/features/transcription/model/split-sentence.ts";
import type { TranscriptionSegment } from "../../src/features/transcription/model/types.ts";

const segments: TranscriptionSegment[] = [
  { start: 0, end: 4, text: "Hello there.", speaker: 1 },
  { start: 4, end: 12, text: "Sure thing and then another one", speaker: 2 },
  { start: 12, end: 14, text: "Okay", speaker: 1 },
];
const outcome: ReassignOutcome = { result: { summary: "", transcript: "", segments } };
let counter = 0;

function setup(index: number, time = 0, overrides: Partial<Parameters<typeof NowSpeaking>[0]> = {}) {
  counter += 1;
  const props = {
    segments, index, time, present: [1, 2], names: null, hasSpeakers: true,
    onReassign: vi.fn(async () => outcome), onSplit: vi.fn(async () => outcome), onMerge: vi.fn(async () => outcome), onApplied: vi.fn(),
    ...overrides,
  };
  const { rerender } = render(<NowSpeaking {...props} />);
  return { ...props, rerender: (next: Partial<Parameters<typeof NowSpeaking>[0]>) => rerender(<NowSpeaking {...props} {...next} />) };
}

describe("split sentence helpers", () => {
  const words = sentenceWords("Sure thing and then");
  it("measures word offsets on the exact string", () => {
    expect(words.map((word) => word.offset)).toEqual([0, 5, 11, 15]);
  });
  it("picks the boundary nearest the playhead, never the first word", () => {
    expect(nearestBoundary(words, 19, 0, 10, 5.5)).toBe(2);
    expect(nearestBoundary(words, 19, 0, 10, 0)).toBe(1);
    expect(nearestBoundary(words, 19, 0, 10, 10)).toBe(3);
    expect(nearestBoundary(words, 19, 0, 10, 11)).toBeNull();
    expect(nearestBoundary(sentenceWords("One"), 3, 0, 1, 0.5)).toBeNull();
  });
});

describe("split and merge controls", () => {
  it("opens split mode, preselects from the playhead and sends the offset and speaker", async () => {
    const props = setup(1, 8);
    expect(screen.getByRole("button", { name: "Split this sentence where another speaker starts" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Split this sentence where another speaker starts" }));
    expect(screen.getByText("Click the word where the other speaker starts.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: 'Split before "then"' })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("button", { name: 'Split before "Sure"' })).not.toBeInTheDocument();
    // Speaker 1 is the first option (the current speaker, 2, is not offered).
    expect(screen.getByRole("button", { name: "Speaker 1" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("button", { name: "Speaker 2" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: 'Split before "and"' }));
    fireEvent.click(screen.getByRole("button", { name: "New speaker" }));
    fireEvent.click(screen.getByRole("button", { name: "Split" }));
    await waitFor(() => expect(props.onSplit).toHaveBeenCalledWith(1, 11, 3));
  });

  it("starts without a boundary when the playhead is outside the sentence and cancels with Escape", () => {
    setup(1, 20);
    fireEvent.click(screen.getByRole("button", { name: "Split this sentence where another speaker starts" }));
    expect(screen.getByRole("button", { name: "Split" })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("button", { name: 'Split before "thing"' }), { key: "Escape" });
    expect(screen.queryByText("Click the word where the other speaker starts.")).not.toBeInTheDocument();
  });

  it("disables splitting a single word and hides merge at the first sentence", () => {
    setup(2);
    expect(screen.getByRole("button", { name: "Split this sentence where another speaker starts" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Merge with the previous sentence" })).toBeEnabled();
  });

  it("exposes the toolbar names and toggles split mode with aria-pressed", () => {
    setup(1, 8);
    expect(screen.getByRole("button", { name: "Wrong speaker? Move this sentence to another speaker" })).toHaveAttribute("aria-haspopup", "menu");
    expect(screen.getByRole("button", { name: "Merge with the previous sentence" })).toBeEnabled();
    const split = screen.getByRole("button", { name: "Split this sentence where another speaker starts" });
    expect(split).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(split);
    expect(split).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(split);
    expect(split).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByText("Click the word where the other speaker starts.")).not.toBeInTheDocument();
  });

  it("hides merge at index 0", () => {
    setup(0);
    expect(screen.queryByRole("button", { name: "Merge with the previous sentence" })).not.toBeInTheDocument();
  });

  it("merges the saved sentence, reports it, and undoes with a split", async () => {
    const props = setup(1);
    fireEvent.click(screen.getByRole("button", { name: "Merge with the previous sentence" }));
    expect(await screen.findByText(/Merged with the previous sentence\./)).toBeInTheDocument();
    expect(props.onMerge).toHaveBeenCalledWith(1);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(props.onSplit).toHaveBeenCalledWith(0, 13, 2));
    await waitFor(() => expect(screen.queryByText(/Merged with the previous sentence\./)).not.toBeInTheDocument());
  });

  it("saves a speaker correction immediately", async () => {
    const props = setup(0);
    fireEvent.click(screen.getByRole("button", { name: "Wrong speaker? Move this sentence to another speaker" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Speaker 2" }));
    await waitFor(() => expect(props.onReassign).toHaveBeenCalledWith(0, 2));
  });

  it("undoes a split by merging the second half back", async () => {
    const props = setup(1, 8);
    fireEvent.click(screen.getByRole("button", { name: "Split this sentence where another speaker starts" }));
    fireEvent.click(screen.getByRole("button", { name: "Split" }));
    expect(await screen.findByText(/Split\. The rest is now Speaker 1\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(props.onMerge).toHaveBeenCalledWith(2));
  });

  it("shows failures in the alert", async () => {
    setup(1, 8, { onSplit: vi.fn(async () => { throw new Error("nope"); }) });
    fireEvent.click(screen.getByRole("button", { name: "Split this sentence where another speaker starts" }));
    fireEvent.click(screen.getByRole("button", { name: "Split" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("nope");
  });
});
