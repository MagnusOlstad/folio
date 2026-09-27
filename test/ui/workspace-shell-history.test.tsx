import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceShellProps } from "../../src/features/workspace/components/WorkspaceShell.tsx";
import { NoteHistoryPanel } from "../../src/features/workspace/components/NoteHistoryPanel.tsx";
import { WorkspaceShell } from "../../src/features/workspace/components/WorkspaceShell.tsx";

vi.mock("../../src/features/workspace/components/EditorWorkspace.tsx", () => ({ EditorWorkspace: () => null }));
vi.mock("../../src/features/sidebar/WorkspaceSidebar.tsx", () => ({ WorkspaceSidebar: () => null }));
vi.mock("../../src/features/workspace/components/WorkspaceSidebarHandle.tsx", () => ({ WorkspaceSidebarHandle: () => null }));
vi.mock("../../src/features/workspace/components/WorkspaceLeftPaneHeader.tsx", () => ({ WorkspaceLeftPaneHeader: () => null }));

const noteId = "/notes/current.md";
const otherNoteId = "/notes/other.md";
const firstPage = { entries: [{ revision: "rev-1", authoredAt: "2026-09-26T12:00:00.000Z", title: "Older title" }], nextCursor: null };

function shellProps(options: {
  rightPaneOpen?: boolean;
  activeGroupId?: string;
  primaryId?: string;
  secondaryId?: string;
  documents?: Record<string, { title: string; deletable: boolean }>;
  loadingDocuments?: Set<string>;
  drafts?: Record<string, string>;
  beforeHistoryRestore?: (id: string) => Promise<void>;
  historyRestored?: (id: string) => Promise<void>;
} = {}): WorkspaceShellProps {
  const primaryId = options.primaryId ?? noteId;
  const secondaryId = options.secondaryId ?? otherNoteId;
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
        groups: [
          { id: "primary", tabs: [primaryId], activeId: primaryId, previewId: null },
          { id: "secondary", tabs: [secondaryId], activeId: secondaryId, previewId: null },
        ],
        activeGroupId: options.activeGroupId ?? "primary",
        documents: options.documents ?? {
          [noteId]: { title: "Current note", deletable: true },
          [otherNoteId]: { title: "Other note", deletable: true },
        },
        loadingDocuments: options.loadingDocuments ?? new Set(),
        drafts: options.drafts ?? {},
      },
      actions: {
        beforeHistoryRestore: options.beforeHistoryRestore ?? vi.fn().mockResolvedValue(undefined),
        historyRestored: options.historyRestored ?? vi.fn().mockResolvedValue(undefined),
      },
    } as unknown as WorkspaceShellProps["editor"],
    exportPreview: null,
    layout: {
      sidebarWidth: null,
      rightPaneWidth: null,
      sidebarOpen: false,
      rightPaneOpen: options.rightPaneOpen ?? true,
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

function stubHistoryApi() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.includes("/version?")
      ? { revision: "rev-1", note: { title: "Older title", description: "", tags: [], status: "stable", staleAfter: null, content: "old" }, diff: "@@ -1 +1 @@\n-old line\n+restored line" }
      : firstPage;
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("workspace history pane", () => {
  it("automatically loads the active filed note, follows active split group switches, and skips editor typing changes", async () => {
    const fetchMock = stubHistoryApi();
    const beforeHistoryRestore = vi.fn().mockResolvedValue(undefined);
    const historyRestored = vi.fn().mockResolvedValue(undefined);
    const firstProps = shellProps({ beforeHistoryRestore, historyRestored });
    const { rerender } = render(<WorkspaceShell {...firstProps} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(encodeURIComponent(noteId));
    expect(screen.queryByRole("button", { name: "History" })).not.toBeInTheDocument();

    const typedProps = shellProps({
      beforeHistoryRestore,
      historyRestored,
      drafts: { [noteId]: "typing in the editor" },
    });
    rerender(<WorkspaceShell {...typedProps} />);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const switchedProps = shellProps({ activeGroupId: "secondary", beforeHistoryRestore, historyRestored });
    rerender(<WorkspaceShell {...switchedProps} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(encodeURIComponent(otherNoteId));
    vi.unstubAllGlobals();
  });

  it("does not fetch while hidden and shows neutral states for drafts and unloaded notes", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const hidden = render(<WorkspaceShell {...shellProps({ rightPaneOpen: false })} />);
    expect(fetchMock).not.toHaveBeenCalled();
    hidden.unmount();

    const draft = render(<WorkspaceShell {...shellProps({ primaryId: "untitled:draft", documents: {} })} />);
    expect(screen.getByText("History is available for filed notes.")).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalled();
    draft.unmount();

    render(<WorkspaceShell {...shellProps({ documents: {}, loadingDocuments: new Set([noteId]) })} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading note");
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("renders direction-aware diff colors and keeps the confirmed restore flow", async () => {
    const fetchMock = stubHistoryApi();
    const beforeHistoryRestore = vi.fn().mockResolvedValue(undefined);
    const historyRestored = vi.fn().mockResolvedValue(undefined);
    const confirm = vi.fn().mockReturnValue(true);
    vi.stubGlobal("confirm", confirm);
    render(<NoteHistoryPanel documentId={noteId} onBeforeRestore={beforeHistoryRestore} onRestored={historyRestored} />);

    fireEvent.click(await screen.findByRole("button", { name: /Older title/ }));
    const addedLine = await screen.findByText("+restored line");
    expect(addedLine).toHaveClass("is-added");
    expect(screen.getByText("-old line")).toHaveClass("is-removed");
    expect(screen.getByText("Current → selected")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    expect(confirm).toHaveBeenCalledOnce();
    await waitFor(() => expect(historyRestored).toHaveBeenCalledWith(noteId));
    expect(beforeHistoryRestore).toHaveBeenCalledWith(noteId);
    expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith("/api/note/history/restore") && init?.method === "POST")).toBe(true);
    vi.unstubAllGlobals();
  });
});
