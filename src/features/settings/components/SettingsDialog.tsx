import { useEffect, useId, useRef, useState } from "react";
import { THEME_OPTIONS, type ThemeId } from "../model/themes.ts";
import type { SettingsCategory } from "../model/settings-category.ts";
import type { ObsidianImportSettings } from "../model/obsidian-import.ts";
import { ModelSettings, type ModelSettingsControls } from "./ModelSettings.tsx";
import {
  BundleSettings,
  type BundleSettingsControls,
} from "./BundleSettings.tsx";

export type SettingsDialogProps = {
  themeId: ThemeId;
  onSelectTheme: (themeId: ThemeId) => void;
  obsidianImport: ObsidianImportSettings;
  onClose: () => void;
  bundleSetup?: BundleSettingsControls;
  modelSettings?: ModelSettingsControls;
  initialCategory?: SettingsCategory;
};

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';
const CATEGORIES = [
  ["bundles", "Bundles"],
  ["models", "Models"],
  ["appearance", "Appearance"],
  ["backup", "Backup"],
] as const satisfies ReadonlyArray<readonly [SettingsCategory, string]>;
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
  modelSettings,
  initialCategory = "bundles",
}: SettingsDialogProps) {
  const titleId = useId();
  const contentId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const hasAttachedBundles = (bundleSetup || UNAVAILABLE_SETUP).bundles.length > 0;
  const [category, setCategory] = useState<SettingsCategory>(initialCategory);
  const activeCategoryIndex = CATEGORIES.findIndex(([id]) => id === category);

  function selectCategory(nextCategory: SettingsCategory) {
    setCategory(nextCategory);
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }

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
        <nav
          className="settings-category-nav"
          aria-label="Settings categories"
          onKeyDown={(event) => {
            const keyOffsets: Record<string, number> = {
              ArrowDown: 1,
              ArrowRight: 1,
              ArrowUp: -1,
              ArrowLeft: -1,
            };
            const offset = keyOffsets[event.key];
            const targetIndex = event.key === "Home"
              ? 0
              : event.key === "End"
                ? CATEGORIES.length - 1
                : offset === undefined
                  ? -1
                  : (activeCategoryIndex + offset + CATEGORIES.length) % CATEGORIES.length;
            if (targetIndex < 0) return;
            event.preventDefault();
            const [targetCategory] = CATEGORIES[targetIndex];
            selectCategory(targetCategory);
            dialogRef.current
              ?.querySelector<HTMLButtonElement>(`[data-settings-category="${targetCategory}"]`)
              ?.focus();
          }}
        >
          {CATEGORIES.map(([id, label]) => (
            <button
              key={id}
              type="button"
              data-settings-category={id}
              id={`settings-category-${id}`}
              aria-current={category === id ? "page" : undefined}
              aria-controls={`settings-panel-${id}`}
              onClick={() => selectCategory(id)}
            >
              {label}
            </button>
          ))}
        </nav>
        <div
          ref={contentRef}
          className="settings-content"
          id={contentId}
          role="region"
          aria-label={`${CATEGORIES[activeCategoryIndex][1]} settings`}
        >
          <div id="settings-panel-bundles" hidden={category !== "bundles"} aria-labelledby="settings-category-bundles">
            <BundleSettings controls={bundleSetup || UNAVAILABLE_SETUP} obsidianImport={obsidianImport} />
          </div>
          <div id="settings-panel-models" hidden={category !== "models"} aria-labelledby="settings-category-models">
            {modelSettings ? <ModelSettings controls={modelSettings} /> : null}
          </div>
          <div id="settings-panel-appearance" hidden={category !== "appearance"} aria-labelledby="settings-category-appearance">
            <section className="settings-section" aria-labelledby={`${titleId}-appearance`}>
              <div className="settings-section-copy"><h2 id={`${titleId}-appearance`}>Appearance</h2><p>A color palette for your workspace.</p></div>
              <div className="theme-options">
                {THEME_OPTIONS.map((theme) => (
                  <label className={`theme-option ${theme.id === themeId ? "selected" : ""}`} key={theme.id}>
                    <input type="radio" name="folio-theme" value={theme.id} checked={theme.id === themeId} onChange={() => onSelectTheme(theme.id)} />
                    <span className="theme-swatches" aria-hidden="true">{theme.swatches.map((color) => <span style={{ backgroundColor: color }} key={color} />)}</span>
                    <strong>{theme.label}</strong><small>{theme.description}</small>
                  </label>
                ))}
              </div>
            </section>
          </div>
          <div id="settings-panel-backup" hidden={category !== "backup"} aria-labelledby="settings-category-backup">
            <section className="settings-section settings-backup-section" aria-labelledby={`${titleId}-backup`}>
              <div className="settings-section-copy"><h2 id={`${titleId}-backup`}>Backup</h2><p>Download all attached bundles as one ZIP file, including their Markdown and attachments.</p></div>
              {hasAttachedBundles ? <a className="settings-action" href="/api/backup">Download all bundle backups <span aria-hidden="true">↓</span></a> : <p className="settings-import-message">Add a bundle to download a backup.</p>}
            </section>
          </div>
        </div>
      </aside>
    </div>
  );
}
