import { useEffect, useId, useRef, useState } from "react";
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
  const infoId = useId();
  const [infoOpen, setInfoOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const infoButtonRef = useRef<HTMLButtonElement>(null);
  const showInfo = !enabled;
  const popoverOpen = infoOpen && showInfo;

  useEffect(() => {
    if (!popoverOpen) return;
    const closeFromOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setInfoOpen(false);
    };
    const closeFromEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setInfoOpen(false);
      infoButtonRef.current?.focus();
    };
    window.addEventListener("pointerdown", closeFromOutside);
    window.addEventListener("keydown", closeFromEscape);
    return () => {
      window.removeEventListener("pointerdown", closeFromOutside);
      window.removeEventListener("keydown", closeFromEscape);
    };
  }, [popoverOpen]);

  function turnOn(next: boolean) {
    setInfoOpen(false);
    onEnabledChange(next);
  }

  return (
    <div className="document-translation-controls" ref={rootRef}>
    <div className="document-translation-group" data-error={error ? "true" : undefined}>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label="Background translation"
        className="document-translation-switch"
        disabled={saving}
        title={error || (enabled ? "Translation on — turn off to stop translating notes in the background" : "Translation off — turn on to translate notes in the background")}
        onClick={() => turnOn(!enabled)}
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
    {showInfo ? (
      <>
        <button
          type="button"
          ref={infoButtonRef}
          className="document-translation-info"
          aria-label="About note translation"
          aria-expanded={popoverOpen}
          aria-controls={popoverOpen ? infoId : undefined}
          onClick={() => setInfoOpen((open) => !open)}
        >
          i
        </button>
        {popoverOpen ? (
          <div className="document-translation-popover" id={infoId} role="dialog" aria-label="Note translation">
            <h3>Note translation</h3>
            <p>Translates your filed notes between Norwegian and English on this Mac, using your selected local model. Nothing leaves your computer.</p>
            <p>Turn it on to translate notes in the background. Then use NO / EN to switch a note's language — the highlighted one is the note's original language, detected when it was filed.</p>
            <p>Uses the generation model and keeps it loaded more often. Translated export (More → Translate…) works even when this is off.</p>
            <button type="button" className="document-translation-popover-action" disabled={saving} onClick={() => turnOn(true)}>Turn on</button>
          </div>
        ) : null}
      </>
    ) : null}
    </div>
  );
}