import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BundleSettings,
  type BundleSettingsControls,
} from "../../src/features/settings/components/BundleSettings.tsx";
import type { ObsidianImportSettings } from "../../src/features/settings/model/obsidian-import.ts";

const bundle = {
  id: "work",
  name: "Work",
  markdownPath: "/notes/work",
  managed: false,
  detached: false,
};
function renderSettings(overrides: Partial<ObsidianImportSettings> = {}) {
  const controls: BundleSettingsControls = {
    bundles: [bundle],
    activeBundleId: bundle.id,
    error: "",
    selectBundle: vi.fn(),
    setupBundle: vi.fn().mockResolvedValue(bundle),
    renameBundle: vi.fn().mockResolvedValue(undefined),
    detachBundle: vi.fn().mockResolvedValue(undefined),
  };
  const importer: ObsidianImportSettings = {
    supported: true,
    busy: false,
    scan: null,
    job: null,
    error: "",
    selectVault: vi.fn(),
    confirmImport: vi.fn(),
    cancelImport: vi.fn(),
    clearScan: vi.fn(),
    ...overrides,
  };
  render(<BundleSettings controls={controls} obsidianImport={importer} />);
  return { controls, importer };
}

describe("bundle setup interface", () => {
  afterEach(() => {
    delete window.folio;
  });

  it("reveals one setup flow and creates a managed bundle with only a name", async () => {
    const { controls } = renderSettings();
    expect(
      screen.queryByRole("textbox", { name: "Name" }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Create bundle or import Obsidian vault" }),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Personal" },
    });
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Create bundle" })),
    );
    expect(controls.setupBundle).toHaveBeenCalledWith({
      destination: "new",
      source: "empty",
      name: "Personal",
    });
    expect(
      screen.queryByRole("textbox", { name: "Name" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Work is ready.");
  });

  it("opens an existing Folio bundle in place and derives its editable name", async () => {
    window.folio = {
      selectFolder: vi.fn().mockResolvedValue("/notes/Research"),
    };
    const { controls } = renderSettings();
    fireEvent.click(
      screen.getByRole("button", { name: "Create bundle or import Obsidian vault" }),
    );
    fireEvent.click(screen.getByRole("radio", { name: /Existing Folio bundle/ }));
    expect(
      screen.queryByRole("combobox", { name: "Location" }),
    ).not.toBeInTheDocument();
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Choose folder" })),
    );
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue(
      "Research",
    );
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Open bundle" })),
    );
    expect(controls.setupBundle).toHaveBeenCalledWith({
      destination: "new",
      source: "existing",
      name: "Research",
      markdownPath: "/notes/Research",
    });
  });

  it("keeps existing Folio bundle selection desktop-only in the browser", () => {
    renderSettings();
    fireEvent.click(
      screen.getByRole("button", { name: "Create bundle or import Obsidian vault" }),
    );
    fireEvent.click(screen.getByRole("radio", { name: /Existing Folio bundle/ }));

    expect(
      screen.getByRole("button", { name: "Choose folder" }),
    ).toBeDisabled();
    expect(
      screen.getByText("Open Folio desktop to connect an existing Folio bundle."),
    ).toBeInTheDocument();
  });

  it("creates a named bundle under the selected custom parent", async () => {
    window.folio = { selectFolder: vi.fn().mockResolvedValue("/notes") };
    const { controls } = renderSettings();
    fireEvent.click(
      screen.getByRole("button", { name: "Create bundle or import Obsidian vault" }),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Personal" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Location" }), {
      target: { value: "custom" },
    });
    expect(
      screen.getByRole("button", { name: "Create bundle" }),
    ).toBeDisabled();
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Choose folder" })),
    );
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Create bundle" })),
    );
    expect(controls.setupBundle).toHaveBeenCalledWith({
      destination: "new",
      source: "empty",
      name: "Personal",
      parentPath: "/notes",
    });
  });

  it("uses the same import preview for an existing destination", async () => {
    const { controls, importer } = renderSettings({
      scan: {
        id: "scan",
        vaultId: "vault",
        name: "Archive",
        provider: "browser",
        total: 2,
        counts: {
          new: 2,
          imported: 0,
          changed: 0,
          retryable: 0,
          invalid: 0,
          attachments: 0,
        },
        requiredUploads: [],
      },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Import into" }), {
      target: { value: "work" },
    });
    expect(
      screen.queryByRole("textbox", { name: "Name" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("combobox", { name: "Location" }),
    ).not.toBeInTheDocument();
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Start import" })),
    );
    expect(controls.setupBundle).toHaveBeenCalledWith({
      destination: "existing",
      source: "obsidian",
      name: "Archive",
      bundleId: "work",
      scanId: "scan",
    });
    expect(importer.confirmImport).toHaveBeenCalledOnce();
  });

  it("leaves a failed import ready to retry with a new vault scan", () => {
    const selectVault = vi.fn();
    renderSettings({
      selectVault,
      scan: {
        id: "scan",
        vaultId: "vault",
        name: "Archive",
        provider: "browser",
        total: 1,
        counts: {
          new: 1,
          imported: 0,
          changed: 0,
          retryable: 0,
          invalid: 0,
          attachments: 0,
        },
        requiredUploads: [],
      },
      job: {
        id: "job",
        scanId: "scan",
        phase: "failed",
        processed: 0,
        total: 1,
        imported: 0,
        failed: 1,
        unresolvedLinks: 0,
        error: "The import could not finish.",
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:01:00.000Z",
      },
    });

    const changeVault = screen.getByRole("button", { name: "Change vault" });
    expect(changeVault).toBeEnabled();
    fireEvent.click(changeVault);
    expect(selectVault).toHaveBeenCalledOnce();
  });

  it("explains file preservation before detaching", async () => {
    const { controls } = renderSettings();
    fireEvent.click(screen.getByRole("button", { name: "Detach Work" }));
    expect(controls.detachBundle).not.toHaveBeenCalled();
    expect(
      screen.getByText(/Its files and saved workspace will be kept/),
    ).toBeInTheDocument();
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Detach bundle" })),
    );
    expect(controls.detachBundle).toHaveBeenCalledWith("work");
  });
});
