import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MLX_GENERATION_MODEL } from "../../src/domain/types.ts";
import type { Note, SearchResult } from "../../src/domain/types.ts";
import { WorkspaceSidebar } from "../../src/features/sidebar/WorkspaceSidebar.tsx";
import type { WorkspaceSidebarProps } from "../../src/features/sidebar/WorkspaceSidebar.tsx";
import { buildFileTree } from "../../src/lib/tree.ts";
import type { ExplorerFileActions } from "../../src/features/workspace/model/explorer.ts";

const note: Note = {
  id: "/notes/preview.md",
  rawId: null,
  title: "Preview note",
  type: "Note",
  description: "",
  tags: [],
  relatedIds: [],
  createdAt: "2026-09-11T12:00:00.000Z",
  classifiedByModel: false,
  status: "stable",
  staleAfter: null,
  stale: false,
  filedBy: null,
  filedAt: null,
};

function sidebarProps(
  openDocument: WorkspaceSidebarProps["openDocument"],
): WorkspaceSidebarProps {
  const searchResult: SearchResult = { ...note, snippet: "Match", score: 1 };
  return {
    sidebarMode: "search",
    setSidebarMode: vi.fn(),
    reindexing: false,
    reindexBundle: vi.fn().mockResolvedValue(undefined),
    filesLoading: false,
    localDraftDocuments: [],
    drafts: {},
    draftTitle: () => "Draft",
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
    openDocument,
    setDraggedFileId: vi.fn(),
    setDropDirectoryPath: vi.fn(),
    moveBundleFile: vi.fn().mockResolvedValue(undefined),
    notes: [note],
    searchInputRef: { current: null },
    searchQuery: "preview",
    setSearchQuery: vi.fn(),
    selectedTag: "",
    searching: false,
    searchNotes: vi.fn().mockResolvedValue(undefined),
    availableTags: [],
    setSelectedTag: vi.fn(),
    setSearchResults: vi.fn(),
    searchTag: vi.fn(),
    searchResults: [searchResult],
    selectedAnswerModel: MLX_GENERATION_MODEL.id,
    asking: false,
    question: "",
    setQuestion: vi.fn(),
    selectedAnswerModelMissing: false,
    askNotes: vi.fn().mockResolvedValue(undefined),
    answer: {
      answer: "[Citation](/notes/preview.md)",
      sources: [note],
      model: "model",
      retrieval: "semantic",
    },
    conceptUrl: (id) => id,
    formatDate: () => "today",
    bundles: [],
    activeBundleId: null,
    selectBundle: vi.fn(),
    openSettings: vi.fn(),
  };
}

describe("WorkspaceSidebar preview navigation", () => {
  it("submits a note search when Enter is pressed in the search field", () => {
    const props = sidebarProps(vi.fn());
    render(<WorkspaceSidebar {...props} />);

    fireEvent.keyDown(screen.getByRole("textbox", { name: "Search your notes" }), { key: "Enter" });

    expect(props.searchNotes).toHaveBeenCalledOnce();
  });

  it("shows the indexed last-edited date after a search result title", () => {
    const props = sidebarProps(vi.fn().mockResolvedValue(undefined));
    props.searchResults = [{
      ...note,
      updatedAt: "2026-09-12T08:30:00.000Z",
      snippet: "Match",
      score: 1,
    }];
    props.formatDate = (value) => value.slice(0, 10);
    const { container } = render(<WorkspaceSidebar {...props} />);

    const title = container.querySelector(".sidebar-result strong")!;
    expect(within(title).getByText("Preview note")).toBeInTheDocument();
    expect(within(title).getByText("2026-09-12")).toHaveAttribute(
      "dateTime",
      "2026-09-12T08:30:00.000Z",
    );
  });

  it("omits a missing or invalid search result date", () => {
    const props = sidebarProps(vi.fn().mockResolvedValue(undefined));
    props.searchResults = [
      { ...note, updatedAt: "not-a-date", snippet: "Invalid date", score: 1 },
      { ...note, id: "/notes/missing.md", title: "Missing date", snippet: "No date", score: 1 },
    ];
    const { container } = render(<WorkspaceSidebar {...props} />);

    expect(container.querySelectorAll(".sidebar-result time")).toHaveLength(0);
  });

  it("previews single-clicked Search and Recent notes and pins double-clicks", () => {
    const openDocument = vi.fn().mockResolvedValue(undefined);
    const props = sidebarProps(openDocument);
    const { container } = render(<WorkspaceSidebar {...props} />);

    const result = container.querySelector<HTMLButtonElement>(".sidebar-result")!;
    fireEvent.click(result);
    expect(openDocument).toHaveBeenLastCalledWith(
      note.id,
      "note",
      undefined,
      "preview",
    );
    fireEvent.doubleClick(result);
    expect(openDocument).toHaveBeenLastCalledWith(
      note.id,
      "note",
      undefined,
      "permanent",
    );

    fireEvent.click(container.querySelector<HTMLButtonElement>(".recent-row")!);
    expect(openDocument).toHaveBeenLastCalledWith(
      note.id,
      "note",
      undefined,
      "preview",
    );
  });

  it("uses preview and permanent dispositions for Ask links and sources", () => {
    const openDocument = vi.fn().mockResolvedValue(undefined);
    const props = { ...sidebarProps(openDocument), sidebarMode: "ask" as const };
    const { container, getByRole } = render(<WorkspaceSidebar {...props} />);

    const citation = getByRole("link", { name: "Citation" });
    fireEvent.click(citation);
    expect(openDocument).toHaveBeenLastCalledWith(
      note.id,
      "note",
      undefined,
      "preview",
    );
    fireEvent.doubleClick(citation);
    expect(openDocument).toHaveBeenLastCalledWith(
      note.id,
      "note",
      undefined,
      "permanent",
    );

    fireEvent.click(
      container.querySelector<HTMLButtonElement>(".answer-sources button")!,
    );
    expect(openDocument).toHaveBeenLastCalledWith(
      note.id,
      "note",
      undefined,
      "preview",
    );
  });

  it("collapses the active bundle without changing which bundle is active", () => {
    const selectBundle = vi.fn();
    const props = {
      ...sidebarProps(vi.fn().mockResolvedValue(undefined)),
      sidebarMode: "explore" as const,
      bundles: [
        {
          id: "work",
          name: "Work",
          markdownPath: "/notes/work",
          managed: false,
          detached: false,
        },
        {
          id: "personal",
          name: "Personal",
          markdownPath: "/notes/personal",
          managed: false,
          detached: false,
        },
      ],
      activeBundleId: "work",
      selectBundle,
    };
    const { container, getByRole } = render(<WorkspaceSidebar {...props} />);
    const workHeading = getByRole("button", { name: /Work/ });
    expect(workHeading).toHaveAttribute("aria-expanded", "true");
    expect(container.querySelector("#bundle-tree-work")).toBeInTheDocument();
    expect(container.querySelector("#bundle-tree-personal")).not.toBeInTheDocument();

    fireEvent.click(workHeading);
    expect(workHeading).toHaveAttribute("aria-expanded", "false");
    expect(container.querySelector("#bundle-tree-work")).not.toBeInTheDocument();
    expect(selectBundle).not.toHaveBeenCalled();

    fireEvent.click(workHeading);
    expect(workHeading).toHaveAttribute("aria-expanded", "true");
    expect(container.querySelector("#bundle-tree-work")).toBeInTheDocument();
  });

  it("activates and expands an inactive bundle in one click", () => {
    const selectBundle = vi.fn();
    const props = {
      ...sidebarProps(vi.fn().mockResolvedValue(undefined)),
      sidebarMode: "explore" as const,
      bundles: [
        {
          id: "work",
          name: "Work",
          markdownPath: "/notes/work",
          managed: false,
          detached: false,
        },
        {
          id: "personal",
          name: "Personal",
          markdownPath: "/notes/personal",
          managed: false,
          detached: false,
        },
      ],
      activeBundleId: "work",
      selectBundle,
    };
    const { container, getByRole, rerender } = render(
      <WorkspaceSidebar {...props} />,
    );

    fireEvent.click(getByRole("button", { name: /Personal/ }));
    expect(selectBundle).toHaveBeenCalledWith("personal");

    rerender(
      <WorkspaceSidebar {...props} activeBundleId="personal" />,
    );
    const personalHeading = getByRole("button", { name: /Personal/ });
    expect(personalHeading).toHaveAttribute("aria-expanded", "true");
    expect(container.querySelector("#bundle-tree-personal")).toBeInTheDocument();
    expect(container.querySelector("#bundle-tree-work")).not.toBeInTheDocument();
  });

  it("shows bundle root files and folders directly under the bundle heading", () => {
    const moveBundleFile = vi.fn().mockResolvedValue(undefined);
    const props = {
      ...sidebarProps(vi.fn().mockResolvedValue(undefined)),
      sidebarMode: "explore" as const,
      moveBundleFile,
      fileTree: buildFileTree([
        {
          id: "/root-note.md",
          name: "root-note.md",
          title: "Root note",
          createdAt: "2026-09-28T12:00:00.000Z",
          directory: "/",
          type: "Note",
          deletable: true,
          movable: true,
          filedBy: null,
          filedAt: null,
        },
        {
          id: "/projects/plan.md",
          name: "plan.md",
          title: "Plan",
          createdAt: "2026-09-28T12:00:00.000Z",
          directory: "/projects",
          type: "Note",
          deletable: true,
          movable: true,
          filedBy: null,
          filedAt: null,
        },
      ]),
      bundles: [
        {
          id: "work",
          name: "Work",
          markdownPath: "/notes/work",
          managed: false,
          detached: false,
        },
      ],
      activeBundleId: "work",
    };
    const { container, getByRole } = render(<WorkspaceSidebar {...props} />);

    const bundleHeading = getByRole("button", { name: /Work/ });
    const bundleContent = container.querySelector("#bundle-tree-work")!;
    const projectDirectory = bundleContent.querySelector("button.tree-directory");
    expect(bundleHeading).toHaveAttribute("aria-expanded", "true");
    expect(bundleContent).toContainElement(getByRole("button", { name: "Root note" }));
    expect(bundleContent.querySelectorAll("button.tree-directory")).toHaveLength(1);
    expect(projectDirectory).toHaveTextContent("projects");
    expect(projectDirectory).not.toHaveTextContent("Bundle");

    fireEvent.drop(bundleContent.querySelector(".tree-branch")!, {
      dataTransfer: { getData: () => "/root-note.md" },
    });
    expect(moveBundleFile).toHaveBeenCalledWith("/root-note.md", "/");
  });

  it("opens an accessible file context menu with create and relative path actions", async () => {
    const actions: ExplorerFileActions = {
      renameFile: vi.fn().mockResolvedValue(undefined),
      createFile: vi.fn().mockResolvedValue(undefined),
      createDirectory: vi.fn().mockResolvedValue(undefined),
      deleteFile: vi.fn().mockResolvedValue(undefined),
      exportFile: vi.fn().mockResolvedValue(undefined),
      copyText: vi.fn().mockResolvedValue(undefined),
    };
    const props = {
      ...sidebarProps(vi.fn().mockResolvedValue(undefined)),
      sidebarMode: "explore" as const,
      fileTree: buildFileTree([
        {
          id: "/projects/plan.md",
          name: "plan.md",
          title: "Plan",
          createdAt: "2026-09-28T12:00:00.000Z",
          directory: "/projects",
          type: "Note",
          deletable: true,
          movable: true,
          filedBy: null,
          filedAt: null,
        },
      ]),
      bundles: [{ id: "work", name: "Work", markdownPath: "/notes/work", managed: false, detached: false }],
      activeBundleId: "work",
      expandedDirectories: new Set(["/", "/projects"]),
      actions,
      setMessage: vi.fn(),
    };
    const { getByRole } = render(<WorkspaceSidebar {...props} />);

    fireEvent.contextMenu(getByRole("button", { name: "Plan" }), { clientX: 30, clientY: 40 });
    const menu = getByRole("menu", { name: "plan.md actions" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Copy relative path" }));
    expect(actions.copyText).toHaveBeenCalledWith("projects/plan.md");
  });

  it("opens a path-directed draft from the selected file's containing folder", () => {
    const actions: ExplorerFileActions = {
      renameFile: vi.fn().mockResolvedValue(undefined),
      createFile: vi.fn().mockResolvedValue(undefined),
      createDirectory: vi.fn().mockResolvedValue(undefined),
      deleteFile: vi.fn().mockResolvedValue(undefined),
      exportFile: vi.fn().mockResolvedValue(undefined),
      copyText: vi.fn().mockResolvedValue(undefined),
    };
    const props = {
      ...sidebarProps(vi.fn().mockResolvedValue(undefined)),
      sidebarMode: "explore" as const,
      fileTree: buildFileTree([{
        id: "/projects/plan.md", name: "plan.md", title: "Plan", createdAt: "2026-09-28T12:00:00.000Z",
        directory: "/projects", type: "Note", deletable: true, movable: true, filedBy: null, filedAt: null,
      }]),
      bundles: [{ id: "work", name: "Work", markdownPath: "/notes/work", managed: false, detached: false }],
      activeBundleId: "work",
      expandedDirectories: new Set(["/", "/projects"]),
      actions,
      setMessage: vi.fn(),
    };
    const { getByRole, queryByRole } = render(<WorkspaceSidebar {...props} />);

    fireEvent.contextMenu(getByRole("button", { name: "Plan" }), { clientX: 30, clientY: 40 });
    fireEvent.click(getByRole("menuitem", { name: "New note" }));
    expect(actions.createFile).toHaveBeenCalledWith("/projects");
    expect(queryByRole("textbox", { name: "New note" })).toBeNull();
  });

  it("requires confirmation before deleting a file from its context menu", () => {
    const actions: ExplorerFileActions = {
      renameFile: vi.fn().mockResolvedValue(undefined),
      createFile: vi.fn().mockResolvedValue(undefined),
      createDirectory: vi.fn().mockResolvedValue(undefined),
      deleteFile: vi.fn().mockResolvedValue(undefined),
      exportFile: vi.fn().mockResolvedValue(undefined),
      copyText: vi.fn().mockResolvedValue(undefined),
    };
    const props = {
      ...sidebarProps(vi.fn().mockResolvedValue(undefined)),
      sidebarMode: "explore" as const,
      fileTree: buildFileTree([{
        id: "/projects/plan.md", name: "plan.md", title: "Plan", createdAt: "2026-09-28T12:00:00.000Z",
        directory: "/projects", type: "Note", deletable: true, movable: true, filedBy: null, filedAt: null,
      }]),
      bundles: [{ id: "work", name: "Work", markdownPath: "/notes/work", managed: false, detached: false }],
      activeBundleId: "work",
      expandedDirectories: new Set(["/", "/projects"]),
      actions,
      setMessage: vi.fn(),
    };
    const { getByRole } = render(<WorkspaceSidebar {...props} />);

    fireEvent.contextMenu(getByRole("button", { name: "Plan" }), { clientX: 30, clientY: 40 });
    fireEvent.click(getByRole("menuitem", { name: "Delete" }));
    const dialog = getByRole("dialog", { name: "Confirm delete" });
    expect(dialog).toHaveTextContent("Delete plan.md?");
    expect(actions.deleteFile).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(actions.deleteFile).toHaveBeenCalledWith(expect.objectContaining({ id: "/projects/plan.md" }));
  });

  it.each([
    { movable: false, blockedFileIds: new Set<string>() },
    { movable: true, blockedFileIds: new Set(["/projects/plan.md"]) },
  ])("disables Delete for fixed or busy files", ({ movable, blockedFileIds }) => {
    const actions: ExplorerFileActions = {
      renameFile: vi.fn().mockResolvedValue(undefined),
      createFile: vi.fn().mockResolvedValue(undefined),
      createDirectory: vi.fn().mockResolvedValue(undefined),
      deleteFile: vi.fn().mockResolvedValue(undefined),
      exportFile: vi.fn().mockResolvedValue(undefined),
      copyText: vi.fn().mockResolvedValue(undefined),
    };
    const props = {
      ...sidebarProps(vi.fn().mockResolvedValue(undefined)),
      sidebarMode: "explore" as const,
      fileTree: buildFileTree([{
        id: "/projects/plan.md", name: "plan.md", title: "Plan", createdAt: "2026-09-28T12:00:00.000Z",
        directory: "/projects", type: "Note", deletable: true, movable, filedBy: null, filedAt: null,
      }]),
      bundles: [{ id: "work", name: "Work", markdownPath: "/notes/work", managed: false, detached: false }],
      activeBundleId: "work",
      expandedDirectories: new Set(["/", "/projects"]),
      blockedFileIds,
      actions,
      setMessage: vi.fn(),
    };
    const { getByRole } = render(<WorkspaceSidebar {...props} />);

    fireEvent.contextMenu(getByRole("button", { name: "Plan" }), { clientX: 30, clientY: 40 });
    expect(getByRole("menuitem", { name: "Delete" })).toBeDisabled();
  });

  it("does not show active-bundle actions from an inactive bundle heading", () => {
    const actions: ExplorerFileActions = {
      renameFile: vi.fn().mockResolvedValue(undefined),
      createFile: vi.fn().mockResolvedValue(undefined),
      createDirectory: vi.fn().mockResolvedValue(undefined),
      deleteFile: vi.fn().mockResolvedValue(undefined),
      exportFile: vi.fn().mockResolvedValue(undefined),
      copyText: vi.fn().mockResolvedValue(undefined),
    };
    const props = {
      ...sidebarProps(vi.fn().mockResolvedValue(undefined)),
      sidebarMode: "explore" as const,
      bundles: [
        { id: "work", name: "Work", markdownPath: "/notes/work", managed: false, detached: false },
        { id: "personal", name: "Personal", markdownPath: "/notes/personal", managed: false, detached: false },
      ],
      activeBundleId: "work",
      actions,
      setMessage: vi.fn(),
    };
    const { getByRole, queryByRole } = render(<WorkspaceSidebar {...props} />);

    fireEvent.contextMenu(getByRole("button", { name: /Personal/ }), { clientX: 30, clientY: 40 });
    expect(queryByRole("menu")).not.toBeInTheDocument();
  });
});
