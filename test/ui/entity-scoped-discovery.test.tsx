import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceDiscovery } from "../../src/features/workspace/hooks/useWorkspaceDiscovery.ts";
import { useEntityScope } from "../../src/features/workspace/hooks/useEntityScope.ts";
import type { EntityScopeMetadata } from "../../src/domain/entities.ts";

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../../src/lib/api.ts", () => ({ apiForBundle: request }));

const scope: EntityScopeMetadata = {
  entityIds: ["acme", "atlas"],
  entities: [{ id: "acme", label: "Acme", type: "organization" }, { id: "atlas", label: "Atlas", type: "product" }],
  coverage: { eligible: 4, processed: 3, stale: 1, failed: 0, pending: 0 },
  incomplete: true,
  matchedNoteCount: 1,
  revision: 4,
  indexRevision: 3,
};

describe("entity-scoped discovery consumers", () => {
  beforeEach(() => request.mockReset());

  it("sends the shared intersection scope to search and Ask and retains coverage metadata", async () => {
    request.mockImplementation((first: string, second?: string) => {
      const path = second ?? first;
      if (typeof path !== "string") return Promise.resolve({});
      if (path.startsWith("/api/search?")) return Promise.resolve({ items: [], scope });
      if (path === "/api/ask") return Promise.resolve({ answer: "Acme and Atlas appear together.", sources: [], model: "gemma4", retrieval: "OKF", scope });
      throw new Error(`Unexpected path ${path}`);
    });
    const { result } = renderHook(() => {
      const entityScope = useEntityScope("bundle-a");
      const discovery = useWorkspaceDiscovery({ setMessage: vi.fn(), setSidebarMode: vi.fn(), bundleId: "bundle-a", entityScope });
      return { entityScope, discovery };
    });
    act(() => {
      result.current.entityScope.toggleEntity({ id: "acme", label: "Acme", type: "organization" }, true);
      result.current.entityScope.toggleEntity({ id: "atlas", label: "Atlas", type: "product" }, true);
      result.current.discovery.setSearchQuery("launch");
    });
    await act(async () => { await result.current.discovery.searchNotes(); });
    const [searchBundle, searchUrl] = request.mock.calls[0] as [string, string];
    expect(searchBundle).toBe("bundle-a");
    expect(searchUrl).toContain("q=launch");
    expect(searchUrl).toContain("entityIds=acme%2Catlas");
    expect(searchUrl).toContain("includeScope=true");
    expect(result.current.discovery.searchScope).toEqual(scope);

    act(() => result.current.discovery.setQuestion("What happened with the launch?"));
    await act(async () => { await result.current.discovery.askNotes("gemma4"); });
    expect(request).toHaveBeenLastCalledWith("bundle-a", "/api/ask", expect.objectContaining({
      method: "POST",
      body: expect.stringContaining('"entityIds":["acme","atlas"]'),
    }));
    expect(result.current.discovery.answer?.scope).toEqual(scope);
  });

  it("does not let a late scoped response repopulate results after scope is cleared", async () => {
    let resolveSearch!: (value: unknown) => void;
    request.mockImplementation((_bundle: string, path?: string) => path?.startsWith("/api/search?")
      ? new Promise((resolve) => { resolveSearch = resolve; })
      : Promise.resolve({}));
    const { result } = renderHook(() => {
      const entityScope = useEntityScope("bundle-a");
      const discovery = useWorkspaceDiscovery({ setMessage: vi.fn(), setSidebarMode: vi.fn(), bundleId: "bundle-a", entityScope });
      return { entityScope, discovery };
    });
    act(() => {
      result.current.entityScope.toggleEntity({ id: "acme", label: "Acme", type: "organization" }, true);
      result.current.discovery.setSearchQuery("launch");
    });
    let pending!: Promise<void>;
    act(() => { pending = result.current.discovery.searchNotes(); });
    act(() => result.current.entityScope.clear());
    await act(async () => {
      resolveSearch({ items: [{ id: "note-a", title: "Acme launch" }], scope });
      await pending;
    });
    expect(request.mock.calls[0]?.[1]).toContain("entityIds=acme");
    expect(result.current.discovery.searchResults).toEqual([]);
    expect(result.current.discovery.searchScope).toBeNull();
  });
});
