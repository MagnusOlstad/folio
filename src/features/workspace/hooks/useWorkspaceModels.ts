import { useState } from "react";
import type { ModelStatus, VersionInfo } from "../../../domain/types.ts";
import { api } from "../../../lib/api.ts";
import { hasInstalledModel } from "../../../lib/workspace.ts";

export function useWorkspaceModels(setMessage: (message: string) => void) {
  const [status, setStatus] = useState<ModelStatus | null>(null);
  const [askModel, setAskModel] = useState("");
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null);
  const [togglingService, setTogglingService] = useState<string | null>(null);
  const [installingModels, setInstallingModels] = useState(false);

  async function toggleOllamaService(service: string, model?: string) {
    if (togglingService) return;
    setTogglingService(service);
    setMessage("");
    try {
      setStatus(
        await api<ModelStatus>(`/api/ollama/toggle/${service}`, {
          method: "POST",
          body: JSON.stringify({ model }),
        }),
      );
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Could not toggle Ollama service",
      );
    } finally {
      setTogglingService(null);
    }
  }

  async function installOllamaModels() {
    if (installingModels) return;
    setInstallingModels(true);
    setMessage("");
    try {
      setStatus(
        await api<ModelStatus>("/api/ollama/install", { method: "POST" }),
      );
      setMessage("Ollama models installed and ready.");
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Could not install Ollama models",
      );
    } finally {
      setInstallingModels(false);
    }
  }

  const configuredAnswerModels = status?.answerModels || [];
  const missingModels = status?.missingModels || [];
  const modelInstallInProgress =
    installingModels || Boolean(status?.installingModels.length);
  const selectedAnswerModel = status?.answerModels.includes(askModel)
    ? askModel
    : status?.answerModel || "";
  const selectedAnswerModelMissing = Boolean(
    status?.online &&
      selectedAnswerModel &&
      !hasInstalledModel(selectedAnswerModel, status.installed),
  );
  const modelEndpoints = [
    { id: "capture", label: "Capture", model: status?.classifierModel },
    { id: "search", label: "Search", model: status?.embedModel },
    { id: "ask", label: "Ask", model: selectedAnswerModel },
  ].map((endpoint) => ({
    ...endpoint,
    state: !status
      ? "checking"
      : !status.online
        ? "offline"
        : !endpoint.model ||
            !hasInstalledModel(endpoint.model, status.installed)
          ? "missing"
          : hasInstalledModel(endpoint.model, status.running)
            ? "online"
            : "stopped",
  }));

  return {
    status,
    setStatus,
    askModel,
    setAskModel,
    versionInfo,
    setVersionInfo,
    togglingService,
    installingModels,
    configuredAnswerModels,
    missingModels,
    modelInstallInProgress,
    selectedAnswerModel,
    selectedAnswerModelMissing,
    modelEndpoints,
    toggleOllamaService,
    installOllamaModels,
  };
}

export type ReturnTypeOfWorkspaceModels = ReturnType<typeof useWorkspaceModels>;
