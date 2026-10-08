import { describe, expect, it } from "vitest";
import { documentPathAfterChanges, replaceDocumentPath, replaceDocumentTabs } from "../../src/features/workspace/model/document-path.ts";

describe("document path transitions", () => {
  it("follows later moves and deletion while stopping at unchanged, self and cyclic paths", () => {
    const changes = {
      "/old.md": { sequence: 1, newId: "/middle.md" },
      "/middle.md": { sequence: 2, newId: "/last.md" },
      "/last.md": { sequence: 2, newId: "/last.md" },
    };
    expect(documentPathAfterChanges(changes, "/old.md", 0)).toBe("/last.md");
    expect(documentPathAfterChanges(changes, "/old.md", 1)).toBeUndefined();
    expect(documentPathAfterChanges({ ...changes, "/last.md": { sequence: 3, newId: null } }, "/old.md", 0)).toBeNull();
    expect(documentPathAfterChanges({ ...changes, "/last.md": { sequence: 3, newId: "/middle.md" } }, "/old.md", 0)).toBe("/middle.md");
  });
  it.each(["/old.md", "/new.md"])("preserves a permanent tab when merging with preview %s", (previewId) => {
    expect(replaceDocumentTabs([{ id: "g", tabs: ["/old.md", "/new.md"], activeId: "/old.md", previewId }], "/old.md", "/new.md"))
      .toEqual([{ id: "g", tabs: ["/new.md"], activeId: "/new.md", previewId: null }]);
  });

  it("migrates a single preview and preserves unsaved local content", () => {
    expect(replaceDocumentTabs([{ id: "g", tabs: ["/old.md"], activeId: "/old.md", previewId: "/old.md" }], "/old.md", "/new.md"))
      .toEqual([{ id: "g", tabs: ["/new.md"], activeId: "/new.md", previewId: "/new.md" }]);
    expect(replaceDocumentPath({ "/old.md": "unsaved" }, "/old.md", "/new.md")).toEqual({ "/new.md": "unsaved" });
    expect(replaceDocumentPath({}, "/old.md", "/new.md")).toEqual({});
  });
});
