import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { Bundle } from "../../src/domain/types.ts";
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
});
