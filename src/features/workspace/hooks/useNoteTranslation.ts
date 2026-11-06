import { useEffect, useState } from "react";
import type { NoteTranslation, NoteTranslationTarget } from "../../../domain/types.ts";
import { fetchNoteTranslation, prioritizeNoteTranslation } from "../../../lib/api.ts";

export const TRANSLATION_POLL_MS = 4000;

type Loaded = { key: string; translation: NoteTranslation | null; error: string };

/**
 * Fetches the translated view of a note. `contentVersion` changes after a save so the
 * translation is refetched once; while the server reports "pending" it polls.
 */
export function useNoteTranslation(
  id: string,
  target: NoteTranslationTarget | null,
  contentVersion: string,
) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const key = target ? `${id}\n${target}` : "";

  useEffect(() => {
    if (!target) return;
    const controller = new AbortController();
    let timer: number | undefined;
    const run = async () => {
      try {
        const translation = await fetchNoteTranslation(id, target, controller.signal);
        if (controller.signal.aborted) return;
        setLoaded({ key, translation, error: "" });
        if (translation.status === "pending") timer = window.setTimeout(run, TRANSLATION_POLL_MS);
      } catch (error) {
        if (controller.signal.aborted) return;
        setLoaded((current) => ({
          key,
          translation: current?.key === key ? current.translation : null,
          error: error instanceof Error ? error.message : "Could not load the translation.",
        }));
      }
    };
    void prioritizeNoteTranslation(id).catch(() => {});
    void run();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [id, target, key, contentVersion]);

  const current = loaded?.key === key ? loaded : null;
  return {
    translation: current?.translation ?? null,
    error: current?.error ?? "",
    loading: Boolean(target) && !current,
  };
}
