import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecorderPanel } from "../../src/features/transcription/components/RecorderPanel.tsx";
import { TranscriptionDock } from "../../src/features/transcription/components/TranscriptionDock.tsx";
import { useAudioRecorder } from "../../src/features/transcription/hooks/useAudioRecorder.ts";
import type { TranscriptionDockActions, TranscriptionDockModel } from "../../src/features/transcription/hooks/useTranscription.ts";
import { openCapture, SystemAudioUnavailableError } from "../../src/features/transcription/model/capture-streams.ts";
import { INITIAL_SILENCE, meterLevel, nextSilence, rmsOf, SILENCE_WARNING_MS } from "../../src/features/transcription/model/level-meter.ts";
import { encodeAudioBufferAsWav } from "../../src/features/transcription/model/recording.ts";
import { loadRecordingSource, parseRecordingSource, RECORDING_SOURCE_KEY } from "../../src/features/transcription/model/recording-source.ts";

vi.mock("../../src/lib/api.ts", () => ({ api: vi.fn(), apiForBundle: vi.fn() }));

type FakeTrack = {
  kind: string;
  readyState: string;
  stop: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
  end: () => void;
};

function fakeStream(kinds: string[], readyState = "live") {
  let tracks: FakeTrack[] = kinds.map((kind) => {
    const listeners: Array<() => void> = [];
    const track: FakeTrack = {
      kind,
      readyState,
      stop: vi.fn(),
      addEventListener: vi.fn((_type: string, listener: () => void) => { listeners.push(listener); }),
      end: () => { track.readyState = "ended"; listeners.forEach((listener) => listener()); },
    };
    return track;
  });
  const stream = {
    getTracks: () => [...tracks],
    getAudioTracks: () => tracks.filter((track) => track.kind === "audio"),
    getVideoTracks: () => tracks.filter((track) => track.kind === "video"),
    removeTrack: vi.fn((track: FakeTrack) => { tracks = tracks.filter((item) => item !== track); }),
  };
  return { stream: stream as unknown as MediaStream, raw: stream, all: [...tracks] };
}

function setFolio(value: Window["folio"]) {
  Object.defineProperty(window, "folio", { configurable: true, writable: true, value });
}

const desktop = { systemAudio: { supported: true } };

beforeEach(() => { localStorage.clear(); setFolio(undefined); });
afterEach(() => { vi.unstubAllGlobals(); setFolio(undefined); });

describe("recording source preference", () => {
  it("validates values and only honours system sources on supported desktops", () => {
    expect(parseRecordingSource("system")).toBe("system");
    expect(parseRecordingSource("bogus")).toBeNull();
    expect(parseRecordingSource(null)).toBeNull();
    localStorage.setItem(RECORDING_SOURCE_KEY, "system");
    expect(loadRecordingSource()).toBe("microphone");
    setFolio(desktop);
    expect(loadRecordingSource()).toBe("system");
    localStorage.setItem(RECORDING_SOURCE_KEY, "junk");
    expect(loadRecordingSource()).toBe("mixed");
    localStorage.removeItem(RECORDING_SOURCE_KEY);
    expect(loadRecordingSource()).toBe("mixed");
  });
});

describe("silence detection", () => {
  it("flags a source only after eight quiet seconds and resets on sound", () => {
    expect(rmsOf(new Float32Array([0.5, -0.5]))).toBeCloseTo(0.5);
    expect(rmsOf([])).toBe(0);
    let state = nextSilence(INITIAL_SILENCE, 0, 1_000);
    expect(state.silent).toBe(false);
    state = nextSilence(state, 0.0005, 1_000 + SILENCE_WARNING_MS - 1);
    expect(state.silent).toBe(false);
    state = nextSilence(state, 0, 1_000 + SILENCE_WARNING_MS);
    expect(state.silent).toBe(true);
    expect(nextSilence(state, 0.1, 20_000)).toEqual(INITIAL_SILENCE);
    expect(meterLevel(0)).toBe(0);
    expect(meterLevel(1)).toBe(1);
  });
});

describe("capture streams", () => {
  it("opens the microphone alone with plain audio constraints", async () => {
    const mic = fakeStream(["audio"]);
    const getUserMedia = vi.fn(async () => mic.stream);
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
    const capture = await openCapture("microphone");
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    capture.close();
    expect(mic.all[0]?.stop).toHaveBeenCalled();
  });

  it("drops the video track of the system capture and rejects streams without audio", async () => {
    const withAudio = fakeStream(["video", "audio"]);
    const getDisplayMedia = vi.fn(async () => withAudio.stream);
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getDisplayMedia } });
    const capture = await openCapture("system");
    expect(getDisplayMedia).toHaveBeenCalledWith({ video: true, audio: true });
    expect(withAudio.all[0]?.stop).toHaveBeenCalled();
    expect(capture.stream.getVideoTracks()).toHaveLength(0);
    expect(capture.stream.getAudioTracks()).toHaveLength(1);

    const silent = fakeStream(["video"]);
    getDisplayMedia.mockResolvedValueOnce(silent.stream);
    await expect(openCapture("system")).rejects.toBeInstanceOf(SystemAudioUnavailableError);
    expect(silent.all[0]?.stop).toHaveBeenCalled();
    getDisplayMedia.mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"));
    await expect(openCapture("system")).rejects.toThrow(/Screen & System Audio Recording/);
  });

  it("treats a system capture whose audio tracks are all ended as unavailable", async () => {
    const ended = fakeStream(["video", "audio"], "ended");
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getDisplayMedia: vi.fn(async () => ended.stream) },
    });
    await expect(openCapture("system")).rejects.toBeInstanceOf(SystemAudioUnavailableError);
    expect(ended.all.every((track) => track.stop.mock.calls.length > 0)).toBe(true);
  });

  it("mixes microphone and system audio into one stream and cleans everything up", async () => {
    const mic = fakeStream(["audio"]);
    const system = fakeStream(["video", "audio"]);
    const getUserMedia = vi.fn(async () => mic.stream);
    const mixed = fakeStream(["audio"]);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia, getDisplayMedia: vi.fn(async () => system.stream) },
    });
    const connect = vi.fn();
    const close = vi.fn(async () => undefined);
    const sources: MediaStream[] = [];
    vi.stubGlobal("AudioContext", class {
      constructor(public options: unknown) { contextOptions.push(options); }
      resume = vi.fn(async () => undefined);
      close = close;
      createMediaStreamDestination = () => ({ stream: mixed.stream, channelCount: 2 });
      createMediaStreamSource = (stream: MediaStream) => { sources.push(stream); return { connect }; };
    });
    const contextOptions: unknown[] = [];
    const capture = await openCapture("mixed");
    expect(getUserMedia).toHaveBeenCalledWith({ audio: { echoCancellation: true, noiseSuppression: true } });
    expect(capture.stream).toBe(mixed.stream);
    expect(sources).toEqual([mic.stream, system.stream]);
    expect(connect).toHaveBeenCalledTimes(2);
    capture.close();
    capture.close();
    expect(mic.all[0]?.stop).toHaveBeenCalled();
    expect(system.all[1]?.stop).toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("releases the microphone when system audio is unavailable in mixed mode", async () => {
    const mic = fakeStream(["audio"]);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => mic.stream), getDisplayMedia: vi.fn(async () => fakeStream(["video"]).stream) },
    });
    await expect(openCapture("mixed")).rejects.toBeInstanceOf(SystemAudioUnavailableError);
    expect(mic.all[0]?.stop).toHaveBeenCalled();
  });
});

describe("mono 16 kHz WAV encoding", () => {
  it("downmixes channels to mono and writes 16 kHz header fields", async () => {
    const left = new Float32Array([1, 0.5]);
    const right = new Float32Array([-1, 0.5]);
    const audio = { numberOfChannels: 2, length: 2, sampleRate: 16_000, getChannelData: (channel: number) => channel === 0 ? left : right } as unknown as AudioBuffer;
    const view = new DataView(await encodeAudioBufferAsWav(audio).arrayBuffer());
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint32(28, true)).toBe(32_000);
    expect(view.getUint16(32, true)).toBe(2);
    expect(view.getUint32(40, true)).toBe(4);
    expect(view.getInt16(44, true)).toBe(0);
    expect(view.getInt16(46, true)).toBeGreaterThan(16_000);
  });

  it("refuses recordings over the 500 MB cap", () => {
    const huge = { numberOfChannels: 1, length: 260 * 1024 * 1024, sampleRate: 16_000, getChannelData: () => new Float32Array(0) } as unknown as AudioBuffer;
    expect(() => encodeAudioBufferAsWav(huge)).toThrow(/500 MB/);
  });
});

function recordingModel(overrides: Partial<TranscriptionDockModel["recording"]> = {}): TranscriptionDockModel["recording"] {
  return {
    phase: "idle", duration: "0:00", error: "", saving: false, source: "mixed", systemAudioSupported: true,
    systemAudioBlocked: false, levels: { mic: 0.3, system: 0.6 }, silent: { mic: false, system: false }, ...overrides,
  };
}

function dockActions(): TranscriptionDockActions {
  const cache = new Map<string | symbol, ReturnType<typeof vi.fn>>();
  return new Proxy({}, {
    get: (_target, key) => {
      if (!cache.has(key)) cache.set(key, vi.fn());
      return cache.get(key);
    },
  }) as unknown as TranscriptionDockActions;
}

function dockModel(recording: TranscriptionDockModel["recording"]): TranscriptionDockModel {
  return {
    phase: "idle", activeSession: null, pending: [], status: null, progress: "", error: "",
    deletingSessionId: null, recording, speakerNamesFor: () => null, audioUrlFor: () => "",
  };
}

describe("recorder UI", () => {
  it("offers the source control only when system audio is supported", () => {
    const actions = dockActions();
    const { rerender } = render(<TranscriptionDock model={dockModel(recordingModel({ systemAudioSupported: false, source: "microphone" }))} actions={actions} />);
    expect(screen.queryByRole("combobox", { name: /Record/ })).toBeNull();
    rerender(<TranscriptionDock model={dockModel(recordingModel())} actions={actions} />);
    const select = screen.getByRole("combobox", { name: /Record/ });
    expect(select).toHaveValue("mixed");
    fireEvent.change(select, { target: { value: "system" } });
    expect(actions.setRecordingSource).toHaveBeenCalledWith("system");
  });

  it("shows per-source meters, the headphones hint and silence warnings while recording", () => {
    render(<RecorderPanel recorder={recordingModel({ phase: "recording", duration: "0:12", silent: { mic: false, system: true } })} actions={dockActions()} busy={false} />);
    expect(screen.getByText("Recording microphone and system audio")).toBeInTheDocument();
    expect(screen.getByRole("meter", { name: "Mic level" })).toHaveAttribute("aria-valuenow", "0.3");
    expect(screen.getByRole("meter", { name: "System level" })).toBeInTheDocument();
    expect(screen.getByText("Use headphones so the meeting isn't recorded twice.")).toBeInTheDocument();
    expect(screen.getByText(/No system audio yet/)).toBeInTheDocument();
  });

  it("explains blocked system audio and opens System Settings", () => {
    const openSystemAudioSettings = vi.fn(async () => undefined);
    setFolio({ ...desktop, openSystemAudioSettings });
    render(<RecorderPanel recorder={recordingModel({ error: "System audio isn't available.", systemAudioBlocked: true })} actions={dockActions()} busy={false} />);
    expect(screen.getByRole("alert")).toHaveTextContent("System audio isn't available.");
    fireEvent.click(screen.getByRole("button", { name: "Open System Settings" }));
    expect(openSystemAudioSettings).toHaveBeenCalledTimes(1);
  });

  it("hides the settings button outside the desktop app", () => {
    render(<RecorderPanel recorder={recordingModel({ error: "System audio isn't available.", systemAudioBlocked: true })} actions={dockActions()} busy={false} />);
    expect(screen.queryByRole("button", { name: "Open System Settings" })).toBeNull();
  });
});

describe("useAudioRecorder with system audio", () => {
  it("remembers the chosen source and surfaces the blocked-permission error", async () => {
    setFolio(desktop);
    vi.stubGlobal("MediaRecorder", class {});
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getDisplayMedia: vi.fn(async () => fakeStream(["video"]).stream) },
    });
    const { result } = renderHook(() => useAudioRecorder({ association: { sourceBundleId: null }, onImport: vi.fn() }));
    expect(result.current.source).toBe("mixed");
    act(() => { result.current.setSource("system"); });
    expect(localStorage.getItem(RECORDING_SOURCE_KEY)).toBe("system");
    await act(async () => { await result.current.start(); });
    await waitFor(() => expect(result.current.error).toMatch(/Screen & System Audio Recording/));
    expect(result.current.systemAudioBlocked).toBe(true);
    expect(result.current.phase).toBe("idle");
  });

  it("keeps recording with a warning when the microphone drops in mixed mode", async () => {
    setFolio(desktop);
    const mic = fakeStream(["audio"]);
    const system = fakeStream(["video", "audio"]);
    const mixed = fakeStream(["audio"]);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => mic.stream), getDisplayMedia: vi.fn(async () => system.stream) },
    });
    vi.stubGlobal("AudioContext", class {
      resume = vi.fn(async () => undefined);
      close = vi.fn(async () => undefined);
      createMediaStreamDestination = () => ({ stream: mixed.stream, channelCount: 2 });
      createMediaStreamSource = () => ({ connect: vi.fn() });
    });
    const recorders: Array<{ state: string; stop: ReturnType<typeof vi.fn> }> = [];
    vi.stubGlobal("MediaRecorder", class {
      state = "inactive";
      stop = vi.fn(() => { this.state = "inactive"; });
      addEventListener = vi.fn();
      start = vi.fn(() => { this.state = "recording"; });
      constructor() { recorders.push(this); }
    });
    const { result } = renderHook(() => useAudioRecorder({ association: { sourceBundleId: null }, onImport: vi.fn() }));
    await act(async () => { await result.current.start(); });
    expect(result.current.phase).toBe("recording");
    act(() => { mic.all[0]?.end(); });
    expect(result.current.error).toBe("Microphone disconnected. Recording continues with meeting audio only.");
    expect(result.current.phase).toBe("recording");
    expect(recorders[0]?.stop).not.toHaveBeenCalled();
  });
});
