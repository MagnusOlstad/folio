import { useEffect, useId, useRef } from "react";
import { THEME_OPTIONS, type ThemeId } from "../model/themes.ts";

export type SettingsDialogProps = {
  themeId: ThemeId;
  onSelectTheme: (themeId: ThemeId) => void;
  onClose: () => void;
};

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

export function SettingsDialog({
  themeId,
  onSelectTheme,
  onClose,
}: SettingsDialogProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement;
    const dialog = dialogRef.current;
    dialog
      ?.querySelector<HTMLInputElement>('input[type="radio"]:checked')
      ?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    };
  }, [onClose]);

  return (
    <div
      className="settings-layer"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside
        ref={dialogRef}
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header className="settings-heading">
          <div>
            <span>Preferences</span>
            <h1 id={titleId}>Settings</h1>
          </div>
          <button type="button" className="settings-close" onClick={onClose}>
            Close
          </button>
        </header>
        <section className="settings-section" aria-labelledby={`${titleId}-appearance`}>
          <div className="settings-section-copy">
            <h2 id={`${titleId}-appearance`}>Appearance</h2>
            <p>Choose a color theme for Folio.</p>
          </div>
          <div className="theme-options">
            {THEME_OPTIONS.map((theme) => (
              <label
                className={`theme-option ${theme.id === themeId ? "selected" : ""}`}
                key={theme.id}
              >
                <input
                  type="radio"
                  name="folio-theme"
                  value={theme.id}
                  checked={theme.id === themeId}
                  onChange={() => onSelectTheme(theme.id)}
                />
                <span className="theme-swatches" aria-hidden="true">
                  {theme.swatches.map((color) => (
                    <span style={{ backgroundColor: color }} key={color} />
                  ))}
                </span>
                <strong>{theme.label}</strong>
                <small>{theme.description}</small>
              </label>
            ))}
          </div>
        </section>
      </aside>
    </div>
  );
}
