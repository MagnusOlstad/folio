import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MlxStatus } from "../../src/domain/types.ts";
import { MlxModelStatusPanel } from "../../src/features/status/WorkspaceStatus.tsx";
import { useWorkspaceModels } from "../../src/features/workspace/hooks/useWorkspaceModels.ts";

const status: MlxStatus = {
  available: true, helperAvailable: true, keepAliveMs: 60_000, installing: [], downloads: [], selectedGenerationModel: "gemma4", activeModel: "whisper",
  models: [
    { id: "whisper", name: "Whisper", purpose: "transcription", downloadSizeBytes: 1_610_000_000, downloadSizeIsEstimate: true, selected: false, installed: true, loaded: true, loading: false, busy: true, requestCount: 1, memory: null },
    { id: "gemma4", name: "Gemma 4 E4B", purpose: "generation", downloadSizeBytes: 5_180_000_000, downloadSizeIsEstimate: true, selected: true, installed: true, loaded: false, memory: null },
  ],
};
const response = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code });

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("model status", () => {
  it("orders active models before stopped models and missing downloads with stable ties", () => {
    const loadingStatus: MlxStatus = { ...status, installing: ["qwen35"], models: [
      ...status.models,
      { ...status.models[1], id: "llama32", name: "Llama 3.2 3B Instruct", selected: false, loaded: false, loading: true },
      { ...status.models[1], id: "embeddinggemma", name: "EmbeddingGemma", purpose: "embeddings", selected: false, loaded: false },
      { ...status.models[1], id: "qwen35", name: "Qwen 3.5 4B", selected: false, installed: false, loaded: false, loading: true },
    ] };
    const props = { mlxStatus: loadingStatus, mlxActionModel: null, onInstallMlxModel: vi.fn(), onToggleMlxModel: vi.fn(), onOpenSettings: vi.fn() };
    const { rerender } = render(<MlxModelStatusPanel {...props} />);
    const grid = screen.getByRole("group", { name: "Models, active first" });
    const names = () => Array.from(grid.querySelectorAll("button")).map((button) => button.getAttribute("aria-label"));
    expect(names()).toEqual(["Start Llama 3.2 3B Instruct", "Stop Whisper", "Start Gemma 4 E4B", "Start EmbeddingGemma", "Manage Qwen 3.5 4B"]);
    rerender(<MlxModelStatusPanel {...props} mlxActionModel="gemma4" mlxAction="load" />);
    expect(names()).toEqual(["Start Gemma 4 E4B", "Start Llama 3.2 3B Instruct", "Stop Whisper", "Start EmbeddingGemma", "Manage Qwen 3.5 4B"]);
    expect(grid).toHaveAttribute("tabindex", "0");
  });

  it("keeps busy models visible but prevents unloading an active request", () => {
    const toggle = vi.fn();
    render(<MlxModelStatusPanel mlxStatus={status} mlxActionModel={null} onInstallMlxModel={vi.fn()} onToggleMlxModel={toggle} onOpenSettings={vi.fn()} />);
    expect(screen.getByText("1 active request")).toBeInTheDocument();
    const whisper = screen.getByRole("button", { name: "Stop Whisper" });
    expect(whisper).toBeDisabled();
    expect(whisper).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(whisper);
    expect(toggle).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Start Gemma 4 E4B" }));
    expect(toggle).toHaveBeenCalledWith("gemma4", false);
  });

  it("opens Models settings for unavailable models", () => {
    const open = vi.fn();
    render(<MlxModelStatusPanel mlxStatus={{ ...status, helperAvailable: false }} mlxActionModel={null} onInstallMlxModel={vi.fn()} onToggleMlxModel={vi.fn()} onOpenSettings={open} />);
    fireEvent.click(screen.getByRole("button", { name: "Manage Whisper" }));
    expect(open).toHaveBeenCalledWith("models");
    expect(screen.queryByText("Click to load")).not.toBeInTheDocument();
  });

  it("polls automatic model switches with one request stream and stops on unmount", async () => {
    vi.useFakeTimers();
    let snapshot = status;
    const fetchMock = vi.fn(() => Promise.resolve(response(snapshot)));
    vi.stubGlobal("fetch", fetchMock);
    const { result, unmount } = renderHook(() => useWorkspaceModels(vi.fn()));
    await act(async () => { await result.current.refreshMlxStatus(); });
    snapshot = { ...status, activeModel: "gemma4", models: status.models.map((model) => ({ ...model, loaded: model.id === "gemma4", busy: false, requestCount: 0 })) };
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(result.current.mlxStatus?.activeModel).toBe("gemma4");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    unmount();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("shares in-flight reads and discards a status snapshot from before a mutation", async () => {
    let finishStatus: ((value: Response) => void) | undefined;
    let reads = 0;
    const fetchMock = vi.fn((_url: string, options?: RequestInit) => {
      if (options?.method === "POST") return Promise.resolve(response(status));
      reads += 1;
      return reads === 1 ? new Promise<Response>((resolve) => { finishStatus = resolve; }) : Promise.resolve(response(status));
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useWorkspaceModels(vi.fn()));
    let initialRead: Promise<MlxStatus>;
    let action: Promise<void>;
    await act(async () => {
      initialRead = result.current.refreshMlxStatus();
      expect(result.current.refreshMlxStatus()).toBe(initialRead);
      action = result.current.toggleMlxModel("gemma4", false);
    });
    await act(async () => {
      finishStatus?.(response({ ...status, activeModel: null }));
      await initialRead;
      await action;
    });
    expect(reads).toBe(2);
    expect(result.current.mlxStatus?.activeModel).toBe("whisper");
  });

  it("refreshes actual helper state after a failed action and locks duplicate clicks", async () => {
    let finishMutation: ((value: Response) => void) | undefined;
    const fetchMock = vi.fn((_url: string, options?: RequestInit) => options?.method === "POST"
      ? new Promise<Response>((resolve) => { finishMutation = resolve; })
      : Promise.resolve(response(status)));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useWorkspaceModels(vi.fn()));
    let action: Promise<void>;
    await act(async () => {
      action = result.current.toggleMlxModel("gemma4", false);
      void result.current.toggleMlxModel("gemma4", false);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { finishMutation?.(response({ error: "The model is busy." }, 409)); await action; });
    expect(result.current.modelError).toBe("The model is busy.");
    expect(result.current.mlxStatus?.activeModel).toBe("whisper");
    expect(result.current.mlxActionModel).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
