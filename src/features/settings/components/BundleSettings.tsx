import { useId, useState } from "react";
import type { FormEvent } from "react";
import type { Bundle } from "../../../domain/types.ts";
import type { BundleSetupInput } from "../hooks/useBundleSetup.ts";
import type { ObsidianImportSettings } from "../model/obsidian-import.ts";
import { selectBundleFolder } from "../model/bundle-picker.ts";

export type BundleSettingsControls = {
  bundles: Bundle[];
  activeBundleId: string | null;
  error: string;
  selectBundle: (id: string) => void;
  setupBundle: (input: BundleSetupInput) => Promise<Bundle>;
  renameBundle: (id: string, name: string) => Promise<void>;
  detachBundle: (id: string) => Promise<void>;
};

const SOURCES = [
  {
    id: "empty",
    mark: "+",
    title: "Start fresh",
    description: "A home for new notes",
  },
  {
    id: "existing",
    mark: "↗",
    title: "Markdown folder",
    description: "Open your files in place",
  },
  {
    id: "obsidian",
    mark: "◇",
    title: "Obsidian vault",
    description: "Bring your notes into Folio",
  },
] as const;

function BundleRow({
  bundle,
  active,
  controls,
  onError,
}: {
  bundle: Bundle;
  active: boolean;
  controls: BundleSettingsControls;
  onError: (message: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(bundle.name);
  const [confirmDetach, setConfirmDetach] = useState(false);
  const [busy, setBusy] = useState(false);

  async function mutate(action: () => Promise<void>) {
    setBusy(true);
    onError("");
    try {
      await action();
      setEditing(false);
      setConfirmDetach(false);
    } catch (error) {
      onError(
        error instanceof Error ? error.message : "Could not update bundle.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`bundle-row${active ? " active" : ""}`} role="listitem">
      {editing ? (
        <form
          className="bundle-rename"
          onSubmit={(event) => {
            event.preventDefault();
            void mutate(() => controls.renameBundle(bundle.id, name));
          }}
        >
          <label className="sr-only" htmlFor={`rename-${bundle.id}`}>
            Rename {bundle.name}
          </label>
          <input
            id={`rename-${bundle.id}`}
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoFocus
            required
            disabled={busy}
          />
          <button
            type="submit"
            className="bundle-text-action"
            disabled={busy || !name.trim()}
          >
            Save
          </button>
          <button
            type="button"
            className="bundle-text-action"
            disabled={busy}
            onClick={() => setEditing(false)}
          >
            Cancel
          </button>
        </form>
      ) : (
        <>
          <button
            className="bundle-select"
            type="button"
            onClick={() => controls.selectBundle(bundle.id)}
            aria-pressed={active}
          >
            <span className="bundle-symbol" aria-hidden="true">
              ▱
            </span>
            <span className="bundle-identity">
              <span className="bundle-name">
                {bundle.name}
                {active ? (
                  <span className="bundle-active-label">Active</span>
                ) : null}
              </span>
              <span className="bundle-path" title={bundle.markdownPath}>
                {bundle.markdownPath}
              </span>
            </span>
          </button>
          <div className="bundle-row-actions">
            <button
              type="button"
              className="bundle-text-action"
              onClick={() => {
                setName(bundle.name);
                setEditing(true);
                setConfirmDetach(false);
              }}
              aria-label={`Rename ${bundle.name}`}
            >
              Rename
            </button>
            <button
              type="button"
              className="bundle-text-action"
              onClick={() => setConfirmDetach(!confirmDetach)}
              aria-label={`Detach ${bundle.name}`}
              aria-expanded={confirmDetach}
            >
              Detach
            </button>
          </div>
        </>
      )}
      {confirmDetach ? (
        <div className="bundle-detach-confirm">
          <p>
            Remove <strong>{bundle.name}</strong> from Folio? Its files and
            saved workspace will be kept.
          </p>
          <div>
            <button
              type="button"
              className="bundle-text-action"
              disabled={busy}
              onClick={() => setConfirmDetach(false)}
            >
              Keep bundle
            </button>
            <button
              type="button"
              className="bundle-text-action danger"
              disabled={busy}
              onClick={() =>
                void mutate(() => controls.detachBundle(bundle.id))
              }
            >
              {busy ? "Detaching…" : "Detach bundle"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function BundleSettings({
  controls,
  obsidianImport,
}: {
  controls: BundleSettingsControls;
  obsidianImport: ObsidianImportSettings;
}) {
  const id = useId();
  const [open, setOpen] = useState(
    Boolean(obsidianImport.scan) || controls.bundles.length === 0,
  );
  const [source, setSource] = useState<BundleSetupInput["source"]>(
    obsidianImport.scan ? "obsidian" : "empty",
  );
  const [destination, setDestination] = useState<"new" | "existing">("new");
  const [destinationId, setDestinationId] = useState(
    controls.activeBundleId || controls.bundles[0]?.id || "",
  );
  const [name, setName] = useState<string | null>(null);
  const [sourcePath, setSourcePath] = useState("");
  const [parentPath, setParentPath] = useState("");
  const [customLocation, setCustomLocation] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const nativePicker = Boolean(window.folio?.selectFolder);
  const bundleName =
    name ??
    (source === "obsidian"
      ? obsidianImport.scan?.name || ""
      : sourcePath.split(/[\\/]/).filter(Boolean).pop() || "");
  const job = obsidianImport.job;
  const importRunning = Boolean(
    job && !["completed", "cancelled", "failed"].includes(job.phase),
  );
  const locked = busy || obsidianImport.busy || importRunning;
  const effectiveDestination: "new" | "existing" =
    destination === "existing" && controls.bundles.length === 0
      ? "new"
      : destination;
  const effectiveDestinationId =
    effectiveDestination === "existing" &&
    controls.bundles.some((bundle) => bundle.id === destinationId)
      ? destinationId
      : controls.activeBundleId || controls.bundles[0]?.id || "";

  async function chooseFolder(forSource: boolean) {
    setError("");
    try {
      const path = await selectBundleFolder();
      if (path) {
        if (forSource) setSourcePath(path);
        else setParentPath(path);
      }
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Could not select folder.",
      );
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const bundle = await controls.setupBundle({
        destination: effectiveDestination,
        source,
        name: bundleName,
        ...(effectiveDestination === "existing"
          ? { bundleId: effectiveDestinationId }
          : {}),
        ...(source === "existing" ? { markdownPath: sourcePath } : {}),
        ...(customLocation &&
        source !== "existing" &&
        effectiveDestination === "new"
          ? { parentPath }
          : {}),
        ...(source === "obsidian" && obsidianImport.scan
          ? { scanId: obsidianImport.scan.id }
          : {}),
      });
      if (source === "obsidian" && obsidianImport.scan && !job) {
        setDestination("existing");
        setDestinationId(bundle.id);
        await obsidianImport.confirmImport();
      }
      if (source !== "obsidian") {
        setOpen(false);
        setName(null);
        setSourcePath("");
        setParentPath("");
        setCustomLocation(false);
        setSuccess(`${bundle.name} is ready.`);
      }
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Could not set up bundle.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className="settings-section settings-bundles-section"
      aria-labelledby={`${id}-title`}
    >
      <div className="settings-section-heading">
        <div className="settings-section-copy">
          <h2 id={`${id}-title`}>Bundles</h2>
          <p>
            Separate spaces for your notes. Each remembers where you left off.
          </p>
        </div>
        {!open ? (
          <button
            type="button"
            className="settings-action primary"
            onClick={() => {
              setOpen(true);
              setSuccess("");
            }}
          >
            Add or import bundle
          </button>
        ) : null}
      </div>
      {controls.error || error ? (
        <p className="settings-import-error" role="alert">
          {controls.error || error}
        </p>
      ) : null}
      {controls.bundles.length ? (
        <div className="bundle-list" role="list" aria-label="Bundles">
          {controls.bundles.map((bundle) => (
            <BundleRow
              key={bundle.id}
              bundle={bundle}
              active={bundle.id === controls.activeBundleId}
              controls={controls}
              onError={setError}
            />
          ))}
        </div>
      ) : (
        <div className="bundle-empty">
          <span aria-hidden="true">▱</span>
          <div>
            <strong>Your first bundle starts here</strong>
            <p>
              Create a space for new notes, or bring a folder you already have.
            </p>
          </div>
        </div>
      )}
      {success ? (
        <p className="bundle-success" role="status">
          ✓ {success}
        </p>
      ) : null}
      {open ? (
        <form
          className="bundle-setup-form"
          onSubmit={(event) => void submit(event)}
        >
          <div className="bundle-setup-heading">
            <div>
              <span className="settings-eyebrow">Bundle setup</span>
              <h3>Where would you like to start?</h3>
            </div>
            {controls.bundles.length > 0 && !locked ? (
              <button
                type="button"
                className="bundle-text-action"
                onClick={() => setOpen(false)}
              >
                Cancel
              </button>
            ) : null}
          </div>
          <fieldset className="bundle-source-options" disabled={locked}>
            <legend className="sr-only">Source</legend>
            {SOURCES.map((option) => (
              <label
                key={option.id}
                className={`bundle-source-option${source === option.id ? " selected" : ""}`}
              >
                <input
                  type="radio"
                  name={`${id}-source`}
                  value={option.id}
                  checked={source === option.id}
                  onChange={() => {
                    setSource(option.id);
                    setDestination("new");
                    setSourcePath("");
                    setParentPath("");
                    setCustomLocation(false);
                    setName(null);
                    setError("");
                  }}
                />
                <span className="bundle-source-mark" aria-hidden="true">
                  {option.mark}
                </span>
                <strong>{option.title}</strong>
                <small>{option.description}</small>
              </label>
            ))}
          </fieldset>
          <div className="bundle-setup-fields">
            {source === "existing" ? (
              <div className="bundle-field">
                <label htmlFor={`${id}-folder`}>Markdown folder</label>
                <div className="bundle-path-control">
                  <input
                    id={`${id}-folder`}
                    value={sourcePath}
                    readOnly
                    placeholder="Choose a folder on your computer"
                    required
                  />
                  <button
                    type="button"
                    className="settings-action"
                    disabled={!nativePicker || locked}
                    onClick={() => void chooseFolder(true)}
                  >
                    Choose folder
                  </button>
                </div>
                <p>
                  Your Markdown stays in this folder. Other files are left
                  untouched.
                </p>
                {!nativePicker ? (
                  <p>Open Folio desktop to connect a local Markdown folder.</p>
                ) : null}
              </div>
            ) : null}
            {source === "obsidian" ? (
              <div className="bundle-vault-picker">
                <div>
                  <strong>
                    {obsidianImport.scan?.name || "Choose your Obsidian vault"}
                  </strong>
                  <p>
                    {obsidianImport.scan
                      ? "Vault scanned and ready to review below."
                      : "Select a vault to preview what will be imported."}
                  </p>
                </div>
                <button
                  type="button"
                  className="settings-action"
                  disabled={!obsidianImport.supported || locked}
                  onClick={obsidianImport.selectVault}
                >
                  {obsidianImport.busy && !job
                    ? "Scanning…"
                    : obsidianImport.scan
                      ? "Change vault"
                      : "Choose Obsidian vault"}
                </button>
                {!obsidianImport.supported ? (
                  <p>
                    Vault selection is unavailable in this browser. Use Folio
                    desktop.
                  </p>
                ) : null}
              </div>
            ) : null}
            {source === "obsidian" && controls.bundles.length > 0 ? (
              <div className="bundle-field">
                <label htmlFor={`${id}-destination`}>Import into</label>
                <select
                  id={`${id}-destination`}
                  value={
                    effectiveDestination === "new"
                      ? "new"
                      : effectiveDestinationId
                  }
                  disabled={locked}
                  onChange={(event) => {
                    const value = event.target.value;
                    setDestination(value === "new" ? "new" : "existing");
                    if (value !== "new") setDestinationId(value);
                  }}
                >
                  <option value="new">A new bundle</option>
                  {controls.bundles.map((bundle) => (
                    <option key={bundle.id} value={bundle.id}>
                      {bundle.name}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            {effectiveDestination === "new" ? (
              <div className="bundle-field">
                <label htmlFor={`${id}-name`}>Name</label>
                <input
                  id={`${id}-name`}
                  value={bundleName}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="e.g. Personal notes"
                  required
                  disabled={locked}
                  autoComplete="off"
                />
              </div>
            ) : null}
            {effectiveDestination === "new" && source !== "existing" ? (
              <div className="bundle-field">
                <label htmlFor={`${id}-location`}>Location</label>
                <select
                  id={`${id}-location`}
                  value={customLocation ? "custom" : "default"}
                  disabled={locked}
                  onChange={(event) =>
                    setCustomLocation(event.target.value === "custom")
                  }
                >
                  <option value="default">Default Folio location</option>
                  <option value="custom" disabled={!nativePicker}>
                    Custom folder{!nativePicker ? " · desktop only" : ""}
                  </option>
                </select>
                {customLocation ? (
                  <>
                    <div className="bundle-path-control">
                      <input
                        aria-label="Parent folder"
                        value={parentPath}
                        readOnly
                        placeholder="Choose a parent folder"
                        required
                      />
                      <button
                        type="button"
                        className="settings-action"
                        disabled={locked}
                        onClick={() => void chooseFolder(false)}
                      >
                        Choose folder
                      </button>
                    </div>
                    <p>
                      A new folder
                      {bundleName
                        ? ` named “${bundleName}”`
                        : " with your bundle’s name"}{" "}
                      will be created here.
                    </p>
                  </>
                ) : (
                  <p>Folio manages this bundle’s folder for you.</p>
                )}
              </div>
            ) : null}
          </div>
          {source === "obsidian" && obsidianImport.scan ? (
            <div className="settings-import-summary">
              <strong>Ready to import</strong>
              <dl>
                <div>
                  <dt>Notes to import</dt>
                  <dd>
                    {obsidianImport.scan.counts.new +
                      obsidianImport.scan.counts.retryable}
                  </dd>
                </div>
                <div>
                  <dt>Already imported</dt>
                  <dd>{obsidianImport.scan.counts.imported}</dd>
                </div>
                <div>
                  <dt>Attachments</dt>
                  <dd>{obsidianImport.scan.counts.attachments}</dd>
                </div>
                <div>
                  <dt>Need attention</dt>
                  <dd>
                    {obsidianImport.scan.counts.invalid +
                      obsidianImport.scan.counts.changed}
                  </dd>
                </div>
              </dl>
              <p>
                Folio archives the originals before importing. Your source vault
                stays intact.
              </p>
            </div>
          ) : null}
          {obsidianImport.error && source === "obsidian" ? (
            <p className="settings-import-error" role="alert">
              {obsidianImport.error}
            </p>
          ) : null}
          {source === "obsidian" && job ? (
            <div
              className="settings-import-progress"
              role="status"
              aria-live="polite"
            >
              <div>
                <strong>
                  {job.phase === "completed"
                    ? "Import complete"
                    : job.phase === "failed"
                      ? "Import needs attention"
                      : job.phase === "cancelled"
                        ? "Import paused"
                        : "Importing your notes"}
                </strong>
                <span>
                  {job.processed} / {job.total}
                </span>
              </div>
              <progress
                value={job.processed}
                max={Math.max(1, job.total)}
                aria-label="Import progress"
              />
              <p>
                {job.error ||
                  (job.phase === "completed"
                    ? `${job.imported} notes imported. You can find them in the Explorer.`
                    : importRunning
                      ? "You can close Settings and keep working. The import will continue."
                      : "Your imported notes are safe. Choose the vault again to retry remaining notes.")}
              </p>
              {importRunning ? (
                <button
                  type="button"
                  className="bundle-text-action"
                  onClick={obsidianImport.cancelImport}
                >
                  Cancel after current note
                </button>
              ) : null}
            </div>
          ) : null}
          <div className="bundle-setup-footer">
            <p>
              {source === "existing"
                ? "Connect this folder without moving any files."
                : source === "obsidian"
                  ? "Review the preview, then start the import."
                  : "A fresh workspace, ready for your first note."}
            </p>
            <button
              type="submit"
              className="settings-action primary"
              disabled={
                locked ||
                (source === "obsidian" &&
                  (!obsidianImport.scan || Boolean(job))) ||
                (source === "existing" && !sourcePath) ||
                (customLocation && !parentPath) ||
                (effectiveDestination === "existing" && !effectiveDestinationId)
              }
            >
              {busy
                ? "Setting up…"
                : source === "obsidian"
                  ? "Start import"
                  : source === "existing"
                    ? "Open bundle"
                    : "Create bundle"}
            </button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
