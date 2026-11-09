import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveMarkdownEditor } from "../../src/features/workspace/components/LiveMarkdownEditor.tsx";
import { TranscriptionDock } from "../../src/features/transcription/components/TranscriptionDock.tsx";
import { useTranscription } from "../../src/features/transcription/hooks/useTranscription.ts";
import type { TranscriptionDockActions, TranscriptionDockModel } from "../../src/features/transcription/hooks/useTranscription.ts";
import { playbackStore } from "../../src/features/transcription/model/playback-store.ts";
import type { TranscriptionResult, TranscriptionSession } from "../../src/features/transcription/model/types.ts";
import { FakeAudio } from "./fake-audio.ts";

const { apiMock, apiForBundleMock } = vi.hoisted(() => ({ apiMock: vi.fn(), apiForBundleMock: vi.fn() }));
vi.mock("../../src/lib/api.ts", () => ({ api: apiMock, apiForBundle: apiForBundleMock }));

const ready: TranscriptionSession = {
  id: "11111111-1111-4111-8111-111111111111", state: "ready", draftId: null, durationMs: 40_000, error: null,
  fileName: "meeting.wav", sourceBundleId: "bundle-a", createdAt: "2026-10-02T10:00:00.000Z",
};
const recorded: TranscriptionSession = { ...ready, id: "22222222-2222-4222-8222-222222222222", state: "recorded", fileName: "memo.wav" };
const running: TranscriptionSession = { ...ready, id: "33333333-3333-4333-8333-333333333333", state: "transcribing", fileName: "call.wav", progressPercent: 40 };

const segments = [
  { start: 0, end: 5, text: "Hello there.", speaker: 1 },
  { start: 5, end: 10, text: "Hi, thanks.", speaker: 2 },
  { start: 10, end: 15, text: "Let us begin.", speaker: 1 },
  { start: 15, end: 20, text: "Sounds good.", speaker: 2 },
];
const transcript = "**{{speaker1}}** [00:00]\nHello there.\n\n**{{speaker2}}** [00:05]\nHi, thanks.\n\n**{{speaker1}}** [00:10]\nLet us begin.\n\n**{{speaker2}}** [00:15]\nSounds good.";
const storedResult: TranscriptionResult = { summary: "", transcript, segments, speakers: true, speakerNumbers: [1, 2], speakerCount: 2 };

function model(overrides: Partial<TranscriptionDockModel> = {}): TranscriptionDockModel {
  return {
    phase: "idle", activeSession: null, pending: [], status: null, progress: "", error: "", identifySpeakers: false,
    deletingSessionId: null, recording: { phase: "idle", duration: "0:00", error: "", saving: false },
    speakerNamesFor: () => null, audioUrlFor: (item) => `/api/transcriptions/${item.id}/audio`, ...overrides,
  };
}

function actions(overrides: Partial<TranscriptionDockActions> = {}): TranscriptionDockActions {
  return {
    importFile: vi.fn(), startRecording: vi.fn(), stopRecording: vi.fn(), discardRecording: vi.fn(), retryRecording: vi.fn(),
    installModel: vi.fn(), installSpeakerModel: vi.fn(), setIdentifySpeakers: vi.fn(), setSessionIdentifySpeakers: vi.fn(),
    transcribe: vi.fn(), retranscribe: vi.fn(), cancel: vi.fn(), openTranscript: vi.fn(), regenerateSummary: vi.fn(),
    deleteSession: vi.fn(async () => undefined), loadResult: vi.fn(async () => storedResult), reassignSpeaker: vi.fn(),
    ...overrides,
  };
}

async function selectReadyRow() {
  fireEvent.click(screen.getByRole("button", { name: /^meeting\.wav, / }));
  return await screen.findByRole("group", { name: "Player for meeting.wav" });
}

beforeAll(() => { vi.stubGlobal("Audio", FakeAudio); });
afterAll(() => { vi.unstubAllGlobals(); });
beforeEach(() => { apiMock.mockReset(); apiForBundleMock.mockReset(); });
afterEach(() => {
  playbackStore.setSolo(null);
  playbackStore.unload(ready.id);
  playbackStore.configure({});
});

describe("recordings list", () => {
  it("shows exactly one contextual action per row", () => {
    render(<TranscriptionDock model={model({ status: { canTranscribe: true } as never, pending: [ready, recorded, running] })} actions={actions()} />);
    const rows = screen.getAllByRole("listitem");
    const visible = rows.map((row) => within(row).queryAllByRole("button").filter((button) => button.classList.contains("transcription-row-action")).map((button) => button.textContent));
    expect(visible).toEqual([[], ["Transcribe"], ["Cancel"]]);
    expect(screen.getByText("Transcribing… 40%")).toBeInTheDocument();
    expect(screen.getByText(/not transcribed/)).toBeInTheDocument();
  });

  it("keeps the other actions in an accessible overflow menu that Escape closes", () => {
    const dockActions = actions();
    render(<TranscriptionDock model={model({ status: { canTranscribe: true } as never, pending: [ready] })} actions={dockActions} />);
    const trigger = screen.getByRole("button", { name: "More actions for meeting.wav" });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    fireEvent.click(trigger);
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Open draft", "Summarize again", "Re-transcribe…", "Delete…"]);
    expect(screen.getByRole("menuitem", { name: "Open draft" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("menuitem", { name: "Open draft" }), { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: "Summarize again" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("menuitem", { name: "Summarize again" }), { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    fireEvent.click(trigger);
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "Summarize again" }));
    expect(dockActions.regenerateSummary).toHaveBeenCalledWith(ready);
  });
});

describe("player", () => {
  it("appears for a selected ready row and toggles playback", async () => {
    render(<TranscriptionDock model={model({ pending: [ready, recorded] })} actions={actions()} />);
    expect(screen.queryByRole("group", { name: /Player for/ })).not.toBeInTheDocument();
    const player = await selectReadyRow();
    expect(screen.getByRole("listitem", { current: true })).toHaveTextContent("meeting.wav");
    await waitFor(() => expect(within(player).getByRole("button", { name: /Speaker 1 · 2/ })).toBeInTheDocument());
    expect(FakeAudio.last?.getAttribute("src")).toBe(`/api/transcriptions/${ready.id}/audio`);
    fireEvent.click(within(player).getByRole("button", { name: "Play" }));
    expect(FakeAudio.last?.paused).toBe(false);
    expect(within(player).getByRole("button", { name: "Pause" })).toBeInTheDocument();
    fireEvent.click(within(player).getByRole("button", { name: "Playback speed 1×" }));
    expect(FakeAudio.last?.playbackRate).toBe(1.5);
    expect(within(player).getByText("Hello there.")).toBeInTheDocument();
    expect(within(player).getByRole("combobox", { name: "Who said this?" })).toBeInTheDocument();
  });

  it("passes the bundle in the audio URL", () => {
    const urls = renderHook(() => useTranscription({
      drafts: { createDraft: vi.fn(), getDraftContent: vi.fn(), getDraftDocument: vi.fn(), updateDraftContent: vi.fn(), openDraft: vi.fn() },
      setMessage: vi.fn(), sourceBundleId: "bundle a/b",
    })).result.current.model;
    expect(urls.audioUrlFor({ ...ready, sourceBundleId: "bundle a/b" })).toBe(`/api/transcriptions/${ready.id}/audio?bundle=bundle%20a%2Fb`);
  });

  it("solo mode skips the other speakers' turns", async () => {
    render(<TranscriptionDock model={model({ pending: [ready] })} actions={actions()} />);
    const player = await selectReadyRow();
    const chip = await within(player).findByRole("button", { name: /Speaker 2 · 2/ });
    fireEvent.click(chip);
    expect(chip).toHaveAttribute("aria-pressed", "true");
    const audio = FakeAudio.last!;
    expect(audio.currentTime).toBe(5);
    act(() => { audio.play(); });
    act(() => { audio.tick(10.2); });
    expect(audio.currentTime).toBe(15);
    act(() => { audio.tick(20.1); });
    expect(audio.paused).toBe(true);
    fireEvent.click(chip);
    expect(chip).toHaveAttribute("aria-pressed", "false");
  });

  it("toggles playback with Space only when focus is inside the player", async () => {
    render(<TranscriptionDock model={model({ pending: [ready] })} actions={actions()} />);
    const player = await selectReadyRow();
    await within(player).findByRole("button", { name: /Speaker 1/ });
    const before = FakeAudio.last!.playCalls;
    fireEvent.keyDown(document.body, { key: " " });
    expect(FakeAudio.last!.playCalls).toBe(before);
    fireEvent.keyDown(player, { key: " " });
    expect(FakeAudio.last!.playCalls).toBe(before + 1);
  });
});

describe("speaker reassignment", () => {
  it("confirms once, posts the change, and rewrites the Transcript section of the open draft", async () => {
    const updatedResult: TranscriptionResult = {
      ...storedResult,
      transcript: "**{{speaker2}}** [00:00]\nHello there.\n\n**{{speaker2}}** [00:05]\nHi, thanks.",
      segments: segments.map((segment, index) => index === 0 ? { ...segment, speaker: 2 } : segment),
    };
    const drafts = new Map<string, string>();
    apiMock.mockImplementation(async (url: string) => {
      if (url === "/api/transcriptions/status") return { canTranscribe: true, modelState: "ready" };
      if (url === "/api/transcriptions?pending=1") return [ready];
      throw new Error(`Unexpected API request: ${url}`);
    });
    apiForBundleMock.mockImplementation(async (_bundle: string | null, url: string, options?: { body?: string }) => {
      if (url.endsWith("/segments/speaker")) {
        expect(JSON.parse(options?.body ?? "{}")).toEqual({ index: 0, speaker: 2 });
        return { result: updatedResult };
      }
      if (/\/api\/transcriptions\/[^/]+$/.test(url)) return { session: ready, result: storedResult };
      throw new Error(`Unexpected bundle request: ${url}`);
    });
    const adapter = {
      createDraft: vi.fn((content = "") => { drafts.set("untitled:one", content); return "untitled:one"; }),
      getDraftContent: vi.fn((id: string) => drafts.get(id)),
      getDraftDocument: vi.fn(() => undefined),
      isDraftOpen: vi.fn(() => true),
      updateDraftContent: vi.fn((id: string, content: string) => { drafts.set(id, content); }),
      openDraft: vi.fn(),
    };
    function Harness() {
      const { model: hookModel, actions: hookActions } = useTranscription({ drafts: adapter, setMessage: vi.fn(), sourceBundleId: "bundle-a" });
      return <TranscriptionDock model={hookModel} actions={hookActions} />;
    }
    render(<Harness />);
    await screen.findByRole("button", { name: "More actions for meeting.wav" });
    fireEvent.click(screen.getByRole("button", { name: "More actions for meeting.wav" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Open draft" }));
    await waitFor(() => expect(adapter.createDraft).toHaveBeenCalled());
    drafts.set("untitled:one", "# Meeting\n\n## Speakers\n\nspeaker1:: Alex\n\n## Transcript\n\nstale\n");

    const player = await selectReadyRow();
    const select = await within(player).findByRole("combobox", { name: "Who said this?" });
    expect(within(player).getByRole("button", { name: /Alex · 2/ })).toBeInTheDocument();
    fireEvent.change(select, { target: { value: "2" } });
    expect(within(player).getByText(/This rewrites the Transcript section of the draft/)).toBeInTheDocument();
    expect(apiForBundleMock).not.toHaveBeenCalledWith("bundle-a", expect.stringContaining("/segments/speaker"), expect.anything());
    fireEvent.click(within(player).getByRole("button", { name: "Reassign" }));
    await waitFor(() => expect(drafts.get("untitled:one")).toContain("**{{speaker2}}** [00:00]\nHello there."));
    expect(drafts.get("untitled:one")).toContain("speaker1:: Alex");
    expect(drafts.get("untitled:one")).not.toContain("stale");
    expect(await within(player).findByText("Transcript section updated in the draft.")).toBeInTheDocument();

    // The confirmation is only shown the first time for a recording.
    fireEvent.change(within(player).getByRole("combobox", { name: "Who said this?" }), { target: { value: "2" } });
    expect(within(player).queryByText(/This rewrites the Transcript section/)).not.toBeInTheDocument();
  });
});

describe("draft link", () => {
  it("keeps the draft linked when a render sees the new draft as not yet open", async () => {
    const drafts = new Map<string, string>();
    let open = false;
    apiMock.mockResolvedValue([]);
    apiForBundleMock.mockResolvedValue({ session: ready, result: storedResult });
    const adapter = {
      createDraft: vi.fn((content = "") => { drafts.set("untitled:one", content); return "untitled:one"; }),
      getDraftContent: vi.fn((id: string) => drafts.get(id)),
      getDraftDocument: vi.fn(() => undefined),
      isDraftOpen: vi.fn(() => open),
      updateDraftContent: vi.fn(),
      openDraft: vi.fn(),
    };
    const { result } = renderHook(() => useTranscription({ drafts: adapter, setMessage: vi.fn(), sourceBundleId: "bundle-a" }));
    await act(async () => { await result.current.actions.openTranscript(ready); });
    // A render before the tab list catches up reads names while the adapter reports "not open".
    expect(result.current.model.speakerNamesFor(ready)).toBeNull();
    open = true;
    expect(result.current.model.speakerNamesFor(ready)).not.toBeNull();
  });
});

describe("editor timestamps", () => {
  const note = "# Meeting\n\n## Transcript\n\n**{{speaker1}}** [00:05]\nHello\n\n**{{speaker2}}** [01:23]\nWorld\n";

  it("seeks the recording linked to the draft when a timestamp is clicked", async () => {
    playbackStore.configure({ sourceFor: (id) => `/audio/${id}`, sessionForDraft: (id) => id === "untitled:one" ? ready.id : null });
    render(<LiveMarkdownEditor value={note} onChange={vi.fn()} documentId="untitled:one" ariaLabel="Transcript note" />);
    const view = EditorView.findFromDOM(screen.getByLabelText("Transcript note"))!;
    const marks = [...view.dom.querySelectorAll<HTMLElement>(".cm-live-markdown-timestamp")];
    expect(marks.map((mark) => mark.textContent)).toEqual(["[00:05]", "[01:23]"]);
    fireEvent.click(marks[1]);
    expect(playbackStore.getSnapshot()).toMatchObject({ sessionId: ready.id, currentTime: 83, playing: true });
    await waitFor(() => expect(view.dom.querySelectorAll(".cm-live-markdown-playing-turn").length).toBeGreaterThan(0));
    expect(view.dom.querySelector(".cm-live-markdown-playing-turn")?.textContent).toContain("[01:23]");
  });

  it("leaves a click alone when no recording is linked or loaded", () => {
    playbackStore.configure({ sourceFor: () => null, sessionForDraft: () => null });
    render(<LiveMarkdownEditor value={note} onChange={vi.fn()} documentId="untitled:other" ariaLabel="Transcript note" />);
    const view = EditorView.findFromDOM(screen.getByLabelText("Transcript note"))!;
    fireEvent.click(view.dom.querySelector(".cm-live-markdown-timestamp")!);
    expect(playbackStore.getSnapshot().sessionId).toBeNull();
  });

  it("does not mark timestamps without a document id", () => {
    render(<LiveMarkdownEditor value={note} onChange={vi.fn()} ariaLabel="Plain note" />);
    expect(screen.getByLabelText("Plain note").querySelector(".cm-live-markdown-timestamp")).toBeNull();
  });
});
