import { useEffect, useLayoutEffect, useRef } from "react";
import type { FilingQueueEntry } from "../model/filing.ts";
import { isInternalBundlePath, normalizeDirectoryInput } from "../../../lib/paths.ts";
import { FilingFieldsForm } from "./FilingFieldsForm.tsx";

type FilingConfirmationProps = {
  entry: FilingQueueEntry;
  directories: string[];
  autoFocus?: boolean;
  onChange: (fields: FilingQueueEntry["fields"]) => void;
  onAccept: () => void;
  onStandalone: () => void;
  onDismiss: () => void;
  onRevealStandalone: () => void;
};

export function FilingConfirmation({
  entry,
  directories,
  autoFocus = true,
  onChange,
  onAccept,
  onStandalone,
  onDismiss,
  onRevealStandalone,
}: FilingConfirmationProps) {
  const acceptRef = useRef<HTMLButtonElement>(null);
  const isAppend = entry.filing.mode !== "new";
  const proposal = entry.standalone
    ? entry.filing.standaloneProposal
    : entry.filing.proposal;

  useEffect(() => {
    if (autoFocus && entry.status === "ready") acceptRef.current?.focus();
  }, [autoFocus, entry.status, entry.filing.id]);

  useLayoutEffect(() => {
    if (!autoFocus) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onDismiss();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [autoFocus, onDismiss]);

  const directoryReserved = isInternalBundlePath(normalizeDirectoryInput(entry.fields.directory));
  const submitAction = entry.standalone ? onStandalone : onAccept;
  const submit = () => {
    if (!directoryReserved) submitAction();
  };
  if (entry.status === "preparing") {
    return (
      <div className="filing-confirmation-layer">
        <aside className="filing-confirmation filing-confirmation-preparing" aria-label="Filing confirmation" aria-live="polite">
          <span className="filing-spinner" aria-hidden="true" />
          <div>
            <strong>Filing note…</strong>
            <p>Choosing a title, location, and tags.</p>
          </div>
        </aside>
      </div>
    );
  }

  return (
    <div className="filing-confirmation-layer">
      <aside
        className="filing-confirmation"
        role="dialog"
        aria-modal="true"
        aria-label="Filing confirmation"
      >
        <header>
          <div>
            <h2>
              {entry.standalone ? "File separately" : isAppend ? "Append to destination" : "Review filing"}
            </h2>
          </div>
          <span className="filing-status">Ready</span>
        </header>
        {isAppend && !entry.standalone ? (
          <div className="filing-destination">
            <div>
              <span>Destination</span>
              <strong>{entry.filing.proposal.title}</strong>
              <small>{entry.filing.proposal.directory}</small>
            </div>
          </div>
        ) : (
          <form
            onSubmit={(event) => { event.preventDefault(); submit(); }}
            onKeyDown={(event) => {
              if (event.defaultPrevented) return;
              if (event.key !== "Enter" || !(event.target instanceof HTMLInputElement)) return;
              event.preventDefault();
              submit();
            }}
          >
            <FilingFieldsForm
              fields={entry.fields}
              directories={directories}
              pathInvalid={directoryReserved}
              onChange={(fields) => onChange({
                directory: fields.directory,
                title: fields.title,
                description: fields.description,
                tags: fields.tags,
              })}
            />
            <button type="submit" hidden>Submit filing</button>
          </form>
        )}
        {directoryReserved && (
          <p className="filing-error" role="alert">References is an internal folder. Choose another path.</p>
        )}
        {entry.error && <p className="filing-error" role="alert">{entry.error}</p>}
        <div className="filing-actions">
          <span>Enter to accept · Esc to keep agent filing</span>
          <div>
            {isAppend && !entry.standalone && (
              <button className="filing-button filing-button-secondary" type="button" onClick={onRevealStandalone}>
                File separately
              </button>
            )}
            <button className="filing-button filing-button-primary" ref={acceptRef} type="button" onClick={submit} disabled={entry.status === "submitting" || directoryReserved}>
              {entry.status === "submitting" ? "Filing…" : entry.error ? "Retry" : entry.standalone ? "File separately" : "Accept"}
            </button>
          </div>
        </div>
        {proposal === undefined && <p className="filing-error">The server did not provide a separate filing proposal.</p>}
      </aside>
    </div>
  );
}
