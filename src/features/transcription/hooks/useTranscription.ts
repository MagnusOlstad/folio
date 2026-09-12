import { useEffect, useRef, useState } from "react";
import type { ViewerDocument } from "../../../domain/types.ts";
import { api } from "../../../lib/api.ts";
import {
  isTranscriptionBusyState,
  mergeTranscriptionDraft,
  normalizeBeginResult,
  type TranscriptionBridge,
  type TranscriptionDraftAdapter,
  type TranscriptionPhase,
  type TranscriptionProcessResponse,
  type TranscriptionSession,
  type TranscriptionStatus,
} from "../model/types.ts";

export type TranscriptionDockModel = {
  phase: TranscriptionPhase;
  elapsedMs: number;
  activeSession: TranscriptionSession | null;
  pending: TranscriptionSession[];
  systemAudio: boolean;
  fallbackMessage: string;
  bridgeAvailable: boolean;
  status: TranscriptionStatus | null;
  error: string;
};

export type TranscriptionDockActions = {
  start: () => void;
  stop: () => void;
  transcribe: () => void;
  transcribePending: (session: TranscriptionSession) => void;
  later: () => void;
  retry: () => void;
  revealModelFolder: () => void;
};

type Options = {
  drafts: TranscriptionDraftAdapter;
  setMessage: (message: string) => void;
};

type CaptureResources = {
  context: AudioContext;
  processor: ScriptProcessorNode;
  streams: MediaStream[];
  sources: MediaStreamAudioSourceNode[];
  tracks: MediaStreamTrack[];
};

const TARGET_SAMPLE_RATE = 16_000;
function bridge(): TranscriptionBridge | undefined {
  return window.folio;
}

function isSession(value: unknown): value is TranscriptionSession {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.state === "string" &&
    (typeof candidate.draftId === "string" || candidate.draftId === null) &&
    (typeof candidate.durationMs === "number" || candidate.durationMs === null) &&
    (candidate.systemAudio === "captured" || candidate.systemAudio === "unavailable")
  );
}

function sessionsFromResponse(value: unknown): TranscriptionSession[] {
  if (Array.isArray(value)) return value.filter(isSession);
  if (!value || typeof value !== "object") return [];
  const sessions = (value as { sessions?: unknown }).sessions;
  return Array.isArray(sessions) ? sessions.filter(isSession) : [];
}

function pcm16Chunk(input: Float32Array, sampleRate: number) {
  const ratio = sampleRate / TARGET_SAMPLE_RATE;
  const outputLength = Math.max(1, Math.floor(input.length / ratio));
  const output = new ArrayBuffer(outputLength * 2);
  const view = new DataView(output);
  for (let index = 0; index < outputLength; index += 1) {
    const sourceIndex = Math.min(input.length - 1, Math.floor(index * ratio));
    const sample = Math.max(-1, Math.min(1, input[sourceIndex] ?? 0));
    view.setInt16(index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return output;
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function fallbackDraft(id: string, content: string): ViewerDocument {
  const createdAt = new Date().toISOString();
  return {
    id,
    title: "Untitled",
    type: "Local draft",
    description: "",
    tags: [],
    createdAt,
    content,
    deletable: true,
    movable: false,
    status: "draft",
    staleAfter: null,
    stale: false,
    filedBy: null,
    filedAt: null,
    links: [],
    backlinks: [],
    suggestions: [],
    updatedAt: createdAt,
  };
}

export function useTranscription({ drafts, setMessage }: Options) {
  const [phase, setPhase] = useState<TranscriptionPhase>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [activeSession, setActiveSession] = useState<TranscriptionSession | null>(null);
  const [pending, setPending] = useState<TranscriptionSession[]>([]);
  const [systemAudio, setSystemAudio] = useState(false);
  const [fallbackMessage, setFallbackMessage] = useState("");
  const [status, setStatus] = useState<TranscriptionStatus | null>(null);
  const [error, setError] = useState("");
  const phaseRef = useRef<TranscriptionPhase>("idle");
  const stoppingRef = useRef(false);
  const systemAudioRef = useRef(false);
  const resourcesRef = useRef<CaptureResources | null>(null);
  const recordingIdRef = useRef<string | null>(null);
  const activeDraftIdRef = useRef<string | null>(null);
  const startedAtRef = useRef(0);
  const chunkWriteQueueRef = useRef(Promise.resolve());
  const pendingProcessRef = useRef<TranscriptionSession | null>(null);

  function changePhase(next: TranscriptionPhase) {
    phaseRef.current = next;
    setPhase(next);
  }

  const loadPending = async () => {
    try {
      const [statusResult, pendingResult] = await Promise.all([
        api<TranscriptionStatus>("/api/transcriptions/status"),
        api<unknown>("/api/transcriptions?pending=1"),
      ]);
      setStatus(statusResult);
      setPending(sessionsFromResponse(pendingResult));
    } catch {
      // Transcriptions are optional. Keep the dock useful while the API starts.
    }
  };

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void loadPending(), 0);
    const interval = window.setInterval(() => void loadPending(), 10_000);
    return () => {
      window.clearTimeout(initialLoad);
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (phase !== "recording") return;
    const interval = window.setInterval(() => {
      setElapsedMs(Math.max(0, Date.now() - startedAtRef.current));
    }, 250);
    return () => window.clearInterval(interval);
  }, [phase]);

  function cleanupCapture() {
    const resources = resourcesRef.current;
    resourcesRef.current = null;
    if (!resources) return;
    resources.processor.disconnect();
    resources.sources.forEach((source) => source.disconnect());
    resources.tracks.forEach((track) => track.stop());
    void resources.context.close();
  }

  function queueChunk(chunk: ArrayBuffer) {
    const id = recordingIdRef.current;
    const writer = bridge()?.writeTranscriptionChunk;
    if (!id || !writer) return;
    const previous = chunkWriteQueueRef.current.catch(() => undefined);
    chunkWriteQueueRef.current = previous.then(() => writer(id, chunk));
  }

  async function createCapture(): Promise<{ resources: CaptureResources; system: boolean; warning: string }> {
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.getUserMedia || !mediaDevices.getDisplayMedia)
      throw new Error("This browser cannot capture audio. Use the Folio desktop app.");

    let mic: MediaStream | null = null;
    let system: MediaStream | null = null;
    let micError = "";
    let systemError = "";
    try {
      const permission = await bridge()?.requestMicrophoneAccess?.();
      if (permission === false) throw new Error("Microphone permission was denied.");
      mic = await mediaDevices.getUserMedia({ audio: true });
    } catch (captureError) {
      micError = errorMessage(captureError, "Microphone capture failed.");
    }
    try {
      const loopback = await bridge()?.enableTranscriptionLoopback?.();
      if (loopback === false) throw new Error("System audio loopback is unavailable.");
      system = await mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });
      if (!system.getAudioTracks().length) {
        system.getTracks().forEach((track) => track.stop());
        system = null;
        systemError = "System audio was not shared.";
      } else {
        system.getVideoTracks().forEach((track) => track.stop());
        system = new MediaStream(system.getAudioTracks());
      }
    } catch (captureError) {
      systemError = errorMessage(captureError, "System audio capture was unavailable.");
    }
    if (!mic) {
      system?.getTracks().forEach((track) => track.stop());
      throw new Error(micError || "Microphone capture failed.");
    }

    const streams = [mic, system].filter((stream): stream is MediaStream => Boolean(stream));
    let context: AudioContext | null = null;
    const sources: MediaStreamAudioSourceNode[] = [];
    try {
      context = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
      const compressor = context.createDynamicsCompressor();
      const processor = context.createScriptProcessor(4096, 1, 1);
      const silent = context.createGain();
      silent.gain.value = 0;
      compressor.connect(processor);
      processor.connect(silent);
      silent.connect(context.destination);
      streams.forEach((stream) => {
        const source = context!.createMediaStreamSource(stream);
        source.connect(compressor);
        sources.push(source);
      });
      processor.onaudioprocess = (event) => {
        queueChunk(pcm16Chunk(event.inputBuffer.getChannelData(0), context!.sampleRate));
      };
      await context.resume();
      const tracks = streams.flatMap((stream) => stream.getTracks());
      const systemTracks = system?.getAudioTracks() ?? [];
      const microphoneTracks = mic.getAudioTracks();
      microphoneTracks.forEach((track) => {
        track.addEventListener("ended", () => {
          setFallbackMessage("Microphone ended; recording stopped.");
          void stopRecording();
        });
      });
      systemTracks.forEach((track) => {
        track.addEventListener("ended", () => {
          systemAudioRef.current = false;
          setSystemAudio(false);
          setFallbackMessage("System audio ended; continuing with microphone only.");
          if (!mic?.getAudioTracks().some((candidate) => candidate.readyState === "live"))
            void stopRecording();
        });
      });
      const warning = systemError || "";
      return { resources: { context: context!, processor, streams, sources, tracks }, system: Boolean(system), warning };
    } catch (captureError) {
      sources.forEach((source) => source.disconnect());
      streams.flatMap((stream) => stream.getTracks()).forEach((track) => track.stop());
      if (context) void context.close();
      throw captureError;
    }
  }

  async function start() {
    if (phaseRef.current === "recording" || phaseRef.current === "processing") return;
    setError("");
    setFallbackMessage("");
    const currentBridge = bridge();
    if (!currentBridge?.beginTranscriptionRecording || !currentBridge.writeTranscriptionChunk) {
      setError("Transcription recording is available in the Folio desktop app only.");
      changePhase("error");
      return;
    }
    const draftId = drafts.createDraft();
    activeDraftIdRef.current = draftId;
    drafts.openDraft(draftId);
    try {
      const capture = await createCapture();
      resourcesRef.current = capture.resources;
      const result = await currentBridge.beginTranscriptionRecording({
        draftId,
        systemAudio: capture.system,
      });
      const recordingId = normalizeBeginResult(result);
      if (!recordingId) throw new Error("The desktop recorder did not return a session id.");
      recordingIdRef.current = recordingId;
      chunkWriteQueueRef.current = Promise.resolve();
      startedAtRef.current = Date.now();
      setElapsedMs(0);
      setSystemAudio(capture.system);
      systemAudioRef.current = capture.system;
      setFallbackMessage(capture.warning);
      const nextSession: TranscriptionSession = {
        id: recordingId,
        state: "recording",
        draftId,
        durationMs: 0,
        systemAudio: capture.system ? "captured" : "unavailable",
        error: null,
      };
      setActiveSession(nextSession);
      changePhase("recording");
    } catch (captureError) {
      try {
        await currentBridge.disableTranscriptionLoopback?.();
      } catch {
        // Best-effort cleanup when loopback setup or recorder IPC fails.
      }
      cleanupCapture();
      activeDraftIdRef.current = null;
      setError(errorMessage(captureError, "Could not start transcription recording."));
      changePhase("error");
    }
  }

  async function stopRecording() {
    const id = recordingIdRef.current;
    if (!id || phaseRef.current !== "recording" || stoppingRef.current) return;
    stoppingRef.current = true;
    const durationMs = Math.max(0, Date.now() - startedAtRef.current);
    const capturedSystemAudio = systemAudioRef.current;
    cleanupCapture();
    recordingIdRef.current = null;
    try {
      await chunkWriteQueueRef.current.catch(() => undefined);
      await bridge()?.disableTranscriptionLoopback?.();
    } catch {
      // The recorded session remains recoverable even if loopback cleanup fails.
    }
    let stopped: TranscriptionSession | null = null;
    try {
      stopped = (await bridge()?.stopTranscriptionRecording?.(id)) ?? null;
    } catch (stopError) {
      setError(errorMessage(stopError, "Could not stop transcription recording."));
      stoppingRef.current = false;
      changePhase("error");
      return;
    }
    const nextSession: TranscriptionSession = {
      id,
      state: "recorded",
      draftId: stopped?.draftId ?? activeDraftIdRef.current,
      durationMs: stopped?.durationMs ?? durationMs,
      systemAudio: stopped?.systemAudio ?? (capturedSystemAudio ? "captured" : "unavailable"),
      error: stopped?.error ?? null,
      createdAt: stopped?.createdAt,
      updatedAt: stopped?.updatedAt,
    };
    setActiveSession(nextSession);
    setElapsedMs(nextSession.durationMs ?? durationMs);
    stoppingRef.current = false;
    changePhase("stopped");
    void loadPending();
  }

  async function abort() {
    stoppingRef.current = true;
    phaseRef.current = "idle";
    const id = recordingIdRef.current;
    cleanupCapture();
    recordingIdRef.current = null;
    if (id) {
      try {
        await bridge()?.abortTranscriptionRecording?.(id);
      } catch {
        // Best effort on unmount or an abandoned recording.
      }
    }
    activeDraftIdRef.current = null;
    setActiveSession(null);
    stoppingRef.current = false;
    changePhase("idle");
  }

  async function processSession(session: TranscriptionSession) {
    if (phaseRef.current === "recording" || phaseRef.current === "processing") return;
    pendingProcessRef.current = session;
    setError("");
    changePhase("processing");
    setActiveSession({ ...session, state: "transcribing" });
    try {
      const response = await api<TranscriptionProcessResponse>(
        `/api/transcriptions/${encodeURIComponent(session.id)}/process`,
        { method: "POST" },
      );
      const draftId = session.draftId && drafts.getDraftContent(session.draftId) !== undefined
        ? session.draftId
        : drafts.createDraft();
      activeDraftIdRef.current = draftId;
      setActiveSession((current) => current ? { ...current, draftId } : current);
      drafts.openDraft(draftId);
      const content = mergeTranscriptionDraft(drafts.getDraftContent(draftId), response.result);
      drafts.updateDraftContent(draftId, content);
      const document = drafts.getDraftDocument(draftId) ?? fallbackDraft(draftId, content);
      drafts.fileDraft(document, content);
      await api(`/api/transcriptions/${encodeURIComponent(session.id)}/delivered`, {
        method: "POST",
      });
      setActiveSession(null);
      changePhase("idle");
      activeDraftIdRef.current = null;
      pendingProcessRef.current = null;
      setMessage("Transcription is ready for filing review.");
      await loadPending();
    } catch (processError) {
      const message = errorMessage(processError, "Could not transcribe recording.");
      setError(message);
      setActiveSession({ ...session, state: "failed", error: message });
      changePhase("error");
      await loadPending();
    }
  }

  function later() {
    if (phase !== "stopped") return;
    setActiveSession(null);
    changePhase("idle");
    activeDraftIdRef.current = null;
    void loadPending();
  }

  function retry() {
    const target = pendingProcessRef.current ?? activeSession;
    if (target) void processSession(target);
    else void start();
  }

  function revealModelFolder() {
    void bridge()?.revealTranscriptionModelFolder?.();
  }

  useEffect(() => () => {
    void abort();
  }, []);

  const model: TranscriptionDockModel = {
    phase,
    elapsedMs,
    activeSession,
    pending,
    systemAudio,
    fallbackMessage,
    bridgeAvailable: Boolean(bridge()?.beginTranscriptionRecording),
    status,
    error,
  };
  const actions: TranscriptionDockActions = {
    start: () => void start(),
    stop: () => void stopRecording(),
    transcribe: () => {
      if (activeSession) void processSession(activeSession);
    },
    transcribePending: (session) => void processSession(session),
    later,
    retry,
    revealModelFolder,
  };
  return { model, actions, isDraftBusy: (id: string) => {
    const target = activeDraftIdRef.current ?? activeSession?.draftId;
    return Boolean(target === id && activeSession && (phase === "recording" || phase === "processing" || isTranscriptionBusyState(activeSession.state)));
  }};
}
