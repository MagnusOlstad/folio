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
    return { ...group, tabs, activeId };
  });
}

export function moveGroupTab(
  groups: TabGroup[],
  documentId: string,
  sourceGroupId: string,
  targetGroupId: string,
) {
  if (sourceGroupId === targetGroupId) return groups;
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
      };
    }
    if (group.id === targetGroupId) {
      return {
        ...group,
        tabs: group.tabs.includes(documentId)
          ? group.tabs
          : [...group.tabs, documentId],
        activeId: documentId,
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
  };
}
