import { act, useState } from "react";
import { fireEvent, render, renderHook, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AskResult, BundleDirectory, BundleFile, Note, TabGroup, ViewerDocument } from "../../src/domain/types.ts";
import { useWorkspaceDocumentState } from "../../src/features/workspace/hooks/useWorkspaceDocumentState.ts";
import { useWorkspaceDocumentNavigation } from "../../src/features/workspace/hooks/useWorkspaceDocumentNavigation.ts";
import { useWorkspaceDiscovery } from "../../src/features/workspace/hooks/useWorkspaceDiscovery.ts";
import { useWorkspaceExplorerActions } from "../../src/features/workspace/hooks/useWorkspaceExplorerActions.ts";
import { useWorkspaceBundleActions } from "../../src/features/workspace/hooks/useWorkspaceBundleActions.ts";
import { ExplorerContextMenu } from "../../src/features/workspace/components/ExplorerContextMenu.tsx";
import type { ExplorerFileActions } from "../../src/features/workspace/model/explorer.ts";

const { mockApi, mockScopedApi, activeBundle } = vi.hoisted(() => ({ mockApi: vi.fn(), mockScopedApi: vi.fn(), activeBundle: { id: "bundle-a", revision: 0 } }));
vi.mock("../../src/lib/api.ts", () => ({
  api: mockApi,
  apiForBundle: mockScopedApi,
  getActiveBundleId: () => activeBundle.id,
  getActiveBundleRevision: () => activeBundle.revision,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function document(id: string): ViewerDocument {
  return { id, title: id, type: "Note", description: "", content: "# Content", tags: [], createdAt: "2026-01-01", deletable: true, movable: true };
}
function file(id: string): BundleFile {
  return { id, title: id, name: id.split("/").at(-1)!, directory: id.slice(0, id.lastIndexOf("/")), createdAt: "2026-01-01", type: "Note", deletable: true, movable: true, filedBy: null, filedAt: null };
}

function useHarness(isDirty = (_id: string) => false) {
  const documents = useWorkspaceDocumentState({ expandedDirectories: new Set(), expandedDirectoriesReady: false, persistenceEnabled: false });
  const [files, setFiles] = useState([file("/remove/sub/a.md"), file("/remove-old/b.md")]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [directories, setDirectories] = useState<BundleDirectory[]>([{ path: "/remove" }, { path: "/remove/sub" }, { path: "/remove-old" }]);
  const [groups, setGroups] = useState<TabGroup[]>([{ id: "g", tabs: ["/remove/sub/a.md", "/remove-old/b.md"], activeId: "/remove/sub/a.md", previewId: "/remove/sub/a.md" }]);
  const [expanded, setExpandedDirectories] = useState(new Set(["/", "/remove", "/remove/sub", "/remove-old"]));
  const [message, setMessage] = useState("");
  const [movingFileId, setMovingFileId] = useState<string | null>(null);
  const [reindexing, setReindexing] = useState(false);
  const discovery = useWorkspaceDiscovery({ setMessage, setSidebarMode: vi.fn() });
  const closeTab = vi.fn();
  const navigation = useWorkspaceDocumentNavigation({ documents, groups, setGroups, activeGroupId: "g", setActiveGroupId: vi.fn(), closeTab, setNotes, setFiles, setMessage, removeDiscoveryDocument: discovery.removeDocument });
  const actions = useWorkspaceExplorerActions({
    files, groups, editingKey: documents.editingKey, savingDocuments: documents.savingDocuments, loadingDocuments: documents.loadingDocuments, movingFileId,
    setFiles, setDirectories, setNotes, setDocuments: documents.setDocuments, setDrafts: documents.setDrafts, setGroups,
    setExpandedDirectories, setMessage, deleteFiledNote: (file) => navigation.deleteFiledNote(file, true), exportFile: vi.fn(), createNewTab: vi.fn(),
    documentRequests: documents.documentRequests, documentsRef: documents.documentsRef, draftsRef: documents.draftsRef,
    deletingDirectories: documents.deletingDirectories, directoryDeletions: documents.directoryDeletions,
    documentMutationSequence: documents.documentMutationSequence, recordDocumentPathChange: documents.recordDocumentPathChange, recordExplorerMutation: documents.recordExplorerMutation, isDocumentDirty: isDirty,
    removeDiscoveryDirectory: discovery.removeDirectory, setLoadingDocuments: documents.setLoadingDocuments,
    setEditingKey: documents.setEditingKey,
    setMovingFileId,
  });
  const bundleActions = useWorkspaceBundleActions({
    reindexing, groups, files, editingKey: documents.editingKey, movingFileId,
    savingDocuments: documents.savingDocuments, loadingDocuments: documents.loadingDocuments,
    deletingDirectories: documents.deletingDirectories, documentsRef: documents.documentsRef,
    draftsRef: documents.draftsRef, documentRequests: documents.documentRequests,
    documentPathChanges: documents.documentPathChanges, documentMutationSequence: documents.documentMutationSequence,
    recordDocumentPathChange: documents.recordDocumentPathChange,
    isDocumentDirty: isDirty,
  }, {
    setReindexing, setMessage, setNotes, setFiles, setDirectories, setDocuments: documents.setDocuments,
    setGroups, setEditingKey: documents.setEditingKey, clearDiscovery: discovery.clearDiscovery,
    setMovingFileId, setDrafts: documents.setDrafts, setExpandedDirectories,
    setDraggedFileId: vi.fn(), setDropDirectoryPath: vi.fn(), setLoadingDocuments: documents.setLoadingDocuments,
  });
  return { actions, bundleActions, documents, navigation, discovery, files, directories, notes, groups, expanded, message, movingFileId, reindexing, setMovingFileId, setGroups, closeTab };
}

beforeEach(() => {
  mockApi.mockReset(); mockScopedApi.mockReset();
  mockScopedApi.mockImplementation((_bundle: string | null, ...args: unknown[]) => mockApi(...args));
  activeBundle.id = "bundle-a"; activeBundle.revision = 0;
});

describe("file mutation and navigation races", () => {
  it("loads from authoritative refs after switching and deduplicates same-tick requests", async () => {
    const load = deferred<ViewerDocument>();
    mockApi.mockReturnValue(load.promise);
    const { result } = renderHook(() => useHarness());
    act(() => result.current.documents.setDocuments({ "/remove/sub/a.md": document("/remove/sub/a.md") }));
    const oldNavigation = result.current.navigation;
    result.current.documents.documentsRef.current = {};
    let loading!: Promise<void>;
    act(() => {
      loading = oldNavigation.loadDocument("/remove/sub/a.md");
      void oldNavigation.loadDocument("/remove/sub/a.md");
    });
    expect(mockApi).toHaveBeenCalledTimes(1);
    await act(async () => { load.resolve({ ...document("/remove/sub/a.md"), content: "new bundle" }); await loading; });
    expect(result.current.documents.documents["/remove/sub/a.md"].content).toBe("new bundle");
  });

  it("ignores late failures after switching away and back to the same bundle", async () => {
    const load = deferred<ViewerDocument>();
    mockApi.mockReturnValue(load.promise);
    const { result } = renderHook(() => useHarness());
    let opening!: Promise<void>;
    act(() => { opening = result.current.navigation.openDocument("/late.md"); });
    activeBundle.id = "bundle-b"; activeBundle.revision += 1;
    activeBundle.id = "bundle-a"; activeBundle.revision += 1;
    await act(async () => { load.reject(new Error("old bundle failure")); await opening; });
    expect(result.current.closeTab).not.toHaveBeenCalled();
    expect(result.current.message).toBe("");
  });

  it("blocks renaming dirty content even outside editing mode", async () => {
    const { result } = renderHook(() => useHarness(() => true));
    await expect(result.current.actions.renameFile("/remove/sub/a.md", "b.md")).rejects.toThrow("Finish editing");
    expect(mockApi).not.toHaveBeenCalled();
  });

  it("retains the canonical document loaded and edited while an alias request is pending", async () => {
    const alias = deferred<ViewerDocument>();
    mockApi.mockReturnValue(alias.promise);
    const { result } = renderHook(() => useHarness());
    let opening!: Promise<void>;
    act(() => { opening = result.current.navigation.openDocument("/alias.md"); });
    const canonical = { ...document("/current.md"), content: "current saved content" };
    act(() => {
      result.current.documents.setDocuments({ "/current.md": canonical });
      result.current.documents.changeDraftContent(canonical, "current local edit");
      result.current.setGroups([{ id: "g", tabs: ["/alias.md", "/current.md"], activeId: "/alias.md", previewId: "/alias.md" }]);
    });
    await act(async () => { alias.resolve({ ...document("/current.md"), content: "stale alias content" }); await opening; });
    expect(result.current.documents.documents["/current.md"]).toEqual(canonical);
    expect(result.current.documents.drafts["/current.md"]).toBe("current local edit");
    expect(result.current.groups[0]).toMatchObject({ tabs: ["/current.md"], activeId: "/current.md", previewId: null });
  });

  it.each(["/remove/sub/a.md", "/remove/sub/renamed.md"])("preserves local drafts and mutation cache against an alias response resolving to %s", async (aliasId) => {
    const alias = deferred<ViewerDocument>();
    mockApi.mockImplementation((url: string) => {
      if (url.includes("path=%2Falias.md")) return alias.promise;
      if (url === "/api/file/rename") return Promise.resolve({ oldId: "/remove/sub/a.md", newId: "/remove/sub/renamed.md", note: { ...document("/remove/sub/renamed.md"), content: "renamed content" }, warning: null });
      return Promise.reject(new Error("refresh offline"));
    });
    const { result } = renderHook(() => useHarness());
    act(() => {
      result.current.documents.setDocuments({ "/remove/sub/a.md": document("/remove/sub/a.md") });
      result.current.documents.setDrafts({ "/remove/sub/a.md": "local content" });
      result.current.setGroups([{ id: "g", tabs: ["/remove/sub/a.md", "/remove/sub/renamed.md"], activeId: "/remove/sub/a.md", previewId: "/remove/sub/a.md" }]);
    });
    let opening!: Promise<void>;
    act(() => { opening = result.current.navigation.openDocument("/alias.md"); });
    await act(async () => { await result.current.actions.renameFile("/remove/sub/a.md", "renamed.md"); });
    await act(async () => { alias.resolve({ ...document(aliasId), content: "stale content" }); await opening; });
    expect(result.current.documents.documents).toEqual({ "/remove/sub/renamed.md": { ...document("/remove/sub/renamed.md"), content: "renamed content" } });
    expect(result.current.documents.drafts).toEqual({ "/remove/sub/renamed.md": "local content" });
    expect(result.current.groups[0]).toMatchObject({ tabs: ["/remove/sub/renamed.md"], activeId: "/remove/sub/renamed.md", previewId: null });
    expect(result.current.files.map((item) => item.id)).toEqual(["/remove/sub/renamed.md", "/remove-old/b.md"]);
    expect(result.current.documents.loadingDocuments.size).toBe(0);
  });

  it("pins a move to its original bundle and ignores its completion after switching", async () => {
    const moving = deferred<{ oldId: string; newId: string; note: ViewerDocument; warning: null }>();
    mockApi.mockReturnValue(moving.promise);
    const { result } = renderHook(() => useHarness());
    let pending!: Promise<void>;
    act(() => { pending = result.current.bundleActions.moveBundleFile("/remove/sub/a.md", "/destination"); });
    await act(async () => { await result.current.bundleActions.moveBundleFile("/remove/sub/a.md", "/destination"); });
    expect(mockScopedApi).toHaveBeenCalledTimes(1);
    expect(mockScopedApi.mock.calls[0][0]).toBe("bundle-a");
    activeBundle.id = "bundle-b"; activeBundle.revision += 1;
    act(() => result.current.setMovingFileId("/new-bundle.md"));
    await act(async () => { moving.resolve({ oldId: "/remove/sub/a.md", newId: "/destination/a.md", note: document("/destination/a.md"), warning: null }); await pending; });
    expect(mockScopedApi).toHaveBeenCalledTimes(1);
    expect(result.current.documents.documents).toEqual({});
    expect(result.current.movingFileId).toBe("/new-bundle.md");
  });

  it("retains a deletion and new folder created while the move refresh is pending", async () => {
    const oldNotes = deferred<Note[]>();
    const oldFiles = deferred<BundleFile[]>();
    const oldDirectories = deferred<BundleDirectory[]>();
    const newId = "/destination/a.md";
    mockApi.mockImplementation((url: string) => {
      if (url === "/api/file/move") return Promise.resolve({ oldId: "/remove/sub/a.md", newId, note: document(newId), warning: null });
      if (url === "/api/notes") return oldNotes.promise;
      if (url === "/api/files") return oldFiles.promise;
      if (url === "/api/directories") return oldDirectories.promise;
      throw new Error(`Unexpected request ${url}`);
    });
    const { result } = renderHook(() => useHarness());
    let pending!: Promise<void>;
    await act(async () => { pending = result.current.bundleActions.moveBundleFile("/remove/sub/a.md", "/Destination Folder"); });
    expect(result.current.files.map((item) => item.id)).toEqual([newId, "/remove-old/b.md"]);
    expect(result.current.files[0].directory).toBe("/destination");
    expect(result.current.directories).toContainEqual({ path: "/destination" });
    expect(result.current.directories).not.toContainEqual({ path: "/Destination Folder" });
    let deleted = false;
    mockApi.mockImplementation((url: string) => {
      if (url.startsWith("/api/note?id=")) { deleted = true; return Promise.resolve({ deletedId: newId, rawId: null }); }
      if (url === "/api/file/folder") return Promise.resolve({ path: "/fresh-folder" });
      if (url === "/api/notes") return Promise.resolve([]);
      if (url === "/api/files") return Promise.resolve(deleted ? [file("/remove-old/b.md")] : [file(newId), file("/remove-old/b.md")]);
      if (url === "/api/directories") return Promise.resolve([{ path: "/destination" }, { path: "/fresh-folder" }]);
      throw new Error(`Unexpected request ${url}`);
    });
    await act(async () => { await result.current.actions.createDirectory("/", "fresh-folder"); });
    await act(async () => { await result.current.actions.deleteFile(file(newId)); });
    await act(async () => {
      oldNotes.resolve([{ ...document(newId), rawId: null, relatedIds: [], classifiedByModel: false }]);
      oldFiles.resolve([file(newId), file("/remove-old/b.md")]);
      oldDirectories.resolve([{ path: "/destination" }]);
      await pending;
    });
    expect(result.current.files.map((item) => item.id)).toEqual(["/remove-old/b.md"]);
    expect(result.current.notes).toEqual([]);
    expect(result.current.directories).toContainEqual({ path: "/fresh-folder" });
    expect(result.current.documents.documents[newId]).toBeUndefined();
    expect(result.current.message).toContain("Deleted");
  });

  it("retains content edited during a reindex document refresh", async () => {
    const refresh = deferred<ViewerDocument>();
    let dirty = false;
    mockApi.mockImplementation((url: string) => {
      if (url === "/api/reindex") return Promise.resolve({ notes: [], errors: [] });
      if (url === "/api/files") return Promise.resolve([]);
      if (url === "/api/directories") return Promise.resolve([]);
      return refresh.promise;
    });
    const { result } = renderHook(() => useHarness(() => dirty));
    act(() => result.current.documents.setDocuments({ "/remove/sub/a.md": document("/remove/sub/a.md") }));
    let pending!: Promise<void>;
    await act(async () => { pending = result.current.bundleActions.reindexBundle(); });
    dirty = true;
    act(() => result.current.documents.changeDraftContent(document("/remove/sub/a.md"), "new edit"));
    await act(async () => { refresh.resolve({ ...document("/remove/sub/a.md"), content: "old content" }); await pending; });
    expect(result.current.documents.documents["/remove/sub/a.md"].content).toBe("# Content");
    expect(result.current.documents.drafts["/remove/sub/a.md"]).toBe("new edit");
    expect(result.current.reindexing).toBe(false);
  });

  it("does not refresh an alias into a dirty canonical document", async () => {
    const refresh = deferred<ViewerDocument>();
    let dirty = false;
    mockApi.mockImplementation((url: string) => {
      if (url === "/api/reindex") return Promise.resolve({ notes: [], errors: [] });
      if (url === "/api/files" || url === "/api/directories") return Promise.resolve([]);
      return refresh.promise;
    });
    const { result } = renderHook(() => useHarness((id) => dirty && id === "/current.md"));
    const canonical = { ...document("/current.md"), content: "current saved content" };
    act(() => {
      result.current.documents.setDocuments({ "/current.md": canonical });
      result.current.setGroups([{ id: "g", tabs: ["/alias.md"], activeId: "/alias.md", previewId: null }]);
    });
    let pending!: Promise<void>;
    await act(async () => { pending = result.current.bundleActions.reindexBundle(); });
    dirty = true;
    act(() => result.current.documents.changeDraftContent(canonical, "new edit"));
    await act(async () => { refresh.resolve({ ...document("/current.md"), content: "stale alias content" }); await pending; });
    expect(result.current.documents.documents["/current.md"]).toEqual(canonical);
    expect(result.current.documents.drafts["/current.md"]).toBe("new edit");
  });

  it("retains newer explorer lists when a rename finishes during reindex refresh", async () => {
    const refresh = deferred<ViewerDocument>();
    mockApi.mockImplementation((url: string) => {
      if (url === "/api/reindex") return Promise.resolve({ notes: [], errors: [] });
      if (url === "/api/files") return Promise.resolve([file("/remove/sub/a.md")]);
      if (url === "/api/directories") return Promise.resolve([{ path: "/remove/sub" }]);
      if (url === "/api/notes") return Promise.resolve([]);
      if (url === "/api/file/rename") return Promise.resolve({ oldId: "/remove/sub/a.md", newId: "/remove/sub/new.md", note: document("/remove/sub/new.md"), warning: null });
      return refresh.promise;
    });
    const { result } = renderHook(() => useHarness());
    let pending!: Promise<void>;
    await act(async () => { pending = result.current.bundleActions.reindexBundle(); });
    // Return the fresh renamed tree for the rename's own refresh.
    mockApi.mockImplementation((url: string) => {
      if (url === "/api/file/rename") return Promise.resolve({ oldId: "/remove/sub/a.md", newId: "/remove/sub/new.md", note: document("/remove/sub/new.md"), warning: null });
      if (url === "/api/files") return Promise.resolve([file("/remove/sub/new.md")]);
      if (url === "/api/directories") return Promise.resolve([{ path: "/remove/sub" }]);
      if (url === "/api/notes") return Promise.resolve([]);
      return refresh.promise;
    });
    await act(async () => { await result.current.actions.renameFile("/remove/sub/a.md", "new.md"); });
    await act(async () => { refresh.resolve(document("/remove/sub/a.md")); await pending; });
    expect(result.current.files.map((item) => item.id)).toEqual(["/remove/sub/new.md"]);
    expect(Object.keys(result.current.documents.documents)).toEqual(["/remove/sub/new.md"]);
  });
});

describe("recursive folder deletion", () => {
  it("cleans descendants and invalidates pending file, alias, search and answer responses when refresh fails", async () => {
    const load = deferred<ViewerDocument>();
    const alias = deferred<ViewerDocument>();
    const search = deferred<Note[]>();
    const answer = deferred<AskResult>();
    let deleting = false;
    mockApi.mockImplementation((url: string) => {
      if (url.startsWith("/api/file/folder?")) { deleting = true; return Promise.resolve({ path: "/remove", deletedIds: ["/remove/sub/a.md"], warning: null }); }
      if (url.includes("path=%2Fremove%2Fsub%2Floading.md")) return load.promise;
      if (url.includes("path=%2Fbefore.md")) return alias.promise;
      if (url.startsWith("/api/search?")) return search.promise;
      if (url === "/api/ask") return answer.promise;
      if (deleting) return Promise.reject(new Error("refresh offline"));
      throw new Error(`Unexpected request ${url}`);
    });
    const { result } = renderHook(() => useHarness());
    act(() => {
      result.current.documents.setDocuments({ "/remove/sub/a.md": document("/remove/sub/a.md"), "/remove-old/b.md": document("/remove-old/b.md") });
      result.current.documents.setDrafts({ "/remove/sub/a.md": "draft", "/remove-old/b.md": "keep" });
      result.current.discovery.setQuestion("Ask about notes");
      result.current.discovery.setSearchResults([{ ...document("/remove/sub/a.md"), snippet: "gone" }]);
    });
    let loading!: Promise<void>, aliasLoading!: Promise<void>, searching!: Promise<void>, asking!: Promise<void>;
    act(() => {
      loading = result.current.navigation.loadDocument("/remove/sub/loading.md");
      aliasLoading = result.current.navigation.loadDocument("/before.md");
      searching = result.current.discovery.searchNotes("old");
      asking = result.current.discovery.askNotes("model");
    });
    await act(async () => { await result.current.actions.deleteDirectory("/remove"); });
    expect(result.current.files.map((item) => item.id)).toEqual(["/remove-old/b.md"]);
    expect(result.current.directories).toEqual([{ path: "/remove-old" }]);
    expect(result.current.documents.documents).toEqual({ "/remove-old/b.md": document("/remove-old/b.md") });
    expect(result.current.documents.drafts).toEqual({ "/remove-old/b.md": "keep" });
    expect(result.current.groups[0]).toMatchObject({ tabs: ["/remove-old/b.md"], activeId: "/remove-old/b.md", previewId: null });
    expect([...result.current.expanded]).toEqual(["/", "/remove-old"]);
    expect(result.current.message).toContain("could not be refreshed");
    expect(result.current.documents.documentRequests.current["/remove/sub/loading.md"]).toBe(2);
    await act(async () => {
      load.resolve(document("/remove/sub/loading.md"));
      alias.resolve(document("/remove/sub/a.md"));
      search.resolve([{ ...document("/remove/sub/a.md"), rawId: null, relatedIds: [], classifiedByModel: false }]);
      answer.resolve({ answer: "stale answer", sources: [] } as AskResult);
      await Promise.all([loading, aliasLoading, searching, asking]);
    });
    expect(Object.keys(result.current.documents.documents)).toEqual(["/remove-old/b.md"]);
    expect(result.current.discovery.searchResults).toEqual([]);
    expect(result.current.discovery.answer).toBeNull();
    expect(result.current.documents.loadingDocuments.size).toBe(0);
  });

  it("closes an alias preview when its late response resolves into a deleted folder", async () => {
    const alias = deferred<ViewerDocument>();
    mockApi.mockImplementation((url: string) => {
      if (url.startsWith("/api/file/folder?")) return Promise.resolve({ path: "/remove", deletedIds: [], warning: null });
      if (url.includes("path=%2Fbefore.md")) return alias.promise;
      return Promise.reject(new Error("offline refresh"));
    });
    const { result } = renderHook(() => useHarness());
    let opening!: Promise<void>;
    act(() => { opening = result.current.navigation.openDocument("/before.md", "file", "g", "preview"); });
    await act(async () => { await result.current.actions.deleteDirectory("/remove"); });
    expect(result.current.groups[0].tabs).toContain("/before.md");
    await act(async () => { alias.resolve(document("/remove/sub/a.md")); await opening; });
    expect(result.current.groups[0]).toMatchObject({ tabs: ["/remove-old/b.md"], activeId: "/remove-old/b.md", previewId: null });
    expect(result.current.documents.documents).toEqual({});
  });

  it("clears an editor activated after folder deletion started", async () => {
    const deletion = deferred<{ path: string; deletedIds: string[]; warning: null }>();
    mockApi.mockImplementation((url: string) => url.startsWith("/api/file/folder?") ? deletion.promise : Promise.reject(new Error("offline refresh")));
    const { result } = renderHook(() => useHarness());
    let pending!: Promise<void>;
    act(() => { pending = result.current.actions.deleteDirectory("/remove"); });
    act(() => { result.current.documents.setEditingKey("g:/remove/sub/a.md"); });
    await act(async () => { deletion.resolve({ path: "/remove", deletedIds: [], warning: null }); await pending; });
    expect(result.current.documents.editingKey).toBeNull();
  });

  it.each(["dirty", "saving", "editing", "moving"])("blocks deletion while a descendant is %s", async (mode) => {
    const { result } = renderHook(() => useHarness((id) => mode === "dirty" && id === "/remove/sub/a.md"));
    act(() => {
      if (mode === "saving") result.current.documents.setSavingDocuments(new Set(["/remove/sub/a.md"]));
      if (mode === "editing") result.current.documents.setEditingKey("g:/remove/sub/a.md");
      if (mode === "moving") result.current.setMovingFileId("/remove/sub/a.md");
    });
    await expect(result.current.actions.deleteDirectory("/remove")).rejects.toThrow("Finish editing, saving, or moving");
    expect(mockApi).not.toHaveBeenCalled();
  });

  it("propagates a failed file deletion without refreshing or clearing the error", async () => {
    mockApi.mockRejectedValue(new Error("Delete failed"));
    const { result } = renderHook(() => useHarness());
    await act(async () => {
      await expect(result.current.actions.deleteFile(file("/remove/sub/a.md"))).rejects.toThrow("Delete failed");
    });
    expect(mockApi).toHaveBeenCalledTimes(1);
    expect(result.current.files).toHaveLength(2);
    expect(result.current.message).toBe("Delete failed");
  });

  it("prevents duplicate deletes and reopening descendants while deleting, and ignores a result after bundle switching", async () => {
    const deletion = deferred<{ path: string; deletedIds: string[]; warning: null }>();
    mockApi.mockReturnValue(deletion.promise);
    const { result } = renderHook(() => useHarness());
    let pending!: Promise<void>;
    act(() => { pending = result.current.actions.deleteDirectory("/remove"); });
    await act(async () => {
      await result.current.actions.deleteDirectory("/remove");
      await result.current.navigation.openDocument("/remove/sub/a.md");
    });
    expect(mockApi).toHaveBeenCalledTimes(1);
    activeBundle.id = "bundle-b";
    activeBundle.revision += 1;
    await act(async () => { deletion.resolve({ path: "/remove", deletedIds: [], warning: null }); await pending; });
    expect(result.current.files).toHaveLength(2);
    expect(result.current.directories).toHaveLength(3);
    expect(result.current.documents.deletingDirectories.current.size).toBe(0);
  });
});

describe("explorer confirmation", () => {
  function actions(): ExplorerFileActions {
    return { renameFile: vi.fn(), createFile: vi.fn(), createDirectory: vi.fn(), deleteFile: vi.fn(), deleteDirectory: vi.fn(), exportFile: vi.fn(), copyText: vi.fn() };
  }
  it("warns about every type of folder content and disables all controls during a request", async () => {
    const handlers = actions();
    const deletion = deferred<void>();
    vi.mocked(handlers.deleteDirectory).mockReturnValue(deletion.promise);
    render(<ExplorerContextMenu state={{ target: { kind: "directory", path: "/notes" }, x: 0, y: 0, anchor: documentAnchor() }} bundlePath="/bundle" actions={handlers} blockedFileIds={new Set()} onDismiss={vi.fn()} onError={vi.fn()} />);
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("nested folders, hidden files, and non-Markdown files");
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByRole("button", { name: "Deleting…" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Deleting…" }));
    expect(handlers.deleteDirectory).toHaveBeenCalledTimes(1);
    await act(async () => { deletion.resolve(); });
  });
  it("does not dismiss a newly targeted menu when an old asynchronous action completes", async () => {
    const handlers = actions();
    const creating = deferred<void>();
    vi.mocked(handlers.createFile).mockReturnValue(creating.promise);
    const dismiss = vi.fn();
    const { rerender } = render(<ExplorerContextMenu key="first" state={{ target: { kind: "directory", path: "/first" }, x: 0, y: 0, anchor: documentAnchor() }} bundlePath="/bundle" actions={handlers} blockedFileIds={new Set()} onDismiss={dismiss} onError={vi.fn()} />);
    fireEvent.click(screen.getByRole("menuitem", { name: "New note" }));
    rerender(<ExplorerContextMenu key="second" state={{ target: { kind: "directory", path: "/second" }, x: 0, y: 0, anchor: documentAnchor() }} bundlePath="/bundle" actions={handlers} blockedFileIds={new Set()} onDismiss={dismiss} onError={vi.fn()} />);
    await act(async () => { creating.resolve(); });
    expect(screen.getByRole("menu", { name: "second actions" })).toBeVisible();
    expect(dismiss).not.toHaveBeenCalled();
  });

  it("keeps Delete visible but disabled for a blocked descendant", () => {
    render(<ExplorerContextMenu state={{ target: { kind: "directory", path: "/notes" }, x: 0, y: 0, anchor: documentAnchor() }} bundlePath="/bundle" actions={actions()} blockedFileIds={new Set(["/notes/sub/a.md"])} onDismiss={vi.fn()} onError={vi.fn()} />);
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeDisabled();
  });
});

function documentAnchor() { return window.document.createElement("button"); }
