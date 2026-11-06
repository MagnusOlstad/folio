import { useEffect, useSyncExternalStore } from "react";
import type { TranslationSettings } from "../../../domain/types.ts";
import { fetchTranslationSettings } from "../../../lib/api.ts";

type Snapshot = { settings: TranslationSettings | null; error: string };

let snapshot: Snapshot = { settings: null, error: "" };
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function publish(next: Snapshot) {
  snapshot = next;
  for (const listener of [...listeners]) listener();
}

function load(force = false) {
  if (loading || (snapshot.settings && !force)) return;
  loading = fetchTranslationSettings()
    .then((settings) => publish({ settings, error: "" }))
    .catch((error: unknown) =>
      publish({ settings: snapshot.settings, error: error instanceof Error ? error.message : "Could not load translation settings." }),
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
  snapshot = { settings: null, error: "" };
  loading = null;
}

/** App-wide translation availability (is a generation model installed). */
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
  return state;
}
