import { useEffect, useId, useRef } from "react";
import { THEME_OPTIONS, type ThemeId } from "../model/themes.ts";
import type { ObsidianImportSettings } from "../model/obsidian-import.ts";
import {
  BundleSettings,
  type BundleSettingsControls,
} from "./BundleSettings.tsx";
import { getActiveBundleId } from "../../../lib/api.ts";

export type SettingsDialogProps = {
  themeId: ThemeId;
  onSelectTheme: (themeId: ThemeId) => void;
  obsidianImport: ObsidianImportSettings;
  onClose: () => void;
  bundleSetup?: BundleSettingsControls;
};

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';
const UNAVAILABLE_SETUP: BundleSettingsControls = {
  bundles: [],
  activeBundleId: null,
  error: "",
  selectBundle: () => {},
  setupBundle: async () => {
    throw new Error("Bundle setup is unavailable.");
  },
  renameBundle: async () => {},
  detachBundle: async () => {},
};

export function SettingsDialog({
  themeId,
  onSelectTheme,
  obsidianImport,
  onClose,
  bundleSetup,
}: SettingsDialogProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const activeBundleId = bundleSetup
    ? bundleSetup.activeBundleId
    : getActiveBundleId();

  useEffect(() => {
    const previouslyFocused = document.activeElement;
    const dialog = dialogRef.current;
    dialog?.querySelector<HTMLButtonElement>(".settings-close")?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((element) => element.getClientRects().length > 0);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
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
            <span>Make yourself at home</span>
            <h1 id={titleId}>Settings</h1>
          </div>
          <button type="button" className="settings-close" onClick={onClose}>
            Close
          </button>
        </header>
        <BundleSettings
          controls={bundleSetup || UNAVAILABLE_SETUP}
          obsidianImport={obsidianImport}
        />
        <section
          className="settings-section"
          aria-labelledby={`${titleId}-appearance`}
        >
          <div className="settings-section-copy">
            <h2 id={`${titleId}-appearance`}>Appearance</h2>
            <p>A color palette for your workspace.</p>
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
        <section
          className="settings-section settings-backup-section"
          aria-labelledby={`${titleId}-backup`}
        >
          <div className="settings-section-copy">
            <h2 id={`${titleId}-backup`}>Keep a copy</h2>
            <p>
              Download the active bundle as a ZIP file, including its Markdown
              and attachments.
            </p>
          </div>
          {activeBundleId || !bundleSetup ? (
            <a
              className="settings-action"
              href={`/api/backup${activeBundleId ? `?bundle=${encodeURIComponent(activeBundleId)}` : ""}`}
            >
              Download bundle backup <span aria-hidden="true">↓</span>
            </a>
          ) : (
            <p className="settings-import-message">
              Open a bundle to download a backup.
            </p>
          )}
        </section>
      </aside>
    </div>
  );
}
