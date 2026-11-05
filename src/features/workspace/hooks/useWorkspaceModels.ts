import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { MLX_GENERATION_MODEL } from "../../../domain/types.ts";
import type { MlxModelId, MlxStatus, MlxTranscriptionModelId, VersionInfo } from "../../../domain/types.ts";
import { apiForBundle, apiWithRetryForBundle } from "../../../lib/api.ts";
import { refreshTranslationSettings } from "./useTranslationSettings.ts";

type ModelAction = "install" | "load" | "unload" | "remove" | "select" | "select-transcription";

export function useWorkspaceModels(setMessage: (message: string) => void, enabled = true, bundleId: string | null = null) {
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null);
  const [mlxStatus, setStatus] = useState<MlxStatus | null>(null);
  const [statusBundleId, setStatusBundleId] = useState(bundleId);
  const [mlxActionModel, setMlxActionModel] = useState<MlxModelId | null>(null);
  const [mlxAction, setMlxAction] = useState<ModelAction | null>(null);
  const [actionBundleId, setActionBundleId] = useState(bundleId);
  const [modelError, setModelError] = useState("");
  const [modelErrorBundleId, setModelErrorBundleId] = useState(bundleId);
  const [statusError, setStatusError] = useState("");
  const [statusErrorBundleId, setStatusErrorBundleId] = useState(bundleId);
  const mountedRef = useRef(false);
  const epochRef = useRef(0);
  const bundleRef = useRef(bundleId);
  useLayoutEffect(() => { bundleRef.current = bundleId; }, [bundleId]);
  const actionRef = useRef(false);
  const requestRef = useRef<{ bundleId: string | null; promise: Promise<MlxStatus> } | null>(null);

  const setMlxStatus = useCallback((status: MlxStatus | null) => {
    epochRef.current += 1;
    setStatus(status);
    setStatusBundleId(bundleRef.current);
  }, []);

  const refreshMlxStatus = useCallback((retry = false): Promise<MlxStatus> => {
    if (requestRef.current?.bundleId === bundleId) return requestRef.current.promise;
    const epoch = epochRef.current;
    const request = (retry ? apiWithRetryForBundle<MlxStatus>(bundleId, "/api/mlx/status") : apiForBundle<MlxStatus>(bundleId, "/api/mlx/status")).then((status) => {
      if (mountedRef.current && bundleRef.current === bundleId && epoch === epochRef.current) { setStatus(status); setStatusBundleId(bundleId); setStatusError(""); }
      if (mountedRef.current && bundleRef.current === bundleId && epoch === epochRef.current) setStatusErrorBundleId(bundleId);
      return status;
    }).catch((error: unknown) => {
      if (mountedRef.current && bundleRef.current === bundleId && epoch === epochRef.current) {
        setStatus(null);
        setStatusBundleId(bundleId);
        setStatusError("Could not refresh model status. Reconnecting automatically.");
        setStatusErrorBundleId(bundleId);
      }
      throw error;
    }).finally(() => {
      if (requestRef.current?.promise === request) requestRef.current = null;
    });
    requestRef.current = { bundleId, promise: request };
    return request;
  }, [bundleId]);

  useLayoutEffect(() => {
    epochRef.current += 1;
  }, [bundleId]);

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

  const generationSignature = mlxStatus
    ? `${mlxStatus.selectedGenerationModel}:${mlxStatus.models.filter((model) => model.purpose === "generation" && model.installed).map((model) => model.id).join(",")}`
    : null;
  const previousSignatureRef = useRef<string | null>(null);
  useEffect(() => {
    // Translation availability follows the selected generation model's install state.
    if (previousSignatureRef.current !== null && generationSignature !== null && generationSignature !== previousSignatureRef.current)
      refreshTranslationSettings();
    if (generationSignature !== null) previousSignatureRef.current = generationSignature;
  }, [generationSignature]);

  async function runMlxAction(id: MlxModelId, action: ModelAction) {
    if (actionRef.current) return;
    if (action === "select" && id !== "gemma4" && id !== "qwen35" && id !== "llama32") return;
    if (action === "select-transcription" && id !== "whisper" && id !== "whisperlarge") return;
    actionRef.current = true;
    epochRef.current += 1;
    setMlxActionModel(id);
    setActionBundleId(bundleId);
    setMlxAction(action);
    setModelError("");
    setModelErrorBundleId(bundleId);
    setMessage("");
    try {
      const selectionAction = action === "select" || action === "select-transcription";
      const selectionPath = action === "select-transcription" ? "/api/mlx/models/transcription-selection" : "/api/mlx/models/selection";
      await apiForBundle<MlxStatus>(bundleId, selectionAction ? selectionPath : `/api/mlx/models/${id}/${action}`, {
        method: selectionAction ? "PUT" : "POST",
        ...(selectionAction ? { body: JSON.stringify({ id }) } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : `Could not ${action} ${id}`;
      if (mountedRef.current && bundleRef.current === bundleId) { setModelError(message); setModelErrorBundleId(bundleId); setMessage(message); }
    } finally {
      // A failed mutation may still have changed helper state. Invalidate any
      // earlier snapshot, drain it, and always read the actual resulting state.
      epochRef.current += 1;
      await requestRef.current?.promise.catch(() => {});
      await refreshMlxStatus().catch(() => {});
      actionRef.current = false;
      if (mountedRef.current) { setMlxActionModel(null); setMlxAction(null); }
    }
  }

  async function setEntityAnalysisEnabled(enabled: boolean) {
    if (!bundleId) return;
    try {
      await apiForBundle(bundleId, "/api/entities/settings", { method: "PUT", body: JSON.stringify({ enabled }) });
      await refreshMlxStatus();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not update entity analysis settings.";
      if (mountedRef.current && bundleRef.current === bundleId) { setModelError(message); setModelErrorBundleId(bundleId); setMessage(message); }
    }
  }

  const currentStatus = statusBundleId === bundleId ? mlxStatus : null;
  const currentActionModel = actionBundleId === bundleId ? mlxActionModel : null;
  const currentAction = actionBundleId === bundleId ? mlxAction : null;
  const currentModelError = modelErrorBundleId === bundleId ? modelError : "";
  const currentStatusError = statusErrorBundleId === bundleId ? statusError : "";
  const selectedAnswerModel = currentStatus?.selectedGenerationModel || MLX_GENERATION_MODEL.id;
  const selectedTranscriptionModel = currentStatus?.selectedTranscriptionModel ?? "whisper";
  const selectedAnswerModelMissing = !currentStatus?.available || !currentStatus.helperAvailable || !currentStatus.models.some(
    (model) => model.id === selectedAnswerModel && model.installed,
  );
  return {
    versionInfo, setVersionInfo, selectedAnswerModel, selectedAnswerModelMissing, selectedTranscriptionModel,
    mlxStatus: currentStatus, setMlxStatus, mlxActionModel: currentActionModel, mlxAction: currentAction, modelError: currentModelError || currentStatusError,
    installMlxModel: (id: MlxModelId) => runMlxAction(id, "install"),
    removeMlxModel: (id: MlxModelId) => runMlxAction(id, "remove"),
    selectGenerationModel: (id: MlxModelId) => runMlxAction(id, "select"),
    selectTranscriptionModel: (id: MlxTranscriptionModelId) => runMlxAction(id, "select-transcription"),
    toggleMlxModel: (id: MlxModelId, loaded: boolean) => runMlxAction(id, loaded ? "unload" : "load"),
    setEntityAnalysisEnabled,
    refreshMlxStatus,
  };
}

export type ReturnTypeOfWorkspaceModels = ReturnType<typeof useWorkspaceModels>;
