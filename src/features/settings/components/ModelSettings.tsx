import type { MlxModelId, MlxStatus, MlxTranscriptionModelId } from "../../../domain/types.ts";

import { modelCatalog } from "../../workspace/model/model-catalog.ts";

export type ModelSettingsControls = {
  status: MlxStatus | null;
  actionModel: MlxModelId | null;
  action: string | null;
  error: string;
  install: (id: MlxModelId) => void;
  remove: (id: MlxModelId) => void;
  select: (id: MlxModelId) => void;
  selectTranscription: (id: MlxTranscriptionModelId) => void;
};

export function ModelSettings({ controls }: { controls: ModelSettingsControls }) {
  const models = controls.status?.models ?? [];
  const canManage = Boolean(controls.status?.available && controls.status.helperAvailable);
  const selectedTranscriptionModel = controls.status?.selectedTranscriptionModel ?? "whisper";
  const selectedTranscriptionInstalled = Boolean(models.find((model) => model.id === selectedTranscriptionModel)?.installed);
  const renderModel = (definition: typeof modelCatalog[number]) => {
    const model = models.find((item) => item.id === definition.id);
    const download = controls.status?.downloads.find((item) => item.id === definition.id)?.progress;
    const acting = controls.actionModel === definition.id;
    const downloading = Boolean(controls.status?.installing.includes(definition.id));
    const busy = Boolean(model?.busy || model?.loading || downloading || controls.actionModel !== null);
    const identity = <span><strong>{definition.name}</strong><small>{definition.description}</small></span>;
    return (
      <article className={`model-settings-row${definition.generation ? "" : " model-settings-auxiliary"}`} key={definition.id}>
        {definition.generation ? <label>
          <input type="radio" name="folio-generation-model" checked={controls.status?.selectedGenerationModel === definition.id} onChange={() => controls.select(definition.id)} disabled={!canManage || controls.actionModel !== null} />
          {identity}
        </label> : definition.transcription ? <label>
          <input type="radio" name="folio-transcription-model" value={definition.id} checked={selectedTranscriptionModel === definition.id} onChange={() => controls.selectTranscription(definition.id as MlxTranscriptionModelId)} disabled={!canManage || controls.actionModel !== null} />
          {identity}
        </label> : identity}
        <div className="model-settings-actions">
          {model?.installed ? <span className="model-installed">{model.busy ? "In use" : model.loaded ? "Ready" : "Installed"}</span> : null}
          {model?.installed ? (
            <button type="button" onClick={() => controls.remove(definition.id)} disabled={!canManage || busy} title={model.busy ? "Wait until this model finishes its requests to remove it." : undefined}>
              {acting && controls.action === "remove" ? "Removing…" : "Remove"}
            </button>
          ) : (
            <button type="button" onClick={() => controls.install(definition.id)} disabled={!canManage || busy}>
              {downloading || (acting && controls.action === "install") ? "Downloading…" : "Download"}
            </button>
          )}
        </div>
        {download ? (
          <div className="model-download-progress" aria-live="polite">
            <div><span>{download.phase === "loading" ? "Loading model" : "Downloading"}</span><span>{download.percent}% · {(download.downloadedBytes / 1_000_000_000).toFixed(1)} GB of {(download.totalBytes / 1_000_000_000).toFixed(1)} GB</span></div>
            <progress max={100} value={download.percent} aria-label={`Downloading ${definition.name}`} />
          </div>
        ) : null}
      </article>
    );
  };
  return (
    <section className="settings-section" aria-labelledby="settings-models-heading">
      <div className="settings-section-copy">
        <h2 id="settings-models-heading">Local models</h2>
        <p>Choose models for text generation and transcription. Manage semantic search below. Model files stay in Folio’s local cache.</p>
      </div>
      {!controls.status?.available ? <p className="settings-import-message">Local MLX models need Apple Silicon and macOS 14 or newer.</p> : null}
      {controls.status?.available && !controls.status.helperAvailable ? <p className="settings-import-message">The local MLX helper is not ready. Rebuild or reinstall Folio, then retry the download.</p> : null}
      <fieldset className="model-settings-group" aria-label="Text generation">
        <legend>Text generation</legend>
        {modelCatalog.filter((definition) => definition.generation).map(renderModel)}
      </fieldset>
      <fieldset className="model-settings-group" aria-label="Transcription">
        <legend>Transcription</legend>
        <p>Choose a local speech recognition model. If your choice is missing, install it below before transcribing.</p>
        {modelCatalog.filter((definition) => definition.transcription).map(renderModel)}
        {controls.status && canManage && !selectedTranscriptionInstalled ? <p role="status">The selected transcription model is not installed. Transcription will wait until it is downloaded.</p> : null}
      </fieldset>
      {modelCatalog.filter((definition) => !definition.generation && !definition.transcription).map(renderModel)}
      {controls.error ? <p className="settings-model-error" role="alert">{controls.error}</p> : null}
    </section>
  );
}
