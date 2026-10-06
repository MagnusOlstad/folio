import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsDialog } from "../../src/features/settings/components/SettingsDialog.tsx";
import {
  loadStoredTheme,
  useThemeSettings,
} from "../../src/features/settings/hooks/useThemeSettings.ts";
import { WorkspaceLeftPaneHeader } from "../../src/features/workspace/components/WorkspaceLeftPaneHeader.tsx";
import { useObsidianImport } from "../../src/features/settings/hooks/useObsidianImport.ts";
import {
  DEFAULT_NOTE_FONT_SIZE,
  loadStoredNoteFontSize,
  normalizeNoteFontSize,
} from "../../src/features/settings/model/note-appearance.ts";

describe("theme settings", () => {
  afterEach(() => {
    window.localStorage.clear();
    delete document.documentElement.dataset.theme;
    document.documentElement.style.colorScheme = "";
    document.documentElement.style.removeProperty("--note-font-size");
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

  it("loads a valid note font size, defaults corrupted storage, and clamps out-of-range values", () => {
    expect(loadStoredNoteFontSize()).toBe(DEFAULT_NOTE_FONT_SIZE);
    window.localStorage.setItem("folio:note-font-size", "23");
    expect(loadStoredNoteFontSize()).toBe(23);
    window.localStorage.setItem("folio:note-font-size", "not-a-size");
    expect(loadStoredNoteFontSize()).toBe(DEFAULT_NOTE_FONT_SIZE);
    window.localStorage.setItem("folio:note-font-size", "   ");
    expect(loadStoredNoteFontSize()).toBe(DEFAULT_NOTE_FONT_SIZE);
    expect(normalizeNoteFontSize(1)).toBe(12);
    expect(normalizeNoteFontSize(100)).toBe(28);
  });

  it("applies and persists note font size independently of the color theme", () => {
    window.localStorage.setItem("folio:theme", "light");
    const { result } = renderHook(() => useThemeSettings());

    expect(result.current.noteFontSize).toBe(DEFAULT_NOTE_FONT_SIZE);
    act(() => result.current.selectNoteFontSize(22));

    expect(document.documentElement.style.getPropertyValue("--note-font-size")).toBe("22px");
    expect(window.localStorage.getItem("folio:note-font-size")).toBe("22");
    expect(window.localStorage.getItem("folio:theme")).toBe("light");
  });

  it("keeps font size usable when browser storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("Storage disabled");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Storage disabled");
    });
    const { result } = renderHook(() => useThemeSettings());

    expect(result.current.noteFontSize).toBe(DEFAULT_NOTE_FONT_SIZE);
    act(() => result.current.selectNoteFontSize(21));

    expect(result.current.noteFontSize).toBe(21);
    expect(document.documentElement.style.getPropertyValue("--note-font-size")).toBe("21px");
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
        initialCategory="appearance"
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
    expect(screen.getByRole("radio", { name: /Original/ })).toBeChecked();
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();

    fireEvent.click(screen.getByRole("radio", { name: /Editorial/ }));
    expect(onSelectTheme).toHaveBeenCalledWith("editorial");

    const categories = screen.getByRole("navigation", { name: "Settings categories" });
    fireEvent.click(screen.getByRole("button", { name: "Bundles" }));
    expect(screen.getByRole("region", { name: "Bundles settings" })).toBeInTheDocument();
    expect(screen.getByText(/Create bundle or import Obsidian vault/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Backup" }));
    expect(screen.getByRole("region", { name: "Backup settings" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Download all bundle backups" })).toHaveAttribute("href", "/api/backup");
    expect(categories).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Appearance" }));
    fireEvent.keyDown(screen.getByRole("button", { name: "Appearance" }), { key: "ArrowRight" });
    expect(screen.getByRole("button", { name: "Backup" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "Backup" })).toHaveFocus();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps an in-progress bundle setup draft when switching categories", () => {
    render(
      <SettingsDialog
        themeId="original"
        onSelectTheme={() => {}}
        obsidianImport={{ supported: false, busy: false, scan: null, job: null, error: "", selectVault: () => {}, confirmImport: () => {}, cancelImport: () => {}, clearScan: () => {} }}
        onClose={() => {}}
        bundleSetup={{
          bundles: [{ id: "work", name: "Work", markdownPath: "/notes/work", managed: false, detached: false }],
          activeBundleId: "work",
          error: "",
          selectBundle: () => {},
          setupBundle: async () => ({ id: "work", name: "Work", markdownPath: "/notes/work", managed: false, detached: false }),
          renameBundle: async () => {},
          detachBundle: async () => {},
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Create bundle or import Obsidian vault" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Research notes" } });

    fireEvent.click(screen.getByRole("button", { name: "Models" }));
    expect(screen.getByRole("region", { name: "Models settings" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Bundles" }));

    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Research notes");
  });

  it("runs the active-bundle reindex from bundle settings and shows its busy state", async () => {
    let finishReindex: (() => void) | undefined;
    const reindexBundle = vi.fn(() => new Promise<void>((resolve) => { finishReindex = resolve; }));
    const bundleSetup = {
      bundles: [{ id: "work", name: "Work", markdownPath: "/notes/work", managed: false, detached: false }],
      activeBundleId: "work",
      error: "",
      selectBundle: () => {},
      setupBundle: async () => ({ id: "work", name: "Work", markdownPath: "/notes/work", managed: false, detached: false }),
      renameBundle: async () => {},
      detachBundle: async () => {},
      reindexing: false,
      reindexBundle,
    };
    const props = {
      themeId: "original" as const,
      onSelectTheme: () => {},
      noteFontSize: 18,
      onSelectNoteFontSize: () => {},
      obsidianImport: { supported: false, busy: false, scan: null, job: null, error: "", selectVault: () => {}, confirmImport: () => {}, cancelImport: () => {}, clearScan: () => {} },
      onClose: () => {},
      bundleSetup,
    };
    const { rerender } = render(
      <SettingsDialog
        {...props}
      />,
    );

    const reindex = screen.getByRole("button", { name: "Reindex active bundle" });
    fireEvent.click(reindex);
    expect(reindexBundle).toHaveBeenCalledOnce();
    rerender(<SettingsDialog {...props} bundleSetup={{ ...bundleSetup, reindexing: true }} />);
    expect(screen.getByRole("button", { name: "Reindexing…" })).toBeDisabled();
    finishReindex?.();
  });

  it("hides reindex until a bundle is active", () => {
    render(
      <SettingsDialog
        themeId="original"
        onSelectTheme={() => {}}
        obsidianImport={{ supported: false, busy: false, scan: null, job: null, error: "", selectVault: () => {}, confirmImport: () => {}, cancelImport: () => {}, clearScan: () => {} }}
        onClose={() => {}}
        bundleSetup={{
          bundles: [],
          activeBundleId: null,
          error: "",
          selectBundle: () => {},
          setupBundle: async () => { throw new Error("Not used."); },
          renameBundle: async () => {},
          detachBundle: async () => {},
          reindexing: false,
          reindexBundle: vi.fn().mockResolvedValue(undefined),
        }}
      />,
    );

    expect(screen.queryByRole("button", { name: /Reindex active bundle|Reindexing/ })).not.toBeInTheDocument();
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

  it("keeps Folio identity and Settings in the left pane header", () => {
    const onOpenSettings = vi.fn();
    render(<WorkspaceLeftPaneHeader versionInfo={null} onOpenSettings={onOpenSettings} sidebarOpen onToggleSidebar={() => {}} />);

    expect(screen.getByRole("link", { name: "Folio home" })).toBeInTheDocument();
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
