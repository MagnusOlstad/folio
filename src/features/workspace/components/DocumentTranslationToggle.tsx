import { useId } from "react";
import type { NoteLanguageSource, NoteTranslationTarget } from "../../../domain/types.ts";
import { NOTE_TRANSLATION_LANGUAGES } from "../model/note-translation.ts";

type Props = {
  enabled: boolean;
  saving: boolean;
  error: string;
  value: NoteTranslationTarget | null;
  available: boolean;
  /** The note's own language when known; its button doubles as "Original". */
  originalLanguage: NoteTranslationTarget | null;
  originalSource: NoteLanguageSource | null;
  onChange: (target: NoteTranslationTarget) => void;
  onEnabledChange: (enabled: boolean) => void;
};

/** Leading switch segment plus the language segments; rendered inside the header toolbar. */
export function DocumentTranslationToggle({ enabled, saving, error, value, available, originalLanguage, originalSource, onChange, onEnabledChange }: Props) {
  const markerId = useId();
  return (
    <div className="document-translation-group" data-error={error ? "true" : undefined}>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label="Background translation"
        className="document-translation-switch"
        disabled={saving}
        title={error || (enabled ? "Translation on — turn off to stop translating notes in the background" : "Translation off — turn on to translate notes in the background")}
        onClick={() => onEnabledChange(!enabled)}
      >
        <span className="document-translation-switch-track" aria-hidden="true" />
      </button>
      {enabled ? (
        <div
          className="document-translation-toggle"
          role="group"
          aria-label="Note language"
        >
          {NOTE_TRANSLATION_LANGUAGES.map(({ target, label, code, name }) => {
            const pressed = value === target;
            const isOriginal = originalLanguage === target;
            const marker = `Original language (${name}) — ${originalSource === "frontmatter" ? "set in the note" : "detected from the text"}`;
            return (
              <button
                key={target}
                type="button"
                aria-pressed={pressed}
                aria-label={label}
                aria-describedby={isOriginal ? `${markerId}-${target}` : undefined}
                data-original={isOriginal ? "true" : undefined}
                disabled={!available && !isOriginal}
                title={
                  isOriginal ? marker
                    : available ? `Show in ${name}${pressed ? " — click again for original" : ""}`
                      : "Install a generation model in Settings to translate notes."
                }
                onClick={() => onChange(target)}
              >
                {code}
                {isOriginal ? <span id={`${markerId}-${target}`} className="translation-controls-error">{marker}</span> : null}
              </button>
            );
          })}
        </div>
      ) : null}
      {error ? <span className="translation-controls-error" role="alert">{error}</span> : null}
    </div>
  );
}
