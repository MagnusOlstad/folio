import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceDocumentState } from "../../src/features/workspace/hooks/useWorkspaceDocumentState.ts";
import { storedDraftDocument } from "../../src/lib/workspace.ts";

const draft = (content: string) => storedDraftDocument({
  id: "untitled:test", content,
  createdAt: "2026-09-07T00:00:00Z", updatedAt: "2026-09-07T00:00:00Z",
});

function setup() {
  return renderHook(() => useWorkspaceDocumentState({
    expandedDirectories: new Set<string>(), expandedDirectoriesReady: false,
  }));
}

describe("draft persistence", () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("never saves a new blank draft to local storage or the server", async () => {
    const { result } = setup();
    act(() => result.current.setDocuments({ "untitled:test": draft(" \n ") }));
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(JSON.parse(localStorage.getItem("folio:drafts")!)).toEqual([]);
    expect(fetchMock.mock.calls.every(([, options]) => options.method === "DELETE")).toBe(true);
  });

  it("keeps content recoverable and removes the remote copy when it is cleared", async () => {
    const { result } = setup();
    act(() => result.current.setDocuments({ "untitled:test": draft("Keep me") }));
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(JSON.parse(localStorage.getItem("folio:drafts")!)[0].content).toBe("Keep me");
    expect(fetchMock).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ method: "PUT" }));
    act(() => result.current.changeDraftContent(result.current.documents["untitled:test"], ""));
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(JSON.parse(localStorage.getItem("folio:drafts")!)).toEqual([]);
    expect(fetchMock).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ method: "DELETE" }));
  });

  it("does not restore empty remote drafts", () => {
    const { result } = setup();
    act(() => result.current.mergeRemoteDrafts([{ id: "untitled:empty", content: "\n", createdAt: "2026", updatedAt: "2026" }]));
    expect(result.current.documents).toEqual({});
  });
});
