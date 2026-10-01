import { useState } from "react";
import { MLX_GENERATION_MODEL } from "../../../domain/types.ts";
import type { MlxModelId, MlxStatus, VersionInfo } from "../../../domain/types.ts";
import { api } from "../../../lib/api.ts";

export function useWorkspaceModels(setMessage: (message: string) => void) {
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null);
  const [mlxStatus, setMlxStatus] = useState<MlxStatus | null>(null);
  const [mlxActionModel, setMlxActionModel] = useState<MlxModelId | null>(null);

  async function refreshMlxStatus() {
    try {
      setMlxStatus(await api<MlxStatus>("/api/mlx/status"));
    } catch {
      setMlxStatus(null);
    }
  }

  async function runMlxAction(id: MlxModelId, action: "install" | "load" | "unload") {
    if (mlxActionModel) return;
    setMlxActionModel(id);
    setMessage("");
    try {
      await api<MlxStatus>(`/api/mlx/models/${id}/${action}`, { method: "POST" });
      await refreshMlxStatus();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : `Could not ${action} ${id}`);
    } finally {
      setMlxActionModel(null);
    }
  }

  const selectedAnswerModel = MLX_GENERATION_MODEL.id;
  const selectedAnswerModelMissing = !mlxStatus?.available || !mlxStatus.helperAvailable || !mlxStatus.models.some(
    (model) => model.id === selectedAnswerModel && model.installed,
  );
  return {
    versionInfo,
    setVersionInfo,
    selectedAnswerModel,
    selectedAnswerModelMissing,
    mlxStatus,
    setMlxStatus,
    mlxActionModel,
    installMlxModel: (id: MlxModelId) => runMlxAction(id, "install"),
    toggleMlxModel: (id: MlxModelId, loaded: boolean) => runMlxAction(id, loaded ? "unload" : "load"),
    refreshMlxStatus,
  };
}

export type ReturnTypeOfWorkspaceModels = ReturnType<typeof useWorkspaceModels>;
