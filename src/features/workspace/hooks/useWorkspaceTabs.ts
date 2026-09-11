import { useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type {
  BundleFile,
  Note,
  TabGroup,
  ViewerDocument,
} from "../../../domain/types.ts";
import { isUntitledId } from "../../../lib/workspace.ts";
import {
  activateGroupTab,
  closeGroupTab,
  mergeClosedGroup,
  moveGroupTab,
  pinGroupTab,
} from "../model/tab-state.ts";

type UseWorkspaceTabsOptions = {
  documents: Record<string, ViewerDocument>;
  drafts: Record<string, string>;
  notes: Note[];
  files: BundleFile[];
  setDocuments: Dispatch<SetStateAction<Record<string, ViewerDocument>>>;
  setDrafts: Dispatch<SetStateAction<Record<string, string>>>;
  setEditingKey: Dispatch<SetStateAction<string | null>>;
  draftTitle: (content: string) => string;
};

export function useWorkspaceTabs({
  documents,
  drafts,
  notes,
  files,
  setDocuments,
  setDrafts,
  setEditingKey,
  draftTitle,
}: UseWorkspaceTabsOptions) {
  const [groups, setGroups] = useState<TabGroup[]>([
    { id: "primary", tabs: [], activeId: null, previewId: null },
  ]);
  const [activeGroupId, setActiveGroupId] = useState("primary");
  const untitledCounter = useRef(0);

  function titleForId(id: string) {
    if (isUntitledId(id))
      return draftTitle(drafts[id] ?? documents[id]?.content ?? "");
    return (
      documents[id]?.title ||
      notes.find((note) => note.id === id)?.title ||
      files.find((file) => file.id === id)?.title ||
      "Untitled note"
    );
  }

  function activateTab(groupId: string, documentId: string) {
    setActiveGroupId(groupId);
    setGroups((current) => activateGroupTab(current, groupId, documentId));
    if (isUntitledId(documentId)) setEditingKey(`${groupId}:${documentId}`);
  }

  function pinTab(groupId: string, documentId: string) {
    setGroups((current) => pinGroupTab(current, groupId, documentId));
  }

  function createNewTab(targetGroupId = activeGroupId) {
    const id = `untitled:${Date.now()}:${++untitledCounter.current}`;
    const createdAt = new Date().toISOString();
    const document: ViewerDocument = {
      id,
      title: "Untitled",
      type: "Local draft",
      description: "",
      tags: [],
      createdAt,
      content: "",
      deletable: true,
      movable: false,
      status: "draft",
      staleAfter: null,
      stale: false,
      filedBy: null,
      filedAt: null,
      links: [],
      backlinks: [],
      suggestions: [],
      updatedAt: createdAt,
    };
    setDocuments((current) => ({ ...current, [id]: document }));
    setDrafts((current) => ({ ...current, [id]: "" }));
    setGroups((current) =>
      current.map((group) =>
        group.id === targetGroupId
          ? { ...group, tabs: [...group.tabs, id], activeId: id }
          : group,
      ),
    );
    setActiveGroupId(targetGroupId);
    setEditingKey(`${targetGroupId}:${id}`);
  }

  function openLocalDraft(id: string, targetGroupId = activeGroupId) {
    const existingGroup = groups.find((group) => group.tabs.includes(id));
    if (existingGroup) {
      activateTab(existingGroup.id, id);
      setEditingKey(`${existingGroup.id}:${id}`);
      return;
    }
    setGroups((current) =>
      current.map((group) =>
        group.id === targetGroupId
          ? { ...group, tabs: [...group.tabs, id], activeId: id }
          : group,
      ),
    );
    setActiveGroupId(targetGroupId);
    setEditingKey(`${targetGroupId}:${id}`);
  }

  function closeTab(groupId: string, documentId: string) {
    setGroups((current) => closeGroupTab(current, groupId, documentId));
    setEditingKey((current) =>
      current === `${groupId}:${documentId}` ? null : current,
    );
  }

  function splitWorkspace() {
    if (groups.length === 2) return;
    const source =
      groups.find((group) => group.id === activeGroupId) || groups[0];
    const newGroupId = source.id === "primary" ? "secondary" : "primary";
    setGroups((current) => [
      ...current,
      { id: newGroupId, tabs: [], activeId: null, previewId: null },
    ]);
    setActiveGroupId(newGroupId);
  }

  function closeGroup(groupId: string) {
    const merged = mergeClosedGroup(groups, groupId);
    if (!merged) return;
    setGroups([merged]);
    setActiveGroupId(merged.id);
    setEditingKey(null);
  }

  function moveTabToGroup(
    documentId: string,
    sourceGroupId: string,
    targetGroupId: string,
  ) {
    if (sourceGroupId === targetGroupId) return;
    setGroups((current) =>
      moveGroupTab(current, documentId, sourceGroupId, targetGroupId),
    );
    setActiveGroupId(targetGroupId);
    setEditingKey(null);
  }

  return {
    groups,
    setGroups,
    activeGroupId,
    setActiveGroupId,
    titleForId,
    activateTab,
    pinTab,
    createNewTab,
    openLocalDraft,
    closeTab,
    splitWorkspace,
    closeGroup,
    moveTabToGroup,
  };
}
