import type { ViewerDocument } from "../../../domain/types.ts";

export type TranscriptionPhase =
  | "idle"
  | "recording"
  | "stopped"
  | "processing"
  | "error";

export type TranscriptionSessionState =
  | "recording"
  | "recorded"
  | "queued"
  | "transcribing"
  | "cleaning"
  | "ready"
  | "failed"
  | "delivered";

export type TranscriptionSession = {
  id: string;
  state: TranscriptionSessionState;
  draftId: string | null;
  durationMs: number | null;
  systemAudio: "captured" | "unavailable";
  error: string | null;
  createdAt?: string;
  updatedAt?: string;
};

export type TranscriptionResult = {
  markdown?: string;
  summary: string;
  transcript: string;
};

export type TranscriptionProcessResponse = {
  session: TranscriptionSession;
  result: TranscriptionResult;
};

export type TranscriptionStatus = {
  available: boolean;
  runtime: "ready" | "missing";
  model: "ready" | "missing";
  ollama: "online" | "offline";
  ollamaModel: "ready" | "missing" | "unknown";
  whisperPath: string | null;
  modelPath: string | null;
};

export type TranscriptionBridge = {
  requestMicrophoneAccess?: () => Promise<boolean>;
  enableTranscriptionLoopback?: () => Promise<boolean>;
  disableTranscriptionLoopback?: () => Promise<void>;
  beginTranscriptionRecording?: (options: {
    draftId: string;
    systemAudio: boolean;
  }) => Promise<string | { id: string }>;
  writeTranscriptionChunk?: (id: string, chunk: ArrayBuffer) => Promise<void> | void;
  stopTranscriptionRecording?: (
    id: string,
  ) => Promise<TranscriptionSession | null>;
  abortTranscriptionRecording?: (id: string) => Promise<void>;
  revealTranscriptionModelFolder?: () => Promise<void>;
};

declare global {
  interface FolioBridge extends TranscriptionBridge {}
}

export type TranscriptionDraftAdapter = {
  createDraft: () => string;
  getDraftContent: (id: string) => string | undefined;
  getDraftDocument: (id: string) => ViewerDocument | undefined;
  updateDraftContent: (id: string, content: string) => void;
  openDraft: (id: string) => void;
  fileDraft: (document: ViewerDocument, contentOverride?: string) => void;
};

export function isTranscriptionBusyState(state: TranscriptionSessionState) {
  return state === "recording" || state === "transcribing" || state === "cleaning";
}

export function normalizeBeginResult(result: string | { id: string }) {
  return typeof result === "string" ? result : result.id;
}

export function mergeTranscriptionDraft(
  draftContent: string | undefined,
  result: TranscriptionResult,
) {
  const lines = (draftContent ?? "").split("\n");
  const firstLine = lines.shift()?.trim() || "# Transcription";
  const notes = lines.join("\n").trim();
  const sections = [firstLine, "", "# Notes", "", notes || "(No notes.)"];
  if (result.summary.trim()) sections.push("", "# Summary", "", result.summary.trim());
  if (result.transcript.trim()) sections.push("", "# Transcript", "", result.transcript.trim());
  return `${sections.join("\n").trimEnd()}\n`;
}
