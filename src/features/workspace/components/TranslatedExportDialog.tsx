import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { TranslatedExportJob, ViewerDocument } from "../../../domain/types.ts";
import { ApiError, cancelTranslatedExport, fetchTranslatedExport, startTranslatedExport } from "../../../lib/api.ts";
import {
  TRANSLATED_EXPORT_DESTINATIONS,
  TRANSLATED_EXPORT_LANGUAGES,
  readTranslatedExportPreferences,
  writeTranslatedExportPreferences,
  type TranslatedExportDeliver,
} from "../model/translated-export.ts";
import { translatedProgressLabel } from "../model/note-translation.ts";

export const TRANSLATED_EXPORT_POLL_MS = 1500;

type Props = {
  document: ViewerDocument;
  onClose: () => void;
  onDeliver: TranslatedExportDeliver;
};

type Phase =
  | { kind: "idle" }
  | { kind: "running"; jobId: string | null; translated: number; total: number }
  | { kind: "error"; message: string; noModel: boolean };

export function TranslatedExportDialog({ document: note, onClose, onDeliver }: Props) {
  const titleId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [preferences] = useState(readTranslatedExportPreferences);
  const [target, setTarget] = useState(preferences.target);
  const [destination, setDestination] = useState(preferences.destination);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const jobIdRef = useRef<string | null>(null);
  const deliveredRef = useRef(false);
  const running = phase.kind === "running";
  const jobId = running ? phase.jobId : null;

  useEffect(() => {
    rootRef.current?.querySelector<HTMLInputElement>("input[type=radio]:checked")?.focus();
  }, []);

  useEffect(() => {
    // Leaving mid-job (unmount) must not leave the server translating for nobody.
    return () => {
      const pending = jobIdRef.current;
      if (pending) void cancelTranslatedExport(pending).catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (!jobId) return;
    const controller = new AbortController();
    let timer: number | undefined;
    const poll = async () => {
      try {
        const job: TranslatedExportJob = await fetchTranslatedExport(jobId, controller.signal);
        if (controller.signal.aborted) return;
        if (job.status === "running") {
          setPhase({ kind: "running", jobId, translated: job.translatedBlocks, total: job.totalBlocks });
          timer = window.setTimeout(poll, TRANSLATED_EXPORT_POLL_MS);
        } else if (job.status === "done") {
          jobIdRef.current = null;
          if (deliveredRef.current) return;
          deliveredRef.current = true;
          onClose();
          void onDeliver(note, job, job.target, destination);
        } else {
          jobIdRef.current = null;
          setPhase({
            kind: "error",
            message: job.status === "cancelled" ? "The translation was cancelled." : job.error || "The translation failed.",
            noModel: false,
          });
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        jobIdRef.current = null;
        setPhase({
          kind: "error",
          message: error instanceof Error ? error.message : "Could not read the translation progress.",
          noModel: false,
        });
      }
    };
    timer = window.setTimeout(poll, TRANSLATED_EXPORT_POLL_MS);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
    // The job id alone identifies the poll; destination/target are fixed for its lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  async function start() {
    writeTranslatedExportPreferences({ target, destination });
    deliveredRef.current = false;
    setPhase({ kind: "running", jobId: null, translated: 0, total: 0 });
    try {
      const job = await startTranslatedExport(note.id, target);
      jobIdRef.current = job.jobId;
      setPhase({ kind: "running", jobId: job.jobId, translated: job.translatedBlocks, total: job.totalBlocks });
    } catch (error) {
      setPhase({
        kind: "error",
        message: error instanceof Error ? error.message : "Could not start the translation.",
        noModel: error instanceof ApiError && error.status === 503,
      });
    }
  }

  function cancelAndClose() {
    const pending = jobIdRef.current;
    jobIdRef.current = null;
    if (pending) void cancelTranslatedExport(pending).catch(() => {});
    onClose();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancelAndClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>("input:not(:disabled), button:not(:disabled)"),
    ).filter((element) => !(element instanceof HTMLInputElement && element.type === "radio" && !element.checked && element.name && event.currentTarget.querySelector(`input[name="${element.name}"]:checked`)));
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = window.document.activeElement;
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return createPortal(
    <div className="translated-export-layer" onPointerDown={(event) => { if (event.target === event.currentTarget && !running) onClose(); }}>
      <div
        ref={rootRef}
        className="translated-export-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={handleKeyDown}
      >
        <h2 id={titleId}>Translate and export</h2>
        <p className="translated-export-note">{note.title}</p>
        <fieldset disabled={running}>
          <legend>Language</legend>
          <div className="translated-export-options">
            {TRANSLATED_EXPORT_LANGUAGES.map((language) => (
              <label key={language.target}>
                <input
                  type="radio"
                  name="translated-export-language"
                  checked={target === language.target}
                  onChange={() => setTarget(language.target)}
                  aria-describedby={language.hint ? `${titleId}-${language.target}-hint` : undefined}
                />
                <span>
                  {language.native}
                  {language.hint ? <small id={`${titleId}-${language.target}-hint`} className="translated-export-hint">{language.hint}</small> : null}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset disabled={running}>
          <legend>Destination</legend>
          <div className="translated-export-options">
            {TRANSLATED_EXPORT_DESTINATIONS.map((option) => (
              <label key={option.value}>
                <input
                  type="radio"
                  name="translated-export-destination"
                  checked={destination === option.value}
                  onChange={() => setDestination(option.value)}
                />
                {option.label}
              </label>
            ))}
          </div>
        </fieldset>
        {phase.kind === "running" ? (
          <p className="translation-status" role="status">
            {phase.total > 0 ? translatedProgressLabel(phase.translated, phase.total) : "Starting translation…"}
          </p>
        ) : null}
        {phase.kind === "error" ? (
          <p className="translation-status is-error" role="alert">
            {phase.message}
            {phase.noModel ? " Install a generation model in Settings to translate notes." : ""}
          </p>
        ) : null}
        <div className="translated-export-actions">
          {running ? (
            <button type="button" onClick={cancelAndClose}>Cancel</button>
          ) : (
            <>
              <button type="button" onClick={onClose}>Close</button>
              <button type="button" className="primary" onClick={() => void start()}>
                {phase.kind === "error" ? "Retry" : "Translate"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>,
    window.document.body,
  );
}
