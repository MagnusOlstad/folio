import { useCallback, useLayoutEffect, useSyncExternalStore } from "react";
import type { Entity } from "../../../domain/entities.ts";

type ScopedEntity = Pick<Entity, "id" | "label" | "type">;
type Snapshot = { bundleId: string | null; entities: ScopedEntity[] };

let snapshot: Snapshot = { bundleId: null, entities: [] };
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return snapshot;
}

function update(next: Snapshot) {
  if (next.bundleId === snapshot.bundleId && next.entities === snapshot.entities) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

/** One workspace-level entity selection shared by the entity browser, search, and Ask. */
export function useEntityScope(bundleId: string | null) {
  const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useLayoutEffect(() => {
    if (snapshot.bundleId !== bundleId) update({ bundleId, entities: [] });
  }, [bundleId]);
  const entities = current.bundleId === bundleId ? current.entities : [];
  const toggleEntity = useCallback((entity: ScopedEntity, selected: boolean) => {
    const existing = snapshot.bundleId === bundleId ? snapshot.entities : [];
    update({ bundleId, entities: selected
      ? existing.some((item) => item.id === entity.id) ? existing : [...existing, entity]
      : existing.filter((item) => item.id !== entity.id) });
  }, [bundleId]);
  const clear = useCallback(() => update({ bundleId, entities: [] }), [bundleId]);
  return { bundleId, entities, entityIds: entities.map((entity) => entity.id), toggleEntity, clear };
}
