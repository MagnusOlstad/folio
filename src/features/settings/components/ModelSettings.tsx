import type { MlxModelId, MlxStatus } from "../../../domain/types.ts";

export type ModelSettingsControls = {
  status: MlxStatus | null;
  actionModel: MlxModelId | null;
  action: string | null;
  error: string;
  install: (id: MlxModelId) => void;
  remove: (id: MlxModelId) => void;
  select: (id: MlxModelId) => void;
};

const generationModels: { id: MlxModelId; name: string; description: string }[] = [
  { id: "qwen35", name: "Qwen 3.5 4B", description: "4-bit · about 3.1 GB" },
  { id: "llama32", name: "Llama 3.2 3B Instruct", description: "4-bit · about 1.8 GB" },
  { id: "gemma4", name: "Gemma 4 E4B", description: "4-bit · about 5.2 GB" },
];

function formatBytes(bytes: number) {
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

export function ModelSettings({ controls }: { controls: ModelSettingsControls }) {
  const models = controls.status?.models ?? [];
  const embedding = models.find((model) => model.id === "embeddinggemma");
  const canManage = Boolean(controls.status?.available && controls.status.helperAvailable);
  return (
    <section className="settings-section" aria-labelledby="settings-models-heading">
      <div className="settings-section-copy">
        <h2 id="settings-models-heading">Local models</h2>
        <p>Choose the model Folio uses for filing and Ask. Model files stay in Folio’s local cache.</p>
      </div>
      {!controls.status?.available ? <p className="settings-import-message">Local MLX models need Apple Silicon and macOS 14 or newer.</p> : null}
      {controls.status?.available && !controls.status.helperAvailable ? <p className="settings-import-message">The local MLX helper is not ready. Rebuild or reinstall Folio, then retry the download.</p> : null}
      {generationModels.map((definition) => {
        const model = models.find((item) => item.id === definition.id);
        const download = controls.status?.downloads.find((item) => item.id === definition.id)?.progress;
        const busy = controls.actionModel === definition.id;
        return (
          <article className="model-settings-row" key={definition.id}>
            <label>
              <input
                type="radio"
                name="folio-generation-model"
                checked={controls.status?.selectedGenerationModel === definition.id}
                onChange={() => controls.select(definition.id)}
                disabled={!canManage || controls.actionModel !== null}
              />
              <span><strong>{definition.name}</strong><small>{definition.description}</small></span>
            </label>
            <div className="model-settings-actions">
              {model?.installed ? <span className="model-installed">{model.loaded ? "Ready" : "Installed"}</span> : null}
              {model?.installed ? (
                <button type="button" onClick={() => controls.remove(definition.id)} disabled={controls.actionModel !== null}>
                  {busy && controls.action === "remove" ? "Removing…" : "Remove"}
                </button>
              ) : (
                <button type="button" onClick={() => controls.install(definition.id)} disabled={!canManage || controls.actionModel !== null}>
                  {busy && controls.action === "install" ? "Downloading…" : "Download"}
                </button>
              )}
            </div>
            {download ? (
              <div className="model-download-progress" aria-live="polite">
                <div><span>{download.phase === "loading" ? "Loading model" : "Downloading"}</span><span>{download.percent}% · {formatBytes(download.downloadedBytes)} of {formatBytes(download.totalBytes)}</span></div>
                <progress max={100} value={download.percent} aria-label={`Downloading ${definition.name}`} />
              </div>
            ) : null}
          </article>
        );
      })}
      {controls.error ? <p className="settings-model-error" role="alert">{controls.error}</p> : null}
      <article className="model-settings-row model-settings-embedding">
        <span><strong>EmbeddingGemma</strong><small>Fixed embedding model · about 212 MB</small></span>
        {embedding?.installed ? <span className="model-installed">Installed</span> : (
          <button type="button" onClick={() => controls.install("embeddinggemma")} disabled={!canManage || controls.actionModel !== null}>
            {controls.actionModel === "embeddinggemma" && controls.action === "install" ? "Downloading…" : "Download"}
          </button>
        )}
        {controls.status?.downloads.find((item) => item.id === "embeddinggemma")?.progress ? (() => {
          const progress = controls.status?.downloads.find((item) => item.id === "embeddinggemma")?.progress;
          return progress ? <div className="model-download-progress"><div><span>{progress.phase === "loading" ? "Loading model" : "Downloading"}</span><span>{progress.percent}% · {formatBytes(progress.downloadedBytes)} of {formatBytes(progress.totalBytes)}</span></div><progress max={100} value={progress.percent} aria-label="Downloading EmbeddingGemma" /></div> : null;
        })() : null}
      </article>
    </section>
  );
}
