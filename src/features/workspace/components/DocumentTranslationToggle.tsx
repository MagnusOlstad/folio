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

export function DocumentTranslationToggle({ enabled, saving, error, value, available, onChange, onEnabledChange }: Props) {
  return (
    <div className="document-translation-controls">
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label="Background translation"
        className="document-translation-switch"
        disabled={saving}
        title={enabled ? "Translation on — turn off to stop translating notes in the background" : "Translation off — turn on to translate notes in the background"}
        onClick={() => onEnabledChange(!enabled)}
      >
        <span className="document-translation-switch-track" aria-hidden="true" />
      </button>
      {enabled ? (
        <div
          className="document-translation-toggle"
          role="radiogroup"
          aria-label="Note language"
          title={available ? undefined : "Install a generation model in Settings to translate notes."}
        >
          {NOTE_TRANSLATION_LANGUAGES.map(({ target, label }) => {
            const selected = value === target;
            return (
              <button
                key={label}
                type="button"
                role="radio"
                aria-checked={selected}
                className={selected ? "active" : undefined}
                disabled={!available && target !== null}
                onClick={() => onChange(target)}
              >
                {label}
              </button>
            );
          })}
        </div>
      ) : null}
      {error ? <span className="translation-status is-error" role="alert">{error}</span> : null}
    </div>
  );
}
