import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopUpdateState } from "../../src/domain/types.ts";
import { UpdateSettings } from "../../src/features/settings/components/UpdateSettings.tsx";

describe("UpdateSettings", () => {
  afterEach(() => {
    delete window.folio;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("checks stable updates and offers the packaged download/install flow", async () => {
    let state: DesktopUpdateState = { status: "idle", version: null, percent: null, error: null };
    const listeners = new Set<(next: DesktopUpdateState) => void>();
    const publish = (next: DesktopUpdateState) => {
      state = next;
      listeners.forEach((listener) => listener(next));
    };
    const checkForUpdates = vi.fn(async () => {
      publish({ status: "available", version: "0.8.0", percent: null, error: null });
      return state;
    });
    const startUpdate = vi.fn(async () => {
      publish({ status: "downloading", version: "0.8.0", percent: 42, error: null });
      return state;
    });
    window.folio = {
      getUpdateState: vi.fn(async () => state),
      checkForUpdates,
      startUpdate,
      onUpdateState: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };

    render(<UpdateSettings />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    await screen.findByRole("button", { name: "Download and install v0.8.0" });
    expect(checkForUpdates).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Download and install v0.8.0" }));
    expect(await screen.findByRole("progressbar", { name: "Downloading update" })).toHaveAttribute("value", "42");
    expect(startUpdate).toHaveBeenCalledOnce();
    expect(screen.getByText("Folio will save pending changes before restarting to finish installation.")).toBeVisible();
  });

  it("falls back to the release page check when the desktop updater is unavailable", async () => {
    window.folio = {
      getUpdateState: vi.fn(async () => null),
      checkForUpdates: vi.fn(async () => null),
    };
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ version: "0.7.5", repo: "owner/repo", latest: null, updateAvailable: false }),
    })));

    render(<UpdateSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));

    expect(await screen.findByText("Folio is up to date.")).toBeVisible();
    expect(fetch).toHaveBeenCalledWith("/api/version?refresh=1");
  });

  it("surfaces API failures from a browser release check", async () => {
    window.folio = {
      getUpdateState: vi.fn(async () => null),
      checkForUpdates: vi.fn(async () => null),
    };
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503 })));

    render(<UpdateSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not check for updates. Try again.");
  });

  it("offers a retry when download or save-before-restart fails", async () => {
    let state: DesktopUpdateState = { status: "available", version: "0.8.0", percent: null, error: null };
    const listeners = new Set<(next: DesktopUpdateState) => void>();
    const publish = (next: DesktopUpdateState) => {
      state = next;
      listeners.forEach((listener) => listener(next));
    };
    const startUpdate = vi.fn(async () => {
      publish({ status: "error", version: "0.8.0", percent: null, error: "Save your changes before installing the update. Click to retry." });
      return state;
    });
    window.folio = {
      getUpdateState: vi.fn(async () => state),
      checkForUpdates: vi.fn(async () => state),
      startUpdate,
      onUpdateState: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };

    render(<UpdateSettings />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Download and install v0.8.0" }));
    const retry = await screen.findByRole("button", { name: "Retry update" });
    expect(screen.getByRole("alert")).toHaveTextContent("Save your changes");

    startUpdate.mockImplementationOnce(async () => {
      publish({ status: "downloading", version: "0.8.0", percent: 1, error: null });
      return state;
    });
    fireEvent.click(retry);
    await screen.findByText("Downloading update: 1%");
    expect(startUpdate).toHaveBeenCalledTimes(2);
  });
});
