import { useEffect, useId, useState } from "react";
import type { DesktopUpdateState, MlxModelId, MlxStatus, VersionInfo } from "../../domain/types.ts";
import { selectedWorkspaceModelCatalog, formatModelBytes } from "../workspace/model/model-catalog.ts";
import type { SettingsCategory } from "../settings/model/settings-category.ts";
import { useModelPanelCollapse } from "../workspace/hooks/useModelPanelCollapse.ts";
import { ModelDownloadProgress } from "../workspace/components/ModelDownloadProgress.tsx";

export type WorkspaceStatusProps = {
  mlxStatus: MlxStatus | null;
  mlxActionModel: MlxModelId | null;
  mlxAction?: string | null;
  modelError?: string;
  onInstallMlxModel: (id: MlxModelId) => void;
  onToggleMlxModel: (id: MlxModelId, loaded: boolean) => void;
  onOpenSettings?: (category?: SettingsCategory) => void;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
};

const FIRST_OPEN_SETTINGS_KEY = "folio:model-setup-prompt-seen";

type FirstOpenSettingsPromptProps = {
  mlxStatus: MlxStatus | null;
  onOpenSettings?: (category?: SettingsCategory) => void;
};

function FirstOpenSettingsPrompt({ mlxStatus, onOpenSettings }: FirstOpenSettingsPromptProps) {
  const [alreadySeen] = useState(() => {
    try { return window.localStorage.getItem(FIRST_OPEN_SETTINGS_KEY) === "1"; }
    catch { return false; }
  });
  const [decision, setDecision] = useState<{ resolved: boolean; show: boolean }>({ resolved: false, show: false });

  if (!decision.resolved && mlxStatus) {
    const selectedInstalled = mlxStatus.models.some((model) => model.id === mlxStatus.selectedGenerationModel && model.installed);
    setDecision({ resolved: true, show: !alreadySeen && !selectedInstalled });
  }

  useEffect(() => {
    if (!decision.resolved) return;
    try { window.localStorage.setItem(FIRST_OPEN_SETTINGS_KEY, "1"); }
    catch { /* settings remain available when browser storage is disabled */ }
  }, [decision.resolved]);

  if (!decision.show || !onOpenSettings) return null;
  return (
    <button className="mlx-model-settings-link" type="button" onClick={() => {
      setDecision((current) => ({ ...current, show: false }));
      onOpenSettings("models");
    }}>Open model settings</button>
  );
}

export function FolioBrand() {
  return (
    <div className="brand-group">
      <a className="brand" href="#workspace" aria-label="Folio home">
        <span className="brand-mark" aria-hidden="true">F</span>
        <span>Folio</span>
      </a>
    </div>
  );
}

export function DesktopUpdateControls({ versionInfo, updateState }: { versionInfo: VersionInfo | null; updateState: DesktopUpdateState | null }) {

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
    <div className="desktop-update-controls">
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
  collapsed: controlledCollapsed,
  onToggleCollapsed,
}: WorkspaceStatusProps) {
  const localCollapse = useModelPanelCollapse();
  const collapsed = controlledCollapsed ?? localCollapse.collapsed;
  const toggleCollapsed = onToggleCollapsed ?? localCollapse.toggleCollapsed;
  const bodyId = useId();
  const available = Boolean(mlxStatus?.available && mlxStatus.helperAvailable);
  const stateText = !mlxStatus ? "Checking" : available ? "Available" : "Unavailable";
  const visibleModelCatalog = selectedWorkspaceModelCatalog(mlxStatus, mlxActionModel, mlxAction);
  const visibleModelIds = new Set(visibleModelCatalog.map(({ id }) => id));
  const runningModels = available ? mlxStatus?.models.filter((model) => visibleModelIds.has(model.id) && model.loaded) ?? [] : [];
  const runningSummary = available ? `${runningModels.length} running` : stateText.toLowerCase();
  const runningDetails = runningModels.map((model) => `${model.name}${model.busy || model.requestCount ? " (in use)" : ""}`).join(", ");
  return (
    <section className={`mlx-status${collapsed ? " is-collapsed" : ""}`} aria-label="MLX model management">
      <div className="model-status-header">
        <button
          className="model-status-disclosure"
          type="button"
          aria-label={collapsed ? "Expand models" : "Collapse models"}
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          onClick={toggleCollapsed}
        >
          <span className={`model-status ${available ? "online" : ""}`}>
            <span className="status-dot" aria-hidden="true" />
            {collapsed ? <span className="model-status-summary" role="status" title={runningDetails || stateText} aria-label={`MLX ${runningSummary}${runningDetails ? `: ${runningDetails}` : ""}`}>MLX · {runningSummary}</span> : <span>MLX {stateText.toLowerCase()}</span>}
          </span>
          <svg className="model-disclosure-chevron" aria-hidden="true" viewBox="0 0 16 16"><path d={collapsed ? "m4 10 4-4 4 4" : "m4 6 4 4 4-4"} /></svg>
        </button>
        <div className="model-status-controls">
          {onOpenSettings ? <button className="model-manage-link" type="button" onClick={() => onOpenSettings("models")}>Manage</button> : null}
        </div>
      </div>
      <div className="mlx-model-panel-body" id={bodyId} hidden={collapsed}>
        <FirstOpenSettingsPrompt mlxStatus={mlxStatus} onOpenSettings={onOpenSettings} />
        <div className="mlx-model-list" role="group" aria-label="Models, active first" tabIndex={0}>
          {visibleModelCatalog.map((definition) => {
            const { id } = definition;
            const model = mlxStatus?.models.find((item) => item.id === id);
            const download = mlxStatus?.downloads.find((item) => item.id === id)?.progress;
            const installing = Boolean(mlxStatus?.installing.includes(id));
            const acting = mlxActionModel === id;
            const downloading = Boolean(download) || (!model?.installed && (installing || (acting && mlxAction === "install") || Boolean(model?.loading)));
            const loading = Boolean(model?.loading || installing || acting);
            const busy = Boolean(model?.busy || model?.requestCount);
            const loaded = Boolean(model?.loaded && available);
            const installed = Boolean(model?.installed);
            const launchMemory = formatModelBytes(model?.downloadSizeBytes ?? definition.bytes);
            const name = model?.name || definition.name;
            const modelState = !mlxStatus ? "Checking status"
              : loading ? download?.phase === "loading" ? "Loading" : download?.phase === "downloading" || (acting && mlxAction === "install") ? "Downloading" : acting && mlxAction === "unload" ? "Unloading" : acting && mlxAction === "remove" ? "Removing" : acting && (mlxAction === "select" || mlxAction === "select-transcription") ? "Selecting" : "Loading"
              : !available ? "Unavailable"
              : busy ? "In use"
              : loaded ? "Running"
              : installed ? "Stopped" : "Not installed";
            const downloadPercent = downloading && download?.phase === "downloading"
              && Number.isFinite(download.downloadedBytes) && download.downloadedBytes > 0
              && Number.isFinite(download.totalBytes) && download.totalBytes > 0
              && Number.isFinite(download.percent) ? ` ${download.percent}%` : "";
            const actionLabel = installed && available ? `${loaded ? "Stop" : "Start"} ${name}` : `Manage ${name}`;
            const disabled = installed && available ? loading || busy || mlxActionModel !== null : !onOpenSettings;
            const memory = loaded ? model?.memory : null;
            return (
              <button
                className={`mlx-model mlx-model-${id}${loaded ? " is-loaded" : ""}${installed && available && !loaded && !loading ? " is-stopped" : ""}${!installed || !available ? " is-dormant" : ""}${loading || busy ? " is-working" : ""}`}
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
                <span className={`mlx-model-state${loaded ? " online" : ""}`}><span className="model-state-mark" aria-hidden="true">{loaded || loading ? "▶" : installed ? "■" : "↓"}</span>{modelState}{downloadPercent}</span>
                <span className="mlx-model-details" id={`model-details-${id}`}>
                  {memory ? <span title={`Active memory ${formatModelBytes(memory.activeBytes)} · ${formatModelBytes(memory.cacheBytes)} allocator cache · ${formatModelBytes(memory.peakResidentBytes)} peak process`}>{formatModelBytes(memory.activeBytes)} active</span>
                    : <span title={`Estimated launch memory, based on the approximate download size (${launchMemory}).`}>~{launchMemory} on launch</span>}
                  {!installed ? <span>{model?.downloadSizeIsEstimate ?? true ? "About " : ""}{launchMemory} download</span>
                    : busy ? <span>Processing locally</span>
                    : <span>{!available ? "Manage in settings" : loaded ? "Ready on device" : "Click to load"}</span>}
                  {busy ? <span>{model?.requestCount ? `${model.requestCount} active request${model.requestCount === 1 ? "" : "s"}` : "Request in progress"}</span> : null}
                </span>
                {downloading ? <ModelDownloadProgress modelName={name} progress={download} /> : null}
              </button>
            );
          })}
        </div>
        <p className="model-status-hint">Active first. Click to load or release memory.</p>
      </div>
      {modelError ? <p className="model-status-error" role="alert">{modelError}</p> : null}
    </section>
  );
}
