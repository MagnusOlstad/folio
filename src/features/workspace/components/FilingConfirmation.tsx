import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { FilingQueueEntry } from "../model/filing.ts";
import {
  applyDirectorySuggestion,
  directorySuggestionContext,
} from "../model/directory-suggestions.ts";
import { isInternalBundlePath, normalizeDirectoryInput } from "../../../lib/paths.ts";

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

function tagText(tags: string[]) {
  return tags.join(", ");
}

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
  const directoryInputRef = useRef<HTMLInputElement>(null);
  const directoryListId = useId();
  const [directoryCaret, setDirectoryCaret] = useState(entry.fields.directory.length);
  const [directoryMenuOpen, setDirectoryMenuOpen] = useState(false);
  const [activeSuggestion, setActiveSuggestion] = useState<number | null>(null);
  const isAppend = entry.filing.mode !== "new";
  const proposal = entry.standalone
    ? entry.filing.standaloneProposal
    : entry.filing.proposal;

  useEffect(() => {
    if (autoFocus && entry.status === "ready") acceptRef.current?.focus();
  }, [autoFocus, entry.status, entry.filing.id]);

  useEffect(() => {
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
  const update = (key: keyof FilingQueueEntry["fields"], value: string | string[]) =>
    onChange({ ...entry.fields, [key]: value });
  const directoryContext = useMemo(
    () => directorySuggestionContext(entry.fields.directory, directoryCaret, directories),
    [directories, directoryCaret, entry.fields.directory],
  );
  const directorySuggestions = directoryContext.suggestions;
  const selectDirectorySuggestion = (index: number) => {
    const suggestion = directorySuggestions[index];
    if (!suggestion) return;
    const value = applyDirectorySuggestion(
      entry.fields.directory,
      directoryContext,
      suggestion,
    );
    const caret = directoryContext.segmentStart + suggestion.segment.length;
    update("directory", value);
    setDirectoryCaret(caret);
    setDirectoryMenuOpen(false);
    setActiveSuggestion(null);
    requestAnimationFrame(() => {
      directoryInputRef.current?.focus();
      directoryInputRef.current?.setSelectionRange(caret, caret);
    });
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
            <label className="filing-directory-field">Path
              <input
                ref={directoryInputRef}
                role="combobox"
                aria-autocomplete="list"
                aria-controls={directoryListId}
                aria-expanded={directoryMenuOpen && directorySuggestions.length > 0}
                aria-activedescendant={activeSuggestion === null ? undefined : `${directoryListId}-option-${activeSuggestion}`}
                aria-invalid={directoryReserved}
                value={entry.fields.directory}
                onFocus={(event) => {
                  setDirectoryCaret(event.currentTarget.selectionStart ?? event.currentTarget.value.length);
                  setDirectoryMenuOpen(true);
                }}
                onClick={(event) => setDirectoryCaret(event.currentTarget.selectionStart ?? event.currentTarget.value.length)}
                onSelect={(event) => setDirectoryCaret(event.currentTarget.selectionStart ?? event.currentTarget.value.length)}
                onBlur={() => {
                  setDirectoryMenuOpen(false);
                  setActiveSuggestion(null);
                }}
                onChange={(event) => {
                  setDirectoryCaret(event.currentTarget.selectionStart ?? event.currentTarget.value.length);
                  setDirectoryMenuOpen(true);
                  setActiveSuggestion(null);
                  update("directory", event.target.value);
                }}
                onKeyDown={(event) => {
                  if (!directorySuggestions.length) return;
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault();
                    setDirectoryMenuOpen(true);
                    setActiveSuggestion((current) => {
                      if (current === null) return event.key === "ArrowDown" ? 0 : directorySuggestions.length - 1;
                      return (current + (event.key === "ArrowDown" ? 1 : directorySuggestions.length - 1)) % directorySuggestions.length;
                    });
                  }
                  if (event.key === "Enter" && directoryMenuOpen && activeSuggestion !== null) {
                    event.preventDefault();
                    selectDirectorySuggestion(activeSuggestion);
                  }
                  if (event.key === "Tab" && directoryMenuOpen) {
                    const suggestionIndex = activeSuggestion ?? 0;
                    const suggestion = directorySuggestions[suggestionIndex];
                    if (suggestion && applyDirectorySuggestion(
                      entry.fields.directory,
                      directoryContext,
                      suggestion,
                    ) !== entry.fields.directory) {
                      event.preventDefault();
                      selectDirectorySuggestion(suggestionIndex);
                    }
                  }
                }}
              />
              {directoryMenuOpen && directorySuggestions.length > 0 && (
                <ul className="filing-directory-suggestions" id={directoryListId} role="listbox" aria-label="Directory suggestions">
                  {directorySuggestions.map((suggestion, index) => (
                    <li key={suggestion.directory} id={`${directoryListId}-option-${index}`} role="option" aria-selected={activeSuggestion === index}>
                      <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => selectDirectorySuggestion(index)}>{suggestion.directory}</button>
                    </li>
                  ))}
                </ul>
              )}
            </label>
            <label>Title<input value={entry.fields.title} onChange={(event) => update("title", event.target.value)} /></label>
            <label>Description<input value={entry.fields.description} onChange={(event) => update("description", event.target.value)} /></label>
            <label>Tags<input value={tagText(entry.fields.tags)} onChange={(event) => update("tags", event.target.value.split(",").map((tag) => tag.trim()).filter(Boolean))} /></label>
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
