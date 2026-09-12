import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { Note, SearchResult } from "../../src/domain/types.ts";
import { WorkspaceSidebar } from "../../src/features/sidebar/WorkspaceSidebar.tsx";
import type { WorkspaceSidebarProps } from "../../src/features/sidebar/WorkspaceSidebar.tsx";
import { buildFileTree } from "../../src/lib/tree.ts";
import type { TranscriptionDockProps } from "../../src/features/transcription/components/TranscriptionDock.tsx";

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
    status: null,
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
    selectedAnswerModel: "model",
    setAskModel: vi.fn(),
    setAnswer: vi.fn(),
    asking: false,
    configuredAnswerModels: ["model"],
    hasInstalledModel: () => true,
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
  };
}

function transcriptionProps(): TranscriptionDockProps {
  return {
    model: {
      phase: "idle",
      elapsedMs: 0,
      activeSession: null,
      pending: [],
      systemAudio: false,
      fallbackMessage: "",
      bridgeAvailable: false,
      status: null,
      error: "",
    },
    actions: {
      start: vi.fn(),
      stop: vi.fn(),
      transcribe: vi.fn(),
      transcribePending: vi.fn(),
      later: vi.fn(),
      retry: vi.fn(),
      revealModelFolder: vi.fn(),
    },
  };
}

describe("WorkspaceSidebar preview navigation", () => {
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

  it("opens the transcription controls from the compact sidebar tab", () => {
    const props = {
      ...sidebarProps(vi.fn().mockResolvedValue(undefined)),
      sidebarMode: "transcription" as const,
      transcriptions: transcriptionProps(),
    };
    const { getByRole, getByText } = render(<WorkspaceSidebar {...props} />);
    expect(getByText("Transcriptions")).toBeInTheDocument();
    expect(getByRole("button", { name: "Transcription" })).toHaveTextContent("Record");
    expect(getByRole("button", { name: "Record" })).toBeDisabled();
  });
});
