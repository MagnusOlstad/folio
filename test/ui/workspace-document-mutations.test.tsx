import { renderHook, waitFor } from "@testing-library/react";
import { act, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockApi } = vi.hoisted(() => ({
  mockApi: vi.fn(),
}));

vi.mock("../../src/lib/api.ts", () => ({ api: mockApi }));

import type { BundleFile, Note, NoteDetail, NoteUpdateResult, TabGroup, ViewerDocument } from "../../src/domain/types.ts";
import { useWorkspaceDocumentMutations } from "../../src/features/workspace/hooks/useWorkspaceDocumentMutations.ts";
import { useWorkspaceDocumentState } from "../../src/features/workspace/hooks/useWorkspaceDocumentState.ts";

function noteDetail(content: string, type = "Todo List"): NoteDetail {
  return {
    id: "/todo-list.md",
    rawId: null,
    title: type === "Daily Note" ? "Daily 2026-10-01" : "Todo List",
    type,
    description: "",
    tags: [],
    relatedIds: [],
    createdAt: "2026-10-01T10:00:00.000Z",
    classifiedByModel: false,
    status: "stable",
    staleAfter: null,
    stale: false,
    filedBy: null,
    filedAt: null,
    content,
    movable: true,
    links: [],
    backlinks: [],
    suggestions: [],
  };
}

function viewerDocument(content: string, type = "Todo List"): ViewerDocument {
  return { ...noteDetail(content, type), deletable: true, updatedAt: "2026-10-01T10:00:00.000Z" };
}

function noteSummary(id: string): Note {
  return {
    ...noteDetail(""),
    id,
  };
}

describe("workspace document mutations", () => {
  beforeEach(() => mockApi.mockReset());

  it("does not let a stale Todo PATCH response roll back two newer capture observations", async () => {
    let resolveOldPatch: ((value: NoteUpdateResult) => void) | undefined;
    const oldPatch = new Promise<NoteUpdateResult>((resolve) => { resolveOldPatch = resolve; });
    let resolveAcknowledgedPatch: ((value: NoteUpdateResult) => void) | undefined;
    const acknowledgedPatch = new Promise<NoteUpdateResult>((resolve) => { resolveAcknowledgedPatch = resolve; });
    const patchResponses = [oldPatch, acknowledgedPatch];
    const base = "# Todo\n- [ ] A";
    const firstCanonical = `${base}\n\n## 2026-10-01 10:30\n\n- [ ] B`;
    const secondCanonical = `${firstCanonical}\n\n## 2026-10-01 10:30\n\n- [ ] C`;
    const thirdCanonical = `${secondCanonical}\n\n## 2026-10-01 10:30\n\n- [ ] D`;
    let noteResponse = noteSummary("/todo-list.md");
    let detailResponse = noteDetail(firstCanonical);
    mockApi.mockImplementation((path?: string, options?: RequestInit) => {
      if (path === undefined) return Promise.resolve([]);
      if (path === "/api/note?id=%2Ftodo-list.md" && options?.method === "PATCH") {
        return patchResponses.length
          ? patchResponses.shift()
          : Promise.resolve({
            ...noteDetail(JSON.parse(String(options.body)).content),
            oldId: "/todo-list.md",
            newId: "/todo-list.md",
            warning: null,
          });
      }
      if (path === "/api/notes") return Promise.resolve({
        note: noteResponse,
        notes: [noteResponse],
        warning: null,
        appended: true,
        filing: null,
      });
      if (path === "/api/note?id=%2Ftodo-list.md") return Promise.resolve(detailResponse);
      if (path === "/api/files") return Promise.resolve([]);
      throw new Error(`Unexpected API request: ${String(path)}`);
    });

    const { result } = renderHook(() => {
      const documents = useWorkspaceDocumentState({
        expandedDirectories: new Set(),
        expandedDirectoriesReady: false,
        persistenceEnabled: false,
      });
      const [, setGroups] = useState<TabGroup[]>([]);
      const [, setNotes] = useState<Note[]>([]);
      const [, setFiles] = useState<BundleFile[]>([]);
      const mutations = useWorkspaceDocumentMutations({
        documents,
        setGroups,
        setNotes,
        setFiles,
        setMessage: vi.fn(),
        clearDiscovery: vi.fn(),
        replaceDiscoveryDocument: vi.fn(),
        observeAggregateContent: vi.fn(),
      });
      return { documents, mutations };
    });

    await act(async () => {
      result.current.documents.setDocuments({ "/todo-list.md": viewerDocument(base) });
      result.current.documents.changeDraftContent(viewerDocument(base), base);
    });

    act(() => {
      result.current.documents.changeDraftContent(
        viewerDocument(base),
        "# Todo\n- [x] A saved by the old request",
      );
      void result.current.mutations.persistDocument(
        viewerDocument(base),
        "# Todo\n- [x] A saved by the old request",
        [],
        true,
        false,
        base,
      );
    });
    await waitFor(() => expect(mockApi).toHaveBeenCalledWith(
      "/api/note?id=%2Ftodo-list.md",
      expect.objectContaining({ method: "PATCH" }),
    ));

    const firstDraft = viewerDocument("Todo\nB");
    firstDraft.id = "untitled://first";
    const secondDraft = viewerDocument("Todo\nC");
    secondDraft.id = "untitled://second";
    act(() => result.current.mutations.fileDraft(firstDraft));
    await waitFor(() => expect(result.current.documents.documents["/todo-list.md"]?.content).toBe(firstCanonical));

    noteResponse = noteSummary("/todo-list.md");
    detailResponse = noteDetail(secondCanonical);
    act(() => result.current.mutations.fileDraft(secondDraft));
    await waitFor(() => expect(result.current.documents.documents["/todo-list.md"]?.content).toBe(secondCanonical));

    await act(async () => {
      resolveOldPatch?.({
        ...noteDetail("# Todo\n- [x] A saved by the old request"),
        oldId: "/todo-list.md",
        newId: "/todo-list.md",
        warning: null,
      });
    });

    expect(result.current.documents.documents["/todo-list.md"]?.content).toBe(secondCanonical);
    const editedTodo = "# Todo\n- [x] A saved by the old request\n\n## 2026-10-01 10:30\n\n- [ ] B\n\n## 2026-10-01 10:30\n\n- [ ] C";
    expect(result.current.documents.drafts["/todo-list.md"]).toBe(editedTodo);

    const currentTodo = result.current.documents.documents["/todo-list.md"]!;
    act(() => {
      void result.current.mutations.persistDocument(
        currentTodo,
        editedTodo,
        [],
        true,
        false,
        secondCanonical,
      );
    });
    await waitFor(() => expect(mockApi.mock.calls.filter(([path, options]) => path === "/api/note?id=%2Ftodo-list.md" && options?.method === "PATCH")).toHaveLength(2));

    noteResponse = noteSummary("/todo-list.md");
    detailResponse = noteDetail(thirdCanonical);
    const thirdDraft = viewerDocument("Todo\nD");
    thirdDraft.id = "untitled://third";
    act(() => result.current.mutations.fileDraft(thirdDraft));
    await waitFor(() => expect(result.current.documents.documents["/todo-list.md"]?.content).toBe(thirdCanonical));

    const acknowledgedContent = `${editedTodo}\n\n## 2026-10-01 10:30\n\n- [ ] D`;
    await act(async () => {
      resolveAcknowledgedPatch?.({
        ...noteDetail(acknowledgedContent),
        oldId: "/todo-list.md",
        newId: "/todo-list.md",
        warning: null,
      });
    });
    await waitFor(() => expect(result.current.documents.documents["/todo-list.md"]?.content).toBe(acknowledgedContent));

    const nextEdit = `${acknowledgedContent}\n- [ ] E`;
    const latestTodo = result.current.documents.documents["/todo-list.md"]!;
    act(() => {
      void result.current.mutations.persistDocument(
        latestTodo,
        nextEdit,
        [],
        true,
        false,
        acknowledgedContent,
      );
    });
    await waitFor(() => expect(mockApi.mock.calls.filter(([path, options]) => path === "/api/note?id=%2Ftodo-list.md" && options?.method === "PATCH")).toHaveLength(3));
    const finalPatch = [...mockApi.mock.calls].reverse().find(([path, options]) => path === "/api/note?id=%2Ftodo-list.md" && options?.method === "PATCH");
    expect(JSON.parse(String(finalPatch?.[1]?.body)).baseContent).toBe(acknowledgedContent);
  });

  it("ignores an out-of-order older Daily Note capture refresh and keeps the latest save base", async () => {
    let resolveOlderDetail: ((value: NoteDetail) => void) | undefined;
    const olderDetail = new Promise<NoteDetail>((resolve) => { resolveOlderDetail = resolve; });
    const type = "Daily Note";
    const base = "# Daily 2026-10-01\nMorning entry.";
    const firstCanonical = `${base}\n\n## 10:30\n\nAfternoon entry.`;
    const latestCanonical = `${firstCanonical}\n\n## 10:31\n\nEvening entry.`;
    let detailCalls = 0;
    mockApi.mockImplementation((path?: string, options?: RequestInit) => {
      if (path === undefined) return Promise.resolve([]);
      if (path === "/api/notes" && options?.method === "POST") {
        return Promise.resolve({ note: noteSummary("/todo-list.md"), notes: [], warning: null, appended: true, filing: null });
      }
      if (path === "/api/note?id=%2Ftodo-list.md" && options?.method === "PATCH") {
        const content = JSON.parse(String(options.body)).content as string;
        return Promise.resolve({ ...noteDetail(content, type), oldId: "/todo-list.md", newId: "/todo-list.md", warning: null });
      }
      if (path === "/api/note?id=%2Ftodo-list.md") {
        detailCalls += 1;
        return detailCalls === 1 ? olderDetail : Promise.resolve(noteDetail(latestCanonical, type));
      }
      if (path === "/api/files") return Promise.resolve([]);
      throw new Error(`Unexpected API request: ${String(path)}`);
    });

    const { result } = renderHook(() => {
      const documents = useWorkspaceDocumentState({
        expandedDirectories: new Set(),
        expandedDirectoriesReady: false,
        persistenceEnabled: false,
      });
      const [, setGroups] = useState<TabGroup[]>([]);
      const [, setNotes] = useState<Note[]>([]);
      const [, setFiles] = useState<BundleFile[]>([]);
      const mutations = useWorkspaceDocumentMutations({
        documents,
        setGroups,
        setNotes,
        setFiles,
        setMessage: vi.fn(),
        clearDiscovery: vi.fn(),
        replaceDiscoveryDocument: vi.fn(),
        observeAggregateContent: vi.fn(),
      });
      return { documents, mutations };
    });

    await act(async () => {
      result.current.documents.setDocuments({ "/todo-list.md": viewerDocument(base, type) });
      result.current.documents.changeDraftContent(viewerDocument(base, type), base);
    });
    const firstDraft = viewerDocument("Daily\nAfternoon entry.", type);
    firstDraft.id = "untitled://older-capture";
    const secondDraft = viewerDocument("Daily\nEvening entry.", type);
    secondDraft.id = "untitled://newer-capture";

    act(() => result.current.mutations.fileDraft(firstDraft));
    await waitFor(() => expect(detailCalls).toBe(1));
    act(() => result.current.mutations.fileDraft(secondDraft));
    await waitFor(() => expect(result.current.documents.documents["/todo-list.md"]?.content).toBe(latestCanonical));

    await act(async () => resolveOlderDetail?.(noteDetail(firstCanonical, type)));
    await waitFor(() => expect(result.current.documents.documents["/todo-list.md"]?.content).toBe(latestCanonical));
    await waitFor(() => {
      expect(result.current.documents.filingQueues[firstDraft.id]).toBeUndefined();
      expect(result.current.documents.filingQueues[secondDraft.id]).toBeUndefined();
    });
    expect(result.current.documents.filingDraftIds.current.has(firstDraft.id)).toBe(true);
    expect(result.current.documents.filingDraftIds.current.has(secondDraft.id)).toBe(true);
    expect(result.current.documents.drafts["/todo-list.md"]).toBe(latestCanonical);

    const nextContent = `${latestCanonical}\n- [ ] D`;
    await act(async () => {
      await result.current.mutations.persistDocument(
        result.current.documents.documents["/todo-list.md"]!,
        nextContent,
        [],
        true,
        false,
        latestCanonical,
      );
    });
    const latestPatch = [...mockApi.mock.calls].reverse().find(([path, options]) => path === "/api/note?id=%2Ftodo-list.md" && options?.method === "PATCH");
    expect(JSON.parse(String(latestPatch?.[1]?.body))).toMatchObject({ content: nextContent, baseContent: latestCanonical });
  });
});
