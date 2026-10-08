import type { TabGroup } from "../../../domain/types.ts";

type DocumentPathChange = { sequence: number; newId: string | null };

/** Follow later mutations so an old alias never lands on an intermediate path. */
export function documentPathAfterChanges(changes: Record<string, DocumentPathChange>, id: string, sinceSequence: number) {
  const initial = changes[id];
  if (!initial || initial.sequence <= sinceSequence) return undefined;
  let { newId, sequence } = initial;
  const visited = new Set([id]);
  while (newId && !visited.has(newId)) {
    visited.add(newId);
    const next = changes[newId];
    if (!next || next.sequence <= sequence || next.newId === newId) break;
    newId = next.newId;
    sequence = next.sequence;
  }
  return newId;
}

/** Preserve local content when a server mutation changes its document path. */
export function replaceDocumentPath<T>(current: Record<string, T>, oldId: string, newId: string, value?: T) {
  if (!(oldId in current) && value === undefined) return current;
  const next = { ...current };
  delete next[oldId];
  next[newId] = value === undefined ? current[oldId] : value;
  return next;
}

export function replaceDocumentTabs(groups: TabGroup[], oldId: string, newId: string) {
  return groups.map((group) => {
    const eitherWasPermanent = (group.tabs.includes(newId) && group.previewId !== newId)
      || (group.tabs.includes(oldId) && group.previewId !== oldId);
    return {
      ...group,
      tabs: [...new Set(group.tabs.map((id) => id === oldId ? newId : id))],
      activeId: group.activeId === oldId ? newId : group.activeId,
      previewId: group.previewId === oldId || group.previewId === newId
        ? eitherWasPermanent ? null : newId
        : group.previewId,
    };
  });
}
