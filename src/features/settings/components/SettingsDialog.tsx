import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent } from "react";
import { THEME_OPTIONS, type ThemeId } from "../model/themes.ts";
import type { ObsidianImportSettings } from "../model/obsidian-import.ts";
import type { Bundle } from "../../../domain/types.ts";
import type { BundleSetupInput } from "../hooks/useBundleSetup.ts";
import { selectBundleFolder } from "../model/bundle-picker.ts";
import { getActiveBundleId } from "../../../lib/api.ts";

export type SettingsDialogProps = {
  themeId: ThemeId;
  onSelectTheme: (themeId: ThemeId) => void;
  obsidianImport: ObsidianImportSettings;
  onClose: () => void;
  bundleSetup?: {
    bundles: Bundle[];
    activeBundleId: string | null;
    error: string;
    selectBundle: (id: string) => void;
    setupBundle: (input: BundleSetupInput) => Promise<Bundle>;
    renameBundle: (id: string, name: string) => Promise<void>;
    detachBundle: (id: string) => Promise<void>;
  };
};

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

export function SettingsDialog({
  themeId,
  onSelectTheme,
  obsidianImport,
  onClose,
  bundleSetup,
}: SettingsDialogProps) {
  const setup = bundleSetup || {
    bundles: [], activeBundleId: null, error: "",
    selectBundle: () => {}, setupBundle: async () => { throw new Error("Bundle setup is unavailable."); },
    renameBundle: async () => {}, detachBundle: async () => {},
  };
  const supportsNativeFolderPicker = Boolean(window.folio?.selectFolder);
  const titleId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const [destination, setDestination] = useState<"new" | "existing">("new");
  const [destinationBundleId, setDestinationBundleId] = useState("");
  const [source, setSource] = useState<"empty" | "existing" | "obsidian">(obsidianImport.scan ? "obsidian" : "empty");
  const [bundleName, setBundleName] = useState("");
  const [parentPath, setParentPath] = useState("");
  const [sourcePath, setSourcePath] = useState("");
  const [bundleBusy, setBundleBusy] = useState(false);
  const [bundleError, setBundleError] = useState("");
  const [renamingBundleId, setRenamingBundleId] = useState<string | null>(null);
  const [renamingName, setRenamingName] = useState("");

  async function submitBundle(event: FormEvent) {
    event.preventDefault();
    setBundleBusy(true);
    setBundleError("");
    try {
      await setup.setupBundle({
        destination,
        source,
        name: bundleName,
        ...(destination === "existing" ? { bundleId: destinationBundleId } : {}),
        ...(destination === "new" && source === "existing" ? { sourcePath } : {}),
        ...(destination === "new" && source !== "existing" && parentPath ? { parentPath } : {}),
        ...(source === "obsidian" && obsidianImport.scan ? { scanId: obsidianImport.scan.id } : {}),
      });
      if (source === "obsidian" && obsidianImport.scan && !obsidianImport.job)
        await obsidianImport.confirmImport();
      setBundleName("");
      setParentPath("");
      setSourcePath("");
    } catch (error) {
      setBundleError(error instanceof Error ? error.message : "Could not set up bundle.");
    } finally {
      setBundleBusy(false);
    }
  }

  useEffect(() => {
    if (source === "obsidian" && obsidianImport.scan && !bundleName)
      setBundleName(obsidianImport.scan.name);
  }, [bundleName, obsidianImport.scan, source]);

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
        <section className="settings-section" aria-labelledby={`${titleId}-backup`}>
          <div className="settings-section-copy">
            <h2 id={`${titleId}-backup`}>Backup</h2>
            <p>
              Download the complete Folio bundle as a ZIP file. We recommend
              making a backup before importing an Obsidian vault.
            </p>
          </div>
          <div className="settings-import-actions">
            <a className="settings-action" href={`/api/backup${getActiveBundleId() ? `?bundle=${encodeURIComponent(getActiveBundleId() as string)}` : ""}`}>
              Download bundle backup
            </a>
          </div>
        </section>
        <section className="settings-section settings-bundles-section" aria-labelledby={`${titleId}-bundles`}>
          <div className="settings-section-copy">
            <h2 id={`${titleId}-bundles`}>Bundles</h2>
            <p>Add or import bundle. Choose where the Markdown lives and what Folio should do with it.</p>
          </div>
          {setup.error ? <p className="settings-import-error" role="alert">{setup.error}</p> : null}
          <div className="bundle-list" role="list" aria-label="Bundles">
            {setup.bundles.map((bundle) => (
              <div className={`bundle-row ${bundle.id === setup.activeBundleId ? "active" : ""}`} key={bundle.id} role="listitem">
                {renamingBundleId === bundle.id ? (
                  <form onSubmit={(event) => {
                    event.preventDefault();
                    setBundleError("");
                    void setup.renameBundle(bundle.id, renamingName)
                      .then(() => setRenamingBundleId(null))
                      .catch((error) => setBundleError(error instanceof Error ? error.message : "Could not rename bundle."));
                  }}>
                    <input value={renamingName} onChange={(event) => setRenamingName(event.target.value)} aria-label={`Rename ${bundle.name}`} autoFocus />
                    <button type="submit">Save</button>
                  </form>
                ) : <button type="button" onClick={() => setup.selectBundle(bundle.id)} aria-pressed={bundle.id === setup.activeBundleId}>
                  <strong>{bundle.name}</strong><small>{bundle.markdownPath}</small>
                </button>}
                <button type="button" onClick={() => { setRenamingBundleId(bundle.id); setRenamingName(bundle.name); }}>Rename</button>
                <button type="button" onClick={() => {
                  setBundleError("");
                  void setup.detachBundle(bundle.id).catch((error) => setBundleError(error instanceof Error ? error.message : "Could not detach bundle."));
                }}>Detach</button>
              </div>
            ))}
          </div>
          <form className="bundle-setup-form" onSubmit={(event) => void submitBundle(event)}>
            <label>Destination
              <select value={destination} onChange={(event) => {
                const next = event.target.value as "new" | "existing";
                setDestination(next);
                if (next === "existing") {
                  setSource("obsidian");
                  setDestinationBundleId(setup.activeBundleId || setup.bundles[0]?.id || "");
                }
              }}>
                <option value="new">New bundle</option><option value="existing">Existing bundle</option>
              </select>
            </label>
            {destination === "existing" ? (
              <label>Bundle
                <select value={destinationBundleId} onChange={(event) => setDestinationBundleId(event.target.value)} required>
                  <option value="">Choose a bundle</option>
                  {setup.bundles.map((bundle) => <option value={bundle.id} key={bundle.id}>{bundle.name}</option>)}
                </select>
              </label>
            ) : null}
            <label>Source
              <select value={source} onChange={(event) => setSource(event.target.value as "empty" | "existing" | "obsidian")}>
                <option value="empty" disabled={destination === "existing"}>Empty</option><option value="existing" disabled={destination === "existing"}>Markdown folder</option><option value="obsidian">Obsidian vault</option>
              </select>
            </label>
            {destination === "new" ? <label>Name<input value={bundleName} onChange={(event) => setBundleName(event.target.value)} required placeholder={source === "obsidian" ? "Vault name" : "Bundle name"} /></label> : null}
            {destination === "new" && source === "existing" ? <label>Markdown folder<input value={sourcePath} onChange={(event) => setSourcePath(event.target.value)} placeholder="/path/to/folder" required disabled={!supportsNativeFolderPicker} /></label> : null}
            {destination === "new" && source !== "existing" ? <label>Parent folder<input value={parentPath} onChange={(event) => setParentPath(event.target.value)} placeholder="Default Folio location" disabled={!supportsNativeFolderPicker} /></label> : null}
            <div className="settings-import-actions">
              <button type="button" onClick={() => {
                if (source === "obsidian") {
                  obsidianImport.selectVault();
                  return;
                }
                void selectBundleFolder().then((path) => {
                  if (!path) return;
                  if (source === "existing" && destination === "new") setSourcePath(path);
                  else setParentPath(path);
                  if (destination === "new" && source === "existing") {
                    const selectedName = path.split(/[\\/]/).filter(Boolean).pop();
                    if (selectedName) setBundleName(selectedName);
                  }
                });
              }} disabled={source === "obsidian" ? (!obsidianImport.supported || obsidianImport.busy) : !supportsNativeFolderPicker}>{source === "obsidian" ? "Choose Obsidian vault" : "Choose folder"}</button>
              {source !== "obsidian" && !supportsNativeFolderPicker ? <small className="settings-import-message">Custom folder paths require Folio desktop; browser folder handles are not sent as paths.</small> : null}
              <button type="submit" className="primary" disabled={bundleBusy || (source === "obsidian" && !obsidianImport.scan)}>{bundleBusy ? "Setting up…" : "Add or import bundle"}</button>
            </div>
            {bundleError ? <p className="settings-import-error" role="alert">{bundleError}</p> : null}
            {obsidianImport.error ? <p className="settings-import-error" role="alert">{obsidianImport.error}</p> : null}
            {source === "obsidian" && obsidianImport.scan ? (
              <div className="settings-import-summary">
                <strong>{obsidianImport.scan.name}</strong>
                <span>Folio will archive the originals and import {obsidianImport.scan.counts.new + obsidianImport.scan.counts.retryable} notes. This is the only confirmation.</span>
                {obsidianImport.job ? <p className="settings-import-message" aria-live="polite">{obsidianImport.job.phase} · {obsidianImport.job.processed} of {obsidianImport.job.total}</p> : null}
                {obsidianImport.job && !["completed", "cancelled", "failed"].includes(obsidianImport.job.phase) ? <button type="button" onClick={obsidianImport.cancelImport}>Cancel after current note</button> : null}
              </div>
            ) : null}
          </form>
        </section>
      </aside>
    </div>
  );
}
