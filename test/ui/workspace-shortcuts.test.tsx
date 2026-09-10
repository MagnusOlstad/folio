import { act, fireEvent, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useWorkspaceShortcutActions } from "../../src/features/workspace/hooks/useWorkspaceShortcutActions.ts";

describe("workspace shortcuts", () => {
  it("opens find in the active note and changes tabs within the active group", () => {
    const activateTab = vi.fn();
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
          { id: "primary", tabs: ["first", "second"], activeId: "first" },
          { id: "secondary", tabs: ["third"], activeId: "third" },
        ],
        activeGroupId: "primary",
        documents: {},
        createNewTab: vi.fn(),
        activateTab,
        closeTab: vi.fn(),
        fileDraft: vi.fn(),
        flushDocument: vi.fn().mockResolvedValue(undefined),
        openSettings: vi.fn(),
      }),
    );

    fireEvent.keyDown(window, { key: "f", metaKey: true });
    fireEvent.keyDown(window, { key: "2", ctrlKey: true });

    expect(findInNote).toHaveBeenCalledOnce();
    expect(activateTab).toHaveBeenCalledWith("primary", "second");

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
        activateTab: vi.fn(),
        closeTab: vi.fn(),
        fileDraft: vi.fn(),
        flushDocument: vi.fn().mockResolvedValue(undefined),
        openSettings: vi.fn(),
      }),
    );

    fireEvent.keyDown(window, { key: "f", ctrlKey: true, shiftKey: true });

    expect(setSidebarMode).toHaveBeenCalledWith("search");

    unmount();
    searchInput.remove();
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
        activateTab: vi.fn(),
        closeTab: vi.fn(),
        fileDraft: vi.fn(),
        flushDocument: vi.fn().mockResolvedValue(undefined),
        openSettings,
      }),
    );

    act(() => handleMenuAction?.("open-settings"));

    expect(openSettings).toHaveBeenCalledOnce();
    unmount();
    delete window.folio;
  });
});
