import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useEntityScope } from "../../src/features/workspace/hooks/useEntityScope.ts";

describe("workspace entity scope", () => {
  it("keeps selections across note consumers and clears them when the bundle changes", () => {
    const { result, rerender } = renderHook(({ bundleId }) => useEntityScope(bundleId), { initialProps: { bundleId: "bundle-a" } });
    act(() => result.current.toggleEntity({ id: "entity-a", label: "Acme", type: "organization" }, true));
    expect(result.current.entityIds).toEqual(["entity-a"]);

    rerender({ bundleId: "bundle-b" });
    expect(result.current.entityIds).toEqual([]);
    act(() => result.current.toggleEntity({ id: "entity-b", label: "Atlas", type: "project" }, true));
    rerender({ bundleId: "bundle-a" });
    expect(result.current.entityIds).toEqual([]);
  });
});
