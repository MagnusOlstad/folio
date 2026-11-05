import type { NoteTranslationTarget } from "../../../domain/types.ts";
import { NOTE_TRANSLATION_LANGUAGES } from "../model/note-translation.ts";

type Props = {
  enabled: boolean;
  saving: boolean;
  error: string;
  value: NoteTranslationTarget | null;
  available: boolean;
  onChange: (target: NoteTranslationTarget | null) => void;
  onEnabledChange: (enabled: boolean) => void;
};

/** Leading switch segment plus the language segments; rendered inside the header toolbar. */
export function DocumentTranslationToggle({ enabled, saving, error, value, available, onChange, onEnabledChange }: Props) {
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
            return (
              <button
                key={target}
                type="button"
                aria-pressed={pressed}
                aria-label={label}
                disabled={!available}
                title={available ? `Show in ${name} — click again for original` : "Install a generation model in Settings to translate notes."}
                onClick={() => onChange(pressed ? null : target)}
              >
                {code}
              </button>
            );
          })}
        </div>
      ) : null}
      {error ? <span className="translation-controls-error" role="alert">{error}</span> : null}
    </div>
  );
}
