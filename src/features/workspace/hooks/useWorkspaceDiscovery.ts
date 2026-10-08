import { useRef, useState } from "react";
import type {
  AskResult,
  NoteDetail,
  SearchResult,
  SidebarMode,
} from "../../../domain/types.ts";
import { api } from "../../../lib/api.ts";

type UseWorkspaceDiscoveryOptions = {
  setMessage: (message: string) => void;
  setSidebarMode: (mode: SidebarMode) => void;
};

export function useWorkspaceDiscovery({
  setMessage,
  setSidebarMode,
}: UseWorkspaceDiscoveryOptions) {
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedTag, setSelectedTag] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<AskResult | null>(null);
  const [asking, setAsking] = useState(false);
  const searchRequest = useRef(0);
  const askRequest = useRef(0);

  async function searchNotes(query = searchQuery, tag = selectedTag) {
    if (!query.trim() && !tag) return;
    const requestId = ++searchRequest.current;
    setSearching(true);
    setMessage("");
    try {
      const parameters = new URLSearchParams();
      if (query.trim()) parameters.set("q", query.trim());
      if (tag) parameters.set("tag", tag);
      const results = await api<SearchResult[]>(`/api/search?${parameters}`);
      if (requestId === searchRequest.current) setSearchResults(results);
    } catch (error) {
      if (requestId === searchRequest.current)
        setMessage(
          error instanceof Error ? error.message : "Could not search notes",
        );
    } finally {
      if (requestId === searchRequest.current) setSearching(false);
    }
  }

  function searchTag(tag: string) {
    setSidebarMode("search");
    setSelectedTag(tag);
    setSearchQuery("");
    void searchNotes("", tag);
  }

  async function askNotes(selectedModel: string) {
    if (!question.trim() || asking || !selectedModel) return;
    const requestId = ++askRequest.current;
    setAsking(true);
    setMessage("");
    setAnswer(null);
    try {
      const result = await api<AskResult>("/api/ask", {
        method: "POST",
        body: JSON.stringify({
          question,
          model: selectedModel,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      });
      if (requestId === askRequest.current) setAnswer(result);
    } catch (error) {
      if (requestId === askRequest.current) setMessage(
        error instanceof Error ? error.message : "Could not ask your notes",
      );
    } finally {
      if (requestId === askRequest.current) setAsking(false);
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
