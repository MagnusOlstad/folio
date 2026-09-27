import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsDialog } from "../../src/features/settings/components/SettingsDialog.tsx";
import {
  loadStoredTheme,
  useThemeSettings,
} from "../../src/features/settings/hooks/useThemeSettings.ts";
import { TopBar } from "../../src/features/status/TopBar.tsx";
import { useObsidianImport } from "../../src/features/settings/hooks/useObsidianImport.ts";

describe("theme settings", () => {
  afterEach(() => {
    window.localStorage.clear();
    delete document.documentElement.dataset.theme;
    document.documentElement.style.colorScheme = "";
    vi.restoreAllMocks();
    vi.useRealTimers();
    delete window.folio;
  });

  it("restores valid themes and defaults invalid or unavailable storage to Original", () => {
    expect(loadStoredTheme()).toBe("original");

    window.localStorage.setItem("folio:theme", "editorial");
    expect(loadStoredTheme()).toBe("editorial");

    window.localStorage.setItem("folio:theme", "unexpected");
    expect(loadStoredTheme()).toBe("original");

    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("Storage disabled");
    });
    expect(loadStoredTheme()).toBe("original");
  });

  it("applies and persists theme changes without touching unrelated storage", () => {
    window.localStorage.setItem("folio:theme", "light");
    window.localStorage.setItem("folio:drafts", "important draft");
    const { result } = renderHook(() => useThemeSettings());

    expect(result.current.themeId).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.style.colorScheme).toBe("light");

    act(() => result.current.selectTheme("dark"));

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(window.localStorage.getItem("folio:theme")).toBe("dark");
    expect(window.localStorage.getItem("folio:drafts")).toBe("important draft");
  });

  it("still applies changes when theme storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Storage disabled");
    });
    const { result } = renderHook(() => useThemeSettings());

    act(() => result.current.selectTheme("editorial"));

    expect(result.current.themeId).toBe("editorial");
    expect(document.documentElement.dataset.theme).toBe("editorial");
  });

  it("renders four swatch choices and reports immediate selections", () => {
    const onSelectTheme = vi.fn();
    const onClose = vi.fn();
    render(
      <SettingsDialog
        themeId="original"
        onSelectTheme={onSelectTheme}
        obsidianImport={{
          supported: false,
          busy: false,
          scan: null,
          job: null,
          error: "",
          selectVault: () => {},
          confirmImport: () => {},
          cancelImport: () => {},
          clearScan: () => {},
        }}
        onClose={onClose}
        bundleSetup={{
          bundles: [{
            id: "bundle-1",
            name: "Work vault",
            markdownPath: "/bundles/work-vault",
            managed: true,
            detached: false,
          }],
          activeBundleId: "bundle-1",
          error: "",
          selectBundle: () => {},
          setupBundle: async () => {
            throw new Error("Not used.");
          },
          renameBundle: async () => {},
          detachBundle: async () => {},
        }}
      />,
    );

    expect(screen.getAllByRole("radio", { name: /Original|Editorial|Light|Dark/ })).toHaveLength(4);
    expect(
      screen.getByText(/Download all attached bundles as one ZIP file/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Download all bundle backups" }),
    ).toHaveAttribute("href", "/api/backup");
    expect(screen.getByRole("radio", { name: /Original/ })).toBeChecked();
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();

    fireEvent.click(screen.getByRole("radio", { name: /Editorial/ }));
    expect(onSelectTheme).toHaveBeenCalledWith("editorial");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("summarizes a vault and requires one explicit import confirmation", async () => {
    const confirmImport = vi.fn();
    const setupBundle = vi.fn().mockResolvedValue({
      id: "bundle-1",
      name: "Work vault",
      markdownPath: "/bundles/work-vault",
      managed: true,
      detached: false,
    });
    render(
      <SettingsDialog
        themeId="original"
        onSelectTheme={() => {}}
        onClose={() => {}}
        bundleSetup={{
          bundles: [],
          activeBundleId: null,
          error: "",
          selectBundle: () => {},
          setupBundle,
          renameBundle: async () => {},
          detachBundle: async () => {},
        }}
        obsidianImport={{
          supported: true,
          busy: false,
          scan: {
            id: "scan-1",
            vaultId: "vault-1",
            name: "Work vault",
            provider: "browser",
            total: 9,
            counts: { new: 4, imported: 2, changed: 1, retryable: 1, invalid: 0, attachments: 1 },
            requiredUploads: ["Alpha.md"],
          },
          job: null,
          error: "",
          selectVault: () => {},
          confirmImport,
          cancelImport: () => {},
          clearScan: () => {},
        }}
      />,
    );

    expect(screen.getByText("Work vault")).toBeInTheDocument();
    expect(screen.getByText("Notes to import").nextElementSibling).toHaveTextContent("5");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start import" }));
    });
    expect(confirmImport).toHaveBeenCalledOnce();
    expect(setupBundle).toHaveBeenCalledOnce();
  });

  it("always shows the top-bar Settings button", () => {
    const onOpenSettings = vi.fn();
    const topBarProps = {
      versionInfo: null,
      status: null,
      missingModels: [],
      modelInstallInProgress: false,
      modelEndpoints: [],
      togglingService: null,
      onInstall: vi.fn(),
      onToggle: vi.fn(),
      onOpenSettings,
    };
    render(<TopBar {...topBarProps} />);

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it("reports a terminal Obsidian import exactly once", async () => {
    vi.useFakeTimers();
    const onImportFinished = vi.fn();
    const scan = {
      id: "scan-1",
      vaultId: "vault-1",
      name: "Work vault",
      provider: "electron" as const,
      total: 1,
      counts: { new: 1, imported: 0, changed: 0, retryable: 0, invalid: 0, attachments: 0 },
      requiredUploads: [],
    };
    const runningJob = {
      id: "job-1",
      scanId: scan.id,
      phase: "planning" as const,
      processed: 0,
      total: 1,
      imported: 0,
      failed: 0,
      unresolvedLinks: 0,
      error: null,
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: null,
    };
    window.folio = {
      selectObsidianVault: vi.fn().mockResolvedValue(scan),
      startObsidianImport: vi.fn().mockResolvedValue(runningJob),
      getObsidianImportJob: vi.fn().mockResolvedValue({
        ...runningJob,
        phase: "cancelled",
        imported: 1,
        finishedAt: "2026-01-01T00:01:00.000Z",
      }),
    };
    const { result } = renderHook(() => useObsidianImport({ onImportFinished }));

    await act(async () => result.current.selectVault());
    await act(async () => result.current.confirmImport());
    await act(async () => vi.advanceTimersByTimeAsync(500));
    await act(async () => vi.advanceTimersByTimeAsync(1_000));

    expect(onImportFinished).toHaveBeenCalledOnce();
    expect(onImportFinished).toHaveBeenCalledWith(expect.objectContaining({
      id: "job-1",
      phase: "cancelled",
      imported: 1,
    }));
  });
});
