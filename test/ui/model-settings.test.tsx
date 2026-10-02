import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { MlxStatus } from "../../src/domain/types.ts";
import type { ModelSettingsControls } from "../../src/features/settings/components/ModelSettings.tsx";
import { SettingsDialog } from "../../src/features/settings/components/SettingsDialog.tsx";

const status: MlxStatus = {
  available: true,
  helperAvailable: true,
  keepAliveMs: 60_000,
  installing: ["qwen35"],
  selectedGenerationModel: "gemma4",
  selectedTranscriptionModel: "whisper",
  downloads: [{ id: "qwen35", progress: { downloadedBytes: 1_530_000_000, totalBytes: 3_060_000_000, percent: 50, phase: "downloading" } }],
  models: [
    { id: "qwen35", name: "Qwen 3.5 4B", purpose: "generation", downloadSizeBytes: 3_060_000_000, downloadSizeIsEstimate: true, selected: false, installed: false, loaded: false, memory: null },
    { id: "llama32", name: "Llama 3.2 3B Instruct", purpose: "generation", downloadSizeBytes: 1_810_000_000, downloadSizeIsEstimate: true, selected: false, installed: false, loaded: false, memory: null },
    { id: "gemma4", name: "Gemma 4 E4B", purpose: "generation", downloadSizeBytes: 5_180_000_000, downloadSizeIsEstimate: true, selected: true, installed: true, loaded: false, memory: null },
    { id: "embeddinggemma", name: "EmbeddingGemma", purpose: "embeddings", downloadSizeBytes: 212_000_000, downloadSizeIsEstimate: true, selected: false, installed: false, loaded: false, memory: null },
    { id: "whisper", name: "Whisper Large v3 Turbo", purpose: "transcription", downloadSizeBytes: 1_610_000_000, downloadSizeIsEstimate: true, selected: true, installed: false, loaded: false, memory: null },
    { id: "whisperlarge", name: "Whisper Large v3", purpose: "transcription", downloadSizeBytes: 3_100_000_000, downloadSizeIsEstimate: true, selected: false, installed: false, loaded: false, memory: null },
  ],
};

function renderSettings(overrides: Partial<ModelSettingsControls> = {}) {
  const select = vi.fn();
  const selectTranscription = vi.fn();
  const install = vi.fn();
  const remove = vi.fn();
  render(
    <SettingsDialog
      themeId="original"
      onSelectTheme={vi.fn()}
      obsidianImport={{ supported: false, busy: false, scan: null, job: null, error: "", selectVault: () => {}, confirmImport: () => {}, cancelImport: () => {}, clearScan: () => {} }}
      onClose={vi.fn()}
      initialCategory="models"
      modelSettings={{ status, actionModel: null, action: null, error: "", install, remove, select, selectTranscription, ...overrides }}
    />,
  );
  return { select, selectTranscription, install, remove };
}

describe("model settings", () => {
  it("offers independent transcription radios and administers both Whisper variants", () => {
    const actions = renderSettings({ status: { ...status, models: status.models.map((model) => model.id === "whisper" ? { ...model, installed: true } : model) } });
    const turbo = screen.getByRole("radio", { name: /Whisper Large v3 Turbo/ });
    const large = screen.getByRole("radio", { name: /Whisper Large v3.*3\.1 GB/ });
    expect(turbo).toBeChecked();
    fireEvent.click(large);
    expect(actions.selectTranscription).toHaveBeenCalledWith("whisperlarge");
    expect(screen.getByRole("radio", { name: /Gemma 4 E4B/ })).toBeChecked();
    const row = screen.getByText("Whisper Large v3 Turbo").closest(".model-settings-row") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Remove" }));
    expect(actions.remove).toHaveBeenCalledWith("whisper");
  });

  it("reports Large v3 download progress and prevents duplicate downloads", () => {
    renderSettings({ status: { ...status, selectedTranscriptionModel: "whisperlarge", installing: ["whisperlarge"], downloads: [{ id: "whisperlarge", progress: { downloadedBytes: 1_550_000_000, totalBytes: 3_100_000_000, percent: 50, phase: "downloading" } }] } });
    expect(screen.getByRole("progressbar", { name: "Downloading Whisper Large v3" })).toHaveAttribute("value", "50");
    const row = screen.getByText("Whisper Large v3").closest(".model-settings-row") as HTMLElement;
    expect(within(row).getByRole("button", { name: "Downloading…" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(/selected transcription model is not installed/i);
  });

  it("selects one generation model, keeps EmbeddingGemma fixed, and reports byte progress", () => {
    const actions = renderSettings();
    expect(screen.getByRole("radio", { name: /Gemma 4 E4B/ })).toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: /Qwen 3.5 4B/ }));
    expect(actions.select).toHaveBeenCalledWith("qwen35");
    expect(screen.queryByRole("radio", { name: /EmbeddingGemma/ })).not.toBeInTheDocument();
    expect(screen.getByText("50% · 1.5 GB of 3.1 GB")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(actions.remove).toHaveBeenCalledWith("gemma4");
    const llamaRow = screen.getByText("Llama 3.2 3B Instruct").closest(".model-settings-row");
    expect(llamaRow).not.toBeNull();
    fireEvent.click(within(llamaRow as HTMLElement).getByRole("button", { name: "Download" }));
    expect(actions.install).toHaveBeenCalledWith("llama32");
  });

  it("explains when the native helper is unavailable and disables downloads", () => {
    renderSettings({ status: { ...status, helperAvailable: false } });
    expect(screen.getByText(/helper is not ready/i)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Download" }).every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
  });
});
