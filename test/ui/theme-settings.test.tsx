import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsDialog } from "../../src/features/settings/components/SettingsDialog.tsx";
import {
  loadStoredTheme,
  useThemeSettings,
} from "../../src/features/settings/hooks/useThemeSettings.ts";
import { TopBar } from "../../src/features/status/TopBar.tsx";

describe("theme settings", () => {
  afterEach(() => {
    window.localStorage.clear();
    delete document.documentElement.dataset.theme;
    document.documentElement.style.colorScheme = "";
    vi.restoreAllMocks();
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
        onClose={onClose}
      />,
    );

    expect(screen.getAllByRole("radio")).toHaveLength(4);
    expect(screen.getByRole("radio", { name: /Original/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /Original/ })).toHaveFocus();

    fireEvent.click(screen.getByRole("radio", { name: /Editorial/ }));
    expect(onSelectTheme).toHaveBeenCalledWith("editorial");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("shows the top-bar Settings fallback only for browser builds", () => {
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
    const { rerender } = render(
      <TopBar {...topBarProps} showSettingsButton />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(onOpenSettings).toHaveBeenCalledOnce();

    rerender(<TopBar {...topBarProps} showSettingsButton={false} />);
    expect(screen.queryByRole("button", { name: "Settings" })).not.toBeInTheDocument();
  });
});
