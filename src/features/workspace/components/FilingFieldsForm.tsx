import { useId, useMemo, useRef, useState } from "react";
import {
  applyDirectorySuggestion,
  directorySuggestionContext,
} from "../model/directory-suggestions.ts";
import type { FilingFields } from "../model/filing.ts";

export type FilingFieldsFormValue = FilingFields;

type FilingFieldsFormProps = {
  fields: FilingFieldsFormValue;
  directories: string[];
  descriptionMultiline?: boolean;
  pathInvalid?: boolean;
  onChange: (fields: FilingFieldsFormValue) => void;
};

export function FilingFieldsForm({
  fields,
  directories,
  descriptionMultiline = false,
  pathInvalid = false,
  onChange,
}: FilingFieldsFormProps) {
  const pathRef = useRef<HTMLInputElement>(null);
  const directoryListId = useId();
  const [pathCaret, setPathCaret] = useState(fields.directory.length);
  const [directoryMenuOpen, setDirectoryMenuOpen] = useState(false);
  const [activeSuggestion, setActiveSuggestion] = useState<number | null>(null);
  const directoryCaret = pathCaret;
  const directoryContext = useMemo(
    () => directorySuggestionContext(fields.directory, directoryCaret, directories),
    [directories, directoryCaret, fields.directory],
  );
  const directorySuggestions = directoryContext.suggestions;

  const update = (next: Partial<FilingFieldsFormValue>) => onChange({ ...fields, ...next });
  const selectDirectorySuggestion = (index: number) => {
    const suggestion = directorySuggestions[index];
    if (!suggestion) return;
    const directory = applyDirectorySuggestion(
      fields.directory,
      directoryContext,
      suggestion,
    );
    const caret = directoryContext.segmentStart + suggestion.segment.length;
    update({ directory });
    setPathCaret(caret);
    setDirectoryMenuOpen(false);
    setActiveSuggestion(null);
    requestAnimationFrame(() => {
      pathRef.current?.focus();
      pathRef.current?.setSelectionRange(caret, caret);
    });
  };

  return (
    <>
      <label className="filing-directory-field">Path
        <input
          ref={pathRef}
          role="combobox"
          aria-autocomplete="list"
          aria-controls={directoryListId}
          aria-expanded={directoryMenuOpen && directorySuggestions.length > 0}
          aria-activedescendant={activeSuggestion === null ? undefined : `${directoryListId}-option-${activeSuggestion}`}
          aria-invalid={pathInvalid || undefined}
          value={fields.directory}
          onFocus={(event) => {
            setPathCaret(event.currentTarget.selectionStart ?? event.currentTarget.value.length);
            setDirectoryMenuOpen(true);
          }}
          onClick={(event) => setPathCaret(event.currentTarget.selectionStart ?? event.currentTarget.value.length)}
          onSelect={(event) => setPathCaret(event.currentTarget.selectionStart ?? event.currentTarget.value.length)}
          onBlur={() => {
            setDirectoryMenuOpen(false);
            setActiveSuggestion(null);
          }}
          onChange={(event) => {
            setPathCaret(event.currentTarget.selectionStart ?? event.currentTarget.value.length);
            setDirectoryMenuOpen(true);
            setActiveSuggestion(null);
            update({ directory: event.currentTarget.value });
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
                fields.directory,
                directoryContext,
                suggestion,
              ) !== fields.directory) {
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
      <label>Title<input value={fields.title} onChange={(event) => update({ title: event.target.value })} /></label>
      <label>Description
        {descriptionMultiline ? (
          <textarea rows={3} value={fields.description} onChange={(event) => update({ description: event.target.value })} />
        ) : (
          <input value={fields.description} onChange={(event) => update({ description: event.target.value })} />
        )}
      </label>
      <label>Tags<input value={fields.tags.join(", ")} onChange={(event) => update({ tags: event.target.value.split(",").map((tag) => tag.trim()).filter(Boolean) })} /></label>
    </>
  );
}
