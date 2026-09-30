import { useEffect, useState } from "react";
import type { DesktopUpdateState, ModelStatus, VersionInfo } from "../../domain/types.ts";

export type Endpoint = {
  id: string;
  label: string;
  model: string | undefined;
  state: string;
};

export type WorkspaceStatusProps = {
  status: ModelStatus | null;
  missingModels: string[];
  modelInstallInProgress: boolean;
  modelEndpoints: Endpoint[];
  togglingService: string | null;
  onInstall: () => void;
  onToggle: (id: string, model?: string) => void;
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

export function OllamaStatus({
  status,
  missingModels,
  modelInstallInProgress,
  modelEndpoints,
  togglingService,
  onInstall,
  onToggle,
}: WorkspaceStatusProps) {
  return (
    <div className="ollama-status" aria-live="polite">
      <div className={`model-status ${status?.online ? "online" : ""}`}>
        <span className="status-dot" />
        <span>Ollama {status?.online ? "online" : "offline"}</span>
      </div>
      {!status ? (
        <span className="model-setup-copy">Checking local models...</span>
      ) : !status.online ? (
        <div className="model-setup">
          <span>Install or start Ollama first.</span>
          <a href="https://ollama.com/download" target="_blank" rel="noreferrer">
            Get Ollama
          </a>
          <button type="button" onClick={onInstall} disabled={modelInstallInProgress}>
            {modelInstallInProgress ? "Checking..." : "Set up"}
          </button>
        </div>
      ) : missingModels.length ? (
        <div className="model-setup">
          <span>
            {missingModels.length} local model{missingModels.length === 1 ? "" : "s"} required.
          </span>
          <button type="button" onClick={onInstall} disabled={modelInstallInProgress}>
            {modelInstallInProgress ? "Installing..." : "Install models"}
          </button>
        </div>
      ) : (
        <div className="endpoint-statuses" aria-label="Ollama endpoint status">
          {modelEndpoints.map((endpoint) => (
            <div
              className={`endpoint-status ${endpoint.state}`}
              key={endpoint.id}
              title={`${endpoint.label}: ${endpoint.model || "checking"} (${endpoint.state})`}
            >
              <button
                className="model-toggle"
                type="button"
                onClick={() => onToggle(endpoint.id, endpoint.model)}
                disabled={togglingService !== null}
                aria-label={`${endpoint.state === "online" ? "Stop" : "Launch"} ${endpoint.label}`}
              >
                <span className="toggle-symbol" aria-hidden="true" />
              </button>
              <span>{endpoint.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
