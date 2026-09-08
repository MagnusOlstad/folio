import { renderHook } from "@testing-library/react";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useFiledDocumentAutosave } from "../../src/features/workspace/hooks/useFiledDocumentAutosave.ts";

async function advance(milliseconds: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}

describe("useFiledDocumentAutosave", () => {
  afterEach(() => vi.useRealTimers());

  it("waits 500ms of idle time before saving the newest content", async () => {
    vi.useFakeTimers();
    const save = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useFiledDocumentAutosave({ save }));

    act(() => result.current.scheduleSave("one", "first"));
    await advance(400);
    act(() => result.current.scheduleSave("one", "newest"));
    await advance(499);
    expect(save).not.toHaveBeenCalled();

    await advance(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith("one", "newest");
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

    act(() => result.current.scheduleSave("one", "first"));
    await advance(500);
    expect(save).toHaveBeenLastCalledWith("one", "first");

    act(() => {
      result.current.scheduleSave("one", "second");
      result.current.scheduleSave("one", "third");
    });
    expect(save).toHaveBeenCalledTimes(1);

    await act(async () => resolveFirst?.());
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith("one", "third");
    expect(result.current.isDirty("one")).toBe(false);
  });

  it("flushes a pending document immediately and flushes every document", async () => {
    vi.useFakeTimers();
    const save = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useFiledDocumentAutosave({ save }));

    act(() => {
      result.current.scheduleSave("one", "a");
      result.current.scheduleSave("two", "b");
    });
    await act(async () => result.current.flushSave("one"));
    expect(save).toHaveBeenCalledWith("one", "a");
    expect(save).not.toHaveBeenCalledWith("two", "b");

    await act(async () => result.current.flushAllSaves());
    expect(save).toHaveBeenCalledWith("two", "b");
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

    act(() => result.current.scheduleSave("one", "unsaved"));
    await advance(500);
    expect(onSaveError).toHaveBeenCalledWith("one", failure);
    expect(result.current.isDirty("one")).toBe(true);

    await act(async () => result.current.flushSave("one"));
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith("one", "unsaved");
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

    act(() => result.current.scheduleSave("one", "old"));
    await advance(500);
    act(() => result.current.scheduleSave("one", "new"));
    await act(async () => resolveFirst?.());

    expect(save).toHaveBeenLastCalledWith("one", "new");
    expect(states).toContainEqual({ dirty: true, saving: true });
    expect(result.current.isDirty("one")).toBe(true);

    await act(async () => resolveSecond?.());
    expect(result.current.isDirty("one")).toBe(false);
  });
});
