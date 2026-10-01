import { useEffect, useState } from "react";
import { MLX_GENERATION_MODEL } from "../../../domain/types.ts";
import type { MlxModelId, MlxStatus, VersionInfo } from "../../../domain/types.ts";
import { api } from "../../../lib/api.ts";

export function useWorkspaceModels(setMessage: (message: string) => void) {
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null);
  const [mlxStatus, setMlxStatus] = useState<MlxStatus | null>(null);
  const [mlxActionModel, setMlxActionModel] = useState<MlxModelId | null>(null);
  const [mlxAction, setMlxAction] = useState<"install" | "load" | "unload" | "remove" | "select" | null>(null);
  const [modelError, setModelError] = useState("");

  async function refreshMlxStatus() {
    try {
      setMlxStatus(await api<MlxStatus>("/api/mlx/status"));
    } catch {
      setMlxStatus(null);
    }
  }

  useEffect(() => {
    if (!mlxStatus?.installing.length && mlxAction !== "install") return;
    const timer = window.setInterval(() => { void refreshMlxStatus(); }, 900);
    return () => window.clearInterval(timer);
  }, [mlxAction, mlxStatus?.installing.length]);

  async function runMlxAction(id: MlxModelId, action: "install" | "load" | "unload" | "remove") {
    if (mlxActionModel) return;
    setMlxActionModel(id);
    setMlxAction(action);
    setModelError("");
    setMessage("");
    try {
      await api<MlxStatus>(`/api/mlx/models/${id}/${action}`, { method: "POST" });
      await refreshMlxStatus();
    } catch (error) {
      const message = error instanceof Error ? error.message : `Could not ${action} ${id}`;
      setModelError(message);
      setMessage(message);
    } finally {
      setMlxActionModel(null);
      setMlxAction(null);
    }
  }

  async function selectGenerationModel(id: MlxModelId) {
    if (mlxActionModel || id === "embeddinggemma") return;
    setMlxActionModel(id);
    setMlxAction("select");
    setModelError("");
    setMessage("");
    try {
      setMlxStatus(await api<MlxStatus>("/api/mlx/models/selection", {
        method: "PUT",
        body: JSON.stringify({ id }),
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not select this model.";
      setModelError(message);
      setMessage(message);
    } finally {
      setMlxActionModel(null);
      setMlxAction(null);
    }
  }

  const selectedAnswerModel = mlxStatus?.selectedGenerationModel || MLX_GENERATION_MODEL.id;
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
    mlxAction,
    modelError,
    installMlxModel: (id: MlxModelId) => runMlxAction(id, "install"),
    removeMlxModel: (id: MlxModelId) => runMlxAction(id, "remove"),
    selectGenerationModel,
    toggleMlxModel: (id: MlxModelId, loaded: boolean) => runMlxAction(id, loaded ? "unload" : "load"),
    refreshMlxStatus,
  };
}

export type ReturnTypeOfWorkspaceModels = ReturnType<typeof useWorkspaceModels>;
