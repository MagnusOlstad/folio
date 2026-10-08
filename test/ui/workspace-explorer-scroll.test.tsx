import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";

import type { Bundle, BundleFile } from "../../src/domain/types.ts";
import { WorkspaceExplorer } from "../../src/features/workspace/components/WorkspaceExplorer.tsx";
import type { WorkspaceExplorerProps } from "../../src/features/workspace/components/WorkspaceExplorer.tsx";
import { buildFileTree } from "../../src/lib/tree.ts";

const bundle: Bundle = {
  id: "bundle-1",
  name: "Notes",
  markdownPath: "/notes",
  managed: true,
  detached: false,
};
const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");

afterEach(() => {
  if (originalScrollIntoView) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScrollIntoView);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

function explorerProps(overrides: Partial<WorkspaceExplorerProps> = {}): WorkspaceExplorerProps {
  return {
    explorerScrollTop: 64,
    onExplorerScroll: vi.fn(),
    filesLoading: false,
    localDraftDocuments: [],
    drafts: {},
    draftTitle: (value) => value,
    openLocalDraft: vi.fn(),
    deleteLocalDraft: vi.fn().mockResolvedValue(undefined),
    deletingDraftIds: new Set(),
    savingDocuments: new Set(),
    fileTree: buildFileTree([]),
    expandedDirectories: new Set(),
    draggedFileId: null,
    dropDirectoryPath: null,
    movingFileId: null,
    blockedFileIds: new Set(),
    activeFileId: null,
    activeFileDirectory: null,
    activeFileRevealRequest: 0,
    setExpandedDirectories: vi.fn(),
    openDocument: vi.fn().mockResolvedValue(undefined),
    setDraggedFileId: vi.fn(),
    setDropDirectoryPath: vi.fn(),
    moveBundleFile: vi.fn().mockResolvedValue(undefined),
    bundles: [bundle],
    activeBundleId: bundle.id,
    selectBundle: vi.fn(),
    openSettings: vi.fn(),
    actions: {
      renameFile: vi.fn().mockResolvedValue(undefined),
      createFile: vi.fn().mockResolvedValue(undefined),
      createDirectory: vi.fn().mockResolvedValue(undefined),
      deleteFile: vi.fn().mockResolvedValue(undefined),
      deleteDirectory: vi.fn().mockResolvedValue(undefined),
      exportFile: vi.fn().mockResolvedValue(undefined),
      copyText: vi.fn().mockResolvedValue(undefined),
    },
    setMessage: vi.fn(),
    ...overrides,
  };
}

describe("WorkspaceExplorer scroll restoration", () => {
  it("restores saved scroll after remount/load without rewinding an unrelated live scroll", () => {
    const props = explorerProps();
    const { container, rerender } = render(<WorkspaceExplorer {...props} />);
    const tree = container.querySelector<HTMLDivElement>(".tree-scroll");
    expect(tree).not.toBeNull();
    expect(tree?.scrollTop).toBe(64);

    tree!.scrollTop = 121;
    rerender(<WorkspaceExplorer {...props} fileTree={buildFileTree([])} />);
    expect(tree!.scrollTop).toBe(121);

    const heading = container.querySelector<HTMLButtonElement>(".bundle-explorer-heading");
    expect(heading).not.toBeNull();
    fireEvent.click(heading!);
    expect(container.querySelector(".tree-scroll")).toBeNull();
    fireEvent.click(heading!);
    const remountedTree = container.querySelector<HTMLDivElement>(".tree-scroll");
    expect(remountedTree?.scrollTop).toBe(64);

    rerender(<WorkspaceExplorer {...props} filesLoading />);
    const loadingTree = container.querySelector<HTMLDivElement>(".tree-scroll");
    expect(loadingTree).not.toBeNull();
    loadingTree!.scrollTop = 83;
    rerender(<WorkspaceExplorer {...props} filesLoading={false} />);
    expect(container.querySelector<HTMLDivElement>(".tree-scroll")?.scrollTop).toBe(64);
  });

  it("reveals the active file on activation, then leaves manual browsing alone until the next activation", async () => {
    const file: BundleFile = {
      id: "/projects/active.md",
      name: "active.md",
      title: "Active note",
      createdAt: "2026-01-01",
      directory: "/projects",
      type: "Note",
      deletable: true,
      movable: true,
      filedBy: null,
      filedAt: null,
    };
    const otherFile: BundleFile = {
      ...file,
      id: "/archive/other.md",
      name: "other.md",
      title: "Other note",
      directory: "/archive",
    };
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    function Harness({ revealRequest, activeId = file.id }: { revealRequest: number; activeId?: string }) {
      const [expanded, setExpanded] = useState(new Set<string>());
      const activeFile = [file, otherFile].find((candidate) => candidate.id === activeId);
      return (
        <WorkspaceExplorer
          {...explorerProps({
            fileTree: buildFileTree([file, otherFile]),
            expandedDirectories: expanded,
            setExpandedDirectories: setExpanded,
            activeFileId: activeId,
            activeFileDirectory: activeFile?.directory ?? null,
            activeFileRevealRequest: revealRequest,
          })}
        />
      );
    }

    const { container, rerender } = render(<Harness revealRequest={1} />);
    const row = await screen.findByRole("button", { name: "Active note" });
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
    expect(row).toHaveClass("active");
    expect(row).toHaveAttribute("aria-current", "true");
    const projectsButton = () => screen.getByText("projects").closest("button")!;
    expect(projectsButton()).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(projectsButton());
    expect(screen.queryByRole("button", { name: "Active note" })).not.toBeInTheDocument();
    const tree = container.querySelector<HTMLDivElement>(".tree-scroll")!;
    tree.scrollTop = 37;
    rerender(<Harness revealRequest={1} />);
    expect(tree.scrollTop).toBe(37);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(projectsButton()).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(container.querySelector<HTMLButtonElement>(".bundle-explorer-heading")!);
    expect(container.querySelector(".tree-scroll")).toBeNull();
    rerender(<Harness revealRequest={1} />);
    expect(container.querySelector(".tree-scroll")).toBeNull();

    rerender(<Harness revealRequest={2} />);
    expect(await screen.findByRole("button", { name: "Active note" })).toHaveClass("active");
    expect(container.querySelector(".tree-scroll")).not.toBeNull();
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(2));

    rerender(<Harness revealRequest={3} activeId={otherFile.id} />);
    expect(await screen.findByRole("button", { name: "Other note" })).toHaveClass("active");
    expect(screen.getByRole("button", { name: "Active note" })).not.toHaveClass("active");
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(3));
    const activeTree = container.querySelector<HTMLDivElement>(".tree-scroll")!;
    activeTree.scrollTop = 91;
    rerender(<Harness revealRequest={3} activeId={otherFile.id} />);
    expect(activeTree.scrollTop).toBe(91);
    expect(scrollIntoView).toHaveBeenCalledTimes(3);
  });
});
