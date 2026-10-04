import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ViewerDocument } from "../../src/domain/types.ts";
import { useWorkspaceDocumentState } from "../../src/features/workspace/hooks/useWorkspaceDocumentState.ts";
import { storedDraftDocument } from "../../src/lib/workspace.ts";

const draft = (content: string, id = "untitled:test") => storedDraftDocument({
  id, content,
  createdAt: "2026-09-07T00:00:00Z", updatedAt: "2026-09-07T00:00:00Z",
});

function setup({ bundleId = "legacy-bundle", persistenceEnabled = true } = {}) {
  return renderHook(() => useWorkspaceDocumentState({
    expandedDirectories: new Set<string>(), expandedDirectoriesReady: false,
    bundleId, persistenceEnabled,
  }));
}

describe("draft persistence", () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => "{}" });
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
    expect(JSON.parse(localStorage.getItem("folio:drafts:v2:legacy-bundle")!)).toEqual([]);
    expect(fetchMock.mock.calls.every(([, options]) => options.method === "DELETE")).toBe(true);
  });

  it("keeps content recoverable and removes the remote copy when it is cleared", async () => {
    const { result } = setup();
    act(() => result.current.setDocuments({ "untitled:test": draft("Keep me") }));
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(JSON.parse(localStorage.getItem("folio:drafts:v2:legacy-bundle")!)[0].content).toBe("Keep me");
    expect(fetchMock).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ method: "PUT" }));
    act(() => result.current.changeDraftContent(result.current.documents["untitled:test"], ""));
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(JSON.parse(localStorage.getItem("folio:drafts:v2:legacy-bundle")!)).toEqual([]);
    expect(fetchMock).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ method: "DELETE" }));
  });

  it("does not repeat unchanged draft server or storage writes on the idle cadence", async () => {
    const storageWrite = vi.spyOn(Storage.prototype, "setItem");
    const { result } = setup();
    act(() => result.current.setDocuments({ "untitled:test": draft("Keep me") }));
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    const requestsAfterSave = fetchMock.mock.calls.length;
    const storageWritesAfterSave = storageWrite.mock.calls.filter(([key]) => key === "folio:drafts:v2:legacy-bundle").length;

    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });

    expect(fetchMock).toHaveBeenCalledTimes(requestsAfterSave);
    expect(storageWrite.mock.calls.filter(([key]) => key === "folio:drafts:v2:legacy-bundle")).toHaveLength(storageWritesAfterSave);
    storageWrite.mockRestore();
  });

  it("retries a failed sync on the existing cadence and syncs changed drafts", async () => {
    fetchMock.mockReset()
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => "{}" })
      .mockResolvedValue({ ok: true, text: async () => "{}" });
    const { result } = setup();
    act(() => result.current.setDocuments({ "untitled:test": draft("First") }));
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    act(() => result.current.changeDraftContent(result.current.documents["untitled:test"], "Changed"));
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(JSON.parse(fetchMock.mock.calls[2][1].body as string).content).toBe("Changed");

    act(() => result.current.setDocuments((current) => ({
      ...current,
      "untitled:new": draft("New draft", "untitled:new"),
    })));
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(JSON.parse(fetchMock.mock.calls[3][1].body as string).content).toBe("New draft");
  });

  it("retries a failed blank-draft deletion on the idle cadence", async () => {
    fetchMock.mockReset()
      .mockResolvedValueOnce({ ok: true, text: async () => "{}" })
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => "{}" })
      .mockResolvedValue({ ok: true, text: async () => "{}" });
    const { result } = setup();
    act(() => result.current.setDocuments({ "untitled:test": draft("Existing") }));
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    act(() => result.current.changeDraftContent(result.current.documents["untitled:test"], ""));
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1].method).toBe("DELETE");

    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2][1].method).toBe("DELETE");
  });

  it("sends a recreated same-id draft after an older request finishes", async () => {
    let resolveFirstRequest: ((response: { ok: boolean; text: () => Promise<string> }) => void) | undefined;
    fetchMock.mockReset().mockImplementationOnce(() => new Promise((resolve) => {
      resolveFirstRequest = resolve;
    })).mockResolvedValue({ ok: true, text: async () => "{}" });
    const { result } = setup();
    act(() => result.current.setDocuments({ "untitled:test": draft("Before removal") }));
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    act(() => result.current.setDocuments({}));
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    act(() => result.current.setDocuments({ "untitled:test": draft("Recreated") }));
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirstRequest?.({ ok: true, text: async () => "{}" });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string).content).toBe("Recreated");
  });

  it("does not persist while disabled and scopes draft requests when the bundle changes", async () => {
    const disabled = setup({ bundleId: "bundle-a", persistenceEnabled: false });
    act(() => disabled.result.current.setDocuments({ "untitled:test": draft("Disabled") }));
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(localStorage.getItem("folio:drafts:v2:bundle-a")).toBeNull();
    disabled.unmount();

    const hook = renderHook(
      ({ bundleId }: { bundleId: string }) => useWorkspaceDocumentState({
        expandedDirectories: new Set<string>(), expandedDirectoriesReady: false,
        bundleId,
      }),
      { initialProps: { bundleId: "bundle-a" } },
    );
    act(() => hook.result.current.setDocuments({ "untitled:test": draft("Scoped") }));
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    hook.rerender({ bundleId: "bundle-b" });
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });

    expect(localStorage.getItem("folio:drafts:v2:bundle-a")).not.toBeNull();
    expect(localStorage.getItem("folio:drafts:v2:bundle-b")).not.toBeNull();
    expect(fetchMock.mock.calls.map(([, options]) => options.headers)).toEqual([
      expect.objectContaining({ "x-folio-bundle": "bundle-a" }),
      expect.objectContaining({ "x-folio-bundle": "bundle-b" }),
    ]);
    hook.unmount();
  });

  it("skips transient document derivation while disabled and syncs after re-enabling", async () => {
    const storageWrite = vi.spyOn(Storage.prototype, "setItem");
    const hook = renderHook(
      ({ enabled }: { enabled: boolean }) => useWorkspaceDocumentState({
        expandedDirectories: new Set<string>(), expandedDirectoriesReady: false,
        persistenceEnabled: enabled,
      }),
      { initialProps: { enabled: false } },
    );
    const writesAtMount = storageWrite.mock.calls.filter(([key]) => key === "folio:drafts:v2:legacy-bundle").length;
    act(() => hook.result.current.setDocuments({
      transient: {} as ViewerDocument,
    }));
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(storageWrite.mock.calls.filter(([key]) => key === "folio:drafts:v2:legacy-bundle")).toHaveLength(writesAtMount);

    act(() => hook.result.current.setDocuments({ "untitled:test": draft("Ready") }));
    hook.rerender({ enabled: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });

    expect(JSON.parse(localStorage.getItem("folio:drafts:v2:legacy-bundle")!)[0].content).toBe("Ready");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ method: "PUT", body: expect.stringContaining("Ready") }),
    );
    expect(storageWrite.mock.calls.filter(([key]) => key === "folio:drafts:v2:legacy-bundle").length).toBeGreaterThan(writesAtMount);
    storageWrite.mockRestore();
    hook.unmount();
  });

  it("skips the draft cache write when unrelated document state changes", async () => {
    const storageWrite = vi.spyOn(Storage.prototype, "setItem");
    const { result } = setup();
    act(() => result.current.setDocuments({ "untitled:test": draft("Keep me") }));
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    const writesAfterDraft = storageWrite.mock.calls.filter(([key]) => key === "folio:drafts:v2:legacy-bundle").length;
    act(() => result.current.setDocuments((current) => ({
      ...current,
      "note:filed": storedDraftDocument({
        id: "note:filed", content: "Filed", createdAt: "2026-09-07T00:00:00Z",
        updatedAt: "2026-09-07T00:00:00Z",
      }),
    })));
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });

    expect(storageWrite.mock.calls.filter(([key]) => key === "folio:drafts:v2:legacy-bundle")).toHaveLength(writesAfterDraft);
    storageWrite.mockRestore();
  });

  it("does not restore empty remote drafts", () => {
    const { result } = setup();
    act(() => result.current.mergeRemoteDrafts([{ id: "untitled:empty", content: "\n", createdAt: "2026", updatedAt: "2026" }]));
    expect(result.current.documents).toEqual({});
  });
});
