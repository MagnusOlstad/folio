import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceShellProps } from "../../src/features/workspace/components/WorkspaceShell.tsx";
import { WorkspaceShell } from "../../src/features/workspace/components/WorkspaceShell.tsx";

vi.mock("../../src/features/workspace/components/EditorWorkspace.tsx", () => ({ EditorWorkspace: () => null }));
vi.mock("../../src/features/sidebar/WorkspaceSidebar.tsx", () => ({ WorkspaceSidebar: () => null }));
vi.mock("../../src/features/workspace/components/WorkspaceSidebarHandle.tsx", () => ({ WorkspaceSidebarHandle: () => null }));
vi.mock("../../src/features/workspace/components/WorkspaceLeftPaneHeader.tsx", () => ({ WorkspaceLeftPaneHeader: () => null }));

function shellProps(rightPaneOpen: boolean, loaded = true): WorkspaceShellProps {
  const documentId = "/notes/current.md";
  return {
    app: {
      versionInfo: null,
      onOpenSettings: vi.fn(),
      status: null,
      missingModels: [],
      modelInstallInProgress: false,
      modelEndpoints: [],
      togglingService: null,
      onInstall: vi.fn(),
      onToggle: vi.fn(),
    },
    settings: { open: false } as WorkspaceShellProps["settings"],
    sidebar: {} as WorkspaceShellProps["sidebar"],
    editor: {
      model: {
        historyTarget: { groupId: "primary", documentId },
        documents: loaded ? { [documentId]: { title: "Current note", deletable: true } } : {},
        loadingDocuments: loaded ? new Set() : new Set([documentId]),
      },
      actions: {
        beforeHistoryRestore: vi.fn().mockResolvedValue(undefined),
        historyRestored: vi.fn().mockResolvedValue(undefined),
      },
    } as WorkspaceShellProps["editor"],
    exportPreview: null,
    layout: {
      sidebarWidth: null,
      rightPaneWidth: null,
      sidebarOpen: false,
      rightPaneOpen,
      setSidebarOpen: vi.fn(),
      setRightPaneOpen: vi.fn(),
      beginHorizontalResize: vi.fn(),
      finishHorizontalResize: vi.fn(),
      resizeSidebar: vi.fn(),
      resizeRightPane: vi.fn(),
      resetSidebar: vi.fn(),
      resetRightPane: vi.fn(),
    },
  };
}

describe("workspace history pane", () => {
  it("does not fetch history while the shell pane is closed, then loads when reopened", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ entries: [], nextCursor: null }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);
    const { rerender } = render(<WorkspaceShell {...shellProps(false)} />);
    expect(fetchMock).not.toHaveBeenCalled();

    rerender(<WorkspaceShell {...shellProps(true)} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(fetchMock.mock.calls[0]?.[0]).toContain("/api/note/history?");
    vi.unstubAllGlobals();
  });

  it("keeps history mode pending without fetching for an unloaded tab", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { getByRole } = render(<WorkspaceShell {...shellProps(true, false)} />);
    expect(getByRole("status")).toHaveTextContent("Loading note");
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
