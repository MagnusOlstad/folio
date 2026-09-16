import type {
  TranscriptionDockActions,
  TranscriptionDockModel,
} from "../hooks/useTranscription.ts";
import type { TranscriptionSession } from "../model/types.ts";

export type TranscriptionDockProps = {
  model: TranscriptionDockModel;
  actions: TranscriptionDockActions;
};

function durationLabel(durationMs: number | null) {
  const totalSeconds = Math.floor((durationMs ?? 0) / 1_000);
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function pendingLabel(session: TranscriptionSession) {
  if (session.state === "failed") return "Failed";
  if (session.state === "ready") return "Ready";
  if (session.state === "transcribing" || session.state === "cleaning") return "Processing";
  return "Recorded";
}

function dependencyGuidance(status: TranscriptionDockModel["status"]) {
  if (!status) return [];
  const guidance: string[] = [];
  if (status.runtime === "missing") guidance.push("Whisper runtime is missing.");
  if (status.model === "missing") guidance.push("Whisper model is missing.");
  if (status.ollama === "offline") guidance.push("Ollama is offline; local filing may be unavailable.");
  if (status.ollamaModel === "missing") guidance.push("The configured Ollama model is missing.");
  return guidance;
}

export function TranscriptionDock({ model, actions }: TranscriptionDockProps) {
  const canRecord = model.bridgeAvailable && model.phase !== "processing";
  const guidance = dependencyGuidance(model.status);
  return (
    <aside className="transcription-dock" aria-label="Transcriptions">
      <div className="transcription-heading">
        <span>Transcriptions</span>
        <span className="transcription-count">{model.pending.length}</span>
      </div>
      <div className="transcription-current" aria-live="polite">
        {model.phase === "idle" && (
          <>
            <button
              className="transcription-record-button"
              type="button"
              onClick={actions.start}
              disabled={!canRecord}
            >
              <span className="transcription-record-dot" aria-hidden="true" />
              Record
            </button>
            {!model.bridgeAvailable && (
              <p className="transcription-help">
                Recording is available in the Folio desktop app.
              </p>
            )}
          </>
        )}
        {model.phase === "recording" && (
          <div className="transcription-recording">
            <div>
              <strong>Recording {durationLabel(model.elapsedMs)}</strong>
              <span>{model.systemAudio ? "Microphone + system audio" : "Microphone only"}</span>
            </div>
            <button type="button" className="transcription-stop-button" onClick={actions.stop}>
              Stop
            </button>
          </div>
        )}
        {model.fallbackMessage && model.phase === "recording" && (
          <p className="transcription-fallback" role="status">{model.fallbackMessage}</p>
        )}
        {model.phase === "stopped" && (
          <div className="transcription-stopped">
            <strong>Recording stopped · {durationLabel(model.elapsedMs)}</strong>
            <span>What would you like to do with it?</span>
            <div>
              <button type="button" className="transcription-primary" onClick={actions.transcribe}>
                Transcribe now
              </button>
              <button type="button" className="transcription-secondary" onClick={actions.later}>
                Later
              </button>
            </div>
          </div>
        )}
        {model.phase === "processing" && (
          <div className="transcription-processing">
            <span className="transcription-spinner" aria-hidden="true" />
            <span>Transcribing recording…</span>
          </div>
        )}
        {model.phase === "error" && (
          <div className="transcription-error" role="alert">
            <strong>Transcription unavailable</strong>
            <span>{model.error || "The recording could not be completed."}</span>
            <button type="button" className="transcription-primary" onClick={actions.retry}>
              Retry
            </button>
          </div>
        )}
      </div>
      {model.pending.length > 0 && (
        <div className="transcription-pending">
          <div className="transcription-subheading">Pending recordings</div>
          {model.pending.map((session) => (
            <div className="transcription-pending-row" key={session.id}>
              <div>
                <strong>{durationLabel(session.durationMs)}</strong>
                <small>{pendingLabel(session)}</small>
              </div>
              <button
                type="button"
                onClick={() => actions.transcribePending(session)}
                disabled={model.phase === "recording" || model.phase === "processing"}
              >
                {session.state === "failed" ? "Retry" : "Transcribe"}
              </button>
            </div>
          ))}
        </div>
      )}
      {guidance.length > 0 && (
        <div className="transcription-dependency-guidance" role="status">
          {guidance.map((message) => (
            <p key={message}>{message}</p>
          ))}
          {model.status?.model === "missing" && (
            <button type="button" className="transcription-secondary" onClick={actions.revealModelFolder}>
              Reveal Whisper model folder
            </button>
          )}
        </div>
      )}
    </aside>
  );
}
