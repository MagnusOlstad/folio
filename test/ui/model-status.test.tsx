import { act, fireEvent, render, renderHook, screen, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MlxStatus } from "../../src/domain/types.ts";
import { ModelSettings } from "../../src/features/settings/components/ModelSettings.tsx";
import { MlxModelStatusPanel } from "../../src/features/status/WorkspaceStatus.tsx";
import { useWorkspaceModels } from "../../src/features/workspace/hooks/useWorkspaceModels.ts";

const status: MlxStatus = {
  available: true, helperAvailable: true, keepAliveMs: 60_000, installing: [], downloads: [], selectedGenerationModel: "gemma4", selectedTranscriptionModel: "whisper", activeModel: "whisper",
  models: [
    { id: "whisper", name: "Whisper Large v3 Turbo", purpose: "transcription", downloadSizeBytes: 1_610_000_000, downloadSizeIsEstimate: true, selected: true, installed: true, loaded: true, loading: false, busy: true, requestCount: 1, memory: null },
    { id: "whisperlarge", name: "Whisper Large v3", purpose: "transcription", downloadSizeBytes: 3_100_000_000, downloadSizeIsEstimate: true, selected: false, installed: false, loaded: false, loading: false, memory: null },
    { id: "gemma4", name: "Gemma 4 E4B", purpose: "generation", downloadSizeBytes: 5_180_000_000, downloadSizeIsEstimate: true, selected: true, installed: true, loaded: false, memory: null },
  ],
};
const response = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code });

beforeEach(() => { window.localStorage.removeItem("folio:model-panel-collapsed"); });
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.removeItem("folio:model-panel-collapsed");
  window.localStorage.removeItem("folio:model-setup-prompt-seen");
});

describe("model status", () => {
  it("latches first-open setup from the first loaded status across refresh failures and remounts", () => {
    window.localStorage.removeItem("folio:model-setup-prompt-seen");
    const onOpenSettings = vi.fn();
    const missingSelectedModel: MlxStatus = {
      ...status,
      models: status.models.map((model) => model.id === "gemma4" ? { ...model, installed: false, loaded: false } : model),
    };
    const props = { mlxActionModel: null, onInstallMlxModel: vi.fn(), onToggleMlxModel: vi.fn(), onOpenSettings };
    const view = render(<StrictMode><MlxModelStatusPanel {...props} mlxStatus={null} /></StrictMode>);
    expect(screen.queryByRole("button", { name: "Open model settings" })).not.toBeInTheDocument();

    view.rerender(<StrictMode><MlxModelStatusPanel {...props} mlxStatus={missingSelectedModel} /></StrictMode>);
    expect(screen.getByRole("button", { name: "Open model settings" })).toBeInTheDocument();
    expect(window.localStorage.getItem("folio:model-setup-prompt-seen")).toBe("1");

    view.rerender(<StrictMode><MlxModelStatusPanel {...props} mlxStatus={null} /></StrictMode>);
    expect(screen.getByRole("button", { name: "Open model settings" })).toBeInTheDocument();
    view.rerender(<StrictMode><MlxModelStatusPanel {...props} mlxStatus={status} /></StrictMode>);
    expect(screen.getByRole("button", { name: "Open model settings" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open model settings" }));
    expect(onOpenSettings).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Open model settings" })).not.toBeInTheDocument();
    view.rerender(<StrictMode><MlxModelStatusPanel {...props} mlxStatus={missingSelectedModel} /></StrictMode>);
    expect(screen.queryByRole("button", { name: "Open model settings" })).not.toBeInTheDocument();
    view.unmount();

    render(<MlxModelStatusPanel {...props} mlxStatus={missingSelectedModel} />);
    expect(screen.queryByRole("button", { name: "Open model settings" })).not.toBeInTheDocument();
  });

  it("still lets users dismiss the setup prompt when localStorage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("storage unavailable"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("storage unavailable"); });
    const onOpenSettings = vi.fn();
    const missingSelectedModel: MlxStatus = {
      ...status,
      models: status.models.map((model) => model.id === "gemma4" ? { ...model, installed: false, loaded: false } : model),
    };
    render(<MlxModelStatusPanel
      mlxStatus={missingSelectedModel}
      mlxActionModel={null}
      onInstallMlxModel={vi.fn()}
      onToggleMlxModel={vi.fn()}
      onOpenSettings={onOpenSettings}
    />);
    fireEvent.click(screen.getByRole("button", { name: "Open model settings" }));
    expect(onOpenSettings).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Open model settings" })).not.toBeInTheDocument();
  });

  it("advances both progress bars while the install request remains pending", async () => {
    vi.useFakeTimers();
    let currentStatus: MlxStatus = {
      ...status,
      models: status.models.map((model) => model.id === "gemma4" ? { ...model, installed: false, loaded: false } : model),
    };
    let finishInstall: ((value: Response) => void) | undefined;
    const fetchMock = vi.fn((_url: string, options?: RequestInit) => options?.method === "POST"
      ? new Promise<Response>((resolve) => { finishInstall = resolve; })
      : Promise.resolve(response(currentStatus)));
    vi.stubGlobal("fetch", fetchMock);

    function ProgressHarness() {
      const models = useWorkspaceModels(vi.fn());
      return <>
        <ModelSettings controls={{ status: models.mlxStatus, actionModel: models.mlxActionModel, action: models.mlxAction, error: models.modelError, install: models.installMlxModel, remove: models.removeMlxModel, select: models.selectGenerationModel, selectTranscription: models.selectTranscriptionModel }} />
        <MlxModelStatusPanel mlxStatus={models.mlxStatus} mlxActionModel={models.mlxActionModel} mlxAction={models.mlxAction} onInstallMlxModel={models.installMlxModel} onToggleMlxModel={models.toggleMlxModel} onOpenSettings={vi.fn()} />
      </>;
    }

    render(<ProgressHarness />);
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    const generationRow = screen.getAllByText("Gemma 4 E4B").find((element) => element.closest(".model-settings-row"))?.closest(".model-settings-row") as HTMLElement;
    fireEvent.click(within(generationRow).getByRole("button", { name: "Download" }));
    const progress = () => screen.getAllByRole("progressbar", { name: "Downloading Gemma 4 E4B" });
    expect(finishInstall).toBeDefined();
    expect(progress()).toHaveLength(2);
    expect(progress()[0]).not.toHaveAttribute("value");
    expect(progress()[1]).not.toHaveAttribute("value");

    const poll = async (nextStatus: MlxStatus) => {
      currentStatus = nextStatus;
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    };
    const statusRequestCount = () => fetchMock.mock.calls.filter(([url]) => url === "/api/mlx/status").length;
    await poll({ ...currentStatus, installing: ["gemma4"], downloads: [{ id: "gemma4", progress: { downloadedBytes: 0, totalBytes: 5_000_000_000, percent: 0, phase: "downloading" } }] });
    expect(statusRequestCount()).toBe(2);
    expect(progress().map((bar) => bar.hasAttribute("value"))).toEqual([false, false]);
    expect(screen.getByRole("button", { name: "Manage Gemma 4 E4B" }).querySelector(".mlx-model-state")).not.toHaveTextContent("0%");
    await poll({ ...currentStatus, downloads: [{ id: "gemma4", progress: { downloadedBytes: 1_000_000_000, totalBytes: 5_000_000_000, percent: 20, phase: "downloading" } }] });
    expect(statusRequestCount()).toBe(3);
    expect(progress().map((bar) => bar.getAttribute("value"))).toEqual(["20", "20"]);
    await poll({ ...currentStatus, downloads: [{ id: "gemma4", progress: { downloadedBytes: 3_000_000_000, totalBytes: 5_000_000_000, percent: 60, phase: "downloading" } }] });
    expect(statusRequestCount()).toBe(4);
    expect(progress().map((bar) => bar.getAttribute("value"))).toEqual(["60", "60"]);
    await poll({ ...currentStatus, downloads: [{ id: "gemma4", progress: { downloadedBytes: 5_000_000_000, totalBytes: 5_000_000_000, percent: 100, phase: "loading" } }] });
    expect(statusRequestCount()).toBe(5);
    expect(screen.getAllByRole("progressbar", { name: "Loading model Gemma 4 E4B" })).toHaveLength(2);

    await poll({
      ...currentStatus,
      installing: [],
      downloads: [],
      models: currentStatus.models.map((model) => model.id === "gemma4" ? { ...model, installed: true, loading: false } : model),
    });
    expect(statusRequestCount()).toBe(6);
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(finishInstall).toBeDefined();
    await act(async () => { finishInstall?.(response(currentStatus)); });
  });

  it.each([
    ["qwen35", "Qwen 3.5 4B", "generation"],
    ["embeddinggemma", "EmbeddingGemma", "embeddings"],
    ["whisperlarge", "Whisper Large v3", "transcription"],
  ] as const)("renders advancing download progress for %s until it is ready", (id, name, purpose) => {
    const template = status.models.find((model) => model.id === "gemma4")!;
    const installingStatus: MlxStatus = {
      ...status,
      selectedGenerationModel: id === "qwen35" ? "qwen35" : status.selectedGenerationModel,
      selectedTranscriptionModel: id === "whisperlarge" ? "whisperlarge" : status.selectedTranscriptionModel,
      installing: [id],
      downloads: [{ id, progress: null }],
      models: [...status.models, { ...template, id, name, purpose, installed: false, loaded: false, selected: false, memory: null }],
    };
    const props = { mlxStatus: installingStatus, mlxActionModel: null, onInstallMlxModel: vi.fn(), onToggleMlxModel: vi.fn(), onOpenSettings: vi.fn() };
    const { rerender } = render(<MlxModelStatusPanel {...props} />);
    const progressName = `Downloading ${name}`;
    expect(screen.getByRole("progressbar", { name: progressName })).not.toHaveAttribute("value");
    expect(screen.getByText("Preparing download")).toBeInTheDocument();

    const update = (downloadedBytes: number, percent: number, phase: "downloading" | "loading" = "downloading") => ({
      ...installingStatus,
      downloads: [{ id, progress: { downloadedBytes, totalBytes: 2_000_000_000, percent, phase } }],
      models: phase === "loading" ? installingStatus.models.map((model) => model.id === id ? { ...model, installed: true, loading: true } : model) : installingStatus.models,
    });
    rerender(<MlxModelStatusPanel {...props} mlxStatus={update(400_000_000, 20)} />);
    expect(screen.getByRole("progressbar", { name: progressName })).toHaveAttribute("value", "20");
    rerender(<MlxModelStatusPanel {...props} mlxStatus={update(1_400_000_000, 70)} />);
    expect(screen.getByRole("progressbar", { name: progressName })).toHaveAttribute("value", "70");
    rerender(<MlxModelStatusPanel {...props} mlxStatus={update(2_000_000_000, 100, "loading")} />);
    expect(screen.getByRole("progressbar", { name: `Loading model ${name}` })).not.toHaveAttribute("value");
    expect(screen.getByRole("button", { name: `Start ${name}` })).toHaveTextContent("Loading");

    rerender(<MlxModelStatusPanel {...props} mlxStatus={{
      ...installingStatus,
      installing: [],
      downloads: [],
      models: installingStatus.models.map((model) => model.id === id ? { ...model, installed: true, loading: false } : model),
    }} />);
    expect(screen.queryByRole("progressbar", { name: new RegExp(name) })).not.toBeInTheDocument();
  });

  it("clears progress and reports an install failure on the workspace surface", () => {
    const template = status.models.find((model) => model.id === "gemma4")!;
    const installingStatus: MlxStatus = {
      ...status,
      selectedGenerationModel: "qwen35",
      installing: ["qwen35"],
      downloads: [{ id: "qwen35", progress: { downloadedBytes: 500_000_000, totalBytes: 2_000_000_000, percent: 25, phase: "downloading" } }],
      models: [...status.models, { ...template, id: "qwen35", name: "Qwen 3.5 4B", installed: false, loaded: false, selected: false, memory: null }],
    };
    const props = { mlxStatus: installingStatus, mlxActionModel: null, onInstallMlxModel: vi.fn(), onToggleMlxModel: vi.fn(), onOpenSettings: vi.fn() };
    const { rerender } = render(<MlxModelStatusPanel {...props} />);
    expect(screen.getByRole("progressbar", { name: "Downloading Qwen 3.5 4B" })).toHaveAttribute("value", "25");
    rerender(<MlxModelStatusPanel {...props} mlxStatus={{ ...installingStatus, installing: [], downloads: [] }} modelError="Could not download Qwen 3.5 4B" />);
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Could not download Qwen 3.5 4B");
  });

  it("collapses model actions, retains management and errors, and follows live running state", () => {
    const open = vi.fn();
    const props = { mlxStatus: status, mlxActionModel: null, modelError: "Could not stop this model", onInstallMlxModel: vi.fn(), onToggleMlxModel: vi.fn(), onOpenSettings: open };
    const { rerender } = render(<MlxModelStatusPanel {...props} />);
    const collapse = screen.getByRole("button", { name: "Collapse models" });
    expect(collapse).toHaveAttribute("aria-expanded", "true");
    const bodyId = collapse.getAttribute("aria-controls")!;
    expect(document.getElementById(bodyId)).not.toHaveAttribute("hidden");
    fireEvent.click(collapse.querySelector(".model-status")!);
    expect(screen.getByRole("button", { name: "Expand models" })).toHaveAttribute("aria-expanded", "false");
    expect(document.getElementById(bodyId)).toHaveAttribute("hidden");
    expect(screen.queryByRole("button", { name: "Start Gemma 4 E4B" })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Models, active first" })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("MLX · 1 running");
    expect(screen.getByRole("status")).toHaveAccessibleName("MLX 1 running: Whisper Large v3 Turbo (in use)");
    expect(screen.getByRole("alert")).toHaveTextContent("Could not stop this model");
    fireEvent.click(screen.getByRole("button", { name: "Manage", exact: true }));
    expect(open).toHaveBeenCalledWith("models");
    expect(screen.getByRole("button", { name: "Expand models" })).toHaveAttribute("aria-expanded", "false");
    rerender(<MlxModelStatusPanel {...props} mlxStatus={{ ...status, models: status.models.map((model) => ({ ...model, loaded: false, busy: false, requestCount: 0 })) }} />);
    expect(screen.getByRole("status")).toHaveTextContent("MLX · 0 running");
    rerender(<MlxModelStatusPanel {...props} mlxStatus={{ ...status, helperAvailable: false }} />);
    expect(screen.getByRole("status")).toHaveTextContent("MLX · unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Expand models" }));
    expect(document.getElementById(bodyId)).not.toHaveAttribute("hidden");
    expect(screen.getByRole("group", { name: "Models, active first" })).toBeInTheDocument();
  });

  it("shows a launch-memory estimate for unloaded models and actual memory when running", () => {
    const props = { mlxStatus: status, mlxActionModel: null, onInstallMlxModel: vi.fn(), onToggleMlxModel: vi.fn() };
    const { rerender } = render(<MlxModelStatusPanel {...props} />);
    expect(screen.getByText("~5.18 GB on launch")).toHaveAttribute("title", expect.stringContaining("Estimated launch memory"));
    expect(screen.getByText("About 212 MB download")).toBeInTheDocument();

    const loadedStatus: MlxStatus = {
      ...status,
      models: status.models.map((model) => model.id === "gemma4" ? {
        ...model,
        loaded: true,
        memory: { activeBytes: 3_210_000_000, cacheBytes: 420_000_000, peakResidentBytes: 3_760_000_000 },
      } : model),
    };
    rerender(<MlxModelStatusPanel {...props} mlxStatus={loadedStatus} />);
    expect(screen.getByText("3.21 GB active")).toHaveAttribute("title", expect.stringContaining("Active memory"));
  });

  it("remembers collapse across mounts without changing existing preferences", () => {
    window.localStorage.setItem("folio:model-setup-prompt-seen", "1");
    const props = { mlxStatus: status, mlxActionModel: null, onInstallMlxModel: vi.fn(), onToggleMlxModel: vi.fn() };
    const { unmount } = render(<MlxModelStatusPanel {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Collapse models" }));
    expect(window.localStorage.getItem("folio:model-panel-collapsed")).toBe("1");
    unmount();
    render(<MlxModelStatusPanel {...props} />);
    expect(screen.getByRole("button", { name: "Expand models" })).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(screen.getByRole("button", { name: "Expand models" }));
    expect(window.localStorage.getItem("folio:model-panel-collapsed")).toBe("0");
    expect(window.localStorage.getItem("folio:model-setup-prompt-seen")).toBe("1");
  });

  it("still expands and collapses when preference storage fails", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("Storage unavailable"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage unavailable"); });
    render(<MlxModelStatusPanel mlxStatus={status} mlxActionModel={null} onInstallMlxModel={vi.fn()} onToggleMlxModel={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Collapse models" }));
    expect(screen.getByRole("status")).toHaveTextContent("1 running");
    fireEvent.click(screen.getByRole("button", { name: "Expand models" }));
    expect(screen.getByRole("button", { name: "Start Gemma 4 E4B" })).toBeVisible();
  });

  it("distinguishes running, stopped and missing models with text and shapes", () => {
    const { rerender } = render(<MlxModelStatusPanel mlxStatus={{ ...status, models: status.models.map((model) => ({ ...model, busy: false, requestCount: 0 })) }} mlxActionModel={null} onInstallMlxModel={vi.fn()} onToggleMlxModel={vi.fn()} onOpenSettings={vi.fn()} />);
    const running = screen.getByRole("button", { name: "Stop Whisper Large v3 Turbo" });
    const stopped = screen.getByRole("button", { name: "Start Gemma 4 E4B" });
    expect(screen.queryByRole("button", { name: "Manage Qwen 3.5 4B" })).not.toBeInTheDocument();
    const missing = screen.getByRole("button", { name: "Manage EmbeddingGemma" });
    expect(running).toHaveClass("is-loaded");
    expect(running).toHaveTextContent("▶Running");
    expect(stopped).toHaveClass("is-stopped");
    expect(stopped).toHaveTextContent("■Stopped");
    expect(stopped).not.toHaveClass("is-loaded");
    expect(missing).toHaveClass("is-dormant");
    expect(missing).toHaveTextContent("↓Not installed");
    const cachedLoadStatus: MlxStatus = {
      ...status,
      installing: ["gemma4"],
      downloads: [{ id: "gemma4", progress: null }],
      models: status.models.map((model) => model.id === "gemma4" ? { ...model, loading: true } : model),
    };
    rerender(<MlxModelStatusPanel mlxStatus={cachedLoadStatus} mlxActionModel="gemma4" mlxAction="load" onInstallMlxModel={vi.fn()} onToggleMlxModel={vi.fn()} onOpenSettings={vi.fn()} />);
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("orders active models before stopped models and missing downloads with stable ties", () => {
    const generationModel = status.models.find((model) => model.id === "gemma4")!;
    const loadingStatus: MlxStatus = { ...status, selectedGenerationModel: "llama32", installing: ["qwen35"], models: [
      ...status.models,
      { ...generationModel, id: "llama32", name: "Llama 3.2 3B Instruct", selected: false, loaded: false, loading: true },
      { ...generationModel, id: "embeddinggemma", name: "EmbeddingGemma", purpose: "embeddings", selected: false, loaded: false },
      { ...generationModel, id: "qwen35", name: "Qwen 3.5 4B", selected: false, installed: false, loaded: false, loading: true },
    ] };
    const props = { mlxStatus: loadingStatus, mlxActionModel: null, onInstallMlxModel: vi.fn(), onToggleMlxModel: vi.fn(), onOpenSettings: vi.fn() };
    const { rerender } = render(<MlxModelStatusPanel {...props} />);
    const grid = screen.getByRole("group", { name: "Models, active first" });
    const names = () => Array.from(grid.querySelectorAll("button")).map((button) => button.getAttribute("aria-label"));
    expect(names()).toEqual(["Start Llama 3.2 3B Instruct", "Stop Whisper Large v3 Turbo", "Start EmbeddingGemma"]);
    rerender(<MlxModelStatusPanel {...props} mlxActionModel="gemma4" mlxAction="load" />);
    expect(names()).toEqual(["Start Llama 3.2 3B Instruct", "Stop Whisper Large v3 Turbo", "Start EmbeddingGemma"]);
    expect(grid).toHaveAttribute("tabindex", "0");
  });

  it("shows only configured models, keeps fixed embeddings, and excludes hidden busy or installing models from the collapsed summary", () => {
    const qwenSelected: MlxStatus = {
      ...status,
      selectedGenerationModel: "qwen35",
      selectedTranscriptionModel: "whisperlarge",
      installing: ["llama32"],
      models: [
        ...status.models.filter((model) => model.id === "gemma4" || model.id === "whisper").map((model) => model.id === "whisper" ? { ...model, loaded: true } : model),
        { ...status.models[2]!, id: "qwen35", name: "Qwen 3.5 4B", purpose: "generation", installed: true, loaded: true, busy: true, requestCount: 2 },
        { ...status.models[2]!, id: "llama32", name: "Llama 3.2 3B Instruct", purpose: "generation", installed: false, loaded: false, selected: false },
        { ...status.models[1]!, id: "whisperlarge", name: "Whisper Large v3", purpose: "transcription", installed: true, loaded: false, selected: true },
        { ...status.models[2]!, id: "embeddinggemma", name: "EmbeddingGemma", purpose: "embeddings", installed: true, loaded: true, selected: false },
      ],
    };
    const { rerender } = render(<MlxModelStatusPanel mlxStatus={qwenSelected} mlxActionModel={null} onInstallMlxModel={vi.fn()} onToggleMlxModel={vi.fn()} />);
    expect(screen.getAllByRole("button", { name: /^(Stop|Start|Manage) / })).toHaveLength(3);
    expect(screen.getByRole("button", { name: "Stop Qwen 3.5 4B" })).toHaveTextContent("2 active requests");
    expect(screen.getByRole("button", { name: "Start Whisper Large v3" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop EmbeddingGemma" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Llama 3.2/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Whisper Large v3 Turbo/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Collapse models" }));
    expect(screen.getByRole("status")).toHaveAccessibleName("MLX 2 running: Qwen 3.5 4B (in use), EmbeddingGemma");

    rerender(<MlxModelStatusPanel mlxStatus={{ ...qwenSelected, selectedGenerationModel: "gemma4" }} mlxActionModel={null} onInstallMlxModel={vi.fn()} onToggleMlxModel={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveAccessibleName("MLX 1 running: EmbeddingGemma");
  });

  it("keeps busy models visible but prevents unloading an active request", () => {
    const toggle = vi.fn();
    render(<MlxModelStatusPanel mlxStatus={status} mlxActionModel={null} onInstallMlxModel={vi.fn()} onToggleMlxModel={toggle} onOpenSettings={vi.fn()} />);
    expect(screen.getByText("1 active request")).toBeInTheDocument();
    const whisper = screen.getByRole("button", { name: "Stop Whisper Large v3 Turbo" });
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
    fireEvent.click(screen.getByRole("button", { name: "Manage Whisper Large v3 Turbo" }));
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

  it("routes transcription selection independently and falls back to Turbo for legacy status", async () => {
    let snapshot: MlxStatus = { ...status, selectedTranscriptionModel: undefined };
    const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
      if (url === "/api/mlx/models/transcription-selection") {
        const { id } = JSON.parse(String(options?.body)) as { id: MlxStatus["selectedTranscriptionModel"] };
        snapshot = { ...snapshot, selectedTranscriptionModel: id };
      }
      return response(snapshot);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useWorkspaceModels(vi.fn()));
    await act(async () => { await result.current.refreshMlxStatus(); });
    expect(result.current.selectedTranscriptionModel).toBe("whisper");
    await act(async () => { await result.current.selectTranscriptionModel("whisperlarge"); });
    expect(fetchMock).toHaveBeenCalledWith("/api/mlx/models/transcription-selection", expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ id: "whisperlarge" }),
    }));
    expect(result.current.selectedTranscriptionModel).toBe("whisperlarge");
    expect(result.current.mlxStatus?.selectedGenerationModel).toBe("gemma4");
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
