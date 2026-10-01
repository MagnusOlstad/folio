import { act, createEvent, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ViewerDocument } from "../../src/domain/types.ts";
import { DocumentFooter } from "../../src/features/workspace/components/DocumentFooter.tsx";
import { DocumentHeader } from "../../src/features/workspace/components/DocumentHeader.tsx";
import { DocumentPane } from "../../src/features/workspace/components/DocumentPane.tsx";
import { FilingConfirmation } from "../../src/features/workspace/components/FilingConfirmation.tsx";
import { EditorGroup } from "../../src/features/workspace/components/EditorGroup.tsx";
import { RenderedMarkdown } from "../../src/features/workspace/components/RenderedMarkdown.tsx";
import { WorkspaceSplitHandle } from "../../src/features/workspace/components/WorkspaceSplitHandle.tsx";
import { WorkspaceLeftPaneHeader } from "../../src/features/workspace/components/WorkspaceLeftPaneHeader.tsx";
import { WorkspaceRightPane } from "../../src/features/workspace/components/WorkspaceRightPane.tsx";
import { NoteHistoryPanel } from "../../src/features/workspace/components/NoteHistoryPanel.tsx";
import { EditorTabs } from "../../src/features/tabs/EditorTabs.tsx";
import { useWorkspaceEditorUi } from "../../src/features/workspace/hooks/useWorkspaceEditorUi.ts";
import { prepareFiledDocumentHistory } from "../../src/features/workspace/model/history-actions.ts";
import { moveGroupTab } from "../../src/features/workspace/model/tab-state.ts";
import type { FilingQueueEntry } from "../../src/features/workspace/model/filing.ts";

const document: ViewerDocument = {
  id: "/notes/current.md",
  title: "Current note",
  type: "Note",
  description: "Description",
  tags: ["one"],
  createdAt: "2026-09-06T08:00:00.000Z",
  content: "[Other](other.md)\n\n- [ ] Task",
  deletable: true,
  movable: true,
  status: "stable",
  staleAfter: null,
  stale: false,
  filedBy: "human:test",
  filedAt: "2026-09-06T08:00:00.000Z",
  links: [],
  backlinks: [],
  suggestions: [],
};

describe("workspace editor components", () => {
  it("flushes before history actions and rejects when the save remains dirty", async () => {
    const flushSave = vi.fn().mockResolvedValue(undefined);
    const finalize = vi.fn().mockResolvedValue(undefined);
    await expect(prepareFiledDocumentHistory("/notes/current.md", flushSave, finalize, () => true))
      .rejects.toThrow("Could not save the note");
    expect(flushSave).toHaveBeenCalledWith("/notes/current.md");
    expect(finalize).not.toHaveBeenCalled();
  });

  it("keeps the open left-pane toggle beside Settings in its reserved header slot", () => {
    const { container } = render(
      <WorkspaceLeftPaneHeader
        versionInfo={null}
        onOpenSettings={vi.fn()}
        sidebarOpen
        onToggleSidebar={vi.fn()}
      />,
    );

    const header = container.querySelector(".sidebar-app-header");
    const toggle = screen.getByRole("button", { name: "Hide left sidebar" });
    expect(header).toContainElement(screen.getByRole("link", { name: "Folio home" }));
    expect(header).toContainElement(screen.getByRole("button", { name: "Settings" }));
    expect(header).toContainElement(toggle);
    expect(toggle.parentElement).toBe(header);
  });

  it("starts desktop updates from the badge and shows download progress", async () => {
    const previousFolio = window.folio;
    let updateListener: ((state: { status: "downloading"; version: string; percent: number; error: null }) => void) | undefined;
    const startUpdate = vi.fn().mockResolvedValue(null);
    window.folio = {
      getUpdateState: vi.fn().mockResolvedValue({ status: "available", version: "1.2.3", percent: null, error: null }),
      startUpdate,
      onUpdateState: (handler) => {
        updateListener = handler;
        return vi.fn();
      },
    };
    try {
      const { container } = render(
        <WorkspaceLeftPaneHeader
          versionInfo={{ version: "1.0.0", repo: "owner/repo", latest: "1.2.3", latestUrl: "https://example.test/release", updateAvailable: true }}
          onOpenSettings={vi.fn()}
          sidebarOpen
          onToggleSidebar={vi.fn()}
        />,
      );
      const badge = await screen.findByRole("button", { name: "Download update: version 1.2.3" });
      fireEvent.click(badge);
      expect(startUpdate).toHaveBeenCalledOnce();
      await waitFor(() => expect(updateListener).toBeDefined());
      await act(async () => updateListener?.({ status: "downloading", version: "1.2.3", percent: 42, error: null }));
      expect(screen.getByRole("button", { name: "Downloading 42%: version 1.2.3" })).toBeDisabled();
      expect(container.querySelector(".update-spinner")).toBeInTheDocument();
    } finally {
      window.folio = previousFolio;
    }
  });

  it("shows the native update when the release API has no update information", async () => {
    const previousFolio = window.folio;
    window.folio = {
      getUpdateState: vi.fn().mockResolvedValue({ status: "available", version: "1.2.3", percent: null, error: null }),
      startUpdate: vi.fn().mockResolvedValue(null),
    };
    try {
      render(
        <WorkspaceLeftPaneHeader
          versionInfo={{ version: "1.0.0", repo: "owner/repo", latest: null, updateAvailable: false }}
          onOpenSettings={vi.fn()}
          sidebarOpen
          onToggleSidebar={vi.fn()}
        />,
      );
      expect(await screen.findByRole("button", { name: "Download update: version 1.2.3" })).toBeVisible();
    } finally {
      window.folio = previousFolio;
    }
  });

  it("keeps newer update events over stale state reads and handles failed reads", async () => {
    const previousFolio = window.folio;
    let resolveInitial: ((state: { status: "available"; version: string; percent: null; error: null }) => void) | undefined;
    let updateListener: ((state: { status: "available"; version: string; percent: null; error: null }) => void) | undefined;
    const unsubscribe = vi.fn();
    window.folio = {
      getUpdateState: () => new Promise((resolve) => { resolveInitial = resolve; }),
      startUpdate: vi.fn().mockResolvedValue(null),
      onUpdateState: (handler) => {
        updateListener = handler;
        return unsubscribe;
      },
    };
    try {
      const { unmount } = render(
        <WorkspaceLeftPaneHeader
          versionInfo={{ version: "1.0.0", repo: "owner/repo", latest: null, updateAvailable: false }}
          onOpenSettings={vi.fn()}
          sidebarOpen
          onToggleSidebar={vi.fn()}
        />,
      );
      await waitFor(() => expect(updateListener).toBeDefined());
      act(() => updateListener?.({ status: "available", version: "1.3.0", percent: null, error: null }));
      await act(async () => resolveInitial?.({ status: "available", version: "1.2.0", percent: null, error: null }));
      expect(screen.getByRole("button", { name: "Download update: version 1.3.0" })).toBeVisible();
      unmount();
      expect(unsubscribe).toHaveBeenCalledOnce();

      window.folio.getUpdateState = vi.fn().mockRejectedValue(new Error("updater unavailable"));
      const { container } = render(
        <WorkspaceLeftPaneHeader
          versionInfo={{ version: "1.0.0", repo: "owner/repo", latest: "1.4.0", latestUrl: "https://example.test/release", updateAvailable: true }}
          onOpenSettings={vi.fn()}
          sidebarOpen
          onToggleSidebar={vi.fn()}
        />,
      );
      await waitFor(() => expect(container.querySelector(".update-badge")).toHaveAttribute("href", "https://example.test/release"));
    } finally {
      window.folio = previousFolio;
    }
  });

  it("uses the native updater version when the release API reports no update", async () => {
    const previousFolio = window.folio;
    window.folio = {
      getUpdateState: vi.fn().mockResolvedValue({ status: "available", version: "1.2.3", percent: null, error: null }),
      startUpdate: vi.fn().mockResolvedValue(null),
    };
    try {
      render(
        <WorkspaceLeftPaneHeader
          versionInfo={{ version: "1.0.0", repo: "owner/repo", latest: null, updateAvailable: false }}
          onOpenSettings={vi.fn()}
          sidebarOpen
          onToggleSidebar={vi.fn()}
        />,
      );
      expect(await screen.findByRole("button", { name: "Download update: version 1.2.3" })).toBeVisible();
    } finally {
      window.folio = previousFolio;
    }
  });

  it("keeps an updater event newer than a delayed initial state and ignores rejected state reads", async () => {
    const previousFolio = window.folio;
    let resolveInitial: ((state: { status: "available"; version: string; percent: null; error: null }) => void) | undefined;
    let updateListener: ((state: { status: "available"; version: string; percent: null; error: null }) => void) | undefined;
    const unsubscribe = vi.fn();
    window.folio = {
      getUpdateState: () => new Promise((resolve) => { resolveInitial = resolve; }),
      startUpdate: vi.fn().mockResolvedValue(null),
      onUpdateState: (handler) => {
        updateListener = handler;
        return unsubscribe;
      },
    };
    try {
      const { unmount } = render(
        <WorkspaceLeftPaneHeader
          versionInfo={{ version: "1.0.0", repo: "owner/repo", latest: null, updateAvailable: false }}
          onOpenSettings={vi.fn()}
          sidebarOpen
          onToggleSidebar={vi.fn()}
        />,
      );
      await waitFor(() => expect(updateListener).toBeDefined());
      act(() => updateListener?.({ status: "available", version: "1.3.0", percent: null, error: null }));
      await act(async () => resolveInitial?.({ status: "available", version: "1.2.0", percent: null, error: null }));
      expect(screen.getByRole("button", { name: "Download update: version 1.3.0" })).toBeVisible();
      unmount();
      expect(unsubscribe).toHaveBeenCalledOnce();

      window.folio.getUpdateState = vi.fn().mockRejectedValue(new Error("updater unavailable"));
      const { container } = render(
        <WorkspaceLeftPaneHeader
          versionInfo={{ version: "1.0.0", repo: "owner/repo", latest: "1.4.0", latestUrl: "https://example.test/release", updateAvailable: true }}
          onOpenSettings={vi.fn()}
          sidebarOpen
          onToggleSidebar={vi.fn()}
        />,
      );
      await waitFor(() => expect(container.querySelector(".update-badge")).toHaveAttribute("href", "https://example.test/release"));
    } finally {
      window.folio = previousFolio;
    }
  });

  it("keeps the release page link when the desktop updater is unavailable", () => {
    const previousFolio = window.folio;
    window.folio = undefined;
    try {
      render(
        <WorkspaceLeftPaneHeader
          versionInfo={{ version: "1.0.0", repo: "owner/repo", latest: "1.2.3", latestUrl: "https://example.test/release", updateAvailable: true }}
          onOpenSettings={vi.fn()}
          sidebarOpen
          onToggleSidebar={vi.fn()}
        />,
      );
      expect(screen.getByRole("link", { name: "Update to version 1.2.3" })).toHaveAttribute("href", "https://example.test/release");
    } finally {
      window.folio = previousFolio;
    }
  });

  it("shows the selected generation model and EmbeddingGemma without automatically installing", () => {
    const onHide = vi.fn();
    const props = {
      mlxStatus: null,
      mlxActionModel: null,
      onInstallMlxModel: vi.fn(),
      onToggleMlxModel: vi.fn(),
      onHide,
      historyContent: <div>History timeline</div>,
    };
    const { container } = render(
      <WorkspaceRightPane {...props} />,
    );

    const header = container.querySelector(".right-pane-header");
    const toggle = screen.getByRole("button", { name: "Hide right sidebar" });
    expect(header).toContainElement(toggle);
    expect(header).toHaveClass("right-pane-header");
    expect(screen.getByText("Gemma 4 E4B")).toBeInTheDocument();
    expect(screen.queryByText("Qwen 3.5 4B")).not.toBeInTheDocument();
    expect(screen.queryByText("Llama 3.2 3B Instruct")).not.toBeInTheDocument();
    expect(screen.getByText("EmbeddingGemma")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^Install / })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: /^Install / }).every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
    expect(props.onInstallMlxModel).not.toHaveBeenCalled();
    expect(screen.getByText("History timeline")).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Workspace tools" })).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(onHide).toHaveBeenCalledOnce();

  });

  it("offers explicit install controls for missing MLX models", () => {
    const onInstallMlxModel = vi.fn();
    render(
      <WorkspaceRightPane
        mlxStatus={{
          available: true,
          helperAvailable: true,
          keepAliveMs: 0,
          installing: [],
          selectedGenerationModel: "gemma4",
          downloads: [],
          models: [
            { id: "gemma4", name: "Gemma 4", purpose: "generation", downloadSizeBytes: 5_180_000_000, downloadSizeIsEstimate: true, selected: true, installed: false, loaded: false, memory: null },
            { id: "qwen35", name: "Qwen 3.5", purpose: "generation", downloadSizeBytes: 3_060_000_000, downloadSizeIsEstimate: true, selected: false, installed: false, loaded: false, memory: null },
            { id: "llama32", name: "Llama 3.2", purpose: "generation", downloadSizeBytes: 1_810_000_000, downloadSizeIsEstimate: true, selected: false, installed: false, loaded: false, memory: null },
            { id: "embeddinggemma", name: "EmbeddingGemma", purpose: "embeddings", downloadSizeBytes: 212_000_000, downloadSizeIsEstimate: true, selected: false, installed: false, loaded: false, memory: null },
          ],
        }}
        mlxActionModel={null}
        onInstallMlxModel={onInstallMlxModel}
        onToggleMlxModel={vi.fn()}
        onHide={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Install Gemma 4" }));
    expect(onInstallMlxModel).toHaveBeenCalledWith("gemma4");
    expect(screen.getByText("About 5.18 GB download")).toBeInTheDocument();
    expect(screen.getByText("About 212 MB download")).toBeInTheDocument();
  });

  it("shows the generation model selected by status alongside the fixed embedding model", () => {
    const onInstallMlxModel = vi.fn();
    render(
      <WorkspaceRightPane
        mlxStatus={{
          available: true,
          helperAvailable: true,
          keepAliveMs: 0,
          installing: [],
          selectedGenerationModel: "qwen35",
          downloads: [],
          models: [
            { id: "gemma4", name: "Gemma 4 E4B", purpose: "generation", downloadSizeBytes: 5_180_000_000, downloadSizeIsEstimate: true, selected: false, installed: false, loaded: false, memory: null },
            { id: "qwen35", name: "Qwen 3.5 4B", purpose: "generation", downloadSizeBytes: 3_060_000_000, downloadSizeIsEstimate: true, selected: true, installed: false, loaded: false, memory: null },
            { id: "llama32", name: "Llama 3.2 3B Instruct", purpose: "generation", downloadSizeBytes: 1_810_000_000, downloadSizeIsEstimate: true, selected: false, installed: false, loaded: false, memory: null },
            { id: "embeddinggemma", name: "EmbeddingGemma", purpose: "embeddings", downloadSizeBytes: 212_000_000, downloadSizeIsEstimate: true, selected: false, installed: false, loaded: false, memory: null },
          ],
        }}
        mlxActionModel={null}
        onInstallMlxModel={onInstallMlxModel}
        onToggleMlxModel={vi.fn()}
        onHide={vi.fn()}
      />,
    );

    expect(screen.getByText("Qwen 3.5 4B")).toBeInTheDocument();
    expect(screen.queryByText("Gemma 4 E4B")).not.toBeInTheDocument();
    expect(screen.queryByText("Llama 3.2 3B Instruct")).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^Install / })).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Install Qwen 3.5 4B" }));
    expect(onInstallMlxModel).toHaveBeenCalledWith("qwen35");
  });

  it("links first-time setup to Settings only when the selected generation model is missing", async () => {
    window.localStorage.removeItem("folio:model-setup-prompt-seen");
    const onOpenSettings = vi.fn();
    render(
      <WorkspaceRightPane
        mlxStatus={{
          available: true, helperAvailable: true, keepAliveMs: 60_000, installing: [],
          selectedGenerationModel: "qwen35", downloads: [],
          models: [
            { id: "gemma4", name: "Gemma 4 E4B", purpose: "generation", downloadSizeBytes: 5_180_000_000, downloadSizeIsEstimate: true, selected: false, installed: false, loaded: false, memory: null },
            { id: "qwen35", name: "Qwen 3.5 4B", purpose: "generation", downloadSizeBytes: 3_060_000_000, downloadSizeIsEstimate: true, selected: true, installed: false, loaded: false, memory: null },
            { id: "llama32", name: "Llama 3.2 3B Instruct", purpose: "generation", downloadSizeBytes: 1_810_000_000, downloadSizeIsEstimate: true, selected: false, installed: false, loaded: false, memory: null },
            { id: "embeddinggemma", name: "EmbeddingGemma", purpose: "embeddings", downloadSizeBytes: 212_000_000, downloadSizeIsEstimate: true, selected: false, installed: false, loaded: false, memory: null },
          ],
        }}
        mlxActionModel={null}
        onInstallMlxModel={vi.fn()}
        onToggleMlxModel={vi.fn()}
        onOpenSettings={onOpenSettings}
        onHide={vi.fn()}
      />,
    );
    const settingsLink = await screen.findByRole("button", { name: "Open model settings" });
    expect(settingsLink.closest(".mlx-model-guidance")).not.toBeNull();
    expect(screen.queryByText("Choose and download a generation model in Settings to enable filing and Ask.")).not.toBeInTheDocument();
    fireEvent.click(settingsLink);
    expect(onOpenSettings).toHaveBeenCalledOnce();
    expect(window.localStorage.getItem("folio:model-setup-prompt-seen")).toBe("1");
  });

  it("shows model start and stop state with memory while loaded", () => {
    const onToggleMlxModel = vi.fn();
    render(
      <WorkspaceRightPane
        mlxStatus={{
          available: true,
          helperAvailable: true,
          keepAliveMs: 60_000,
          installing: [],
          selectedGenerationModel: "gemma4",
          downloads: [],
          models: [
            { id: "gemma4", name: "Gemma 4", purpose: "generation", downloadSizeBytes: 5_180_000_000, downloadSizeIsEstimate: true, selected: true, installed: true, loaded: true, memory: { activeBytes: 1_073_741_824, cacheBytes: 536_870_912, peakResidentBytes: 2_147_483_648 } },
            { id: "qwen35", name: "Qwen 3.5", purpose: "generation", downloadSizeBytes: 3_060_000_000, downloadSizeIsEstimate: true, selected: false, installed: false, loaded: false, memory: null },
            { id: "llama32", name: "Llama 3.2", purpose: "generation", downloadSizeBytes: 1_810_000_000, downloadSizeIsEstimate: true, selected: false, installed: false, loaded: false, memory: null },
            { id: "embeddinggemma", name: "EmbeddingGemma", purpose: "embeddings", downloadSizeBytes: 212_000_000, downloadSizeIsEstimate: true, selected: false, installed: true, loaded: false, memory: null },
          ],
        }}
        mlxActionModel={null}
        onInstallMlxModel={vi.fn()}
        onToggleMlxModel={onToggleMlxModel}
        onHide={vi.fn()}
      />,
    );
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(screen.getByText("Memory 1.07 GB active · 537 MB allocator cache · 2.15 GB peak process")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Stop Gemma 4" }));
    fireEvent.click(screen.getByRole("button", { name: "Start EmbeddingGemma" }));
    expect(onToggleMlxModel).toHaveBeenNthCalledWith(1, "gemma4", true);
    expect(onToggleMlxModel).toHaveBeenNthCalledWith(2, "embeddinggemma", false);
  });

  it("keeps history out of editor tab actions", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<EditorTabs
      group={{ id: "primary", tabs: ["untitled-1"], activeId: "untitled-1", previewId: null }}
      groupCount={1}
      titleForId={() => "Untitled"}
      isUntitledId={() => true}
      onActivate={vi.fn()} onDragStart={vi.fn()} onDragEnd={vi.fn()} onCloseTab={vi.fn()} onNewTab={vi.fn()} onSplit={vi.fn()} onCloseGroup={vi.fn()} onPinTab={vi.fn()}
    />);
    expect(screen.queryByRole("button", { name: "History" })).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("shows history times and marks local day boundaries without revision titles", async () => {
    const entries = [
      { revision: "newest", authoredAt: "2026-09-27T12:00:00.000Z", title: "Newest revision" },
      { revision: "same-day", authoredAt: "2026-09-27T10:00:00.000Z", title: "Same-day revision" },
      { revision: "previous-day", authoredAt: "2026-09-26T12:00:00.000Z", title: "Previous-day revision" },
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ entries, nextCursor: null }), { status: 200 })));
    render(<NoteHistoryPanel documentId="/notes/current.md" onBeforeRestore={vi.fn()} onRestored={vi.fn()} onRestoreFeedback={vi.fn()} onPreview={vi.fn()} onExit={vi.fn()} />);
    const newest = await screen.findByRole("button", { name: /Newest revision/ });
    const sameDay = screen.getByRole("button", { name: /Same-day revision/ });
    const previousDay = screen.getByRole("button", { name: /Previous-day revision/ });
    const dateLabel = (value: string) => new Date(value).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
    expect(newest).toHaveClass("is-day-boundary");
    expect(sameDay).not.toHaveClass("is-day-boundary");
    expect(previousDay).toHaveClass("is-day-boundary");
    expect(newest).toHaveTextContent(dateLabel(entries[0].authoredAt));
    expect(sameDay).not.toHaveTextContent(dateLabel(entries[1].authoredAt));
    expect(newest).not.toHaveTextContent("Newest revision");
    expect(screen.getByRole("button", { name: "Present" })).toHaveTextContent("Now");
    vi.unstubAllGlobals();
  });

  it("shows one timestamp legend for consecutive snapshots in the same local minute", async () => {
    const sameMinute = [
      { revision: "minute-newer", authoredAt: "2026-09-27T10:05:50.000Z", title: "Newer in minute" },
      { revision: "minute-older", authoredAt: "2026-09-27T10:05:03.000Z", title: "Older in minute" },
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ entries: sameMinute, nextCursor: null }), { status: 200 })));
    render(<NoteHistoryPanel documentId="/notes/current.md" onBeforeRestore={vi.fn()} onRestored={vi.fn()} onRestoreFeedback={vi.fn()} onPreview={vi.fn()} />);
    const newer = await screen.findByRole("button", { name: /Newer in minute/ });
    const older = screen.getByRole("button", { name: /Older in minute/ });
    const minute = new Date(sameMinute[0].authoredAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    expect(newer).toHaveTextContent(minute);
    expect(older).not.toHaveTextContent(minute);
    const accessibleStamp = new Date(sameMinute[1].authoredAt).toLocaleString(undefined, { dateStyle: "full", timeStyle: "medium" });
    expect(older).toHaveAttribute("aria-label", expect.stringContaining(accessibleStamp));
    expect(newer).toHaveClass("is-day-boundary");
    expect(older).not.toHaveClass("is-day-boundary");
    vi.unstubAllGlobals();
  });

  it("refreshes after a checkpoint while keeping loaded history and its pagination cursor", async () => {
    const loadedEntry = { revision: "loaded", authoredAt: "2026-09-26T10:00:00.000Z", title: "Loaded older moment" };
    const initialEntry = { revision: "initial", authoredAt: "2026-09-27T10:00:00.000Z", title: "Initial moment" };
    const newEntry = { revision: "new", authoredAt: "2026-09-27T11:00:00.000Z", title: "New moment" };
    let initialReads = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.searchParams.has("cursor")) {
        if (url.searchParams.get("cursor") === "first-page") {
          return new Response(JSON.stringify({ entries: [loadedEntry, initialEntry], nextCursor: "after-loaded-page" }), { status: 200 });
        }
        return new Response(JSON.stringify({ entries: [], nextCursor: null }), { status: 200 });
      }
      initialReads += 1;
      return new Response(JSON.stringify({
        entries: initialReads > 1 ? [newEntry, initialEntry] : [initialEntry],
        nextCursor: initialReads > 1 ? "checkpoint-page" : "first-page",
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const onBeforeRestore = vi.fn().mockResolvedValue(undefined);
    const onRestored = vi.fn().mockResolvedValue(undefined);
    const onPreview = vi.fn();
    const { rerender } = render(<NoteHistoryPanel documentId="/notes/current.md" checkpointRevision={0} onBeforeRestore={onBeforeRestore} onRestored={onRestored} onRestoreFeedback={vi.fn()} onPreview={onPreview} />);
    const timeline = screen.getByRole("navigation", { name: "Note timeline" });
    await screen.findByRole("button", { name: /Initial moment/ });
    fireEvent.click(screen.getByRole("button", { name: "Load earlier" }));
    await screen.findByRole("button", { name: /Loaded older moment/ });
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("cursor=first-page"), expect.any(Object));
    timeline.scrollTop = 37;
    rerender(<NoteHistoryPanel documentId="/notes/current.md" checkpointRevision={1} onBeforeRestore={onBeforeRestore} onRestored={onRestored} onRestoreFeedback={vi.fn()} onPreview={onPreview} />);
    const present = screen.getByRole("button", { name: "Present" });
    await screen.findByRole("button", { name: /New moment/ });
    expect(screen.getAllByRole("button", { name: /Initial moment/ })).toHaveLength(1);
    expect(screen.getByRole("button", { name: /Loaded older moment/ })).toBeInTheDocument();
    expect(present).toHaveAttribute("aria-current", "step");
    expect(timeline.scrollTop).toBe(37);
    fireEvent.click(screen.getByRole("button", { name: "Load earlier" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("cursor=after-loaded-page"), expect.any(Object)));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Load earlier" })).not.toBeInTheDocument());
    vi.unstubAllGlobals();
  });

  it("uses the initial history request instead of replaying an old checkpoint signal on mount", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ entries: [], nextCursor: null }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<NoteHistoryPanel documentId="/notes/current.md" checkpointRevision={7} onBeforeRestore={vi.fn()} onRestored={vi.fn()} onRestoreFeedback={vi.fn()} onPreview={vi.fn()} />);
    await screen.findByText("No earlier moments yet.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("automatically appends and deduplicates the next history page near the timeline edge", async () => {
    const newest = { revision: "newest", authoredAt: "2026-09-27T12:00:00.000Z", title: "Newest" };
    const older = { revision: "older", authoredAt: "2026-09-26T12:00:00.000Z", title: "Older" };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const page = url.includes("cursor=next-page")
        ? { entries: [newest, older], nextCursor: "last-page" }
        : { entries: [newest], nextCursor: "next-page" };
      return new Response(JSON.stringify(page), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<NoteHistoryPanel documentId="/notes/current.md" onBeforeRestore={vi.fn()} onRestored={vi.fn()} onRestoreFeedback={vi.fn()} onPreview={vi.fn()} onExit={vi.fn()} />);
    await screen.findByRole("button", { name: /Newest/ });
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("limit=15"), expect.any(Object));
    const timeline = screen.getByRole("navigation", { name: "Note timeline" });
    Object.defineProperty(timeline, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(timeline, "clientHeight", { configurable: true, value: 400 });
    timeline.scrollTop = 450;
    fireEvent.scroll(timeline);

    expect(await screen.findByRole("button", { name: /Older/ })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("cursor=next-page"), expect.any(Object));
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("cursor=next-page&limit=15"), expect.any(Object));
    expect(container.querySelectorAll('button[data-history-stop="newest"]')).toHaveLength(1);
    vi.unstubAllGlobals();
  });

  it("previews a selected moment without a diff and restores after confirmation", async () => {
    let historyReads = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/restore")) return new Response(JSON.stringify({ note: document, warning: "Embedding refresh is pending." }), { status: 200 });
      if (url.includes("/version?")) return new Response(JSON.stringify({ revision: "a".repeat(40), note: { title: "First", description: "", tags: ["one"], status: "stable", staleAfter: null, content: "# Earlier" }, diff: "-# Earlier\n+# Current" }), { status: 200 });
      historyReads += 1;
      return new Response(JSON.stringify({ entries: historyReads > 2 ? [] : [{ revision: "a".repeat(40), authoredAt: "2026-09-27T09:00:00.000Z", title: "First" }], nextCursor: null }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("confirm", vi.fn().mockReturnValue(true));
    const restored = vi.fn().mockResolvedValue(undefined);
    const beforeRestore = vi.fn().mockResolvedValue(undefined);
    const onPreview = vi.fn();
    const onRestoreFeedback = vi.fn();
    render(<NoteHistoryPanel documentId="/notes/current.md" onBeforeRestore={beforeRestore} onRestored={restored} onRestoreFeedback={onRestoreFeedback} onPreview={onPreview} onExit={vi.fn()} />);
    await screen.findByRole("button", { name: /First/ });
    fireEvent.click(screen.getByRole("button", { name: /First/ }));
    await waitFor(() => expect(onPreview).toHaveBeenCalledWith(expect.objectContaining({ note: expect.objectContaining({ content: "# Earlier" }) }), false, false));
    expect(screen.queryByText("+# Current")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /First/ })).toHaveAttribute("aria-current", "step");
    fireEvent.click(screen.getByRole("button", { name: "Restore this version" }));
    await waitFor(() => expect(beforeRestore).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(restored).toHaveBeenCalledWith("/notes/current.md"));
    expect(onRestoreFeedback).toHaveBeenCalledWith("Embedding refresh is pending.");
    expect(screen.queryByText("Embedding refresh is pending.")).not.toBeInTheDocument();
    expect(onPreview).toHaveBeenLastCalledWith(null, false, false);
    expect(screen.getByRole("button", { name: "Present" })).toHaveAttribute("aria-current", "step");
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/note/history/version"), expect.any(Object));
    vi.unstubAllGlobals();
  });

  it("does not issue a restore request when flushing the current note fails", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => String(input).includes("/version?")
      ? new Response(JSON.stringify({ revision: "b".repeat(40), note: { title: "Earlier", description: "", tags: [], status: "stable", staleAfter: null, content: "Before edit" }, diff: "-Before edit\n+Unsaved edit" }), { status: 200 })
      : new Response(JSON.stringify({ entries: [{ revision: "b".repeat(40), authoredAt: "2026-09-27T09:00:00.000Z", title: "Earlier" }], nextCursor: null }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("confirm", vi.fn().mockReturnValue(true));
    const beforeRestore = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("Could not save the note before continuing with history."));
    const onRestoreFeedback = vi.fn();
    render(<NoteHistoryPanel documentId="/notes/current.md" onBeforeRestore={beforeRestore} onRestored={vi.fn()} onRestoreFeedback={onRestoreFeedback} onPreview={vi.fn()} onExit={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /Earlier/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Restore this version" })).toBeEnabled());
    fireEvent.click(await screen.findByRole("button", { name: "Restore this version" }));
    await waitFor(() => expect(onRestoreFeedback).toHaveBeenCalledWith("Could not save the note before continuing with history."));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/restore"))).toBe(false);
    vi.unstubAllGlobals();
  });

  it("ignores an earlier preview response after a newer version is selected", async () => {
    const olderRevision = "a".repeat(40);
    const newerRevision = "b".repeat(40);
    let finishOlder: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/version?") && url.includes(olderRevision)) return new Promise<Response>((resolve) => { finishOlder = resolve; });
      if (url.includes("/version?")) return Promise.resolve(new Response(JSON.stringify({ revision: newerRevision, note: { title: "Newer", description: "", tags: [], status: "stable", staleAfter: null, content: "Newer preview" }, diff: "" }), { status: 200 }));
      return Promise.resolve(new Response(JSON.stringify({ entries: [
        { revision: olderRevision, authoredAt: "2026-09-27T09:00:00.000Z", title: "Older" },
        { revision: newerRevision, authoredAt: "2026-09-27T10:00:00.000Z", title: "Newer" },
      ], nextCursor: null }), { status: 200 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const onPreview = vi.fn();
    const { container } = render(<NoteHistoryPanel documentId="/notes/current.md" onBeforeRestore={vi.fn().mockResolvedValue(undefined)} onRestored={vi.fn()} onRestoreFeedback={vi.fn()} onPreview={onPreview} onExit={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /Older/ }));
    const newerStop = container.querySelector<HTMLButtonElement>(`button[data-history-stop="${newerRevision}"]`);
    expect(newerStop).not.toBeNull();
    if (newerStop) fireEvent.click(newerStop);
    await waitFor(() => expect(onPreview).toHaveBeenLastCalledWith(expect.objectContaining({ revision: newerRevision, note: expect.objectContaining({ content: "Newer preview" }) }), false, false));
    await act(async () => {
      finishOlder?.(new Response(JSON.stringify({ revision: olderRevision, note: { title: "Older", description: "", tags: [], status: "stable", staleAfter: null, content: "Stale older preview" }, diff: "" }), { status: 200 }));
    });
    expect(onPreview).toHaveBeenLastCalledWith(expect.objectContaining({ revision: newerRevision }), false, false);
    expect(container.querySelector(`button[data-history-stop="${newerRevision}"]`)).toHaveAttribute("aria-current", "step");
    vi.unstubAllGlobals();
  });

  it("keeps Now selected when a pending scrub preview is aborted", async () => {
    const firstRevision = "first";
    const pendingRevision = "pending";
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/version?") && url.includes(pendingRevision)) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
      }
      if (url.includes("/version?")) {
        return Promise.resolve(new Response(JSON.stringify({ revision: firstRevision, note: { title: "First", description: "", tags: [], status: "stable", staleAfter: null, content: "First preview" }, diff: "" }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ entries: [
        { revision: firstRevision, authoredAt: "2026-09-27T10:00:00.000Z", title: "First" },
        { revision: pendingRevision, authoredAt: "2026-09-27T09:00:00.000Z", title: "Pending" },
      ], nextCursor: null }), { status: 200 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const preview = vi.fn();
    const { container } = render(<NoteHistoryPanel documentId="/notes/current.md" onBeforeRestore={vi.fn().mockResolvedValue(undefined)} onRestored={vi.fn()} onRestoreFeedback={vi.fn()} onPreview={preview} />);
    fireEvent.click(await screen.findByRole("button", { name: /First/ }));
    await waitFor(() => expect(preview).toHaveBeenLastCalledWith(expect.objectContaining({ revision: firstRevision }), false, false));

    const timeline = screen.getByRole("navigation", { name: "Note timeline" });
    const now = screen.getByRole("button", { name: "Present" });
    const pending = container.querySelector<HTMLButtonElement>(`button[data-history-stop="${pendingRevision}"]`);
    expect(pending).not.toBeNull();
    Object.defineProperty(timeline, "clientHeight", { configurable: true, value: 200 });
    vi.spyOn(timeline, "getBoundingClientRect").mockReturnValue(DOMRect.fromRect({ y: 0 }));
    vi.spyOn(now, "getBoundingClientRect").mockReturnValue(DOMRect.fromRect({ y: 500 }));
    if (pending) vi.spyOn(pending, "getBoundingClientRect").mockReturnValue(DOMRect.fromRect({ y: 100 }));
    fireEvent.wheel(timeline);
    fireEvent.scroll(timeline);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining(`revision=${pendingRevision}`), expect.any(Object)));

    vi.spyOn(now, "getBoundingClientRect").mockReturnValue(DOMRect.fromRect({ y: 100 }));
    if (pending) vi.spyOn(pending, "getBoundingClientRect").mockReturnValue(DOMRect.fromRect({ y: 500 }));
    fireEvent.wheel(timeline);
    fireEvent.scroll(timeline);
    await waitFor(() => expect(preview).toHaveBeenLastCalledWith(null, false, false));
    expect(now).toHaveAttribute("aria-current", "step");
    expect(screen.getByText("Viewing the present")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("moves from preparing to a ready filing dialog without changing hook order", () => {
    const entry = {
      filing: {
        id: "filing-preparing",
        draftId: "untitled-preparing",
        mode: "new",
        destinationId: null,
        actor: "agent",
        proposal: { directory: "/projects", filename: "prepared.md", title: "Prepared", description: "", tags: [] },
      },
      fields: { directory: "/projects", title: "Prepared", description: "", tags: [] },
      standalone: false,
      status: "preparing",
      error: null,
    } satisfies FilingQueueEntry;
    const props = {
      directories: ["/", "/projects"],
      onChange: vi.fn(), onAccept: vi.fn(), onStandalone: vi.fn(), onDismiss: vi.fn(), onRevealStandalone: vi.fn(),
    };
    const { rerender } = render(<FilingConfirmation entry={entry} {...props} />);

    expect(screen.getByText("Filing note…")).toBeInTheDocument();
    rerender(<FilingConfirmation entry={{ ...entry, status: "ready" }} {...props} />);
    expect(screen.getByRole("heading", { name: "Review filing" })).toBeInTheDocument();
  });

  it("confirms filing proposals in the note and exposes independent fields", () => {
    const onChange = vi.fn();
    const onAccept = vi.fn();
    const onDismiss = vi.fn();
    render(
      <FilingConfirmation
        directories={["/", "/projects", "/projects/website", "/projects/writing"]}
        entry={{
          filing: {
            id: "filing-1",
            draftId: "untitled-1",
            mode: "new",
            destinationId: null,
            actor: "agent",
            proposal: {
              directory: "/projects",
              filename: "launch.md",
              title: "Launch plan",
              description: "Publish it",
              tags: ["project"],
            },
          },
          fields: {
            directory: "/projects",
            title: "Launch plan",
            description: "Publish it",
            tags: ["project"],
          },
          standalone: false,
          status: "ready",
          error: null,
        }}
        onChange={onChange}
        onAccept={onAccept}
        onStandalone={vi.fn()}
        onDismiss={onDismiss}
        onRevealStandalone={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Accept" })).toHaveFocus();
    expect(screen.queryByLabelText("Filename")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Published plan" },
    });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      directory: "/projects",
      title: "Published plan",
      description: "Publish it",
      tags: ["project"],
    }));
    expect(screen.getByRole("combobox", { name: "Path" })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByLabelText("Title"), { key: "Enter" });
    expect(onAccept).toHaveBeenCalledOnce();
    fireEvent.keyDown(window.document, { key: "Escape" });
    expect(onDismiss).toHaveBeenCalledOnce();
    fireEvent.pointerDown(window.document.body);
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("keeps filing dialogs independent across notes", () => {
    const firstDismiss = vi.fn();
    const secondDismiss = vi.fn();
    const sharedEntry = {
      filing: {
        id: "filing-shared",
        draftId: "untitled-shared",
        mode: "new" as const,
        destinationId: null,
        actor: "agent",
        proposal: { directory: "/projects", filename: "note.md", title: "Note", description: "", tags: [] },
      },
      fields: { directory: "/projects", title: "Note", description: "", tags: [] },
      standalone: false,
      status: "ready" as const,
      error: null,
    };

    render(
      <>
        <FilingConfirmation
          entry={sharedEntry}
          directories={["/", "/projects"]}
          autoFocus={false}
          onChange={vi.fn()}
          onAccept={vi.fn()}
          onStandalone={vi.fn()}
          onDismiss={firstDismiss}
          onRevealStandalone={vi.fn()}
        />
        <FilingConfirmation
          entry={{ ...sharedEntry, filing: { ...sharedEntry.filing, id: "filing-active" } }}
          directories={["/", "/projects"]}
          onChange={vi.fn()}
          onAccept={vi.fn()}
          onStandalone={vi.fn()}
          onDismiss={secondDismiss}
          onRevealStandalone={vi.fn()}
        />
      </>,
    );

    const pathInputs = screen.getAllByRole("combobox", { name: "Path" });
    expect(pathInputs[0].getAttribute("aria-controls")).not.toBe(pathInputs[1].getAttribute("aria-controls"));
    fireEvent.keyDown(window.document, { key: "Escape" });
    expect(firstDismiss).not.toHaveBeenCalled();
    expect(secondDismiss).toHaveBeenCalledOnce();
  });

  it("selects a depth-scoped path suggestion with the keyboard", () => {
    const onChange = vi.fn();
    render(
      <FilingConfirmation
        directories={["/", "/projects", "/projects/website", "/projects/writing", "/references"]}
        entry={{
          filing: {
            id: "filing-path",
            draftId: "untitled-path",
            mode: "new",
            destinationId: null,
            actor: "agent",
            proposal: { directory: "/projects/we", filename: "launch.md", title: "Launch", description: "", tags: [] },
          },
          fields: { directory: "/projects/we", title: "Launch", description: "", tags: [] },
          standalone: false,
          status: "ready",
          error: null,
        }}
        onChange={onChange}
        onAccept={vi.fn()}
        onStandalone={vi.fn()}
        onDismiss={vi.fn()}
        onRevealStandalone={vi.fn()}
      />,
    );

    const pathInput = screen.getByRole("combobox", { name: "Path" });
    pathInput.focus();
    pathInput.setSelectionRange(12, 12);
    fireEvent.click(pathInput);

    expect(screen.getByRole("option", { name: "/projects/website" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "/references" })).not.toBeInTheDocument();
    fireEvent.keyDown(pathInput, { key: "Tab" });

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      directory: "/projects/website",
    }));
    expect(screen.queryByRole("button", { name: "Keep agent filing" })).not.toBeInTheDocument();
  });

  it("prevents filing into the internal references directory", () => {
    const onAccept = vi.fn();
    render(
      <FilingConfirmation
        directories={["/", "/projects"]}
        entry={{
          filing: {
            id: "filing-reserved",
            draftId: "untitled-reserved",
            mode: "new",
            destinationId: null,
            actor: "agent",
            proposal: { directory: "/references/inbox", filename: "note.md", title: "Note", description: "", tags: [] },
          },
          fields: { directory: "/references/inbox", title: "Note", description: "", tags: [] },
          standalone: false,
          status: "ready",
          error: null,
        }}
        onChange={vi.fn()}
        onAccept={onAccept}
        onStandalone={vi.fn()}
        onDismiss={vi.fn()}
        onRevealStandalone={vi.fn()}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("References is an internal folder");
    expect(screen.getByRole("combobox", { name: "Path" })).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "Accept" })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Path" }), { key: "Enter" });
    expect(onAccept).not.toHaveBeenCalled();
  });

  it("offers a separate proposal for append filing", () => {
    const onReveal = vi.fn();
    render(
      <FilingConfirmation
        directories={["/", "/projects"]}
        entry={{
          filing: {
            id: "filing-append",
            draftId: "untitled-2",
            mode: "existing",
            destinationId: "/projects/launch.md",
            actor: "agent",
            proposal: { directory: "/projects", filename: "launch.md", title: "Launch", description: "", tags: [] },
            standaloneProposal: { directory: "/projects", filename: "separate.md", title: "Separate", description: "", tags: [] },
          },
          fields: { directory: "/projects", title: "Launch", description: "", tags: [] },
          standalone: false,
          status: "ready",
          error: null,
        }}
        onChange={vi.fn()}
        onAccept={vi.fn()}
        onStandalone={vi.fn()}
        onDismiss={vi.fn()}
        onRevealStandalone={onReveal}
      />,
    );
    expect(screen.getByText("Launch")).toBeInTheDocument();
    expect(screen.getByText("/projects")).toBeInTheDocument();
    expect(screen.queryByText("/projects/launch.md")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "File separately" }));
    expect(onReveal).toHaveBeenCalledOnce();
  });

  it("resizes split groups from the keyboard and resets on double click", () => {
    const onResize = vi.fn();
    const onReset = vi.fn();
    render(
      <div>
        <WorkspaceSplitHandle
          splitPosition={50}
          onPointerDown={vi.fn()}
          onResize={onResize}
          onPointerEnd={vi.fn()}
          onReset={onReset}
        />
      </div>,
    );
    const handle = screen.getByRole("separator");
    Object.defineProperty(handle, "offsetWidth", { value: 10 });
    vi.spyOn(handle.parentElement!, "getBoundingClientRect").mockReturnValue({
      x: 10,
      y: 0,
      width: 100,
      height: 100,
      top: 0,
      right: 110,
      bottom: 100,
      left: 10,
      toJSON: () => ({}),
    });

    fireEvent.keyDown(handle, { key: "ArrowRight" });
    fireEvent.doubleClick(handle);

    expect(onResize).toHaveBeenCalledWith(56.8, handle);
    expect(onReset).toHaveBeenCalledOnce();
  });

  it("commits metadata edits on blur and restores the original on Escape", () => {
    const finish = vi.fn();
    const { rerender } = render(
      <DocumentHeader
        groupId="primary"
        document={document}
        editingKey="primary:/notes/current.md:title"
        drafts={{ "primary:/notes/current.md:title": "Changed" }}
        onBeginEditing={vi.fn()}
        onChangeDraft={vi.fn()}
        onFinishEditing={finish}
      />,
    );
    const title = screen.getByLabelText("Title for Current note");
    fireEvent.blur(title);
    expect(finish).toHaveBeenCalledWith(
      "primary:/notes/current.md:title",
      document,
      "title",
      "Changed",
    );

    rerender(
      <DocumentHeader
        groupId="primary"
        document={document}
        editingKey="primary:/notes/current.md:description"
        drafts={{ "primary:/notes/current.md:description": "Changed" }}
        onBeginEditing={vi.fn()}
        onChangeDraft={vi.fn()}
        onFinishEditing={finish}
      />,
    );
    const description = screen.getByLabelText("Description for Current note");
    fireEvent.keyDown(description, { key: "Escape" });
    expect(finish).toHaveBeenLastCalledWith(
      "primary:/notes/current.md:description",
      document,
      "description",
      "Description",
    );
  });

  it("keeps editing controls available and quiet during autosave", () => {
    render(
      <>
        <DocumentHeader
          groupId="primary"
          document={document}
          editingKey={null}
          drafts={{}}
          onBeginEditing={vi.fn()}
          onChangeDraft={vi.fn()}
          onFinishEditing={vi.fn()}
        />
        <DocumentFooter
          groupId="primary"
          document={document}
          draft={undefined}
          pathDraft={undefined}
          tagDraft={undefined}
          saving
          deleting={false}
          deleteInProgress={false}
          moving={false}
          exporting={false}
          onBeginPathEditing={vi.fn()}
          onChangePath={vi.fn()}
          onFinishPathEditing={vi.fn()}
          onResetPath={vi.fn()}
          onBeginTagEditing={vi.fn()}
          onChangeTag={vi.fn()}
          onFinishTagEditing={vi.fn()}
          onFileDraft={vi.fn()}
          onDelete={vi.fn().mockResolvedValue(undefined)}
          onExport={vi.fn()}
          onOpenDocument={vi.fn().mockResolvedValue(undefined)}
        />
      </>,
    );

    expect(screen.getByRole("button", { name: "Current note" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Description" })).toBeEnabled();
    expect(screen.getByLabelText("Path for Current note")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
    expect(screen.queryByText("Saving...")).not.toBeInTheDocument();
  });

  it("renders loading and empty pane states without mounting a document", () => {
    const onCreate = vi.fn();
    const { rerender } = render(
      <DocumentPane
        groupId="primary"
        hasDocument={false}
        loading
        onCreateNewTab={onCreate}
      >
        {null}
      </DocumentPane>,
    );
    expect(screen.getByText("Opening file...")).toBeInTheDocument();

    rerender(
      <DocumentPane
        groupId="primary"
        hasDocument={false}
        loading={false}
        onCreateNewTab={onCreate}
      >
        {null}
      </DocumentPane>,
    );
    fireEvent.click(screen.getByRole("button", { name: "New note" }));
    expect(onCreate).toHaveBeenCalledWith("primary");
  });

  it("opens internal Markdown links and forwards task checkbox changes", () => {
    const onOpen = vi.fn().mockResolvedValue(undefined);
    const onToggle = vi.fn().mockResolvedValue(undefined);
    render(
      <RenderedMarkdown
        document={document}
        groupId="secondary"
        saving={false}
        onOpenDocument={onOpen}
        onToggleTask={onToggle}
      />,
    );

    fireEvent.click(screen.getByRole("link", { name: "Other" }));
    fireEvent.click(screen.getByRole("checkbox"));

    expect(onOpen).toHaveBeenCalledWith(
      "/notes/other.md",
      "file",
      "secondary",
    );
    expect(onToggle).toHaveBeenCalledWith(document, 3, true);
  });

  it("renders bare web URLs as safe external links", () => {
    render(
      <RenderedMarkdown
        document={{
          ...document,
          content: "Bare https://example.com/docs and [Named](https://example.com/named)",
        }}
        groupId="secondary"
        saving={false}
        onOpenDocument={vi.fn().mockResolvedValue(undefined)}
        onToggleTask={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveAttribute("href", "https://example.com/docs");
    expect(links[0]).toHaveAttribute("target", "_blank");
    expect(links[0]).toHaveAttribute("rel", "noopener noreferrer");
    expect(links[1]).toHaveAttribute("href", "https://example.com/named");
  });

  it("renders GFM strikethrough and heading levels", () => {
    render(
      <RenderedMarkdown
        document={{
          ...document,
          content: "# First\n\n## Second\n\n### Third\n\n~~Removed~~",
        }}
        groupId="secondary"
        saving={false}
        onOpenDocument={vi.fn().mockResolvedValue(undefined)}
        onToggleTask={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.getByRole("heading", { name: "First", level: 1 })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Second", level: 2 })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Third", level: 3 })).toBeTruthy();
    expect(screen.getByText("Removed").tagName).toBe("DEL");
  });

  it("marks completed rendered tasks as task-list items for line-through styling", () => {
    const { container } = render(
      <RenderedMarkdown
        document={{ ...document, content: "- [x] Completed" }}
        groupId="secondary"
        saving={false}
        onOpenDocument={vi.fn().mockResolvedValue(undefined)}
        onToggleTask={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    const checkbox = screen.getByRole("checkbox");
    expect(checkbox).toBeChecked();
    expect(checkbox.closest("li")).toHaveClass("task-list-item");
    expect(container.querySelector(".task-list-item:has(input[type='checkbox']:checked)")).not.toBeNull();
  });

  it("renders three hyphens as a horizontal rule without shifting task source lines", () => {
    const onToggleTask = vi.fn().mockResolvedValue(undefined);
    const renderedDocument = {
      ...document,
      content: "Before the rule\n---\n- [ ] After the rule",
    };
    const { container } = render(
      <RenderedMarkdown
        document={renderedDocument}
        groupId="secondary"
        saving={false}
        onOpenDocument={vi.fn().mockResolvedValue(undefined)}
        onToggleTask={onToggleTask}
      />,
    );

    expect(screen.queryByRole("heading", { name: "Before the rule" })).toBeNull();
    expect(screen.getByText("Before the rule").tagName).toBe("P");
    expect(container.querySelector("[data-readonly-markdown] hr")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox"));
    expect(onToggleTask).toHaveBeenCalledWith(renderedDocument, 3, true);
  });

  it("forwards document path, tag, delete, and related-link actions", () => {
    const linkedDocument = {
      ...document,
      links: [
        {
          id: "/notes/linked.md",
          title: "Linked note",
          type: "Note",
          description: "",
          createdAt: "2026-09-05T08:00:00.000Z",
          relation: "related",
          origin: "frontmatter" as const,
        },
      ],
    };
    const move = vi.fn().mockResolvedValue(undefined);
    const persist = vi.fn();
    const onDelete = vi.fn().mockResolvedValue(undefined);
    const onOpen = vi.fn().mockResolvedValue(undefined);

    function FooterHarness() {
      const ui = useWorkspaceEditorUi();
      return (
        <DocumentFooter
          groupId="primary"
          document={linkedDocument}
          draft={undefined}
          pathDraft={ui.pathDrafts[linkedDocument.id]}
          tagDraft={ui.tagDrafts[linkedDocument.id]}
          saving={false}
          deleting={false}
          deleteInProgress={false}
          moving={false}
          exporting={false}
          onBeginPathEditing={ui.beginPathEditing}
          onChangePath={ui.changePathDraft}
          onFinishPathEditing={(target, value) =>
            ui.finishPathEditing(target, value, move)
          }
          onResetPath={ui.resetPathDraft}
          onBeginTagEditing={ui.beginTagEditing}
          onChangeTag={ui.changeTagDraft}
          onFinishTagEditing={(target, value) =>
            ui.finishTagEditing(target, value, persist)
          }
          onFileDraft={vi.fn()}
          onDelete={onDelete}
          onExport={vi.fn()}
          onOpenDocument={onOpen}
        />
      );
    }

    render(<FooterHarness />);

    const path = screen.getByLabelText("Path for Current note");
    fireEvent.focus(path);
    fireEvent.change(path, { target: { value: "/archive" } });
    fireEvent.blur(path);
    const tags = screen.getByLabelText("Tags for Current note");
    fireEvent.focus(tags);
    fireEvent.change(tags, { target: { value: "one, two" } });
    fireEvent.blur(tags);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Delete note" })).toHaveTextContent(
      "The raw capture will be retained",
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete note" }));
    fireEvent.click(screen.getByRole("button", { name: /Linked note/ }));

    expect(move).toHaveBeenCalledWith(document.id, "/archive");
    expect(persist).toHaveBeenCalledWith(
      linkedDocument,
      linkedDocument.content,
      ["one", "two"],
    );
    expect(onDelete).toHaveBeenCalledWith(linkedDocument);
    expect(onOpen).toHaveBeenCalledWith(
      "/notes/linked.md",
      "file",
      "primary",
    );
  });

  it("moves a dropped tab through the editor-group action contract", () => {
    const moveTabToGroup = vi.fn();

    function GroupHarness() {
      const ui = useWorkspaceEditorUi();
      return (
        <EditorGroup
          group={{
            id: "secondary",
            tabs: [],
            activeId: null,
            previewId: null,
          }}
          groupCount={2}
          model={{
            activeGroupId: "primary",
            documents: {},
            loadingDocuments: new Set(),
            savingDocuments: new Set(),
            editingKey: null,
            drafts: {},
            deletingNoteId: null,
            movingFileId: null,
            editorFocusRequest: null,
          }}
          actions={{
            activateGroup: vi.fn(),
            moveTabToGroup,
            titleForId: (id) => id,
            activateTab: vi.fn(),
            pinTab: vi.fn(),
            consumeEditorFocusRequest: vi.fn(),
            createNewTab: vi.fn(),
            splitWorkspace: vi.fn(),
            closeGroup: vi.fn(),
            closeTab: vi.fn(),
            changeDraftContent: vi.fn(),
            fileDraft: vi.fn(),
            beginEditing: vi.fn(),
            finishEditing: vi.fn(),
            openDocument: vi.fn().mockResolvedValue(undefined),
            toggleTaskCheckbox: vi.fn().mockResolvedValue(undefined),
            deleteFiledNote: vi.fn().mockResolvedValue(undefined),
            persistDocument: vi.fn(),
            persistMetadata: vi.fn(),
            moveBundleFile: vi.fn().mockResolvedValue(undefined),
          }}
          ui={ui}
        />
      );
    }

    const { container } = render(<GroupHarness />);
    fireEvent.drop(container.querySelector(".editor-group")!, {
      dataTransfer: {
        getData: () =>
          JSON.stringify({
            documentId: "/notes/current.md",
            groupId: "primary",
          }),
      },
    });

    expect(moveTabToGroup).toHaveBeenCalledWith(
      "/notes/current.md",
      "primary",
      "secondary",
    );
  });

  it("moves a same-group tab to the end from the editor-group right strip", () => {
    const moveTabToGroup = vi.fn();

    function GroupHarness() {
      const ui = useWorkspaceEditorUi();
      const [tabs, setTabs] = useState([
        "/notes/current.md",
        "/notes/target.md",
      ]);
      return (
        <EditorGroup
          group={{
            id: "primary",
            tabs,
            activeId: null,
            previewId: null,
          }}
          groupCount={2}
          model={{
            activeGroupId: "primary",
            documents: {},
            loadingDocuments: new Set(),
            savingDocuments: new Set(),
            editingKey: null,
            drafts: {},
            deletingNoteId: null,
            movingFileId: null,
            editorFocusRequest: null,
          }}
          actions={{
            activateGroup: vi.fn(),
            moveTabToGroup: (documentId, sourceGroupId, targetGroupId, targetIndex) => {
              moveTabToGroup(documentId, sourceGroupId, targetGroupId, targetIndex);
              setTabs((current) =>
                moveGroupTab(
                  [{ id: "primary", tabs: current, activeId: null, previewId: null }],
                  documentId,
                  sourceGroupId,
                  targetGroupId,
                  targetIndex,
                )[0].tabs,
              );
            },
            titleForId: (id) => id,
            activateTab: vi.fn(),
            pinTab: vi.fn(),
            consumeEditorFocusRequest: vi.fn(),
            createNewTab: vi.fn(),
            splitWorkspace: vi.fn(),
            closeGroup: vi.fn(),
            closeTab: vi.fn(),
            changeDraftContent: vi.fn(),
            fileDraft: vi.fn(),
            beginEditing: vi.fn(),
            finishEditing: vi.fn(),
            openDocument: vi.fn().mockResolvedValue(undefined),
            toggleTaskCheckbox: vi.fn().mockResolvedValue(undefined),
            deleteFiledNote: vi.fn().mockResolvedValue(undefined),
            persistDocument: vi.fn(),
            persistMetadata: vi.fn(),
            moveBundleFile: vi.fn().mockResolvedValue(undefined),
          }}
          ui={ui}
        />
      );
    }

    const { container } = render(<GroupHarness />);
    const dragged = screen.getByTitle("/notes/current.md");
    const target = screen.getByTitle("/notes/target.md");
    vi.spyOn(dragged, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      width: 100,
      height: 20,
      top: 0,
      right: 100,
      bottom: 20,
      left: 0,
      toJSON: () => ({}),
    });
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue({
      x: -100,
      y: 0,
      width: 100,
      height: 20,
      top: 0,
      right: 0,
      bottom: 20,
      left: -100,
      toJSON: () => ({}),
    });
    fireEvent.dragStart(dragged, {
      dataTransfer: { setData: vi.fn() },
    });
    fireEvent.dragOver(dragged, {
      clientX: 25,
      dataTransfer: {},
    });
    expect(dragged).toHaveClass("drop-before");
    fireEvent.dragLeave(dragged, { relatedTarget: document.body });
    expect(dragged).not.toHaveClass("drop-before");
    fireEvent.dragStart(dragged, {
      dataTransfer: { setData: vi.fn() },
    });
    const afterLastDragOver = createEvent.dragOver(target, { dataTransfer: {} });
    Object.defineProperty(afterLastDragOver, "clientX", { value: 75 });
    fireEvent(target, afterLastDragOver);
    expect(target).toHaveClass("drop-after");
    fireEvent.dragEnd(dragged);
    expect(target).not.toHaveClass("drop-after");
    fireEvent.dragStart(dragged, {
      dataTransfer: { setData: vi.fn() },
    });
    const tabStrip = container.querySelector(".tab-strip")!;
    fireEvent.dragOver(tabStrip, { dataTransfer: {} });
    expect(target).toHaveClass("drop-after");
    fireEvent.drop(tabStrip, {
      dataTransfer: {
        getData: () =>
          JSON.stringify({
            documentId: "/notes/current.md",
            groupId: "primary",
          }),
      },
    });

    expect(moveTabToGroup).toHaveBeenCalledWith(
      "/notes/current.md",
      "primary",
      "primary",
      1,
    );
    expect(target).not.toHaveClass("drop-before", "drop-after");
    expect(Array.from(container.querySelectorAll<HTMLButtonElement>(".editor-tab")).map((tab) => tab.title)).toEqual([
      "/notes/target.md",
      "/notes/current.md",
    ]);
  });

  it("keeps metadata, path, tag, and drag state inside the workspace hook", () => {
    const { result } = renderHook(() => useWorkspaceEditorUi());
    act(() => {
      result.current.setDraggedTab({
        documentId: document.id,
        groupId: "primary",
      });
      result.current.beginMetadataEditing(
        "primary",
        document,
        "title",
      );
      result.current.beginPathEditing(document);
      result.current.beginTagEditing(document);
    });

    expect(result.current.draggedTab?.documentId).toBe(document.id);
    expect(result.current.editingMetadataKey).toBe(
      "primary:/notes/current.md:title",
    );
    expect(result.current.pathDrafts[document.id]).toBe("/notes");
    expect(result.current.tagDrafts[document.id]).toBe("one");
  });
});
