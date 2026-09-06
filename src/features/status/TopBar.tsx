import type { ModelStatus, VersionInfo } from "../../domain/types.ts";

type Endpoint = {
  id: string;
  label: string;
  model: string | undefined;
  state: string;
};

export function TopBar({
  versionInfo,
  status,
  missingModels,
  modelInstallInProgress,
  modelEndpoints,
  togglingService,
  onInstall,
  onToggle,
}: {
  versionInfo: VersionInfo | null;
  status: ModelStatus | null;
  missingModels: string[];
  modelInstallInProgress: boolean;
  modelEndpoints: Endpoint[];
  togglingService: string | null;
  onInstall: () => void;
  onToggle: (id: string, model?: string) => void;
}) {
  return (
    <header className="topbar">
      <div className="brand-group">
        <a className="brand" href="#workspace" aria-label="Folio home">
          <span className="brand-mark">F</span>
          <span>Folio</span>
        </a>
        {versionInfo && (
          <span className="app-version">v{versionInfo.version}</span>
        )}
        {versionInfo?.updateAvailable && (
          <a
            className="update-badge"
            href={versionInfo.latestUrl}
            target="_blank"
            rel="noreferrer"
          >
            Update to v{versionInfo.latest}
          </a>
        )}
      </div>
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
            <a
              href="https://ollama.com/download"
              target="_blank"
              rel="noreferrer"
            >
              Get Ollama
            </a>
            <button
              type="button"
              onClick={onInstall}
              disabled={modelInstallInProgress}
            >
              {modelInstallInProgress ? "Checking..." : "Set up"}
            </button>
          </div>
        ) : missingModels.length ? (
          <div className="model-setup">
            <span>
              {missingModels.length} local model
              {missingModels.length === 1 ? "" : "s"} required.
            </span>
            <button
              type="button"
              onClick={onInstall}
              disabled={modelInstallInProgress}
            >
              {modelInstallInProgress ? "Installing..." : "Install models"}
            </button>
          </div>
        ) : (
          <div
            className="endpoint-statuses"
            aria-label="Ollama endpoint status"
          >
            {modelEndpoints.map((endpoint) => (
              <div
                className={`endpoint-status ${endpoint.state}`}
                key={endpoint.label}
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
    </header>
  );
}
