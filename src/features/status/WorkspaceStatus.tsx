import { useEffect, useState } from "react";
import type { DesktopUpdateState, MlxModelId, MlxStatus, VersionInfo } from "../../domain/types.ts";
import { orderedModelCatalog, formatModelBytes } from "../workspace/model/model-catalog.ts";
import type { SettingsCategory } from "../settings/model/settings-category.ts";

export type WorkspaceStatusProps = {
  mlxStatus: MlxStatus | null;
  mlxActionModel: MlxModelId | null;
  mlxAction?: string | null;
  modelError?: string;
  onInstallMlxModel: (id: MlxModelId) => void;
  onToggleMlxModel: (id: MlxModelId, loaded: boolean) => void;
  onOpenSettings?: (category?: SettingsCategory) => void;
};

export function FolioBrand({ versionInfo }: { versionInfo: VersionInfo | null }) {
  const [updateState, setUpdateState] = useState<DesktopUpdateState | null>(null);
  useEffect(() => {
    let receivedEvent = false;
    let mounted = true;
    const unsubscribe = window.folio?.onUpdateState?.((state) => {
      receivedEvent = true;
      setUpdateState(state);
    });
    const getUpdateState = window.folio?.getUpdateState;
    if (getUpdateState) {
      void Promise.resolve().then(getUpdateState).then((state) => {
        if (mounted && !receivedEvent && state) setUpdateState(state);
      }).catch(() => {});
    }
    return () => {
      mounted = false;
      unsubscribe?.();
    };
  }, []);

  const startDesktopUpdate = updateState ? window.folio?.startUpdate : undefined;
  const updateVersion = updateState?.version ?? (versionInfo?.updateAvailable ? versionInfo.latest : null);
  const nativeUpdateAvailable = Boolean(
    updateState && updateVersion && updateState.status !== "idle",
  );
  const busy = updateState?.status === "checking" || updateState?.status === "downloading" || updateState?.status === "downloaded" || updateState?.status === "staging" || updateState?.status === "installing";
  const updateLabel = updateState?.status === "error"
    ? "Retry update"
    : updateState?.status === "checking"
      ? "Checking…"
    : updateState?.status === "installing" || updateState?.status === "downloaded"
      ? "Restarting…"
      : updateState?.status === "staging"
        ? "Preparing install…"
      : updateState?.status === "downloading"
        ? `Downloading ${updateState.percent ?? 0}%`
        : "Download update";

  return (
    <div className="brand-group">
      <a className="brand" href="#workspace" aria-label="Folio home">
        <span className="brand-mark" aria-hidden="true">F</span>
        <span>Folio</span>
      </a>
      {versionInfo && <span className="app-version">v{versionInfo.version}</span>}
      {nativeUpdateAvailable && startDesktopUpdate ? (
          <button
            className={`update-badge${busy ? " is-busy" : ""}`}
            type="button"
            onClick={() => { void startDesktopUpdate(); }}
            disabled={busy}
            aria-label={`${updateLabel}: version ${updateVersion}`}
            title={updateState?.error ?? `Download and install v${updateVersion}`}
          >
            {busy && <span className="update-spinner" aria-hidden="true" />}
            {updateState?.status === "error" || busy ? updateLabel : `Update to v${updateVersion}`}
          </button>
      ) : versionInfo?.updateAvailable ? (
          <a
            className="update-badge"
            href={versionInfo.latestUrl}
            target="_blank"
            rel="noreferrer"
            aria-label={`Update to version ${versionInfo.latest}`}
            title={`Update to v${versionInfo.latest}`}
          >
            Update to v{versionInfo.latest}
          </a>
      ) : null}
    </div>
  );
}

export function MlxModelStatusPanel({
  mlxStatus,
  mlxActionModel,
  mlxAction,
  modelError,
  onToggleMlxModel,
  onOpenSettings,
}: WorkspaceStatusProps) {
  const [showFirstOpenSettings, setShowFirstOpenSettings] = useState(false);
  useEffect(() => {
    if (!mlxStatus) return;
    try {
      if (window.localStorage.getItem("folio:model-setup-prompt-seen") === "1") return;
      const selectedInstalled = mlxStatus.models.some((model) => model.id === mlxStatus.selectedGenerationModel && model.installed);
      window.localStorage.setItem("folio:model-setup-prompt-seen", "1");
      setShowFirstOpenSettings(!selectedInstalled);
    } catch {
      setShowFirstOpenSettings(!mlxStatus.models.some((model) => model.id === mlxStatus.selectedGenerationModel && model.installed));
    }
  }, [mlxStatus]);
  const available = Boolean(mlxStatus?.available && mlxStatus.helperAvailable);
  const stateText = !mlxStatus ? "Checking" : available ? "Available" : "Unavailable";
  return (
    <section className="mlx-status" aria-label="MLX model management">
      <div className="model-status-header">
        <div className={`model-status ${available ? "online" : ""}`}>
          <span className="status-dot" aria-hidden="true" />
          <span>MLX {stateText.toLowerCase()}</span>
        </div>
        {onOpenSettings ? <button className="model-manage-link" type="button" onClick={() => onOpenSettings("models")}>Manage</button> : null}
      </div>
      {showFirstOpenSettings && onOpenSettings ? (
        <button className="mlx-model-settings-link" type="button" onClick={() => { setShowFirstOpenSettings(false); onOpenSettings("models"); }}>Open model settings</button>
      ) : null}
      <div className="mlx-model-list" role="group" aria-label="Models, active first" tabIndex={0}>
        {orderedModelCatalog(mlxStatus, mlxActionModel, mlxAction).map((definition) => {
          const { id } = definition;
          const model = mlxStatus?.models.find((item) => item.id === id);
          const download = mlxStatus?.downloads.find((item) => item.id === id)?.progress;
          const installing = Boolean(mlxStatus?.installing.includes(id));
          const acting = mlxActionModel === id;
          const loading = Boolean(model?.loading || installing || acting);
          const busy = Boolean(model?.busy || model?.requestCount);
          const loaded = Boolean(model?.loaded && available);
          const installed = Boolean(model?.installed);
          const name = model?.name || definition.name;
          const modelState = !mlxStatus ? "Checking status"
            : loading ? download?.phase === "downloading" || (acting && mlxAction === "install") ? "Downloading" : acting && mlxAction === "unload" ? "Unloading" : acting && mlxAction === "remove" ? "Removing" : acting && mlxAction === "select" ? "Selecting" : "Loading"
            : !available ? "Unavailable"
            : busy ? "In use"
            : loaded ? "Running"
            : installed ? "Stopped" : "Not installed";
          const actionLabel = installed && available ? `${loaded ? "Stop" : "Start"} ${name}` : `Manage ${name}`;
          const disabled = installed && available ? loading || busy || mlxActionModel !== null : !onOpenSettings;
          const memory = loaded ? model?.memory : null;
          return (
            <button
              className={`mlx-model mlx-model-${id}${loaded ? " is-loaded" : ""}${!installed || !available ? " is-dormant" : ""}${loading || busy ? " is-working" : ""}`}
              key={id}
              type="button"
              aria-label={actionLabel}
              aria-pressed={installed && available ? loaded : undefined}
              aria-describedby={`model-details-${id}`}
              disabled={disabled}
              title={busy ? "This model is processing requests. Wait until it is idle to stop it." : installed && available ? `${loaded ? "Unload from" : "Load into"} memory. Folio also loads installed models when needed.` : "Open Models settings to download or manage this model."}
              onClick={() => installed && available ? onToggleMlxModel(id, loaded) : onOpenSettings?.("models")}
            >
              <span className="model-orbit" aria-hidden="true"><span className="model-blob" /><span className="model-blob-core" /></span>
              <span className="mlx-model-heading"><strong title={name}>{definition.gridName ?? name}</strong><span>{definition.purpose}{model?.selected ? " · Selected" : ""}</span></span>
              <span className={`mlx-model-state${loaded ? " online" : ""}`}>{modelState}{download ? ` ${download.percent}%` : ""}</span>
              <span className="mlx-model-details" id={`model-details-${id}`}>
                {memory ? <span title={`Memory ${formatModelBytes(memory.activeBytes)} active · ${formatModelBytes(memory.cacheBytes)} allocator cache · ${formatModelBytes(memory.peakResidentBytes)} peak process`}>{formatModelBytes(memory.activeBytes)} active memory</span>
                  : busy ? <span>Processing locally</span>
                  : installed ? <span>{!available ? "Manage in settings" : loaded ? "Ready on device" : "Click to load"}</span>
                  : <span>{model?.downloadSizeIsEstimate ?? true ? "About " : ""}{formatModelBytes(model?.downloadSizeBytes ?? definition.bytes)} download</span>}
                {busy ? <span>{model?.requestCount ? `${model.requestCount} active request${model.requestCount === 1 ? "" : "s"}` : "Request in progress"}</span> : null}
              </span>
            </button>
          );
        })}
      </div>
      {modelError ? <p className="model-status-error" role="alert">{modelError}</p> : null}
      <p className="model-status-hint">Active first. Click to load or release memory.</p>
    </section>
  );
}
