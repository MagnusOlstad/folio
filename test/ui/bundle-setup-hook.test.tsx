import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useBundleSetup } from "../../src/features/settings/hooks/useBundleSetup.ts";

describe("bundle setup loading", () => {
  afterEach(() => {
    window.localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("recovers the stored bundle and persists later selection", async () => {
    const bundles = [
      { id: "first", name: "First", markdownPath: "/notes/first", managed: false, detached: false },
      { id: "saved", name: "Saved", markdownPath: "/notes/saved", managed: false, detached: false },
    ];
    window.localStorage.setItem("folio:bundle-active:v1", "saved");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ bundles, error: null }),
    }));

    const { result } = renderHook(() => useBundleSetup());
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.activeBundleId).toBe("saved");
    expect(result.current.bundles).toEqual(bundles);

    act(() => result.current.selectBundle("first"));
    expect(result.current.activeBundleId).toBe("first");
    expect(window.localStorage.getItem("folio:bundle-active:v1")).toBe("first");
  });
});
