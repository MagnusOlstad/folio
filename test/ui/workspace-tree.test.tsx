import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { BundleFile } from "../../src/domain/types.ts";
import { FileTree } from "../../src/features/explorer/FileTree.tsx";
import { buildFileTree } from "../../src/lib/tree.ts";
import {
  expandedPathsForFiles,
  filedDraftContent,
  hasInstalledModel,
  isUntitledId,
  parseTags,
  storedDraftDocument,
  toggleTaskAtLine,
} from "../../src/lib/workspace.ts";

function file(
  id: string,
  title: string,
  createdAt: string,
  movable = true,
): BundleFile {
  return {
    id,
    name: id.split("/").at(-1)!,
    title,
    createdAt,
    directory: id.split("/").slice(0, -1).join("/") || "/",
    type: "Note",
    deletable: true,
    movable,
    filedBy: null,
    filedAt: null,
  };
}

describe("workspace pure helpers", () => {
  it("normalizes tags, model aliases, draft identity/content, and draft documents", () => {
    expect(parseTags(" work, ideas,work, , ideas ")).toEqual(["work", "ideas"]);
    expect(hasInstalledModel("embeddinggemma", ["embeddinggemma:latest"])).toBe(
      true,
    );
    expect(hasInstalledModel("llama3.2:3b", ["llama3.2:3b"])).toBe(true);
    expect(hasInstalledModel("missing", ["other:latest"])).toBe(false);
    expect(isUntitledId("untitled:123")).toBe(true);
    expect(isUntitledId("/notes/123.md")).toBe(false);
    expect(filedDraftContent("# Suggested path\nThe useful content")).toBe(
      "The useful content",
    );
    expect(filedDraftContent("One line")).toBe("One line");
    expect(
      storedDraftDocument({
        id: "untitled:1",
        content: "Draft",
        createdAt: "2026-01-01",
        updatedAt: "2026-01-02",
      }),
    ).toMatchObject({
      title: "Untitled",
      type: "Local draft",
      movable: false,
      content: "Draft",
      updatedAt: "2026-01-02",
    });
  });

  it("toggles valid markdown task lines without changing invalid lines", () => {
    expect(toggleTaskAtLine("- [ ] first\n> 1. [X] second", 2, false)).toBe(
      "- [ ] first\n> 1. [ ] second",
    );
    expect(toggleTaskAtLine("- [ ] first", 0, true)).toBeNull();
    expect(toggleTaskAtLine("plain text", 1, true)).toBeNull();
  });
});

describe("file tree behavior", () => {
  const files = [
    file("/zeta/late.md", "Same title", "2026-01-01"),
    file("/alpha/first.md", "Alpha", "2026-01-01"),
    file("/zeta/early.md", "Same title", "2026-02-01"),
    file("/root.md", "Root", "2026-01-01", false),
  ];

  it("builds alphabetized directories and title/date-sorted files, and expands all ancestors", () => {
    const tree = buildFileTree([
      ...files,
      file("/references/inbox/raw.md", "Raw capture", "2026-03-01", false),
    ]);
    expect(tree.directories.map((directory) => directory.name)).toEqual([
      "alpha",
      "zeta",
    ]);
    expect(tree.directories.some((directory) => directory.name === "references")).toBe(false);
    expect(tree.directories[1].files.map((entry) => entry.id)).toEqual([
      "/zeta/early.md",
      "/zeta/late.md",
    ]);
    expect([...expandedPathsForFiles(files)]).toEqual(["/", "/zeta", "/alpha"]);
  });

  it("toggles directories, opens files, and only exposes eligible files as draggable", () => {
    const tree = buildFileTree(files);
    const handlers = {
      onToggle: vi.fn(),
      onOpen: vi.fn(),
      onFileDragStart: vi.fn(),
      onFileDragEnd: vi.fn(),
      onDirectoryDragOver: vi.fn(),
      onMove: vi.fn(),
    };
    const { rerender } = render(
      <FileTree
        directory={tree}
        depth={0}
        expanded={new Set(["/"])}
        draggedFileId={null}
        dropDirectoryPath={null}
        movingFileId={null}
        blockedFileIds={new Set()}
        {...handlers}
      />,
    );

    fireEvent.click(screen.getByText("Bundle").closest("button")!);
    fireEvent.click(screen.getByRole("button", { name: "Root" }));
    expect(handlers.onToggle).toHaveBeenCalledWith("/");
    expect(handlers.onOpen).toHaveBeenCalledWith("/root.md", "preview");
    fireEvent.doubleClick(screen.getByRole("button", { name: "Root" }));
    expect(handlers.onOpen).toHaveBeenLastCalledWith(
      "/root.md",
      "permanent",
    );
    expect(screen.getByRole("button", { name: "Root" })).toHaveAttribute(
      "draggable",
      "false",
    );
    expect(screen.queryByText("root.md")).not.toBeInTheDocument();

    rerender(
      <FileTree
        directory={tree}
        depth={0}
        expanded={new Set(["/", "/alpha"])}
        draggedFileId={null}
        dropDirectoryPath={null}
        movingFileId={null}
        blockedFileIds={new Set()}
        {...handlers}
      />,
    );
    expect(screen.getByRole("button", { name: "Alpha" })).toHaveAttribute(
      "draggable",
      "true",
    );
  });

  it("limits visible explorer titles while preserving the full accessible title", () => {
    const title = "A".repeat(49);
    render(
      <FileTree
        directory={buildFileTree([file("/long.md", title, "2026-01-01")])}
        depth={0}
        expanded={new Set(["/"])}
        draggedFileId={null}
        dropDirectoryPath={null}
        movingFileId={null}
        blockedFileIds={new Set()}
        onToggle={vi.fn()}
        onOpen={vi.fn()}
        onFileDragStart={vi.fn()}
        onFileDragEnd={vi.fn()}
        onDirectoryDragOver={vi.fn()}
        onMove={vi.fn()}
      />,
    );

    expect(screen.getByText(`${"A".repeat(47)}…`)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: title })).toHaveAttribute(
      "title",
      `${title} - drag onto a folder to move`,
    );
  });
});
