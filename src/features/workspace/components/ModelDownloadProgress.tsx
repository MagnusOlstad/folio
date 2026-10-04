import type { MlxDownloadProgress } from "../../../domain/types.ts";
import { formatModelBytes } from "../model/model-catalog.ts";

type ModelDownloadProgressProps = {
  modelName: string;
  progress: MlxDownloadProgress | null | undefined;
};

export function ModelDownloadProgress({ modelName, progress }: ModelDownloadProgressProps) {
  const loading = progress?.phase === "loading";
  const downloadedBytes = progress?.downloadedBytes;
  const totalBytes = progress?.totalBytes;
  const percent = progress?.percent;
  // A zero-byte snapshot can be the native layer's placeholder while only the
  // catalog estimate is known; wait for measured bytes before showing 0%.
  const validBytes = Number.isFinite(downloadedBytes) && downloadedBytes! > 0
    && Number.isFinite(totalBytes) && totalBytes! > 0;
  const validPercent = Number.isFinite(percent) && percent! >= 0 && percent! <= 100;
  const determinate = !loading && validBytes;
  const value = determinate
    ? validPercent ? percent! : Math.min(100, (downloadedBytes! / totalBytes!) * 100)
    : undefined;
  const phaseLabel = loading ? "Loading model" : "Downloading";
  const detail = loading
    ? "Preparing model for use"
    : validBytes && validPercent
      ? `${percent}% · ${formatModelBytes(downloadedBytes!)} of ${formatModelBytes(totalBytes!)}`
      : validBytes
        ? `${formatModelBytes(downloadedBytes!)} of ${formatModelBytes(totalBytes!)}`
      : "Preparing download";

  return (
    <div className="model-download-progress" aria-live="polite">
      <div><span>{phaseLabel}</span><span>{detail}</span></div>
      <progress max={100} value={value} aria-label={`${phaseLabel} ${modelName}`} />
    </div>
  );
}
