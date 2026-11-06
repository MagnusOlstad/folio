import { useEffect, useState } from "react";
import type { NoteLanguageInfo } from "../../../domain/types.ts";
import { fetchNoteLanguage } from "../../../lib/api.ts";

export const LANGUAGE_POLL_MS = 10_000;

type Loaded = { id: string; info: NoteLanguageInfo | null };

/**
 * Reads the note's own language (no model work on the server). It refetches after
 * saves via `contentVersion` and only polls, slowly, while the language is unknown
 * and background translation is on (detection may finish later).
 */
export function useNoteLanguage(
  id: string,
  active: boolean,
  contentVersion: string,
  pollWhileUnknown: boolean,
) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let timer: number | undefined;
    const run = async () => {
      try {
        const info = await fetchNoteLanguage(id, controller.signal);
        if (controller.signal.aborted) return;
        setLoaded({ id, info });
        if (info.noteLanguage === null && pollWhileUnknown) timer = window.setTimeout(run, LANGUAGE_POLL_MS);
      } catch {
        if (controller.signal.aborted) return;
        // The toggle falls back to the unknown-language behaviour.
        setLoaded((previous) => (previous?.id === id ? previous : { id, info: null }));
      }
    };
    void run();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [id, active, contentVersion, pollWhileUnknown]);

  const settled = active && loaded?.id === id;
  const current = settled ? loaded.info : null;
  return {
    /** False until the first answer (or failure), so a stored choice is not fetched blindly. */
    settled,
    noteLanguage: current?.noteLanguage ?? null,
    noteLanguageSource: current?.noteLanguageSource ?? null,
  };
}
