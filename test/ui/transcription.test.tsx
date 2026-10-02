import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TranscriptionDock } from "../../src/features/transcription/components/TranscriptionDock.tsx";
import { mergeTranscriptionDraft, type TranscriptionSession } from "../../src/features/transcription/model/types.ts";
import type {
  TranscriptionDockActions,
  TranscriptionDockModel,
} from "../../src/features/transcription/hooks/useTranscription.ts";
import { useTranscription } from "../../src/features/transcription/hooks/useTranscription.ts";

const { apiMock, apiForBundleMock } = vi.hoisted(() => ({ apiMock: vi.fn(), apiForBundleMock: vi.fn() }));
vi.mock("../../src/lib/api.ts", () => ({ api: apiMock, apiForBundle: apiForBundleMock }));

function model(overrides: Partial<TranscriptionDockModel> = {}): TranscriptionDockModel {
  return {
    phase: "idle",
    activeSession: null,
    pending: [],
    status: null,
    progress: "",
    error: "",
    ...overrides,
  };
}

function actions(): TranscriptionDockActions {
  return {
    importFile: vi.fn(),
    installModel: vi.fn(),
    transcribe: vi.fn(),
    cancel: vi.fn(),
    openTranscript: vi.fn(),
    regenerateSummary: vi.fn(),
  };
}

const status = {
  model: "mlx-community/whisper-large-v3-turbo",
  revision: "pinned",
  available: true,
  helperAvailable: true,
  modelState: "missing" as const,
  downloadedBytes: 0,
  totalBytes: 1_610_000_000,
  downloadPercent: 0,
  canInstall: true,
  canTranscribe: false,
  installing: false,
};

const session: TranscriptionSession = {
  id: "11111111-1111-4111-8111-111111111111",
  state: "ready",
  draftId: "notes/meeting.md",
  durationMs: 61_000,
  error: null,
  fileName: "meeting.wav",
  source: "file",
  sourceBundleId: "bundle-a",
  createdAt: "2026-10-02T10:00:00.000Z",
};

describe("transcription UI", () => {
  beforeEach(() => { apiMock.mockReset(); apiForBundleMock.mockReset(); });

  it("builds an editable Markdown transcript with source details", () => {
    expect(mergeTranscriptionDraft(session, {
      summary: "A short summary.",
      transcript: "Hello from the transcript.",
    })).toContain("- Source audio: meeting.wav\n- Imported:");
    expect(mergeTranscriptionDraft(session, {
      summary: "A short summary.",
      transcript: "Hello from the transcript.",
    })).toContain("## Transcript\n\nHello from the transcript.");
  });

  it("supports choosing and dropping local audio and explains missing model setup", () => {
    const dockActions = actions();
    const { container } = render(<TranscriptionDock model={model({ status, pending: [session] })} actions={dockActions} />);
    expect(screen.getByRole("button", { name: "Choose audio" })).toBeEnabled();
    expect(screen.getByText(/mlx-community\/whisper-large-v3-turbo/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download model" })).toBeEnabled();
    const file = new File(["local audio"], "meeting.wav", { type: "audio/wav" });
    fireEvent.drop(container.querySelector(".transcription-dropzone")!, { dataTransfer: { files: { length: 1, item: () => file } } });
    expect(dockActions.importFile).toHaveBeenCalledWith(file);
    expect(screen.getByText("meeting.wav")).toBeInTheDocument();
    expect(screen.getByText(/Duration unavailable|1:01/)).toBeInTheDocument();
  });

  it("regenerates from the filed note's edited transcript and updates only its summary", async () => {
    const note = {
      id: "notes/meeting.md",
      content: "# meeting transcript\n\n## Summary\n\nOld summary.\n\n## Transcript\n\nEdited transcript with corrected date.\n",
    };
    const updatedContents: string[] = [];
    const operationOrder: string[] = [];
    apiMock.mockImplementation(async (url: string) => {
      if (url === "/api/transcriptions/status") return { ...status, modelState: "ready", canTranscribe: true };
      if (url === "/api/transcriptions?pending=1") return [session];
      throw new Error(`Unexpected API request: ${url}`);
    });
    apiForBundleMock.mockImplementation(async (_bundleId: string | null, url: string, options?: RequestInit) => {
      if (url === "/api/note?id=notes%2Fmeeting.md" && options?.method === "PATCH") {
        operationOrder.push("persist");
        return { content: String(JSON.parse(String(options.body)).content) };
      }
      if (url.endsWith("/summarize")) {
        operationOrder.push("summarize");
        expect(JSON.parse(String(options?.body)).transcript).toBe("Edited transcript with corrected date.");
        return { result: { summary: "Updated local summary.", transcript: "Edited transcript with corrected date." } };
      }
      throw new Error(`Unexpected API request: ${url}`);
    });
    const drafts = {
      createDraft: vi.fn(() => note.id),
      getDraftContent: vi.fn(() => note.content),
      getDraftDocument: vi.fn(() => note),
      updateDraftContent: vi.fn((_id: string, content: string) => { note.content = content; updatedContents.push(content); }),
      openDraft: vi.fn(),
    };
    const { result } = renderHook(() => useTranscription({
      drafts,
      setMessage: vi.fn(),
      sourceNoteId: "notes/source.md",
      sourceBundleId: "bundle-a",
    }));
    await act(async () => { result.current.actions.regenerateSummary(session); });
    await waitFor(() => expect(updatedContents).toHaveLength(1));
    expect(note.content).toContain("## Summary\n\nUpdated local summary.");
    expect(note.content).toContain("## Transcript\n\nEdited transcript with corrected date.");
    expect(operationOrder).toEqual(["persist", "summarize", "persist"]);
    expect(drafts.openDraft).toHaveBeenCalledWith("notes/meeting.md");
  });

  it("preserves transcript edits made during summary generation and the final note save", async () => {
    let noteContent = "# Meeting\n\n## Summary\n\nOld summary.\n\n## Transcript\n\nOriginal transcript.\n";
    const updatedContents: string[] = [];
    const makeDraftAdapter = () => {
      const snapshot = noteContent;
      return {
        createDraft: vi.fn(() => session.draftId!),
        getDraftContent: vi.fn(() => snapshot),
        getDraftDocument: vi.fn(() => ({ content: snapshot })),
        updateDraftContent: vi.fn((_id: string, content: string) => { updatedContents.push(content); }),
        openDraft: vi.fn(),
      };
    };
    let drafts = makeDraftAdapter();
    let resolveSummary: ((value: unknown) => void) | undefined;
    let resolveFinalPatch: ((value: unknown) => void) | undefined;
    let announceSummary: (() => void) | undefined;
    let announceFinalPatch: (() => void) | undefined;
    const summaryStarted = new Promise<void>((resolve) => { announceSummary = resolve; });
    const finalPatchStarted = new Promise<void>((resolve) => { announceFinalPatch = resolve; });
    let patchCount = 0;
    let finalPatchContent = "";
    apiMock.mockImplementation((url: string) => {
      if (url === "/api/transcriptions/status") return { ...status, modelState: "ready", canTranscribe: true };
      if (url === "/api/transcriptions?pending=1") return [session];
      throw new Error(`Unexpected API request: ${url}`);
    });
    apiForBundleMock.mockImplementation((_bundleId: string | null, url: string, options?: RequestInit) => {
      if (url === "/api/note?id=notes%2Fmeeting.md" && options?.method === "PATCH") {
        patchCount += 1;
        const content = String(JSON.parse(String(options.body)).content);
        if (patchCount === 1) return Promise.resolve({ content });
        finalPatchContent = content;
        announceFinalPatch?.();
        return new Promise((resolve) => { resolveFinalPatch = resolve; });
      }
      if (url.endsWith("/summarize")) {
        announceSummary?.();
        return new Promise((resolve) => { resolveSummary = resolve; });
      }
      throw new Error(`Unexpected bundle API request: ${url}`);
    });
    const { result, rerender } = renderHook(
      ({ adapter }: { adapter: ReturnType<typeof makeDraftAdapter> }) => useTranscription({
        drafts: adapter,
        setMessage: vi.fn(),
        sourceNoteId: null,
        sourceBundleId: "bundle-a",
      }),
      { initialProps: { adapter: drafts } },
    );
    act(() => { result.current.actions.regenerateSummary(session); });
    await summaryStarted;

    noteContent = "# Meeting\n\n## Summary\n\nOld summary.\n\n## Transcript\n\nEdited while summary was generating.\n";
    drafts = makeDraftAdapter();
    rerender({ adapter: drafts });
    await act(async () => { resolveSummary?.({ result: { summary: "Fresh summary.", transcript: "Original transcript." } }); });
    await finalPatchStarted;
    expect(finalPatchContent).toContain("Edited while summary was generating.");

    noteContent = "# Meeting\n\n## Summary\n\nOld summary.\n\n## Transcript\n\nEdited while final save was pending.\n";
    drafts = makeDraftAdapter();
    rerender({ adapter: drafts });
    await act(async () => { resolveFinalPatch?.({ content: finalPatchContent }); });
    await waitFor(() => expect(updatedContents).toHaveLength(1));
    expect(updatedContents[0]).toContain("## Summary\n\nFresh summary.");
    expect(updatedContents[0]).toContain("## Transcript\n\nEdited while final save was pending.");
    expect(drafts.openDraft).toHaveBeenCalledWith("notes/meeting.md");
  });

  it("does not open a completed transcript in a different bundle", async () => {
    let resolveProcess: ((value: unknown) => void) | undefined;
    const processResult = new Promise((resolve) => { resolveProcess = resolve; });
    apiForBundleMock.mockImplementation((_: string | null, url: string) => {
      if (url.endsWith("/process")) return processResult;
      throw new Error(`Unexpected API request: ${url}`);
    });
    apiMock.mockImplementation((url: string) => {
      if (url === "/api/transcriptions/status") return { ...status, modelState: "ready", canTranscribe: true };
      if (url === "/api/transcriptions?pending=1") return [];
      throw new Error(`Unexpected API request: ${url}`);
    });
    const drafts = {
      createDraft: vi.fn(() => "untitled:new"),
      getDraftContent: vi.fn(() => undefined),
      getDraftDocument: vi.fn(() => undefined),
      updateDraftContent: vi.fn(),
      openDraft: vi.fn(),
      persistDraft: vi.fn(async () => false),
    };
    const setMessage = vi.fn();
    const { result, rerender } = renderHook(
      ({ bundleId }: { bundleId: string }) => useTranscription({
        drafts,
        setMessage,
        sourceNoteId: null,
        sourceBundleId: bundleId,
      }),
      { initialProps: { bundleId: "bundle-a" } },
    );
    act(() => { result.current.actions.transcribe({ ...session, draftId: null, sourceBundleId: "bundle-a", state: "recorded" }); });
    rerender({ bundleId: "bundle-b" });
    await act(async () => {
      resolveProcess?.({ session: { ...session, draftId: null, sourceBundleId: "bundle-a" }, result: { summary: "", transcript: "local transcript" } });
      await processResult;
    });
    await waitFor(() => expect(setMessage).toHaveBeenCalledWith("Transcription finished. Switch back to the source workspace to open its Markdown note."));
    expect(drafts.createDraft).not.toHaveBeenCalled();
    expect(drafts.openDraft).not.toHaveBeenCalled();
  });

  it("rechecks the bundle after loading a filed note completes", async () => {
    let resolveNote: ((value: unknown) => void) | undefined;
    let announceNoteRead: (() => void) | undefined;
    const noteReadStarted = new Promise<void>((resolve) => { announceNoteRead = resolve; });
    apiForBundleMock.mockImplementation((_: string | null, url: string) => {
      if (url.endsWith("/process")) return Promise.resolve({
        session: { ...session, sourceBundleId: "bundle-a" },
        result: { summary: "", transcript: "Recovered transcript." },
      });
      if (url === "/api/note?id=notes%2Fmeeting.md") return new Promise((resolve) => {
        resolveNote = resolve;
        announceNoteRead?.();
      });
      throw new Error(`Unexpected bundle API request: ${url}`);
    });
    apiMock.mockImplementation((url: string) => {
      if (url === "/api/transcriptions/status") return { ...status, modelState: "ready", canTranscribe: true };
      if (url === "/api/transcriptions?pending=1") return [];
      throw new Error(`Unexpected API request: ${url}`);
    });
    const drafts = {
      createDraft: vi.fn(() => "untitled:new"),
      getDraftContent: vi.fn(() => undefined),
      getDraftDocument: vi.fn(() => undefined),
      updateDraftContent: vi.fn(),
      openDraft: vi.fn(),
    };
    const setMessage = vi.fn();
    const { result, rerender } = renderHook(
      ({ bundleId }: { bundleId: string }) => useTranscription({
        drafts,
        setMessage,
        sourceNoteId: null,
        sourceBundleId: bundleId,
      }),
      { initialProps: { bundleId: "bundle-a" } },
    );
    act(() => { result.current.actions.transcribe({ ...session, draftId: null, sourceBundleId: "bundle-a", state: "recorded" }); });
    await noteReadStarted;
    rerender({ bundleId: "bundle-b" });
    await act(async () => { resolveNote?.({ content: "# Existing filed transcript" }); });
    await waitFor(() => expect(setMessage).toHaveBeenCalledWith("Transcription finished. Switch back to the source workspace to open its Markdown note."));
    expect(drafts.createDraft).not.toHaveBeenCalled();
    expect(drafts.openDraft).not.toHaveBeenCalled();
  });

  it("releases summary controls after the active bundle changes", async () => {
    let resolveOldSummary: ((value: unknown) => void) | undefined;
    let summaryCalls = 0;
    apiMock.mockImplementation((url: string) => {
      if (url === "/api/transcriptions/status") return { ...status, modelState: "ready", canTranscribe: true };
      if (url === "/api/transcriptions?pending=1") return [];
      throw new Error(`Unexpected API request: ${url}`);
    });
    apiForBundleMock.mockImplementation((_: string | null, url: string) => {
      if (url.endsWith("/summarize")) {
        summaryCalls += 1;
        if (summaryCalls === 1) return new Promise((resolve) => { resolveOldSummary = resolve; });
        return Promise.resolve({ result: { summary: "New bundle summary.", transcript: "New bundle transcript." } });
      }
      if (/\/api\/transcriptions\/[^/]+$/.test(url)) return Promise.resolve({ result: {
        summary: "Previous summary.", transcript: "New bundle transcript.",
      } });
      throw new Error(`Unexpected bundle API request: ${url}`);
    });
    const drafts = {
      createDraft: vi.fn(() => "untitled:new"),
      getDraftContent: vi.fn(() => undefined),
      getDraftDocument: vi.fn(() => undefined),
      updateDraftContent: vi.fn(),
      openDraft: vi.fn(),
    };
    const { result, rerender } = renderHook(
      ({ bundleId }: { bundleId: string }) => useTranscription({
        drafts,
        setMessage: vi.fn(),
        sourceNoteId: null,
        sourceBundleId: bundleId,
      }),
      { initialProps: { bundleId: "bundle-a" } },
    );
    const oldSession = { ...session, draftId: null, sourceBundleId: "bundle-a" };
    act(() => { result.current.actions.regenerateSummary(oldSession); });
    await waitFor(() => expect(summaryCalls).toBe(1));
    rerender({ bundleId: "bundle-b" });
    await act(async () => { resolveOldSummary?.({ result: { summary: "Stale summary.", transcript: "New bundle transcript." } }); });
    await waitFor(() => expect(result.current.model.phase).toBe("idle"));

    const newSession = { ...session, id: "22222222-2222-4222-8222-222222222222", draftId: null, sourceBundleId: "bundle-b" };
    act(() => { result.current.actions.regenerateSummary(newSession); });
    await waitFor(() => expect(summaryCalls).toBe(2));
    await waitFor(() => expect(result.current.model.phase).toBe("idle"));
  });

  it("retains saved audio and lets the user cancel an active transcription", () => {
    const dockActions = actions();
    render(<TranscriptionDock model={model({
      phase: "transcribing",
      activeSession: { ...session, state: "transcribing", draftId: null },
      pending: [{ ...session, state: "transcribing", draftId: null }],
      progress: "Transcribing audio locally…",
    })} actions={dockActions} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(dockActions.cancel).toHaveBeenCalledOnce();
  });

  it("exposes summary cancellation while keeping the prior note intact", () => {
    const dockActions = actions();
    render(<TranscriptionDock model={model({
      phase: "summarizing",
      activeSession: session,
      pending: [session],
      progress: "Generating a summary with the selected local text model…",
    })} actions={dockActions} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel summary" }));
    expect(dockActions.cancel).toHaveBeenCalledWith(session);
    expect(screen.getByText(/previous summary kept/i)).toBeInTheDocument();
  });
});
