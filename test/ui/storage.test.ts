import { afterEach, describe, expect, it, vi } from "vitest";

import {
  loadExpandedDirectoryState,
  loadLocalDrafts,
} from "../../src/lib/storage.ts";

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
