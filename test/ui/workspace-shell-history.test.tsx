import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceShellProps } from "../../src/features/workspace/components/WorkspaceShell.tsx";
import { NoteHistoryPanel } from "../../src/features/workspace/components/NoteHistoryPanel.tsx";
import { WorkspaceShell } from "../../src/features/workspace/components/WorkspaceShell.tsx";

vi.mock("../../src/features/workspace/components/EditorWorkspace.tsx", () => ({
  EditorWorkspace: ({ historyPreview }: WorkspaceShellProps["editor"] & { historyPreview?: { snapshot: { note: { content: string } } | null; loading: boolean } }) =>
    <div data-testid="main-note">{historyPreview ? historyPreview.loading ? "Loading preview" : historyPreview.snapshot?.note.content ?? "Read only present" : "Live editor"}</div>,
}));
vi.mock("../../src/features/sidebar/WorkspaceSidebar.tsx", () => ({ WorkspaceSidebar: () => null }));
vi.mock("../../src/features/workspace/components/WorkspaceSidebarHandle.tsx", () => ({ WorkspaceSidebarHandle: () => null }));
vi.mock("../../src/features/workspace/components/WorkspaceLeftPaneHeader.tsx", () => ({ WorkspaceLeftPaneHeader: () => null }));

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const noteId = "/notes/current.md";
const otherNoteId = "/notes/other.md";
const entries = [{ revision: "rev-1", authoredAt: "2026-09-26T12:00:00.000Z", title: "Older title" }];

function shellProps(options: {
  rightPaneOpen?: boolean;
  activeGroupId?: string;
  primaryId?: string;
  documents?: Record<string, { title: string; deletable: boolean }>;
  loadingDocuments?: Set<string>;
  beforeHistoryRestore?: (id: string) => Promise<void>;
  historyRestored?: (id: string) => Promise<void>;
  notifyMessage?: (message: string) => void;
} = {}): WorkspaceShellProps {
  const primaryId = options.primaryId ?? noteId;
  return {
    app: {
      versionInfo: null, onOpenSettings: vi.fn(), status: null, missingModels: [],
      modelInstallInProgress: false, modelEndpoints: [], togglingService: null,
      onInstall: vi.fn(), onToggle: vi.fn(),
    },
    settings: { open: false } as WorkspaceShellProps["settings"],
    sidebar: {} as WorkspaceShellProps["sidebar"],
    editor: {
      model: {
        groups: [
          { id: "primary", tabs: [primaryId], activeId: primaryId, previewId: null },
          { id: "secondary", tabs: [otherNoteId], activeId: otherNoteId, previewId: null },
        ],
        activeGroupId: options.activeGroupId ?? "primary",
        documents: options.documents ?? {
          [noteId]: { title: "Current note", deletable: true },
          [otherNoteId]: { title: "Other note", deletable: true },
        },
        loadingDocuments: options.loadingDocuments ?? new Set(),
        drafts: {},
      },
      actions: {
        beforeHistoryRestore: options.beforeHistoryRestore ?? vi.fn().mockResolvedValue(undefined),
        historyRestored: options.historyRestored ?? vi.fn().mockResolvedValue(undefined),
        notifyMessage: options.notifyMessage ?? vi.fn(),
      },
    } as unknown as WorkspaceShellProps["editor"],
    exportPreview: null,
    layout: {
      sidebarWidth: null, rightPaneWidth: null, sidebarOpen: false,
      rightPaneOpen: options.rightPaneOpen ?? true,
      setSidebarOpen: vi.fn(), setRightPaneOpen: vi.fn(),
      beginHorizontalResize: vi.fn(), finishHorizontalResize: vi.fn(),
      resizeSidebar: vi.fn(), resizeRightPane: vi.fn(),
      resetSidebar: vi.fn(), resetRightPane: vi.fn(),
    },
  };
}

function stubHistoryApi() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.includes("/version?")
      ? { revision: "rev-1", note: { title: "Older title", description: "", tags: [], status: "stable", staleAfter: null, content: "old content" }, diff: "+ignored diff" }
      : { entries, nextCursor: null };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("workspace history mode", () => {
  it("keeps history visible and exposes the live editor at Now", async () => {
    const fetchMock = stubHistoryApi();
    const props = shellProps();
    const { rerender } = render(<WorkspaceShell {...props} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("main-note")).toHaveTextContent("Live editor");
    expect(screen.getByRole("region", { name: "Note history" })).toBeVisible();
    fireEvent.click(await screen.findByRole("button", { name: /Older title/ }));
    await waitFor(() => expect(screen.getByTestId("main-note")).toHaveTextContent("old content"));
    expect(screen.queryByText(/ignored diff/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Present" }));
    expect(screen.getByTestId("main-note")).toHaveTextContent("Live editor");

    rerender(<WorkspaceShell {...shellProps({ activeGroupId: "secondary" })} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(screen.getByRole("region", { name: "Note history" })).toBeVisible();
  });

  it("keeps drafts live without history controls and leaves unloaded notes neutral", async () => {
    const fetchMock = stubHistoryApi();
    const { rerender } = render(<WorkspaceShell {...shellProps()} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    rerender(<WorkspaceShell {...shellProps({ activeGroupId: "secondary" })} />);
    expect(screen.getByRole("region", { name: "Note history" })).toBeInTheDocument();
    expect(screen.getByTestId("main-note")).toHaveTextContent("Live editor");
    rerender(<WorkspaceShell {...shellProps()} />);
    expect(screen.getByRole("region", { name: "Note history" })).toBeInTheDocument();
    rerender(<WorkspaceShell {...shellProps({ primaryId: "untitled:draft", documents: {} })} />);
    expect(screen.getByText("History begins after filing")).toBeVisible();
    expect(screen.getByText("File this draft to start keeping earlier versions.")).toBeVisible();
    expect(screen.queryByRole("region", { name: "Note history" })).not.toBeInTheDocument();
    expect(screen.getByTestId("main-note")).toHaveTextContent("Live editor");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    rerender(<WorkspaceShell {...shellProps({ documents: {}, loadingDocuments: new Set([noteId]) })} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading note");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("restores the selected moment and returns the preview to present", async () => {
    const fetchMock = stubHistoryApi();
    const before = vi.fn().mockResolvedValue(undefined);
    const restored = vi.fn().mockResolvedValue(undefined);
    const restoreFeedback = vi.fn();
    vi.stubGlobal("confirm", vi.fn().mockReturnValue(true));
    const preview = vi.fn();
    render(<NoteHistoryPanel documentId={noteId} onBeforeRestore={before} onRestored={restored} onRestoreFeedback={restoreFeedback} onPreview={preview} onExit={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /Older title/ }));
    await waitFor(() => expect(preview).toHaveBeenCalledWith(expect.objectContaining({ revision: "rev-1" }), false, false));
    fireEvent.click(screen.getByRole("button", { name: "Restore this version" }));
    await waitFor(() => expect(restored).toHaveBeenCalledWith(noteId));
    expect(before).toHaveBeenCalledWith(noteId);
    expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith("/api/note/history/restore") && init?.method === "POST")).toBe(true);
    await waitFor(() => expect(preview).toHaveBeenLastCalledWith(null, false, false));
    expect(restoreFeedback).toHaveBeenCalledWith("Restored. The previous present is still in history.");
    expect(screen.queryByText(/previous present is still in history/)).not.toBeInTheDocument();
  });

  it("routes restore failures through workspace feedback", async () => {
    vi.stubGlobal("confirm", vi.fn().mockReturnValue(true));
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/version?")) return new Response(JSON.stringify({ revision: "rev-1", note: { title: "Older title", content: "old" }, diff: "" }), { status: 200, headers: { "content-type": "application/json" } });
      if (url.endsWith("/api/note/history/restore")) return new Response(JSON.stringify({ error: "Restore service unavailable" }), { status: 503, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ entries, nextCursor: null }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const restoreFeedback = vi.fn();
    render(<NoteHistoryPanel documentId={noteId} onBeforeRestore={vi.fn().mockResolvedValue(undefined)} onRestored={vi.fn()} onRestoreFeedback={restoreFeedback} onPreview={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /Older title/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Restore this version" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Restore this version" }));
    await waitFor(() => expect(restoreFeedback).toHaveBeenCalledWith("Restore service unavailable"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("wires restore feedback to the workspace notification action", async () => {
    stubHistoryApi();
    vi.stubGlobal("confirm", vi.fn().mockReturnValue(true));
    const notifyMessage = vi.fn();
    render(<WorkspaceShell {...shellProps({ notifyMessage })} />);
    fireEvent.click(await screen.findByRole("button", { name: /Older title/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Restore this version" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Restore this version" }));
    await waitFor(() => expect(notifyMessage).toHaveBeenCalledWith("Restored. The previous present is still in history."));
  });

  it("keeps the last successful preview while a rapid selection is pending and ignores stale results", async () => {
    let resolveSlow: ((response: Response) => void) | undefined;
    const slow = new Promise<Response>((resolve) => { resolveSlow = resolve; });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes("/version?") && url.includes("rev-2")
        ? { revision: "rev-2", note: { title: "Another", description: "", tags: [], status: "stable", staleAfter: null, content: "second" }, diff: "" }
        : { entries: [...entries, { revision: "rev-2", authoredAt: "2026-09-25T12:00:00.000Z", title: "Another" }], nextCursor: null };
      if (url.includes("/version?") && url.includes("rev-1")) return slow;
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
    }));
    const preview = vi.fn();
    render(<NoteHistoryPanel documentId={noteId} onBeforeRestore={vi.fn().mockResolvedValue(undefined)} onRestored={vi.fn()} onRestoreFeedback={vi.fn()} onPreview={preview} onExit={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /Another/ }));
    await waitFor(() => expect(preview).toHaveBeenLastCalledWith(expect.objectContaining({ revision: "rev-2" }), false, false));
    fireEvent.click(screen.getByRole("button", { name: /Older title/ }));
    expect(preview).toHaveBeenLastCalledWith(expect.objectContaining({ revision: "rev-2" }), true, false);
    expect(screen.getByRole("button", { name: "Restore this version" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /Another/ }));
    await waitFor(() => expect(preview).toHaveBeenLastCalledWith(expect.objectContaining({ revision: "rev-2" }), false, false));
    resolveSlow?.(new Response(JSON.stringify({ revision: "rev-1", note: { content: "stale" }, diff: "" }), { status: 200, headers: { "content-type": "application/json" } }));
    await waitFor(() => expect(preview).toHaveBeenLastCalledWith(expect.objectContaining({ revision: "rev-2" }), false, false));
    expect(screen.getByRole("button", { name: "Restore this version" })).toBeEnabled();
  });

  it("shows a failed preview and retries when the same tick is selected again", async () => {
    let attempts = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/version?")) {
        attempts += 1;
        if (attempts === 1) return new Response("temporary error", { status: 503 });
        return new Response(JSON.stringify({ revision: "rev-1", note: { title: "Older title", content: "recovered" }, diff: "" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ entries, nextCursor: null }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const preview = vi.fn();
    render(<NoteHistoryPanel documentId={noteId} onBeforeRestore={vi.fn().mockResolvedValue(undefined)} onRestored={vi.fn()} onRestoreFeedback={vi.fn()} onPreview={preview} onExit={vi.fn()} />);
    const tick = await screen.findByRole("button", { name: /Older title/ });
    fireEvent.click(tick);
    await waitFor(() => expect(preview).toHaveBeenLastCalledWith(null, false, true));
    expect(screen.getByRole("alert")).toBeVisible();
    expect(screen.getByText("Could not open moment")).toBeVisible();
    fireEvent.click(tick);
    await waitFor(() => expect(preview).toHaveBeenLastCalledWith(expect.objectContaining({ revision: "rev-1" }), false, false));
    expect(attempts).toBe(2);
  });

  it("keeps older-page loading visible and retries a failed page without an automatic loop", async () => {
    let olderAttempts = 0;
    let finishOlder: ((response: Response) => void) | undefined;
    const delayedOlder = new Promise<Response>((resolve) => { finishOlder = resolve; });
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("cursor=older")) {
        olderAttempts += 1;
        return olderAttempts === 1 ? Promise.resolve(new Response(JSON.stringify({ error: "temporary error" }), { status: 503, headers: { "content-type": "application/json" } })) : delayedOlder;
      }
      return Promise.resolve(new Response(JSON.stringify({ entries, nextCursor: "older" }), { status: 200, headers: { "content-type": "application/json" } }));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<NoteHistoryPanel documentId={noteId} onBeforeRestore={vi.fn().mockResolvedValue(undefined)} onRestored={vi.fn()} onRestoreFeedback={vi.fn()} onPreview={vi.fn()} />);
    await screen.findByRole("button", { name: /Older title/ });
    fireEvent.click(screen.getByRole("button", { name: "Load earlier" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("temporary error");
    expect(olderAttempts).toBe(1);
    const timeline = screen.getByRole("navigation", { name: "Note timeline" });
    fireEvent.scroll(timeline);
    fireEvent.scroll(timeline);
    expect(olderAttempts).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    const loadingStatus = await screen.findByRole("status", { name: "Loading earlier moments" });
    expect(screen.getByRole("region", { name: "Note history" })).toContainElement(loadingStatus);
    expect(timeline).not.toContainElement(loadingStatus);
    fireEvent.scroll(timeline);
    fireEvent.scroll(timeline);
    expect(olderAttempts).toBe(2);

    finishOlder?.(new Response(JSON.stringify({ entries: [{ revision: "rev-older", authoredAt: "2026-09-25T12:00:00.000Z", title: "Older page" }], nextCursor: null }), { status: 200, headers: { "content-type": "application/json" } }));
    await screen.findByRole("button", { name: /Older page/ });
    expect(screen.queryByRole("button", { name: "Load earlier" })).not.toBeInTheDocument();
    expect(screen.queryByText("Loading earlier moments…")).not.toBeInTheDocument();
  });

  it("ignores an older page response after switching documents", async () => {
    let finishOlder: ((response: Response) => void) | undefined;
    const delayedOlder = new Promise<Response>((resolve) => { finishOlder = resolve; });
    const beforeRestore = vi.fn().mockResolvedValue(undefined);
    const restored = vi.fn();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("id=%2Fnotes%2Fcurrent.md") && url.includes("cursor=older")) return delayedOlder;
      const nextEntry = url.includes("other.md")
        ? { revision: "other-revision", authoredAt: "2026-09-26T12:00:00.000Z", title: "Other document" }
        : entries[0];
      const nextCursor = url.includes("other.md") ? null : "older";
      return Promise.resolve(new Response(JSON.stringify({ entries: [nextEntry], nextCursor }), { status: 200, headers: { "content-type": "application/json" } }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const props = { onBeforeRestore: beforeRestore, onRestored: restored, onRestoreFeedback: vi.fn(), onPreview: vi.fn() };
    const { rerender } = render(<NoteHistoryPanel documentId={noteId} {...props} />);
    await screen.findByRole("button", { name: /Older title/ });
    fireEvent.click(screen.getByRole("button", { name: "Load earlier" }));
    await screen.findByRole("status", { name: "Loading earlier moments" });
    rerender(<NoteHistoryPanel documentId={otherNoteId} {...props} />);
    await screen.findByRole("button", { name: /Other document/ });

    finishOlder?.(new Response(JSON.stringify({ entries: [{ revision: "stale-page", authoredAt: "2026-09-25T12:00:00.000Z", title: "Stale page" }], nextCursor: null }), { status: 200, headers: { "content-type": "application/json" } }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /Stale page/ })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: /Other document/ })).toBeInTheDocument();
  });

  it("settles wheel scrubbing before selecting and supports keyboard navigation", async () => {
    stubHistoryApi();
    const preview = vi.fn();
    render(<NoteHistoryPanel documentId={noteId} onBeforeRestore={vi.fn().mockResolvedValue(undefined)} onRestored={vi.fn()} onRestoreFeedback={vi.fn()} onPreview={preview} onExit={vi.fn()} />);
    const tick = await screen.findByRole("button", { name: /Older title/ });
    const timeline = screen.getByRole("navigation", { name: "Note timeline" });
    Object.defineProperty(timeline, "clientHeight", { configurable: true, value: 200 });
    vi.spyOn(timeline, "getBoundingClientRect").mockReturnValue(DOMRect.fromRect({ y: 0 }));
    vi.spyOn(tick, "getBoundingClientRect").mockReturnValue(DOMRect.fromRect({ y: 100 }));
    fireEvent.wheel(timeline);
    fireEvent.scroll(timeline);
    fireEvent.scroll(timeline);
    fireEvent.scroll(timeline);
    expect(preview).not.toHaveBeenCalledWith(expect.objectContaining({ revision: "rev-1" }), false, false);
    await new Promise((resolve) => setTimeout(resolve, 140));
    await waitFor(() => expect(preview).toHaveBeenLastCalledWith(expect.objectContaining({ revision: "rev-1" }), false, false));
    fireEvent.keyDown(timeline, { key: "Home" });
    await waitFor(() => expect(preview).toHaveBeenLastCalledWith(null, false, false));
  });
});
