import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { TranslationSettings } from "../../../domain/types.ts";
import { fetchTranslationSettings, saveTranslationSettings } from "../../../lib/api.ts";

type Snapshot = { settings: TranslationSettings | null; error: string; saving: boolean };

let snapshot: Snapshot = { settings: null, error: "", saving: false };
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function publish(next: Snapshot) {
  snapshot = next;
  for (const listener of [...listeners]) listener();
}

function load(force = false) {
  if (loading || (snapshot.settings && !force)) return;
  loading = fetchTranslationSettings()
    .then((settings) => publish({ settings, error: "", saving: false }))
    .catch((error: unknown) =>
      publish({ settings: snapshot.settings, error: error instanceof Error ? error.message : "Could not load translation settings.", saving: false }),
    )
    .finally(() => {
      loading = null;
    });
}

/** Re-reads availability after a model install, removal or selection change. */
export function refreshTranslationSettings() {
  if (snapshot.settings || listeners.size) load(true);
}

export function resetTranslationSettingsForTests() {
  snapshot = { settings: null, error: "", saving: false };
  loading = null;
}

/** Shared across the toggle and Settings so flipping the switch updates open notes immediately. */
export function useTranslationSettings() {
  const state = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot,
  );
  useEffect(() => {
    load();
  }, []);
  const setEnabled = useCallback(async (enabled: boolean) => {
    const previous = snapshot.settings;
    if (!previous || snapshot.saving) return;
    publish({ settings: { ...previous, enabled }, error: "", saving: true });
    try {
      publish({ settings: await saveTranslationSettings(enabled), error: "", saving: false });
    } catch (error) {
      publish({
        settings: previous,
        error: error instanceof Error ? error.message : "Could not save translation settings.",
        saving: false,
      });
    }
  }, []);
  return { ...state, setEnabled };
}
