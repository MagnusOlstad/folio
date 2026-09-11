import { afterEach, describe, expect, it, vi } from "vitest";

import {
  loadExpandedDirectoryState,
  loadLocalDrafts,
} from "../../src/lib/storage.ts";
import {
  loadWorkspaceSessionState,
  parseWorkspaceSessionState,
  pruneDocumentScrollTops,
  reconcileWorkspaceSessionState,
} from "../../src/features/workspace/model/workspace-state.ts";

describe("expanded-directory storage", () => {
  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("restores only string directory paths and preserves unrelated storage keys", () => {
    window.localStorage.setItem(
      "folio:expanded-directories",
      JSON.stringify(["/projects", 4, null, "/daily", "/projects"]),
    );
    window.localStorage.setItem("folio:drafts", "important draft");

    const result = loadExpandedDirectoryState();

    expect(result.restored).toBe(true);
    expect([...result.directories]).toEqual(["/projects", "/daily"]);
    expect(window.localStorage.getItem("folio:expanded-directories")).toBe(
      JSON.stringify(["/projects", 4, null, "/daily", "/projects"]),
    );
    expect(window.localStorage.getItem("folio:drafts")).toBe("important draft");
  });

  it("returns an unrestored empty state for missing or invalid JSON without clearing the key", () => {
    expect(loadExpandedDirectoryState()).toMatchObject({ restored: false });

    window.localStorage.setItem("folio:expanded-directories", "{not-json");
    const result = loadExpandedDirectoryState();

    expect(result.restored).toBe(false);
    expect(result.directories).toEqual(new Set());
    expect(window.localStorage.getItem("folio:expanded-directories")).toBe(
      "{not-json",
    );
  });

  it("treats unavailable localStorage as an optional persistence failure", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("Storage disabled");
    });

    expect(loadExpandedDirectoryState()).toEqual({
      directories: new Set(),
      restored: false,
    });
  });
});

describe("local draft storage", () => {
  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("restores valid untitled drafts, skips invalid entries, and leaves the cache untouched", () => {
    const serialized = JSON.stringify([
      {
        id: "untitled:one",
        content: "First draft",
        createdAt: "2026-01-01",
        updatedAt: "2026-01-02",
      },
      { id: "/projects/file.md", content: "Not a draft" },
      { id: "untitled:no-content" },
    ]);
    window.localStorage.setItem("folio:drafts", serialized);
    window.localStorage.setItem("folio:expanded-directories", '["/projects"]');

    expect(loadLocalDrafts()).toEqual([
      expect.objectContaining({
        id: "untitled:one",
        content: "First draft",
        createdAt: "2026-01-01",
        updatedAt: "2026-01-02",
        movable: false,
      }),
    ]);
    expect(window.localStorage.getItem("folio:drafts")).toBe(serialized);
    expect(window.localStorage.getItem("folio:expanded-directories")).toBe(
      '["/projects"]',
    );
  });

  it("recovers malformed draft JSON under a timestamped key and clears only the corrupt cache", () => {
    vi.spyOn(Date, "now").mockReturnValue(12345);
    window.localStorage.setItem("folio:drafts", "{broken");
    window.localStorage.setItem("folio:expanded-directories", '["/daily"]');

    expect(loadLocalDrafts()).toEqual([]);
    expect(window.localStorage.getItem("folio:drafts")).toBeNull();
    expect(window.localStorage.getItem("folio:drafts-recovery:12345")).toBe(
      "{broken",
    );
    expect(window.localStorage.getItem("folio:expanded-directories")).toBe(
      '["/daily"]',
    );
  });

  it("returns no drafts when storage cannot be read", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("Storage disabled");
    });

    expect(loadLocalDrafts()).toEqual([]);
  });
});

describe("workspace session storage", () => {
  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("restores versioned workspace state while filtering invalid values", () => {
    window.localStorage.setItem(
      "folio:workspace-state",
      JSON.stringify({
        version: 1,
        groups: [
          {
            id: "primary",
            tabs: ["/notes/one.md", 4, "/notes/one.md"],
            activeId: "/notes/one.md",
            previewId: "missing",
          },
          null,
        ],
        activeGroupId: "missing",
        sidebarMode: "search",
        explorerScrollTop: 180,
        documentScrollTops: {
          "/notes/one.md": 420,
          bad: -1,
          "": 10,
        },
      }),
    );

    expect(loadWorkspaceSessionState()).toEqual({
      version: 1,
      groups: [
        {
          id: "primary",
          tabs: ["/notes/one.md"],
          activeId: "/notes/one.md",
          previewId: null,
        },
      ],
      activeGroupId: "primary",
      sidebarMode: "search",
      explorerScrollTop: 180,
      documentScrollTops: { "/notes/one.md": 420 },
    });
  });

  it("rejects corrupt or unsupported workspace state", () => {
    expect(parseWorkspaceSessionState({ version: 2, groups: [] })).toBeNull();
    expect(parseWorkspaceSessionState({ version: 1, groups: [] })).toBeNull();
    expect(
      parseWorkspaceSessionState({
        version: 1,
        groups: [
          { id: "tertiary", tabs: ["/bad"], activeId: "/bad", previewId: null },
          { id: "primary", tabs: ["/good"], activeId: "/good", previewId: null },
        ],
      }),
    ).toMatchObject({ groups: [{ id: "primary", tabs: ["/good"] }] });
    window.localStorage.setItem("folio:workspace-state", "{broken");
    expect(loadWorkspaceSessionState()).toBeNull();
  });

  it("caps groups and removes duplicate tabs across groups", () => {
    const result = parseWorkspaceSessionState({
      version: 1,
      groups: [
        {
          id: "primary",
          tabs: ["/same", "/first"],
          activeId: "/same",
          previewId: null,
        },
        {
          id: "secondary",
          tabs: ["/same", "/second"],
          activeId: "/second",
          previewId: null,
        },
        { id: "primary", tabs: ["/third"], activeId: "/third", previewId: null },
      ],
    });
    expect(result?.groups).toEqual([
      {
        id: "primary",
        tabs: ["/same", "/first"],
        activeId: "/same",
        previewId: null,
      },
      {
        id: "secondary",
        tabs: ["/second"],
        activeId: "/second",
        previewId: null,
      },
    ]);
  });

  it("keeps the most recently written scroll entries within the runtime limit", () => {
    const entries = Object.fromEntries(
      Array.from({ length: 205 }, (_, index) => [`/notes/${index}.md`, index]),
    );
    const result = pruneDocumentScrollTops(entries);

    expect(Object.keys(result)).toHaveLength(200);
    expect(result["/notes/0.md"]).toBeUndefined();
    expect(result["/notes/204.md"]).toBe(204);
  });

  it("reconciles restored tabs without loading or selecting documents", () => {
    const state = parseWorkspaceSessionState({
      version: 1,
      groups: [
        { id: "primary", tabs: ["/one.md", "/missing.md"], activeId: "/one.md", previewId: null },
        { id: "secondary", tabs: ["/two.md"], activeId: "/two.md", previewId: null },
      ],
      activeGroupId: "secondary",
      sidebarMode: "explore",
    });
    expect(state).not.toBeNull();
    expect(reconcileWorkspaceSessionState(state!, new Set(["/one.md", "/two.md"]))).toEqual({
      groups: [
        { id: "primary", tabs: ["/one.md"], activeId: "/one.md", previewId: null },
        { id: "secondary", tabs: ["/two.md"], activeId: "/two.md", previewId: null },
      ],
      activeGroupId: "secondary",
    });
  });
});
