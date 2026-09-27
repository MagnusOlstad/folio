import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useNoteHistoryCheckpoint } from "../../src/features/workspace/hooks/useNoteHistoryCheckpoint.ts";

describe("useNoteHistoryCheckpoint", () => {
  afterEach(() => vi.useRealTimers());

  it("checkpoints edited notes every five minutes and stops after a clean checkpoint", async () => {
    vi.useFakeTimers();
    const checkpoint = vi.fn().mockResolvedValue(undefined);
    const { result, unmount } = renderHook(() => useNoteHistoryCheckpoint({ checkpoint }));

    act(() => result.current("/notes/long-session.md", "bundle-one"));
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60 * 1000 - 1); });
    expect(checkpoint).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(checkpoint).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60 * 1000); });
    expect(checkpoint).toHaveBeenCalledTimes(1);

    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps edits made during a checkpoint dirty for the next interval", async () => {
    vi.useFakeTimers();
    let resolveCheckpoint: (() => void) | undefined;
    const checkpoint = vi.fn(() => new Promise<void>((resolve) => { resolveCheckpoint = resolve; }));
    const { result } = renderHook(() => useNoteHistoryCheckpoint({ checkpoint }));
    act(() => result.current("/notes/long-session.md", "bundle-one"));
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60 * 1000); });
    expect(checkpoint).toHaveBeenCalledTimes(1);
    act(() => result.current("/notes/long-session.md", "bundle-one"));
    await act(async () => { resolveCheckpoint?.(); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60 * 1000); });
    expect(checkpoint).toHaveBeenCalledTimes(2);
  });

  it("keeps identical paths in separate bundles scoped and does not restart after unmount", async () => {
    vi.useFakeTimers();
    let resolveCheckpoint: (() => void) | undefined;
    const checkpoint = vi.fn((_documentId: string, _scopeId: string) => new Promise<void>((resolve) => { resolveCheckpoint = resolve; }));
    const { result, unmount } = renderHook(() => useNoteHistoryCheckpoint({ checkpoint }));
    act(() => {
      result.current("/notes/same.md", "bundle-one");
      result.current("/notes/same.md", "bundle-two");
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60 * 1000); });
    expect(checkpoint.mock.calls).toEqual([
      ["/notes/same.md", "bundle-one"],
      ["/notes/same.md", "bundle-two"],
    ]);
    unmount();
    resolveCheckpoint?.();
    await act(async () => { await Promise.resolve(); });
    expect(vi.getTimerCount()).toBe(0);
  });
});
