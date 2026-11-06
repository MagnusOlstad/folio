import { useLayoutEffect, useRef, useState } from "react";
import type {
  AskResult,
  NoteDetail,
  SearchResult,
  ScopedSearchResponse,
  SidebarMode,
} from "../../../domain/types.ts";
import { apiForBundle } from "../../../lib/api.ts";
import type { EntityScopeMetadata } from "../../../domain/entities.ts";
import type { useEntityScope } from "./useEntityScope.ts";

type UseWorkspaceDiscoveryOptions = {
  setMessage: (message: string) => void;
  setSidebarMode: (mode: SidebarMode) => void;
  bundleId: string | null;
  entityScope?: ReturnType<typeof useEntityScope>;
};

export function useWorkspaceDiscovery({
  setMessage,
  setSidebarMode,
  bundleId,
  entityScope,
}: UseWorkspaceDiscoveryOptions) {
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedTag, setSelectedTag] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchScope, setSearchScope] = useState<EntityScopeMetadata | null>(null);
  const [searching, setSearching] = useState(false);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<AskResult | null>(null);
  const [asking, setAsking] = useState(false);
  const searchRequest = useRef(0);
  const askRequest = useRef(0);
  const currentBundleId = useRef(bundleId);
  useLayoutEffect(() => { currentBundleId.current = bundleId; }, [bundleId]);

  async function searchNotes(query = searchQuery, tag = selectedTag) {
    const ids = entityScope && entityScope.bundleId === bundleId ? entityScope.entityIds : [];
    if (!query.trim() && !tag && ids.length === 0) return;
    const requestId = ++searchRequest.current;
    setSearching(true);
    setMessage("");
    try {
      const parameters = new URLSearchParams();
      if (query.trim()) parameters.set("q", query.trim());
      if (tag) parameters.set("tag", tag);
      if (ids.length) {
        parameters.set("entityIds", ids.join(","));
        parameters.set("includeScope", "true");
      }
      const path = `/api/search?${parameters}`;
      if (ids.length) {
        const response = await apiForBundle<ScopedSearchResponse>(bundleId, path);
        if (requestId === searchRequest.current && currentBundleId.current === bundleId) {
          setSearchResults(response.items);
          setSearchScope(response.scope);
        }
      } else {
        const results = await apiForBundle<SearchResult[]>(bundleId, path);
        if (requestId === searchRequest.current && currentBundleId.current === bundleId) {
          setSearchResults(results);
          setSearchScope(null);
        }
      }
    } catch (error) {
      if (requestId === searchRequest.current && currentBundleId.current === bundleId)
        setMessage(
          error instanceof Error ? error.message : "Could not search notes",
        );
    } finally {
      if (requestId === searchRequest.current && currentBundleId.current === bundleId) setSearching(false);
    }
  }

  function searchTag(tag: string) {
    setSidebarMode("search");
    setSelectedTag(tag);
    setSearchQuery("");
    void searchNotes("", tag);
  }

  async function askNotes(selectedModel: string) {
    const ids = entityScope && entityScope.bundleId === bundleId ? entityScope.entityIds : [];
    if (!question.trim() || asking || !selectedModel) return;
    const requestId = ++askRequest.current;
    setAsking(true);
    setMessage("");
    setAnswer(null);
    try {
      const result = await apiForBundle<AskResult>(bundleId, "/api/ask", {
        method: "POST",
        body: JSON.stringify({
          question,
          model: selectedModel,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          ...(ids.length ? { entityIds: ids } : {}),
        }),
      });
      if (requestId === askRequest.current && currentBundleId.current === bundleId) setAnswer(result);
    } catch (error) {
      if (requestId === askRequest.current && currentBundleId.current === bundleId) setMessage(
        error instanceof Error ? error.message : "Could not ask your notes",
      );
    } finally {
      if (requestId === askRequest.current && currentBundleId.current === bundleId) setAsking(false);
    }
  }

  function invalidateRequests() {
    searchRequest.current += 1;
    askRequest.current += 1;
    setSearching(false);
    setAsking(false);
  }

  function clearDiscovery() {
    invalidateRequests();
    setSearchResults([]);
    setSearchScope(null);
    setAnswer(null);
  }

  function removeDocument(id: string) {
    invalidateRequests();
    setSearchResults((current) => current.filter((note) => note.id !== id));
    setAnswer(null);
  }

  function removeDirectory(directory: string) {
    invalidateRequests();
    setSearchResults((current) => current.filter((note) => !note.id.startsWith(`${directory}/`)));
    setAnswer(null);
  }

  function replaceDocument(oldId: string, updated: NoteDetail) {
    setSearchResults((current) =>
      current.map((note) =>
        note.id === oldId
          ? {
              ...note,
              ...updated,
              snippet: updated.content.replace(/\s+/g, " ").trim().slice(0, 320),
            }
          : note,
      ),
    );
    setAnswer((current) =>
      current
        ? {
            ...current,
            sources: current.sources.map((note) =>
              note.id === oldId ? { ...note, ...updated } : note,
            ),
          }
        : null,
    );
  }

  return {
    searchQuery,
    setSearchQuery,
    selectedTag,
    setSelectedTag,
    searchResults,
    setSearchResults,
    searchScope,
    searching,
    question,
    setQuestion,
    answer,
    setAnswer,
    asking,
    searchNotes,
    searchTag,
    askNotes,
    clearDiscovery,
    removeDocument,
    removeDirectory,
    replaceDocument,
  };
}
