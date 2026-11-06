import { useCallback, useEffect, useState } from "react";
import type { NoteLanguageInfo } from "../../../domain/types.ts";
import { fetchNoteLanguage, setNoteAutoTranslate } from "../../../lib/api.ts";

export const LANGUAGE_POLL_MS = 10_000;

type Loaded = { id: string; info: NoteLanguageInfo | null };

/**
 * Per-note translation state: the note's own language (no model work on the server)
 * and whether this note is auto-translated. It refetches after saves via
 * `contentVersion` and only polls, slowly, while the language is unknown and this
 * note is auto-translated (detection may finish later).
 */
export function useNoteLanguage(id: string, active: boolean, contentVersion: string) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<{ id: string; message: string } | null>(null);

  const settled = active && loaded?.id === id;
  const info = settled ? loaded.info : null;
  const autoTranslate = info?.autoTranslate ?? false;
  const pollUnknown = autoTranslate && info?.noteLanguage === null;

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let timer: number | undefined;
    const run = async () => {
      try {
        const next = await fetchNoteLanguage(id, controller.signal);
        if (controller.signal.aborted) return;
        setLoaded({ id, info: next });
        if (next.noteLanguage === null && next.autoTranslate) timer = window.setTimeout(run, LANGUAGE_POLL_MS);
      } catch {
        if (controller.signal.aborted) return;
        // The toggle falls back to the unknown-language, auto-translate-off behaviour.
        setLoaded((previous) => (previous?.id === id ? previous : { id, info: null }));
      }
    };
    void run();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
    // pollUnknown restarts the loop when auto-translate flips while the language is unknown.
  }, [id, active, contentVersion, pollUnknown]);

  const setAuto = useCallback(
    async (enabled: boolean) => {
      if (saving) return;
      const previous = loaded?.id === id ? loaded.info : null;
      const base: NoteLanguageInfo = previous ?? { id, noteLanguage: null, noteLanguageSource: null, autoTranslate: false };
      setSaving(true);
      setSaveError(null);
      setLoaded({ id, info: { ...base, autoTranslate: enabled } });
      try {
        const result = await setNoteAutoTranslate(id, enabled);
        setLoaded({ id, info: { ...base, autoTranslate: result.autoTranslate } });
      } catch (error) {
        setLoaded({ id, info: previous });
        setSaveError({ id, message: error instanceof Error ? error.message : "Could not save auto-translate." });
      } finally {
        setSaving(false);
      }
    },
    [id, loaded, saving],
  );

  return {
    /** False until the first answer (or failure), so a stored choice is not fetched blindly. */
    settled,
    noteLanguage: info?.noteLanguage ?? null,
    noteLanguageSource: info?.noteLanguageSource ?? null,
    autoTranslate,
    saving,
    error: saveError?.id === id ? saveError.message : "",
    setAutoTranslate: setAuto,
  };
}
