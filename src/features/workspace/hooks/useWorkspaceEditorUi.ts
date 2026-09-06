import { useState } from "react";
import type { ViewerDocument } from "../../../domain/types.ts";
import { directoryForId, normalizeDirectoryInput } from "../../../lib/paths.ts";
import { parseTags } from "../../../lib/workspace.ts";
import type {
  MetadataField,
  TabDrag,
} from "../types.ts";

export function useWorkspaceEditorUi() {
  const [draggedTab, setDraggedTab] = useState<TabDrag | null>(null);
  const [dropGroupId, setDropGroupId] = useState<string | null>(null);
  const [metadataDrafts, setMetadataDrafts] = useState<Record<string, string>>(
    {},
  );
  const [editingMetadataKey, setEditingMetadataKey] = useState<string | null>(
    null,
  );
  const [pathDrafts, setPathDrafts] = useState<Record<string, string>>({});
  const [tagDrafts, setTagDrafts] = useState<Record<string, string>>({});

  function beginMetadataEditing(
    groupId: string,
    document: ViewerDocument,
    field: MetadataField,
    saving: boolean,
  ) {
    if (
      !document.deletable ||
      saving ||
      (field === "title" && !document.movable)
    )
      return;
    const key = `${groupId}:${document.id}:${field}`;
    setMetadataDrafts((current) => ({ ...current, [key]: document[field] }));
    setEditingMetadataKey(key);
  }

  function changeMetadataDraft(key: string, value: string) {
    setMetadataDrafts((current) => ({ ...current, [key]: value }));
  }

  function finishMetadataEditing(
    key: string,
    document: ViewerDocument,
    field: MetadataField,
    value: string,
    persist: (
      document: ViewerDocument,
      field: MetadataField,
      value: string,
    ) => void,
  ) {
    setEditingMetadataKey((current) => (current === key ? null : current));
    setMetadataDrafts((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    persist(document, field, value);
  }

  function beginPathEditing(document: ViewerDocument) {
    setPathDrafts((current) => ({
      ...current,
      [document.id]: directoryForId(document.id),
    }));
  }

  function changePathDraft(documentId: string, value: string) {
    setPathDrafts((current) => ({ ...current, [documentId]: value }));
  }

  function finishPathEditing(
    document: ViewerDocument,
    value: string,
    move: (id: string, directory: string) => Promise<void>,
  ) {
    const directory = normalizeDirectoryInput(value);
    setPathDrafts((current) => {
      const next = { ...current };
      delete next[document.id];
      return next;
    });
    if (directory !== directoryForId(document.id))
      void move(document.id, directory);
  }

  function resetPathDraft(document: ViewerDocument) {
    setPathDrafts((current) => ({
      ...current,
      [document.id]: directoryForId(document.id),
    }));
  }

  function beginTagEditing(document: ViewerDocument) {
    setTagDrafts((current) => ({
      ...current,
      [document.id]: document.tags.join(", "),
    }));
  }

  function changeTagDraft(documentId: string, value: string) {
    setTagDrafts((current) => ({ ...current, [documentId]: value }));
  }

  function finishTagEditing(
    document: ViewerDocument,
    value: string,
    persist: (
      document: ViewerDocument,
      nextContent: string,
      nextTags: string[],
    ) => void,
  ) {
    const tags = parseTags(value);
    setTagDrafts((current) => {
      const next = { ...current };
      delete next[document.id];
      return next;
    });
    if (tags.join("\0") !== document.tags.join("\0"))
      persist(document, document.content, tags);
  }

  return {
    draggedTab,
    setDraggedTab,
    dropGroupId,
    setDropGroupId,
    metadataDrafts,
    editingMetadataKey,
    beginMetadataEditing,
    changeMetadataDraft,
    finishMetadataEditing,
    pathDrafts,
    beginPathEditing,
    changePathDraft,
    finishPathEditing,
    resetPathDraft,
    tagDrafts,
    beginTagEditing,
    changeTagDraft,
    finishTagEditing,
  };
}

export type WorkspaceEditorUi = ReturnType<typeof useWorkspaceEditorUi>;
