import { useEffect, useId, useRef } from "react";
import { isInternalBundlePath, normalizeDirectoryInput } from "../../../lib/paths.ts";
import type { RefileEntry, RefileFields } from "../model/refile.ts";
import { FilingFieldsForm } from "./FilingFieldsForm.tsx";

export type { RefileResult } from "../../../domain/types.ts";

type RefileDialogProps = {
  entry: RefileEntry;
  directories: string[];
  onStart: () => void;
  onChange: (fields: RefileFields) => void;
  onAccept: () => void;
  onClose: () => void;
};

function statusLabel(entry: RefileEntry) {
  if (entry.status === "preparing") return "Saving";
  if (entry.status === "proposing") return "Reviewing";
  if (entry.status === "submitting") return "Refiling";
  if (entry.status === "error") return "Needs attention";
  return "Ready";
}

export function RefileDialog({
  entry,
  directories,
  onStart,
  onChange,
  onAccept,
  onClose,
}: RefileDialogProps) {
  const rootRef = useRef<HTMLElement>(null);
  const formId = useId();
  const acceptRef = useRef<HTMLButtonElement>(null);
  const discardRef = useRef<HTMLButtonElement>(null);
  const canAccept = Boolean(entry.proposal && entry.fields) && entry.status !== "submitting";
  const fields = entry.fields;
  const hasFields = fields !== null;
  const reviewReady = entry.status === "ready" && hasFields;
  const reviewPending = entry.status === "preparing" || entry.status === "proposing";

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !event.defaultPrevented && event.target instanceof Node && rootRef.current?.contains(event.target) && entry.status !== "submitting") {
        event.preventDefault();
        onClose();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [entry.status, onClose]);

  useEffect(() => {
    if (reviewReady) acceptRef.current?.focus();
    else if (reviewPending) discardRef.current?.focus();
  }, [reviewPending, reviewReady]);

  const reservedDirectory = fields
    ? isInternalBundlePath(normalizeDirectoryInput(fields.directory))
    : false;

  return (
    <div className="filing-confirmation-layer">
      <aside
        ref={rootRef}
        className="filing-confirmation"
        role="dialog"
        aria-label="Refile note"
        aria-live={entry.status === "preparing" || entry.status === "proposing" ? "polite" : undefined}
      >
        <header>
          <div><h2>Refile note</h2></div>
          <span className="filing-status">{statusLabel(entry)}</span>
        </header>
        {entry.status === "preparing" || entry.status === "proposing" ? (
          <>
            <div className="refile-progress">
              <span className="filing-spinner" aria-hidden="true" />
              <p>{entry.status === "preparing" ? "Saving the latest note edits…" : "Choosing a path and updating metadata…"}</p>
            </div>
            <div className="filing-actions">
              <span>Esc to discard</span>
              <div><button ref={discardRef} className="filing-button filing-button-secondary" type="button" onClick={onClose}>Discard</button></div>
            </div>
          </>
        ) : fields ? (
          <>
          <form
            id={formId}
            onSubmit={(event) => { event.preventDefault(); if (canAccept && !reservedDirectory) onAccept(); }}
            onKeyDown={(event) => {
              if (event.defaultPrevented || event.key !== "Enter" || !(event.target instanceof HTMLInputElement)) return;
              event.preventDefault();
              if (canAccept && !reservedDirectory) onAccept();
            }}
          >
            <FilingFieldsForm
              fields={fields}
              directories={directories}
              onChange={(next) => onChange({
                directory: next.directory,
                filename: fields.filename,
                title: next.title,
                description: next.description,
                tags: next.tags,
              })}
            />
            <button type="submit" hidden>Submit refile</button>
          </form>
          {reservedDirectory && <p className="filing-error" role="alert">References is an internal folder. Choose another path.</p>}
          {entry.error && <p className="filing-error" role="alert">{entry.error}</p>}
          <div className="filing-actions">
            <span>Enter to accept · Esc to discard</span>
            <div>
              <button className="filing-button filing-button-secondary" type="button" onClick={onClose} disabled={entry.status === "submitting"}>Discard</button>
              <button
                className="filing-button filing-button-primary"
                ref={acceptRef}
                form={formId}
                type="submit"
                disabled={!canAccept || reservedDirectory}
              >
                {entry.status === "submitting" ? "Refiling…" : entry.error ? "Retry" : "Accept and refile"}
              </button>
            </div>
          </div>
          </>
        ) : (
          <>
            {entry.error && <p className="filing-error" role="alert">{entry.error}</p>}
            <div className="filing-actions">
              <span>Esc to discard</span>
              <div>
                <button className="filing-button filing-button-secondary" type="button" onClick={onClose}>Discard</button>
                {entry.status === "error" && <button className="filing-button filing-button-primary" type="button" onClick={onStart}>Retry review</button>}
              </div>
            </div>
          </>
        )}
      </aside>
    </div>
  );
}
