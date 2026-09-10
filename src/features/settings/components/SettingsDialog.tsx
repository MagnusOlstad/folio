import { useEffect, useId, useRef } from "react";
import { THEME_OPTIONS, type ThemeId } from "../model/themes.ts";
import type { ObsidianImportSettings } from "../model/obsidian-import.ts";

export type SettingsDialogProps = {
  themeId: ThemeId;
  onSelectTheme: (themeId: ThemeId) => void;
  obsidianImport: ObsidianImportSettings;
  onClose: () => void;
};

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

export function SettingsDialog({
  themeId,
  onSelectTheme,
  obsidianImport,
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
        <section className="settings-section settings-import-section" aria-labelledby={`${titleId}-import`}>
          <div className="settings-section-copy">
            <h2 id={`${titleId}-import`}>Import</h2>
            <p>File every Markdown note from an Obsidian vault into Folio.</p>
          </div>
          {!obsidianImport.supported ? (
            <p className="settings-import-message">
              Folder import requires Folio for desktop or a Chromium browser with folder access.
            </p>
          ) : null}
          {obsidianImport.busy && !obsidianImport.job ? (
            <p className="settings-import-message" aria-live="polite">
              {obsidianImport.scan ? "Preparing source files…" : "Scanning vault…"}
            </p>
          ) : null}
          {obsidianImport.scan ? (
            <div className="settings-import-summary">
              <strong>{obsidianImport.scan.name}</strong>
              <dl>
                <div><dt>New</dt><dd>{obsidianImport.scan.counts.new}</dd></div>
                <div><dt>Already imported</dt><dd>{obsidianImport.scan.counts.imported}</dd></div>
                <div><dt>Changed (skipped)</dt><dd>{obsidianImport.scan.counts.changed}</dd></div>
                <div><dt>Ready to retry</dt><dd>{obsidianImport.scan.counts.retryable}</dd></div>
                <div><dt>Attachments (not copied)</dt><dd>{obsidianImport.scan.counts.attachments}</dd></div>
              </dl>
              {obsidianImport.job ? (
                <div className="settings-import-progress" aria-live="polite">
                  <progress
                    max={Math.max(obsidianImport.job.total, 1)}
                    value={obsidianImport.job.phase === "completed" ? Math.max(obsidianImport.job.total, 1) : obsidianImport.job.processed}
                  />
                  <span>
                    {obsidianImport.job.phase === "completed"
                      ? `Imported ${obsidianImport.job.imported} notes; ${obsidianImport.job.failed} failed; ${obsidianImport.job.unresolvedLinks} note links unresolved.`
                      : obsidianImport.job.phase === "cancelled"
                        ? "Import cancelled. Select this vault again to resume."
                        : obsidianImport.job.phase === "failed"
                          ? obsidianImport.job.error || "Import failed."
                          : `${obsidianImport.job.phase} · ${obsidianImport.job.processed} of ${obsidianImport.job.total || obsidianImport.scan.counts.new + obsidianImport.scan.counts.retryable}`}
                  </span>
                </div>
              ) : (
                <p className="settings-import-message">
                  Folio will archive the originals and import {obsidianImport.scan.counts.new + obsidianImport.scan.counts.retryable} notes. This is the only confirmation.
                </p>
              )}
            </div>
          ) : null}
          {obsidianImport.error ? <p className="settings-import-error" role="alert">{obsidianImport.error}</p> : null}
          <div className="settings-import-actions">
            <button type="button" onClick={obsidianImport.selectVault} disabled={!obsidianImport.supported || obsidianImport.busy}>
              {obsidianImport.scan ? "Choose another vault" : "Choose Obsidian vault"}
            </button>
            {obsidianImport.scan && !obsidianImport.job ? (
              <button type="button" className="primary" onClick={obsidianImport.confirmImport} disabled={obsidianImport.busy || obsidianImport.scan.counts.new + obsidianImport.scan.counts.retryable === 0}>
                Import notes
              </button>
            ) : null}
            {obsidianImport.job && !["completed", "cancelled", "failed"].includes(obsidianImport.job.phase) ? (
              <button type="button" onClick={obsidianImport.cancelImport}>Cancel after current note</button>
            ) : null}
            {obsidianImport.job && ["completed", "cancelled", "failed"].includes(obsidianImport.job.phase) ? (
              <button type="button" onClick={obsidianImport.clearScan}>Done</button>
            ) : null}
          </div>
        </section>
      </aside>
    </div>
  );
}
