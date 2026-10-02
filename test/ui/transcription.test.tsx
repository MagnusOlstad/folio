import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TranscriptionDock } from "../../src/features/transcription/components/TranscriptionDock.tsx";
import { mergeTranscriptionDraft, type TranscriptionSession } from "../../src/features/transcription/model/types.ts";
import type {
  TranscriptionDockActions,
  TranscriptionDockModel,
} from "../../src/features/transcription/hooks/useTranscription.ts";
import { useTranscription } from "../../src/features/transcription/hooks/useTranscription.ts";
import { useAudioRecorder } from "../../src/features/transcription/hooks/useAudioRecorder.ts";

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
    deletingSessionId: null,
    recording: { phase: "idle", duration: "0:00", error: "", saving: false },
    ...overrides,
  };
}

function actions(): TranscriptionDockActions {
  return {
    importFile: vi.fn(),
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
    discardRecording: vi.fn(),
    retryRecording: vi.fn(),
    installModel: vi.fn(),
    transcribe: vi.fn(),
    cancel: vi.fn(),
    openTranscript: vi.fn(),
    regenerateSummary: vi.fn(),
    deleteSession: vi.fn(async () => undefined),
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
    expect(screen.getByRole("button", { name: "Start recording" })).toBeEnabled();
    expect(screen.getByText(/mlx-community\/whisper-large-v3-turbo/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download model" })).toBeEnabled();
    const file = new File(["local audio"], "meeting.wav", { type: "audio/wav" });
    fireEvent.drop(container.querySelector(".transcription-dropzone")!, { dataTransfer: { files: { length: 1, item: () => file } } });
    expect(dockActions.importFile).toHaveBeenCalledWith(file);
    expect(screen.getByText("meeting.wav")).toBeInTheDocument();
    expect(screen.getByText(/Duration unavailable|1:01/)).toBeInTheDocument();
  });

  it("confirms deletion inline and keeps the opened Markdown note", async () => {
    const dockActions = actions();
    render(<TranscriptionDock model={model({ pending: [session] })} actions={dockActions} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByText(/Delete this local audio, transcript, and summary/)).toBeInTheDocument();
    expect(screen.getByText(/Any opened or saved Markdown note will be kept/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("group", { name: /Confirm deletion/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete recording" }));
    await waitFor(() => expect(dockActions.deleteSession).toHaveBeenCalledWith(session));
  });

  it("does not offer deletion while a session is being processed or the recorder is active", () => {
    const dockActions = actions();
    render(<TranscriptionDock model={model({
      pending: [{ ...session, state: "transcribing" }],
      recording: { phase: "recording", duration: "0:03", error: "", saving: false },
    })} actions={dockActions} />);
    expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
  });

  it("deletes from the session's bundle and ignores a stale refresh result", async () => {
    let resolveSessions: ((value: TranscriptionSession[]) => void) | undefined;
    apiMock.mockImplementation((url: string) => {
      if (url === "/api/transcriptions/status") return status;
      if (url === "/api/transcriptions?pending=1") return new Promise((resolve) => { resolveSessions = resolve; });
      throw new Error(`Unexpected API request: ${url}`);
    });
    apiForBundleMock.mockResolvedValue({ deleted: true });
    const setMessage = vi.fn();
    const drafts = {
      createDraft: vi.fn(() => "untitled:new"),
      getDraftContent: vi.fn(() => undefined),
      getDraftDocument: vi.fn(() => undefined),
      updateDraftContent: vi.fn(),
      openDraft: vi.fn(),
    };
    const { result } = renderHook(() => useTranscription({
      drafts, setMessage, sourceNoteId: null, sourceBundleId: "bundle-a",
    }));
    await waitFor(() => expect(resolveSessions).toBeDefined());
    await act(async () => { await result.current.actions.deleteSession(session); });
    expect(apiForBundleMock).toHaveBeenCalledWith("bundle-a", `/api/transcriptions/${session.id}`, { method: "DELETE" });
    await act(async () => { resolveSessions?.([session]); });
    expect(result.current.model.pending).toEqual([]);
    expect(setMessage).toHaveBeenCalledWith(expect.stringContaining("Markdown note you opened or saved was kept"));
  });

  it("keeps a session after DELETE fails and permits a retry", async () => {
    apiMock.mockImplementation((url: string) => {
      if (url === "/api/transcriptions/status") return status;
      if (url === "/api/transcriptions?pending=1") return [session];
      throw new Error(`Unexpected API request: ${url}`);
    });
    apiForBundleMock.mockRejectedValueOnce(new Error("Local storage is unavailable."))
      .mockResolvedValueOnce({ deleted: true });
    const drafts = {
      createDraft: vi.fn(() => "untitled:new"),
      getDraftContent: vi.fn(() => undefined),
      getDraftDocument: vi.fn(() => undefined),
      updateDraftContent: vi.fn(),
      openDraft: vi.fn(),
    };
    const { result } = renderHook(() => useTranscription({
      drafts, setMessage: vi.fn(), sourceNoteId: null, sourceBundleId: "bundle-a",
    }));
    await waitFor(() => expect(result.current.model.pending).toEqual([session]));
    await act(async () => { await result.current.actions.deleteSession(session); });
    expect(result.current.model.pending).toEqual([session]);
    expect(result.current.model.error).toBe("Local storage is unavailable.");
    await act(async () => { await result.current.actions.deleteSession(session); });
    expect(result.current.model.pending).toEqual([]);
    expect(apiForBundleMock).toHaveBeenCalledTimes(2);
  });

  it("records to WAV, retains failed saves for retry, and keeps the starting note association", async () => {
    const stoppedTracks = vi.fn();
    const stream = { getTracks: () => [{ stop: stoppedTracks }] };
    const getUserMedia = vi.fn(async () => stream);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });
    class MockMediaRecorder extends EventTarget {
      state = "inactive";
      mimeType = "audio/webm";
      start() { this.state = "recording"; }
      stop() {
        this.state = "inactive";
        const data = new Event("dataavailable") as Event & { data: Blob };
        Object.defineProperty(data, "data", { value: new Blob(["recorded"]) });
        this.dispatchEvent(data);
        this.dispatchEvent(new Event("stop"));
      }
    }
    vi.stubGlobal("MediaRecorder", MockMediaRecorder);
    class MockAudioContext {
      decodeAudioData = vi.fn(async () => ({
        numberOfChannels: 1,
        length: 2,
        sampleRate: 16_000,
        getChannelData: () => new Float32Array([-0.5, 0.5]),
      } as unknown as AudioBuffer));
      close = vi.fn(async () => undefined);
    }
    vi.stubGlobal("AudioContext", MockAudioContext);
    const importFile = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const options = {
      association: { sourceNoteId: "notes/source.md", sourceBundleId: "bundle-a" },
      onImport: importFile,
    };
    const { result, rerender, unmount } = renderHook((props: typeof options) => useAudioRecorder(props), { initialProps: options });
    await act(async () => { await Promise.all([result.current.start(), result.current.start()]); });
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(result.current.phase).toBe("recording");
    rerender({ ...options, association: { sourceNoteId: "notes/other.md", sourceBundleId: "bundle-b" } });
    await act(async () => { result.current.stop(); });
    await waitFor(() => expect(importFile).toHaveBeenCalledTimes(1));
    const firstFile = importFile.mock.calls[0]?.[0] as File;
    expect(firstFile.name).toMatch(/\.wav$/);
    expect(firstFile.type).toBe("audio/wav");
    expect(new TextDecoder().decode(await firstFile.slice(0, 4).arrayBuffer())).toBe("RIFF");
    expect(importFile.mock.calls[0]?.[1]).toEqual({ sourceNoteId: "notes/source.md", sourceBundleId: "bundle-a" });
    expect(result.current.phase).toBe("ready");
    await act(async () => { await result.current.retry(); });
    expect(importFile).toHaveBeenCalledTimes(2);
    expect(importFile.mock.calls[1]?.[0]).toBe(firstFile);
    expect(stoppedTracks).toHaveBeenCalledTimes(1);
    expect(result.current.phase).toBe("idle");
    await act(async () => { await result.current.start(); });
    unmount();
    await waitFor(() => expect(importFile).toHaveBeenCalledTimes(3));
    expect(stoppedTracks).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it("stops tracks when the dock navigates away during a pending permission request", async () => {
    let grantAccess: ((stream: MediaStream) => void) | undefined;
    const stoppedTrack = vi.fn();
    const stream = { getTracks: () => [{ stop: stoppedTrack }] } as unknown as MediaStream;
    const getUserMedia = vi.fn(() => new Promise<MediaStream>((resolve) => { grantAccess = resolve }));
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
    vi.stubGlobal("MediaRecorder", class {});
    const { result, unmount } = renderHook(() => useAudioRecorder({
      association: { sourceNoteId: null, sourceBundleId: null },
      onImport: vi.fn().mockResolvedValue(true),
    }));
    let starting!: Promise<void>;
    act(() => { starting = result.current.start(); });
    expect(result.current.phase).toBe("requesting");
    act(() => { result.current.stop(); });
    await act(async () => {
      grantAccess?.(stream);
      await starting;
    });
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(stoppedTrack).toHaveBeenCalledTimes(1);
    expect(result.current.phase).toBe("idle");
    unmount();
    vi.unstubAllGlobals();
  });

  it("locks a retained recording while retry conversion is pending", async () => {
    const stream = { getTracks: () => [{ stop: vi.fn() }] };
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => stream) },
    });
    class MockMediaRecorder extends EventTarget {
      state = "inactive";
      mimeType = "audio/webm";
      start() { this.state = "recording"; }
      stop() {
        this.state = "inactive";
        const data = new Event("dataavailable") as Event & { data: Blob };
        Object.defineProperty(data, "data", { value: new Blob(["recorded"]) });
        this.dispatchEvent(data);
        this.dispatchEvent(new Event("stop"));
      }
    }
    vi.stubGlobal("MediaRecorder", MockMediaRecorder);
    const audio = {
      numberOfChannels: 1,
      length: 1,
      sampleRate: 16_000,
      getChannelData: () => new Float32Array([0.25]),
    } as unknown as AudioBuffer;
    let resolveDecode: ((buffer: AudioBuffer) => void) | undefined;
    let decodeCount = 0;
    class MockAudioContext {
      decodeAudioData = vi.fn(() => {
        decodeCount += 1;
        if (decodeCount === 1) return Promise.reject(new Error("decoder failed once"));
        return new Promise<AudioBuffer>((resolve) => { resolveDecode = resolve; });
      });
      close = vi.fn(async () => undefined);
    }
    vi.stubGlobal("AudioContext", MockAudioContext);
    const onImport = vi.fn().mockResolvedValue(true);
    const { result, unmount } = renderHook(() => useAudioRecorder({
      association: { sourceNoteId: null, sourceBundleId: null },
      onImport,
    }));
    await act(async () => { await result.current.start(); });
    await act(async () => { result.current.stop(); });
    await waitFor(() => expect(result.current.phase).toBe("ready"));

    let retrying!: Promise<void>;
    act(() => { retrying = result.current.retry(); });
    expect(result.current.phase).toBe("processing");
    act(() => {
      result.current.discard();
      void result.current.start();
    });
    expect(result.current.phase).toBe("processing");
    expect(onImport).not.toHaveBeenCalled();
    await waitFor(() => expect(resolveDecode).toBeDefined());
    await act(async () => {
      resolveDecode?.(audio);
      await retrying;
    });
    expect(onImport).toHaveBeenCalledTimes(1);
    expect(result.current.phase).toBe("idle");
    unmount();
    vi.unstubAllGlobals();
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
