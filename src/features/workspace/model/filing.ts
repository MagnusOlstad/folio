import type { Filing, FilingProposal, TabGroup } from "../../../domain/types.ts";

export type FilingFields = Omit<FilingProposal, "filename">;
export type FilingQueueEntry = {
  filing: Filing;
  fields: FilingFields;
  standalone: boolean;
  status: "preparing" | "ready" | "submitting" | "error";
  error: string | null;
};

export function proposalFields(proposal: FilingProposal): FilingFields {
  return {
    directory: proposal.directory,
    title: proposal.title,
    description: proposal.description,
    tags: [...proposal.tags],
  };
}

export function filingEntry(filing: Filing): FilingQueueEntry {
  return {
    filing,
    fields: proposalFields(filing.proposal),
    standalone: false,
    status: "ready",
    error: null,
  };
}

export function rekeyFilingQueue(
  queues: Record<string, FilingQueueEntry[]>,
  oldId: string,
  newId: string,
  entry: FilingQueueEntry,
) {
  const next = { ...queues };
  const existing = next[newId] ?? [];
  delete next[oldId];
  next[newId] = [...existing, entry];
  return next;
}

export function advanceFilingQueue(
  queues: Record<string, FilingQueueEntry[]>,
  documentId: string,
  newId: string,
  action: "accept" | "standalone",
) {
  const queue = queues[documentId] ?? [];
  const remaining = queue.slice(1);
  const next = { ...queues };

  if (action === "standalone") {
    if (remaining.length) next[documentId] = remaining;
    else delete next[documentId];
    return next;
  }

  if (documentId !== newId) delete next[documentId];
  const destinationQueue = documentId === newId ? [] : (next[newId] ?? []);
  if (remaining.length || destinationQueue.length)
    next[newId] = [...destinationQueue, ...remaining];
  else delete next[newId];
  return next;
}

export function dismissFailedPreparation(
  queues: Record<string, FilingQueueEntry[]>,
  documentId: string,
) {
  const next = { ...queues };
  delete next[documentId];
  return next;
}

export function finishDraftFiling(
  queues: Record<string, FilingQueueEntry[]>,
  draftId: string,
  filedId: string,
  filing: Filing | null | undefined,
) {
  if (!filing) return dismissFailedPreparation(queues, draftId);
  return rekeyFilingQueue(queues, draftId, filedId, filingEntry(filing));
}

export function filingOwnerGroupIds(
  groups: TabGroup[],
  activeGroupId: string,
  queues: Record<string, FilingQueueEntry[]>,
) {
  const owners: Record<string, string> = {};
  for (const group of groups) {
    const documentId = group.activeId;
    if (!documentId || !queues[documentId]?.length) continue;
    if (!(documentId in owners) || group.id === activeGroupId)
      owners[documentId] = group.id;
  }
  return owners;
}

export function applyStandaloneFilingTabs(
  groups: TabGroup[],
  ownerGroupId: string,
  sourceId: string,
  standaloneId: string,
  sourceRemoved: boolean,
) {
  return groups.map((group) => {
    if (sourceRemoved) {
      const tabs = group.tabs
        .map((id) => (id === sourceId ? standaloneId : id))
        .filter((id, index, allTabs) => allTabs.indexOf(id) === index);
      return {
        ...group,
        tabs,
        activeId: group.activeId === sourceId ? standaloneId : group.activeId,
      };
    }
    if (group.id !== ownerGroupId || group.activeId !== sourceId) return group;
    return {
      ...group,
      tabs: group.tabs.includes(standaloneId)
        ? group.tabs
        : [...group.tabs, standaloneId],
      activeId: standaloneId,
    };
  });
}
