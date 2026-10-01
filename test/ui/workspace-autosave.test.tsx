import { renderHook } from "@testing-library/react";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useFiledDocumentAutosave } from "../../src/features/workspace/hooks/useFiledDocumentAutosave.ts";
import { mergeRemoteAppend } from "../../src/lib/workspace.ts";

async function advance(milliseconds: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}

describe("useFiledDocumentAutosave", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps an identical capture when the same text already appears in its observed base", () => {
    const section = "\n\n## 2026-10-01 10:30\n\n- [ ] Repeat the same task";
    const base = `# Todo${section}`;
    const remote = `${base}${section}`;
    expect(mergeRemoteAppend(base, base, remote)).toBe(`${base}${section}`);
  });

  it("waits 500ms of idle time before saving the newest content", async () => {
    vi.useFakeTimers();
    const save = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useFiledDocumentAutosave({ save }));

    act(() => result.current.scheduleSave("one", "first", "base"));
    await advance(400);
    act(() => result.current.scheduleSave("one", "newest", "base"));
    await advance(499);
    expect(save).not.toHaveBeenCalled();

    await advance(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith("one", "newest", "base");
    expect(result.current.isDirty("one")).toBe(false);
  });

  it("keeps one request in flight and follows it with only the newest edit", async () => {
    vi.useFakeTimers();
    let resolveFirst: (() => void) | undefined;
    const first = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const save = vi
      .fn<(documentId: string, content: string) => Promise<void>>()
      .mockImplementationOnce(() => first)
      .mockResolvedValue(undefined);
    const { result } = renderHook(() => useFiledDocumentAutosave({ save }));

    act(() => result.current.scheduleSave("one", "first", "base"));
    await advance(500);
    expect(save).toHaveBeenLastCalledWith("one", "first", "base");

    act(() => {
      result.current.scheduleSave("one", "second", "base");
      result.current.scheduleSave("one", "third", "base");
    });
    expect(save).toHaveBeenCalledTimes(1);

    await act(async () => resolveFirst?.());
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith("one", "third", "base");
    expect(result.current.isDirty("one")).toBe(false);
  });

  it("flushes a pending document immediately and flushes every document", async () => {
    vi.useFakeTimers();
    const save = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useFiledDocumentAutosave({ save }));

    act(() => {
      result.current.scheduleSave("one", "a", "base-a");
      result.current.scheduleSave("two", "b", "base-b");
    });
    expect(result.current.hasDirtySaves()).toBe(true);
    await act(async () => result.current.flushSave("one"));
    expect(save).toHaveBeenCalledWith("one", "a", "base-a");
    expect(save).not.toHaveBeenCalledWith("two", "b", "base-b");

    await act(async () => result.current.flushAllSaves());
    expect(save).toHaveBeenCalledWith("two", "b", "base-b");
    expect(result.current.hasDirtySaves()).toBe(false);
  });

  it("retains a failed save as dirty and retries it on an explicit flush", async () => {
    vi.useFakeTimers();
    const failure = new Error("offline");
    const onSaveError = vi.fn();
    const save = vi
      .fn<(documentId: string, content: string) => Promise<void>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(undefined);
    const { result } = renderHook(() =>
      useFiledDocumentAutosave({ save, onSaveError }),
    );

    act(() => result.current.scheduleSave("one", "unsaved", "base"));
    await advance(500);
    expect(onSaveError).toHaveBeenCalledWith("one", failure);
    expect(result.current.isDirty("one")).toBe(true);

    await act(async () => result.current.flushSave("one"));
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith("one", "unsaved", "base");
    expect(result.current.isDirty("one")).toBe(false);
  });

  it("does not allow a stale completion to clear newer dirty content", async () => {
    vi.useFakeTimers();
    let resolveFirst: (() => void) | undefined;
    let resolveSecond: (() => void) | undefined;
    const first = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const second = new Promise<void>((resolve) => {
      resolveSecond = resolve;
    });
    const save = vi
      .fn<(documentId: string, content: string) => Promise<void>>()
      .mockImplementationOnce(() => first)
      .mockImplementationOnce(() => second);
    const states: Array<{ dirty: boolean; saving: boolean }> = [];
    const { result } = renderHook(() =>
      useFiledDocumentAutosave({
        save,
        onSaveStateChange: (_documentId, state) => states.push(state),
      }),
    );

    act(() => result.current.scheduleSave("one", "old", "base"));
    await advance(500);
    act(() => result.current.scheduleSave("one", "new", "base"));
    await act(async () => resolveFirst?.());

    expect(save).toHaveBeenLastCalledWith("one", "new", "base");
    expect(states).toContainEqual({ dirty: true, saving: true });
    expect(result.current.isDirty("one")).toBe(true);

    await act(async () => resolveSecond?.());
    expect(result.current.isDirty("one")).toBe(false);
  });

  it("keeps a checkbox edit to a newly visible append without duplicating it", async () => {
    vi.useFakeTimers();
    let resolveFirst: ((content: string) => void) | undefined;
    const first = new Promise<string>((resolve) => {
      resolveFirst = resolve;
    });
    const canonical = "- [x] A checked\n\n## 2026-10-01 10:30\n\n- [ ] B";
    const afterSecond = `${canonical}\n- [ ] C`;
    const save = vi
      .fn<(documentId: string, content: string, baseContent: string) => Promise<string>>()
      .mockImplementationOnce(() => first)
      .mockResolvedValueOnce(afterSecond)
      .mockResolvedValueOnce("- [x] A checked\n\n## 2026-10-01 10:30\n\n- [x] B\n- [ ] C");
    const { result } = renderHook(() => useFiledDocumentAutosave({ save }));

    act(() => result.current.scheduleSave("todo", "- [x] A checked", "- [ ] A"));
    await advance(500);
    act(() => result.current.scheduleSave(
      "todo",
      "- [x] A edited\n\n## 2026-10-01 10:30\n\n- [x] B",
      "- [ ] A",
    ));
    act(() => result.current.observeContent("todo", canonical, "- [x] A edited\n\n## 2026-10-01 10:30\n\n- [x] B"));
    await act(async () => resolveFirst?.(canonical));

    expect(save).toHaveBeenCalledTimes(2);
    const queuedContent = String(save.mock.calls[1][1]);
    expect(queuedContent).toContain("- [x] A edited");
    expect(queuedContent).toContain("- [x] B");
    expect(queuedContent.match(/- \[[x ]\] B/g)).toHaveLength(1);
    expect(queuedContent).not.toContain("- [ ] B");
    expect(save.mock.calls[1][2]).toBe(canonical);

    await advance(0);
    act(() => result.current.scheduleSave("todo", "- [x] A checked\n\n## 2026-10-01 10:30\n\n- [x] B", afterSecond));
    await advance(500);
    expect(save.mock.calls[2][2]).toBe(afterSecond);
    expect(result.current.isDirty("todo")).toBe(false);
  });

  it("carries an unseen append into an in-flight edit to an older task", async () => {
    vi.useFakeTimers();
    let resolveFirst: ((content: string) => void) | undefined;
    const first = new Promise<string>((resolve) => {
      resolveFirst = resolve;
    });
    const canonical = "- [x] A checked\n\n## 2026-10-01 10:45\n\n- [ ] B";
    const save = vi
      .fn<(documentId: string, content: string, baseContent: string) => Promise<string>>()
      .mockImplementationOnce(() => first)
      .mockResolvedValueOnce(canonical);
    const { result } = renderHook(() => useFiledDocumentAutosave({ save }));

    act(() => result.current.scheduleSave("todo", "- [x] A checked", "- [ ] A"));
    await advance(500);
    act(() => result.current.scheduleSave("todo", "- [x] A edited", "- [ ] A"));
    await act(async () => resolveFirst?.(canonical));

    expect(save).toHaveBeenCalledTimes(2);
    const queuedContent = String(save.mock.calls[1][1]);
    expect(queuedContent).toContain("- [x] A edited");
    expect(queuedContent).toContain("- [ ] B");
    expect(queuedContent.match(/- \[[x ]\] B/g)).toHaveLength(1);
    expect(save.mock.calls[1][2]).toBe(canonical);
  });

  it("does not let an older save response roll back a newer observed Todo version", async () => {
    vi.useFakeTimers();
    let resolveFirst: ((content: string) => void) | undefined;
    const first = new Promise<string>((resolve) => {
      resolveFirst = resolve;
    });
    const staleResponse = "- [x] A saved by old request";
    const observed = "- [x] A saved by old request\n\n## 2026-10-01 11:15\n\n- [ ] B";
    const rebasedPending = "- [x] A locally edited\n\n## 2026-10-01 11:15\n\n- [ ] B";
    const save = vi
      .fn<(documentId: string, content: string, baseContent: string) => Promise<string>>()
      .mockImplementationOnce(() => first)
      .mockResolvedValueOnce(rebasedPending);
    const { result } = renderHook(() => useFiledDocumentAutosave({ save }));

    act(() => result.current.scheduleSave("todo", staleResponse, "- [ ] A"));
    await advance(500);
    act(() => result.current.scheduleSave("todo", "- [x] A locally edited", "- [ ] A"));
    act(() => result.current.observeContent("todo", observed, rebasedPending));
    await act(async () => resolveFirst?.(staleResponse));

    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1]).toEqual(["todo", rebasedPending, observed]);
  });
});
