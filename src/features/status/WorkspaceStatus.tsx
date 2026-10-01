import { useEffect, useState } from "react";
import type { DesktopUpdateState, MlxModelId, MlxStatus, VersionInfo } from "../../domain/types.ts";
import type { SettingsCategory } from "../settings/model/settings-category.ts";

export type WorkspaceStatusProps = {
  mlxStatus: MlxStatus | null;
  mlxActionModel: MlxModelId | null;
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

const modelNames: Record<MlxModelId, string> = {
  qwen35: "Qwen 3.5 4B",
  llama32: "Llama 3.2 3B Instruct",
  gemma4: "Gemma 4 E4B",
  embeddinggemma: "EmbeddingGemma",
};

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "kB", "MB", "GB", "TB"];
  const power = Math.min(Math.floor(Math.log10(bytes) / 3), units.length - 1);
  const size = bytes / 1000 ** power;
  const digits = power === 0 || size >= 100 ? 0 : power >= 3 ? 2 : 1;
  return `${size.toFixed(digits)} ${units[power]}`;
}

export function MlxModelStatusPanel({
  mlxStatus,
  mlxActionModel,
  onInstallMlxModel,
  onToggleMlxModel,
  onOpenSettings,
}: WorkspaceStatusProps) {
  const [showFirstOpenSettings, setShowFirstOpenSettings] = useState(false);
  useEffect(() => {
    if (!mlxStatus) return;
    try {
      if (window.localStorage.getItem("folio:model-setup-prompt-seen") === "1") return;
      const generation = mlxStatus.models.filter((model) => model.purpose === "generation");
      const selectedInstalled = generation.some((model) => model.id === mlxStatus.selectedGenerationModel && model.installed);
      window.localStorage.setItem("folio:model-setup-prompt-seen", "1");
      setShowFirstOpenSettings(!selectedInstalled);
    } catch {
      setShowFirstOpenSettings(!mlxStatus.models.some((model) => model.id === mlxStatus.selectedGenerationModel && model.installed));
    }
  }, [mlxStatus]);
  const selectedGenerationId = mlxStatus?.selectedGenerationModel ?? "gemma4";
  const selectedGenerationModel = mlxStatus?.models.find(
    (model) => model.id === selectedGenerationId && model.purpose === "generation",
  );
  const displayedModels = [
    {
      id: selectedGenerationId,
      name: selectedGenerationModel?.name ?? modelNames[selectedGenerationId],
      purpose: "Generation",
      model: selectedGenerationModel,
    },
    {
      id: "embeddinggemma" as const,
      name: modelNames.embeddinggemma,
      purpose: "Embeddings",
      model: mlxStatus?.models.find((model) => model.id === "embeddinggemma"),
    },
  ];
  const stateText = !mlxStatus
    ? "Checking"
    : mlxStatus.available
      ? "Available"
      : "Unavailable";
  return (
    <section className="mlx-status" aria-label="MLX model management" aria-live="polite">
      <div className={`model-status ${mlxStatus?.available ? "online" : ""}`}>
        <span className="status-dot" />
        <span>MLX {stateText.toLowerCase()}</span>
      </div>
      <div className="mlx-helper-status">
        Helper {mlxStatus ? (mlxStatus.helperAvailable ? "available" : "unavailable") : "checking"}
      </div>
      <p className="mlx-model-guidance">
        Choose Install to download model files. {showFirstOpenSettings && onOpenSettings ? (
          <>Choose a generation model in Settings to enable filing and Ask. <button className="mlx-model-settings-link" type="button" onClick={() => { setShowFirstOpenSettings(false); onOpenSettings("models"); }}>Open model settings</button></>
        ) : (
          "Features load installed models when needed; Start and Stop let you manage them."
        )}
      </p>
      <div className="mlx-model-list">
        {displayedModels.map(({ id, name, purpose, model }) => {
          const installing = Boolean(mlxStatus?.installing.includes(id)) || mlxActionModel === id;
          const canAct = Boolean(mlxStatus?.available && mlxStatus.helperAvailable);
          const buttonDisabled = !canAct || installing || mlxActionModel !== null;
          const displayedName = model?.name || name;
          const modelState = !mlxStatus
            ? "Checking status"
            : !model
              ? "Status unavailable"
              : model.loaded
                ? "Running"
                : model.installed
                  ? "Stopped"
                  : "Not installed";
          return (
            <div className="mlx-model" key={id}>
              <div className="mlx-model-heading">
                <strong>{displayedName}</strong>
                <span>{purpose}</span>
              </div>
              <div className={`mlx-model-state${model?.loaded ? " online" : ""}`}>{modelState}</div>
              {model && (
                <div className="mlx-model-details">
                  {model.installed ? "Installed" : `${model.downloadSizeIsEstimate ? "About " : ""}${formatBytes(model.downloadSizeBytes)} download`}
                  {model.loaded && model.memory && (
                    <span>Memory {formatBytes(model.memory.activeBytes)} active · {formatBytes(model.memory.cacheBytes)} allocator cache · {formatBytes(model.memory.peakResidentBytes)} peak process</span>
                  )}
                </div>
              )}
              {model?.installed ? (
                <button
                  className="mlx-model-action"
                  type="button"
                  onClick={() => onToggleMlxModel(id, model.loaded)}
                  disabled={buttonDisabled}
                  aria-label={`${model.loaded ? "Stop" : "Start"} ${displayedName}`}
                >
                  {installing ? "Working…" : model.loaded ? "Stop" : "Start"}
                </button>
              ) : (
                <button
                  className="mlx-model-action"
                  type="button"
                  onClick={() => onInstallMlxModel(id)}
                  disabled={buttonDisabled || !model}
                  aria-label={`Install ${displayedName}`}
                >
                  {installing ? "Installing…" : "Install"}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
