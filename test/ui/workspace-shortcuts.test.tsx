import { act, fireEvent, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ViewerDocument } from "../../src/domain/types.ts";
import { useWorkspaceShortcutActions } from "../../src/features/workspace/hooks/useWorkspaceShortcutActions.ts";

describe("workspace shortcuts", () => {
  it("opens find in the active note and changes tabs within the active group", () => {
    const activateTabAtEnd = vi.fn();
    const findInNote = vi.fn();
    const group = document.createElement("div");
    group.className = "editor-group active";
    const editor = document.createElement("div");
    editor.dataset.liveMarkdownEditor = "";
    editor.addEventListener("folio-find", findInNote);
    group.append(editor);
    document.body.append(group);

    const { unmount } = renderHook(() =>
      useWorkspaceShortcutActions({
        sidebarMode: "explore",
        setSidebarMode: vi.fn(),
        searchInputRef: { current: null },
        groups: [
          {
            id: "primary",
            tabs: ["first", "second"],
            activeId: "first",
            previewId: null,
          },
          {
            id: "secondary",
            tabs: ["third"],
            activeId: "third",
            previewId: null,
          },
        ],
        activeGroupId: "primary",
        documents: {},
        createNewTab: vi.fn(),
        activateTabAtEnd,
        closeTab: vi.fn(),
        fileDraft: vi.fn(),
        flushDocument: vi.fn().mockResolvedValue(undefined),
        exportDocument: vi.fn(),
        openSettings: vi.fn(),
      }),
    );

    fireEvent.keyDown(window, { key: "f", metaKey: true });
    fireEvent.keyDown(window, { key: "2", ctrlKey: true });

    expect(findInNote).toHaveBeenCalledOnce();
    expect(activateTabAtEnd).toHaveBeenCalledWith("primary", "second");

    unmount();
    group.remove();
  });

  it("keeps Cmd/Ctrl+Shift+F for workspace search", () => {
    const setSidebarMode = vi.fn();
    const searchInput = document.createElement("input");
    document.body.append(searchInput);
    const { unmount } = renderHook(() =>
      useWorkspaceShortcutActions({
        sidebarMode: "explore",
        setSidebarMode,
        searchInputRef: { current: searchInput },
        groups: [],
        activeGroupId: "primary",
        documents: {},
        createNewTab: vi.fn(),
        activateTabAtEnd: vi.fn(),
        closeTab: vi.fn(),
        fileDraft: vi.fn(),
        flushDocument: vi.fn().mockResolvedValue(undefined),
        exportDocument: vi.fn(),
        openSettings: vi.fn(),
      }),
    );

    fireEvent.keyDown(window, { key: "f", ctrlKey: true, shiftKey: true });

    expect(setSidebarMode).toHaveBeenCalledWith("search");

    unmount();
    searchInput.remove();
  });

  it("exports the active split-group note from native menu actions", () => {
    const exportDocument = vi.fn();
    let handleMenuAction: ((action: string) => void) | undefined;
    const activeDocument = {
      id: "/active.md",
      title: "Active",
      type: "Note",
      description: "",
      tags: [],
      createdAt: "2026-09-11T08:00:00.000Z",
      content: "Active content",
      deletable: true,
      movable: true,
      status: "stable",
      staleAfter: null,
      stale: false,
      filedBy: null,
      filedAt: null,
      links: [],
      backlinks: [],
      suggestions: [],
    } satisfies ViewerDocument;
    window.folio = {
      onMenuAction: (handler) => {
        handleMenuAction = handler;
        return vi.fn();
      },
    };
    const { unmount } = renderHook(() =>
      useWorkspaceShortcutActions({
        sidebarMode: "explore",
        setSidebarMode: vi.fn(),
        searchInputRef: { current: null },
        groups: [
          {
            id: "primary",
            tabs: ["/other.md"],
            activeId: "/other.md",
            previewId: null,
          },
          {
            id: "secondary",
            tabs: [activeDocument.id],
            activeId: activeDocument.id,
            previewId: null,
          },
        ],
        activeGroupId: "secondary",
        documents: { [activeDocument.id]: activeDocument },
        createNewTab: vi.fn(),
        activateTabAtEnd: vi.fn(),
        closeTab: vi.fn(),
        fileDraft: vi.fn(),
        flushDocument: vi.fn().mockResolvedValue(undefined),
        exportDocument,
        openSettings: vi.fn(),
      }),
    );

    act(() => handleMenuAction?.("export-pdf"));
    expect(exportDocument).toHaveBeenCalledWith(activeDocument, "pdf");

    unmount();
    delete window.folio;
  });

  it("opens settings from the native application menu action", () => {
    const openSettings = vi.fn();
    let handleMenuAction: ((action: string) => void) | undefined;
    window.folio = {
      onMenuAction: (handler) => {
        handleMenuAction = handler;
        return vi.fn();
      },
    };
    const { unmount } = renderHook(() =>
      useWorkspaceShortcutActions({
        sidebarMode: "explore",
        setSidebarMode: vi.fn(),
        searchInputRef: { current: null },
        groups: [],
        activeGroupId: "primary",
        documents: {},
        createNewTab: vi.fn(),
        activateTabAtEnd: vi.fn(),
        closeTab: vi.fn(),
        fileDraft: vi.fn(),
        flushDocument: vi.fn().mockResolvedValue(undefined),
        exportDocument: vi.fn(),
        openSettings,
      }),
    );

    act(() => handleMenuAction?.("open-settings"));

    expect(openSettings).toHaveBeenCalledOnce();
    unmount();
    delete window.folio;
  });
});
