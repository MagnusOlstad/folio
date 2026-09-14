import { useCallback, useEffect, useRef, useState } from "react";
import type { SearchResult } from "../../../domain/types.ts";
import { api } from "../../../lib/api.ts";
import { readStorageItem, writeStorageItem } from "../../../lib/storage.ts";
import {
  buildPaletteSections,
  flattenSections,
  type PaletteCommand,
  type PaletteRow,
  type PaletteSection,
} from "../model/command-palette.ts";

const RECENT_STORAGE_KEY = "folio:palette-recent";
const RECENT_LIMIT = 5;
const NOTE_LIMIT = 5;
const NOTE_SEARCH_DEBOUNCE = 200;

type UseCommandPaletteOptions = {
  commands: PaletteCommand[];
  openNote: (note: SearchResult) => void;
  initialOpen?: boolean;
};

function loadRecentIds(): string[] {
  const stored = readStorageItem(RECENT_STORAGE_KEY);
  if (!stored) return [];
  try {
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((id): id is string => typeof id === "string" && id.length > 0)
      .slice(0, RECENT_LIMIT);
  } catch {
    return [];
  }
}

export function useCommandPalette({
  commands,
  openNote,
  initialOpen = false,
}: UseCommandPaletteOptions) {
  const [open, setOpen] = useState(initialOpen);
  const [query, setQuery] = useState("");
  const [notes, setNotes] = useState<SearchResult[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [recentIds, setRecentIds] = useState<string[]>(loadRecentIds);
  const searchRequest = useRef(0);

  const closePalette = useCallback(() => {
    setOpen(false);
    setQuery("");
    setNotes([]);
    setActiveIndex(0);
  }, []);

  const openPalette = useCallback(() => {
    setOpen(true);
    setActiveIndex(0);
  }, []);

  const togglePalette = useCallback(() => {
    setOpen((current) => {
      if (current) {
        setQuery("");
        setNotes([]);
        setActiveIndex(0);
      }
      return !current;
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    const trimmed = query.trim();
    if (!trimmed) return;
    const timer = window.setTimeout(() => {
      const requestId = ++searchRequest.current;
      api<SearchResult[]>(`/api/search?q=${encodeURIComponent(trimmed)}`)
        .then((results) => {
          if (searchRequest.current === requestId) setNotes(results);
        })
        .catch(() => {
          if (searchRequest.current === requestId) setNotes([]);
        });
    }, NOTE_SEARCH_DEBOUNCE);
    return () => window.clearTimeout(timer);
  }, [open, query]);

  const notesShown = query.trim() ? notes : [];

  const noteCommands: PaletteCommand[] = notesShown.slice(0, NOTE_LIMIT).map((note) => ({
    id: `note:${note.id}`,
    label: note.title,
    description: note.snippet,
    run: () => {
      closePalette();
      openNote(note);
    },
  }));

  const sections: PaletteSection[] = buildPaletteSections({
    commands,
    recentIds,
    query,
    notes: noteCommands,
  });

  const rows: PaletteRow[] = flattenSections(sections);

  function move(delta: number) {
    if (!rows.length) return;
    setActiveIndex((current) =>
      Math.min(Math.max(current + delta, 0), rows.length - 1),
    );
  }

  function execute(index = activeIndex) {
    const row = rows[index];
    if (!row) return;
    if (row.section !== "notes") recordRecent(row.command.id);
    closePalette();
    row.command.run();
  }

  function recordRecent(id: string) {
    setRecentIds((current) => {
      const next = [id, ...current.filter((candidate) => candidate !== id)].slice(
        0,
        RECENT_LIMIT,
      );
      writeStorageItem(RECENT_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }

  return {
    open,
    query,
    setQuery,
    sections,
    rows,
    activeIndex,
    openPalette,
    closePalette,
    togglePalette,
    move,
    execute,
  };
}

export type CommandPaletteState = ReturnType<typeof useCommandPalette>;
