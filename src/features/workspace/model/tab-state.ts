import type { TabGroup } from "../../../domain/types.ts";

export function activateGroupTab(
  groups: TabGroup[],
  groupId: string,
  documentId: string,
) {
  return groups.map((group) =>
    group.id === groupId ? { ...group, activeId: documentId } : group,
  );
}

/** Open a document as the replaceable preview in a group. */
export function openPreviewTab(
  groups: TabGroup[],
  groupId: string,
  documentId: string,
) {
  return groups.map((group) => {
    if (group.id !== groupId) return group;

    const existingIndex = group.tabs.indexOf(documentId);
    // A permanent tab must stay permanent when it is opened as a preview.
    if (existingIndex !== -1 && group.previewId !== documentId) {
      return { ...group, activeId: documentId };
    }

    if (existingIndex !== -1) {
      return { ...group, activeId: documentId, previewId: documentId };
    }

    const previewIndex = group.previewId
      ? group.tabs.indexOf(group.previewId)
      : -1;
    if (previewIndex !== -1) {
      const tabs = [...group.tabs];
      tabs[previewIndex] = documentId;
      return { ...group, tabs, activeId: documentId, previewId: documentId };
    }

    return {
      ...group,
      tabs: [...group.tabs, documentId],
      activeId: documentId,
      previewId: documentId,
    };
  });
}

/** Make a preview permanent, leaving all other group state unchanged. */
export function pinGroupTab(
  groups: TabGroup[],
  groupId: string,
  documentId: string,
) {
  return groups.map((group) =>
    group.id === groupId && group.previewId === documentId
      ? { ...group, previewId: null }
      : group,
  );
}

export function closeGroupTab(
  groups: TabGroup[],
  groupId: string,
  documentId: string,
) {
  return groups.map((group) => {
    if (group.id !== groupId) return group;
    const tabIndex = group.tabs.indexOf(documentId);
    const tabs = group.tabs.filter((id) => id !== documentId);
    const activeId =
      group.activeId === documentId
        ? tabs[Math.min(tabIndex, tabs.length - 1)] || null
        : group.activeId;
    return {
      ...group,
      tabs,
      activeId,
      previewId: group.previewId === documentId ? null : group.previewId,
    };
  });
}

export function moveGroupTab(
  groups: TabGroup[],
  documentId: string,
  sourceGroupId: string,
  targetGroupId: string,
) {
  if (sourceGroupId === targetGroupId)
    return pinGroupTab(groups, sourceGroupId, documentId);
  return groups.map((group) => {
    if (group.id === sourceGroupId) {
      const tabIndex = group.tabs.indexOf(documentId);
      const tabs = group.tabs.filter((id) => id !== documentId);
      return {
        ...group,
        tabs,
        activeId:
          group.activeId === documentId
            ? tabs[Math.min(tabIndex, tabs.length - 1)] || null
            : group.activeId,
        previewId: group.previewId === documentId ? null : group.previewId,
      };
    }
    if (group.id === targetGroupId) {
      return {
        ...group,
        tabs: group.tabs.includes(documentId)
          ? group.tabs
          : [...group.tabs, documentId],
        activeId: documentId,
        // A dragged preview is pinned in its destination group.
        previewId: group.previewId === documentId ? null : group.previewId,
      };
    }
    return group;
  });
}

export function mergeClosedGroup(groups: TabGroup[], groupId: string) {
  if (groups.length === 1) return null;
  const closing = groups.find((group) => group.id === groupId);
  const remaining = groups.find((group) => group.id !== groupId);
  if (!closing || !remaining) return null;
  const tabs = [
    ...remaining.tabs,
    ...closing.tabs.filter((id) => !remaining.tabs.includes(id)),
  ];
  return {
    ...remaining,
    tabs,
    activeId: remaining.activeId || closing.activeId || tabs[0] || null,
    // Both groups' previews become permanent when groups are merged.
    previewId: null,
  };
}
