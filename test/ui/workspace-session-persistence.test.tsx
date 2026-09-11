import { act, renderHook } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TabGroup } from "../../src/domain/types.ts";
import {
  useWorkspaceSessionPersistence,
} from "../../src/features/workspace/hooks/useWorkspaceSessionPersistence.ts";

const group = (id: "primary" | "secondary", tabs: string[], activeId: string): TabGroup => ({
  id,
  tabs,
  activeId,
  previewId: null,
});

function useTestSession(
  initialState: Parameters<typeof useWorkspaceSessionPersistence>[0]["initialState"],
  loadDocument: (id: string, source: "note" | "file") => Promise<void>,
) {
  const [groups, setGroups] = useState<TabGroup[]>(
    initialState?.groups ?? [group("primary", [], "")],
  );
  const [activeGroupId, setActiveGroupId] = useState(
    initialState?.activeGroupId ?? "primary",
  );
  const [documents] = useState<Record<string, never>>({});
  const session = useWorkspaceSessionPersistence({
    initialState,
    documents,
    notes: ["/one.md", "/three.md"].map((id) => ({ id, title: id, rawId: null, type: "note", description: "", tags: [], relatedIds: [], createdAt: "2026-01-01", classifiedByModel: false, status: "stable", staleAfter: null, stale: false, filedBy: null, filedAt: null })),
    files: [{ id: "/two.md", name: "two.md", title: "two", createdAt: "2026-01-01", directory: "/", type: "file", deletable: true }],
    groups,
    activeGroupId,
    sidebarMode: "explore",
    explorerScrollTop: 0,
    setGroups,
    setActiveGroupId,
    loadDocument,
  });
  return { ...session, groups, activeGroupId, setGroups, setActiveGroupId };
}

describe("workspace session persistence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("folio", { setStorage: vi.fn(), removeStorage: vi.fn() });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("reconciles once and loads only active documents", () => {
    const loadDocument = vi.fn().mockResolvedValue(undefined);
    const initialState = {
      version: 1 as const,
      groups: [
        group("primary", ["/one.md", "/two.md"], "/one.md"),
        group("secondary", ["/three.md", "/missing.md"], "/three.md"),
      ],
      activeGroupId: "primary",
      sidebarMode: "explore" as const,
      explorerScrollTop: 0,
      documentScrollTops: {},
    };
    const { result } = renderHook(() => useTestSession(initialState, loadDocument));

    act(() => result.current.markWorkspaceDataReady());
    expect(loadDocument).toHaveBeenCalledTimes(2);
    expect(loadDocument).toHaveBeenCalledWith("/one.md", "note");
    expect(loadDocument).toHaveBeenCalledWith("/three.md", "note");
    expect(result.current.groups).toEqual([
      group("primary", ["/one.md", "/two.md"], "/one.md"),
      group("secondary", ["/three.md"], "/three.md"),
    ]);

    act(() => result.current.markWorkspaceDataReady());
    expect(loadDocument).toHaveBeenCalledTimes(2);
  });

  it("does not reapply selection after a delayed load completes", async () => {
    let resolveLoad: (() => void) | undefined;
    const loadDocument = vi.fn(() => new Promise<void>((resolve) => { resolveLoad = resolve; }));
    const initialState = {
      version: 1 as const,
      groups: [group("primary", ["/one.md", "/two.md"], "/one.md")],
      activeGroupId: "primary",
      sidebarMode: "explore" as const,
      explorerScrollTop: 0,
      documentScrollTops: {},
    };
    const { result } = renderHook(() => useTestSession(initialState, loadDocument));
    act(() => result.current.markWorkspaceDataReady());
    act(() => {
      result.current.setGroups([group("primary", ["/one.md", "/two.md"], "/two.md")]);
      result.current.setActiveGroupId("primary");
    });
    await act(async () => resolveLoad?.());

    expect(result.current.groups[0].activeId).toBe("/two.md");
  });

  it("coalesces rapid selection and scroll changes into one debounced write", () => {
    const storageWrite = vi.mocked(window.folio!.setStorage!);
    const initialState = null;
    const { result } = renderHook(() => useTestSession(initialState, vi.fn().mockResolvedValue(undefined)));

    act(() => {
      result.current.rememberDocumentScrollTop("/one.md", 10);
      result.current.rememberDocumentScrollTop("/one.md", 20);
      result.current.setGroups([group("primary", ["/one.md"], "/one.md")]);
      result.current.setGroups([group("primary", ["/one.md", "/two.md"], "/two.md")]);
    });
    act(() => vi.advanceTimersByTime(399));
    expect(storageWrite).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(storageWrite).toHaveBeenCalledTimes(1);
    expect(JSON.parse(storageWrite.mock.calls[0][1]).groups[0].activeId).toBe("/two.md");
  });
});
