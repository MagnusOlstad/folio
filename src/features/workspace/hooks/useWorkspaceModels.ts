import { useCallback, useEffect, useRef, useState } from "react";
import { MLX_GENERATION_MODEL } from "../../../domain/types.ts";
import type { MlxModelId, MlxStatus, MlxTranscriptionModelId, VersionInfo } from "../../../domain/types.ts";
import { api, apiWithRetry } from "../../../lib/api.ts";

type ModelAction = "install" | "load" | "unload" | "remove" | "select" | "select-transcription";

export function useWorkspaceModels(setMessage: (message: string) => void, enabled = true) {
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null);
  const [mlxStatus, setStatus] = useState<MlxStatus | null>(null);
  const [mlxActionModel, setMlxActionModel] = useState<MlxModelId | null>(null);
  const [mlxAction, setMlxAction] = useState<ModelAction | null>(null);
  const [modelError, setModelError] = useState("");
  const [statusError, setStatusError] = useState("");
  const mountedRef = useRef(false);
  const epochRef = useRef(0);
  const actionRef = useRef(false);
  const requestRef = useRef<Promise<MlxStatus> | null>(null);

  const setMlxStatus = useCallback((status: MlxStatus | null) => {
    epochRef.current += 1;
    setStatus(status);
  }, []);

  const refreshMlxStatus = useCallback((retry = false): Promise<MlxStatus> => {
    if (requestRef.current) return requestRef.current;
    const epoch = epochRef.current;
    const request = (retry ? apiWithRetry<MlxStatus>("/api/mlx/status") : api<MlxStatus>("/api/mlx/status")).then((status) => {
      if (mountedRef.current && epoch === epochRef.current) { setStatus(status); setStatusError(""); }
      return status;
    }).catch((error: unknown) => {
      if (mountedRef.current && epoch === epochRef.current) {
        setStatus(null);
        setStatusError("Could not refresh model status. Reconnecting automatically.");
      }
      throw error;
    }).finally(() => {
      if (requestRef.current === request) requestRef.current = null;
    });
    requestRef.current = request;
    return request;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; epochRef.current += 1; };
  }, []);

  useEffect(() => {
    if (!enabled) return;
    // One poll stream reflects downloads and automatic heavy-model switches.
    // Bootstrap shares the same request, so startup never adds another poller.
    const timer = window.setInterval(() => {
      if (!document.hidden) void refreshMlxStatus().catch(() => {});
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [enabled, refreshMlxStatus]);

  async function runMlxAction(id: MlxModelId, action: ModelAction) {
    if (actionRef.current) return;
    if (action === "select" && (id === "embeddinggemma" || id === "whisper" || id === "whisperlarge")) return;
    if (action === "select-transcription" && id !== "whisper" && id !== "whisperlarge") return;
    actionRef.current = true;
    epochRef.current += 1;
    setMlxActionModel(id);
    setMlxAction(action);
    setModelError("");
    setMessage("");
    try {
      const selectionAction = action === "select" || action === "select-transcription";
      const selectionPath = action === "select-transcription" ? "/api/mlx/models/transcription-selection" : "/api/mlx/models/selection";
      await api<MlxStatus>(selectionAction ? selectionPath : `/api/mlx/models/${id}/${action}`, {
        method: selectionAction ? "PUT" : "POST",
        ...(selectionAction ? { body: JSON.stringify({ id }) } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : `Could not ${action} ${id}`;
      if (mountedRef.current) { setModelError(message); setMessage(message); }
    } finally {
      // A failed mutation may still have changed helper state. Invalidate any
      // earlier snapshot, drain it, and always read the actual resulting state.
      epochRef.current += 1;
      await requestRef.current?.catch(() => {});
      await refreshMlxStatus().catch(() => {});
      actionRef.current = false;
      if (mountedRef.current) { setMlxActionModel(null); setMlxAction(null); }
    }
  }

  const selectedAnswerModel = mlxStatus?.selectedGenerationModel || MLX_GENERATION_MODEL.id;
  const selectedTranscriptionModel = mlxStatus?.selectedTranscriptionModel ?? "whisper";
  const selectedAnswerModelMissing = !mlxStatus?.available || !mlxStatus.helperAvailable || !mlxStatus.models.some(
    (model) => model.id === selectedAnswerModel && model.installed,
  );
  return {
    versionInfo, setVersionInfo, selectedAnswerModel, selectedAnswerModelMissing, selectedTranscriptionModel,
    mlxStatus, setMlxStatus, mlxActionModel, mlxAction, modelError: modelError || statusError,
    installMlxModel: (id: MlxModelId) => runMlxAction(id, "install"),
    removeMlxModel: (id: MlxModelId) => runMlxAction(id, "remove"),
    selectGenerationModel: (id: MlxModelId) => runMlxAction(id, "select"),
    selectTranscriptionModel: (id: MlxTranscriptionModelId) => runMlxAction(id, "select-transcription"),
    toggleMlxModel: (id: MlxModelId, loaded: boolean) => runMlxAction(id, loaded ? "unload" : "load"),
    refreshMlxStatus,
  };
}

export type ReturnTypeOfWorkspaceModels = ReturnType<typeof useWorkspaceModels>;
