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
  modelId: "whisper" as const,
  modelName: "Whisper Large v3 Turbo",
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
    expect(mergeTranscriptionDraft({ ...session, sourceNoteId: "notes/open.md" }, {
      summary: "A short summary.",
      transcript: "Hello from the transcript.",
    })).toContain("## Transcript\n\nHello from the transcript.");
    expect(mergeTranscriptionDraft({ ...session, sourceNoteId: "notes/open.md" }, {
      summary: "A short summary.", transcript: "Hello from the transcript.",
    })).not.toContain("Source note:");
  });

  it("supports choosing and dropping local audio and explains missing model setup", () => {
    const dockActions = actions();
    const { container } = render(<TranscriptionDock model={model({ status, pending: [session] })} actions={dockActions} />);
    expect(screen.getByRole("button", { name: "Choose audio" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Start recording" })).toBeEnabled();
    expect(screen.getByText("Whisper Large v3 Turbo is not installed")).toBeInTheDocument();
    expect(screen.getByText(/mlx-community\/whisper-large-v3-turbo/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download Whisper Large v3 Turbo" })).toBeEnabled();
    const file = new File(["local audio"], "meeting.wav", { type: "audio/wav" });
    fireEvent.drop(container.querySelector(".transcription-input-card")!, { dataTransfer: { files: { length: 1, item: () => file } } });
    expect(dockActions.importFile).toHaveBeenCalledWith(file);
    expect(screen.getByText("meeting.wav")).toBeInTheDocument();
    expect(screen.getByText(/Duration unavailable|1:01/)).toBeInTheDocument();
    expect(screen.getByText("Record, choose, or drop an audio file. Audio stays on this device.")).toBeInTheDocument();
    expect(container.querySelectorAll(".transcription-input-card")).toHaveLength(1);
    expect(container.querySelector(".transcription-recorder")).toBeNull();
  });

  it("reports the selected full Whisper variant and download size", () => {
    render(<TranscriptionDock model={model({ status: {
      ...status,
      modelId: "whisperlarge",
      modelName: "Whisper Large v3",
      model: "mlx-community/whisper-large-v3",
      totalBytes: 3_100_000_000,
    } })} actions={actions()} />);
    expect(screen.getByText("Whisper Large v3 is not installed")).toBeInTheDocument();
    expect(screen.getByText(/mlx-community\/whisper-large-v3 \(about 3.1 GB\)/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download Whisper Large v3" })).toBeEnabled();
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
      drafts, setMessage, sourceBundleId: "bundle-a",
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
      drafts, setMessage: vi.fn(), sourceBundleId: "bundle-a",
    }));
    await waitFor(() => expect(result.current.model.pending).toEqual([session]));
    await act(async () => { await result.current.actions.deleteSession(session); });
    expect(result.current.model.pending).toEqual([session]);
    expect(result.current.model.error).toBe("Local storage is unavailable.");
    await act(async () => { await result.current.actions.deleteSession(session); });
    expect(result.current.model.pending).toEqual([]);
    expect(apiForBundleMock).toHaveBeenCalledTimes(2);
  });

  it("records to WAV, retains failed saves for retry, and keeps the starting workspace association", async () => {
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
      association: { sourceBundleId: "bundle-a" },
      onImport: importFile,
    };
    const { result, rerender, unmount } = renderHook((props: typeof options) => useAudioRecorder(props), { initialProps: options });
    await act(async () => { await Promise.all([result.current.start(), result.current.start()]); });
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(result.current.phase).toBe("recording");
    rerender({ ...options, association: { sourceBundleId: "bundle-b" } });
    await act(async () => { result.current.stop(); });
    await waitFor(() => expect(importFile).toHaveBeenCalledTimes(1));
    const firstFile = importFile.mock.calls[0]?.[0] as File;
    expect(firstFile.name).toMatch(/\.wav$/);
    expect(firstFile.type).toBe("audio/wav");
    expect(new TextDecoder().decode(await firstFile.slice(0, 4).arrayBuffer())).toBe("RIFF");
    expect(importFile.mock.calls[0]?.[1]).toEqual({ sourceBundleId: "bundle-a" });
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

  it("uploads audio without associating it with the open note", async () => {
    apiForBundleMock.mockResolvedValueOnce({ session }).mockResolvedValueOnce({ saved: true });
    const drafts = {
      createDraft: vi.fn(() => "untitled:new"),
      getDraftContent: vi.fn(() => undefined),
      getDraftDocument: vi.fn(() => undefined),
      updateDraftContent: vi.fn(),
      openDraft: vi.fn(),
    };
    const { result } = renderHook(() => useTranscription({
      drafts, setMessage: vi.fn(), sourceBundleId: "bundle-a",
    }));
    const file = new File(["local audio"], "meeting.wav", { type: "audio/wav" });
    await act(async () => { await result.current.actions.importFile(file); });
    const createCall = apiForBundleMock.mock.calls[0];
    expect(createCall?.[0]).toBe("bundle-a");
    expect(JSON.parse(createCall?.[2]?.body as string)).toEqual({ fileName: "meeting.wav", durationMs: null, sourceBundleId: "bundle-a" });
    expect(JSON.parse(createCall?.[2]?.body as string)).not.toHaveProperty("sourceNoteId");
  });

  it("stops tracks when the dock navigates away during a pending permission request", async () => {
    let grantAccess: ((stream: MediaStream) => void) | undefined;
    const stoppedTrack = vi.fn();
    const stream = { getTracks: () => [{ stop: stoppedTrack }] } as unknown as MediaStream;
    const getUserMedia = vi.fn(() => new Promise<MediaStream>((resolve) => { grantAccess = resolve }));
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
    vi.stubGlobal("MediaRecorder", class {});
    const { result, unmount } = renderHook(() => useAudioRecorder({
      association: { sourceBundleId: null },
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
      association: { sourceBundleId: null },
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

  it("opens a fresh raw transcript draft after the previous draft was filed", async () => {
    const rawResult = { summary: "Raw summary.", transcript: "Original recording transcript." };
    const contentById = new Map<string, string>();
    const createdIds: string[] = [];
    apiForBundleMock.mockResolvedValue({ session, result: rawResult });
    const drafts = {
      createDraft: vi.fn((content = "") => {
        const id = "untitled:draft-" + (createdIds.length + 1);
        createdIds.push(id);
        contentById.set(id, content);
        return id;
      }),
      getDraftContent: vi.fn((id: string) => contentById.get(id)),
      getDraftDocument: vi.fn(() => undefined),
      isDraftOpen: vi.fn(() => true),
      updateDraftContent: vi.fn(),
      openDraft: vi.fn(),
    };
    const { result } = renderHook(() => useTranscription({
      drafts, setMessage: vi.fn(), sourceBundleId: "bundle-a",
    }));

    await act(async () => { await result.current.actions.openTranscript(session); });
    expect(contentById.get("untitled:draft-1")).toContain("Original recording transcript.");
    act(() => { result.current.draftFiled("untitled:draft-1", "notes/meeting.md", "bundle-a"); });
    await act(async () => { await result.current.actions.openTranscript({ ...session, draftId: "notes/meeting.md" }); });

    expect(createdIds).toEqual(["untitled:draft-1", "untitled:draft-2"]);
    expect(contentById.get("untitled:draft-2")).toContain("Original recording transcript.");
    expect(drafts.openDraft).not.toHaveBeenCalled();
    expect(apiForBundleMock.mock.calls.some(([, , options]) => options?.method === "POST")).toBe(false);
  });

  it("summarizes edited draft text without changing a filed note or the raw session", async () => {
    const raw = { summary: "Original summary.", transcript: "Original transcript." };
    const initialDraft = "# Meeting\n\n## Summary\n\nOriginal summary.\n\n## Transcript\n\nEdited draft transcript.\n";
    const draftsById = new Map<string, string>();
    const openIds = new Set<string>();
    let draftNumber = 0;
    let finishSummary: ((value: unknown) => void) | undefined;
    let announceSummary: (() => void) | undefined;
    const summaryStarted = new Promise<void>((resolve) => { announceSummary = resolve; });
    apiForBundleMock.mockImplementation((_bundleId: string | null, url: string) => {
      if (url.endsWith("/summarize")) {
        return new Promise((resolve) => { finishSummary = resolve; announceSummary?.(); });
      }
      if (/\/api\/transcriptions\/[^/]+$/.test(url)) return Promise.resolve({ session: { ...session, draftId: "notes/meeting.md" }, result: raw });
      throw new Error("Unexpected API request: " + url);
    });
    const drafts = {
      createDraft: vi.fn((content = "") => {
        draftNumber += 1;
        const id = `untitled:active-draft-${draftNumber}`;
        draftsById.set(id, content || initialDraft);
        openIds.add(id);
        return id;
      }),
      getDraftContent: vi.fn((id: string) => draftsById.get(id)),
      getDraftDocument: vi.fn((id: string) => {
        const content = draftsById.get(id);
        return content === undefined ? undefined : { content } as never;
      }),
      isDraftOpen: vi.fn((id: string) => openIds.has(id)),
      updateDraftContent: vi.fn((id: string, content: string) => { draftsById.set(id, content); }),
      openDraft: vi.fn((id: string) => { openIds.add(id); }),
    };
    const { result } = renderHook(() => useTranscription({
      drafts, setMessage: vi.fn(), sourceBundleId: "bundle-a",
    }));

    await act(async () => { await result.current.actions.openTranscript(session); });
    const draftId = "untitled:active-draft-1";
    draftsById.set(draftId, initialDraft);
    act(() => { result.current.actions.regenerateSummary({ ...session, draftId: "notes/meeting.md" }); });
    await summaryStarted;
    result.current.draftFiled(draftId, "notes/meeting.md", "bundle-a");
    openIds.delete(draftId);
    await act(async () => { finishSummary?.({ result: { summary: "Derived summary.", transcript: "Edited draft transcript." } }); });

    expect(draftsById.get(draftId)).toBe(initialDraft);
    expect([...draftsById.entries()].some(([id, content]) => id !== draftId && content.includes("Derived summary."))).toBe(true);
    expect(draftNumber).toBe(2);
    expect(drafts.openDraft).toHaveBeenCalledTimes(1);
    expect(drafts.openDraft).toHaveBeenCalledWith(draftId);
    expect(apiForBundleMock.mock.calls.some(([, , options]) => options?.method === "PATCH")).toBe(false);
  });

  it("keeps an edited draft intact when summary generation fails", async () => {
    const raw = { summary: "Raw summary.", transcript: "Original transcript." };
    const content = new Map<string, string>();
    apiForBundleMock.mockImplementation((_bundleId: string | null, url: string) => {
      if (/\/api\/transcriptions\/[^/]+$/.test(url)) return Promise.resolve({ session, result: raw });
      if (url.endsWith("/summarize")) return Promise.reject(new Error("Local model unavailable."));
      throw new Error("Unexpected API request: " + url);
    });
    const drafts = {
      createDraft: vi.fn((initial = "") => { content.set("untitled:summary-draft", initial); return "untitled:summary-draft"; }),
      getDraftContent: vi.fn((id: string) => content.get(id)),
      getDraftDocument: vi.fn(() => undefined),
      isDraftOpen: vi.fn(() => true),
      updateDraftContent: vi.fn(),
      openDraft: vi.fn(),
    };
    const { result } = renderHook(() => useTranscription({
      drafts, setMessage: vi.fn(), sourceBundleId: "bundle-a",
    }));
    await act(async () => { await result.current.actions.openTranscript(session); });
    const edited = (content.get("untitled:summary-draft") || "").replace("Original transcript.", "Edited draft transcript.");
    content.set("untitled:summary-draft", edited);
    await act(async () => { await result.current.actions.regenerateSummary(session); });
    expect(content.get("untitled:summary-draft")).toBe(edited);
    expect(drafts.updateDraftContent).not.toHaveBeenCalled();
    expect(raw.transcript).toBe("Original transcript.");
    expect(result.current.model.error).toBe("Local model unavailable.");
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

  it("does not open a draft when the bundle changes while raw transcript loads", async () => {
    let resolveSession: ((value: unknown) => void) | undefined;
    let announceLoad: (() => void) | undefined;
    const loadStarted = new Promise<void>((resolve) => { announceLoad = resolve; });
    apiForBundleMock.mockImplementation((_bundleId: string | null, url: string) => {
      if (/\/api\/transcriptions\/[^/]+$/.test(url)) return new Promise((resolve) => {
        resolveSession = resolve;
        announceLoad?.();
      });
      throw new Error("Unexpected bundle API request: " + url);
    });
    apiMock.mockImplementation((url: string) => {
      if (url === "/api/transcriptions/status") return { ...status, modelState: "ready", canTranscribe: true };
      if (url === "/api/transcriptions?pending=1") return [];
      throw new Error("Unexpected API request: " + url);
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
        drafts, setMessage, sourceBundleId: bundleId,
      }),
      { initialProps: { bundleId: "bundle-a" } },
    );
    act(() => { result.current.actions.openTranscript(session); });
    await loadStarted;
    rerender({ bundleId: "bundle-b" });
    await act(async () => { resolveSession?.({ session, result: { summary: "Raw summary", transcript: "Raw transcript" } }); });
    expect(setMessage).toHaveBeenCalledWith("Transcription finished. Switch back to the source workspace to open its Markdown note.");
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
      progress: "Summarizing the editable draft with the selected local text model…",
    })} actions={dockActions} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel summary" }));
    expect(dockActions.cancel).toHaveBeenCalledWith(session);
    expect(screen.getByText(/your draft and original transcript stay unchanged/i)).toBeInTheDocument();
  });
});
