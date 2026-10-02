import type { MlxModelId, MlxStatus } from "../../../domain/types.ts";

export const modelCatalog: { id: MlxModelId; name: string; gridName?: string; purpose: string; description: string; bytes: number; generation: boolean; transcription?: boolean }[] = [
  { id: "gemma4", name: "Gemma 4 E4B", purpose: "Filing & Ask", description: "4-bit · about 5.2 GB", bytes: 5_180_000_000, generation: true },
  { id: "qwen35", name: "Qwen 3.5 4B", purpose: "Filing & Ask", description: "4-bit · about 3.1 GB", bytes: 3_060_000_000, generation: true },
  { id: "llama32", name: "Llama 3.2 3B Instruct", gridName: "Llama 3.2 3B", purpose: "Filing & Ask", description: "4-bit · about 1.8 GB", bytes: 1_810_000_000, generation: true },
  { id: "embeddinggemma", name: "EmbeddingGemma", purpose: "Semantic search", description: "Fixed embedding model · about 212 MB", bytes: 212_000_000, generation: false },
  { id: "whisper", name: "Whisper Large v3 Turbo", gridName: "Whisper Turbo", purpose: "Transcription", description: "Large v3 Turbo · about 1.6 GB", bytes: 1_610_000_000, generation: false, transcription: true },
  { id: "whisperlarge", name: "Whisper Large v3", gridName: "Whisper Large v3", purpose: "Transcription", description: "Large v3 · about 3.1 GB", bytes: 3_100_000_000, generation: false, transcription: true },
];

/** Prioritize live work, then installed models, with stable catalog ties. */
export function orderedModelCatalog(status: MlxStatus | null, actionModel?: MlxModelId | null, action?: string | null) {
  const available = Boolean(status?.available && status.helperAvailable);
  const priority = (id: MlxModelId) => {
    const model = status?.models.find((item) => item.id === id);
    if (!model?.installed) return 2;
    // A missing model being downloaded is still missing, even if the helper
    // reports its installation as loading. Only installed work is active.
    const active = model.loaded || model.busy || Boolean(model.requestCount) || model.loading
      || (actionModel === id && action === "load");
    return available && active ? 0 : 1;
  };
  return modelCatalog.toSorted((left, right) => priority(left.id) - priority(right.id));
}

export function formatModelBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "kB", "MB", "GB", "TB"];
  const power = Math.min(Math.floor(Math.log10(bytes) / 3), units.length - 1);
  const size = bytes / 1000 ** power;
  const digits = power === 0 || size >= 100 ? 0 : power >= 3 ? 2 : 1;
  return `${size.toFixed(digits)} ${units[power]}`;
}
