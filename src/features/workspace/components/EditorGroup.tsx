import type { TabGroup } from "../../../domain/types.ts";
import type { WorkspaceEditorUi } from "../hooks/useWorkspaceEditorUi.ts";
import { isUntitledId } from "../../../lib/workspace.ts";
import { EditorTabs } from "../../tabs/EditorTabs.tsx";
import { DocumentPane } from "./DocumentPane.tsx";
import { DocumentView } from "./DocumentView.tsx";
import type {
  EditorWorkspaceActions,
  EditorWorkspaceModel,
} from "../types.ts";

type EditorGroupProps = {
  group: TabGroup;
  groupCount: number;
  model: Omit<EditorWorkspaceModel, "groups" | "splitPosition" | "message">;
  actions: Omit<
    EditorWorkspaceActions,
    | "beginHorizontalResize"
    | "resizeSplit"
    | "finishHorizontalResize"
    | "resetSplit"
    | "dismissMessage"
  >;
  ui: WorkspaceEditorUi;
};

export function EditorGroup({
  group,
  groupCount,
  model,
  actions,
  ui,
}: EditorGroupProps) {
  const document = group.activeId ? model.documents[group.activeId] : null;
  const loading = Boolean(
    group.activeId && model.loadingDocuments.has(group.activeId),
  );
  const editKey = document ? `${group.id}:${document.id}` : "";
  const saving = Boolean(document && model.savingDocuments.has(document.id));

  return (
    <section
      className={`editor-group ${model.activeGroupId === group.id ? "active" : ""} ${ui.dropGroupId === group.id ? "drop-target" : ""}`}
      onMouseDown={() => actions.activateGroup(group.id)}
      onDragOver={(event) => {
        if (!ui.draggedTab) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        ui.setDropGroupId(group.id);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node))
          ui.setDropGroupId(null);
      }}
      onDrop={(event) => {
        event.preventDefault();
        const payload = event.dataTransfer.getData("application/x-folio-tab");
        let tab = ui.draggedTab;
        if (payload) {
          try {
            const parsed = JSON.parse(payload) as {
              documentId?: unknown;
              groupId?: unknown;
            };
            if (
              typeof parsed.documentId === "string" &&
              typeof parsed.groupId === "string"
            ) {
              tab = {
                documentId: parsed.documentId,
                groupId: parsed.groupId,
              };
            }
          } catch {
            tab = null;
          }
        }
        if (tab)
          actions.moveTabToGroup(tab.documentId, tab.groupId, group.id);
        ui.setDraggedTab(null);
        ui.setDropGroupId(null);
      }}
    >
      <EditorTabs
        group={group}
        groupCount={groupCount}
        savingDocumentIds={model.savingDocuments}
        titleForId={actions.titleForId}
        isUntitledId={isUntitledId}
        onActivate={actions.activateTab}
        onDragStart={(event, id, groupId) => {
          const payload = { documentId: id, groupId };
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData(
            "application/x-folio-tab",
            JSON.stringify(payload),
          );
          ui.setDraggedTab(payload);
        }}
        onDragEnd={() => {
          ui.setDraggedTab(null);
          ui.setDropGroupId(null);
        }}
        onCloseTab={actions.closeTab}
        onNewTab={actions.createNewTab}
        onSplit={actions.splitWorkspace}
        onCloseGroup={actions.closeGroup}
      />

      <DocumentPane
        groupId={group.id}
        hasDocument={Boolean(document)}
        loading={loading}
        onCreateNewTab={actions.createNewTab}
      >
        {document && (
          <DocumentView
            groupId={group.id}
            document={document}
            editKey={editKey}
            draft={model.drafts[document.id]}
            saving={saving}
            deletingNoteId={model.deletingNoteId}
            movingFileId={model.movingFileId}
            editingMetadataKey={ui.editingMetadataKey}
            metadataDrafts={ui.metadataDrafts}
            pathDraft={ui.pathDrafts[document.id]}
            tagDraft={ui.tagDrafts[document.id]}
            onBeginMetadataEditing={ui.beginMetadataEditing}
            onChangeMetadataDraft={ui.changeMetadataDraft}
            onFinishMetadataEditing={(key, target, field, value) =>
              ui.finishMetadataEditing(
                key,
                target,
                field,
                value,
                actions.persistMetadata,
              )
            }
            onChangeContent={actions.changeDraftContent}
            onFileDraft={actions.fileDraft}
            onBeginEditing={actions.beginEditing}
            onFinishEditing={actions.finishEditing}
            onOpenDocument={actions.openDocument}
            onToggleTask={actions.toggleTaskCheckbox}
            onBeginPathEditing={ui.beginPathEditing}
            onChangePath={ui.changePathDraft}
            onFinishPathEditing={(target, value) =>
              ui.finishPathEditing(target, value, actions.moveBundleFile)
            }
            onResetPath={ui.resetPathDraft}
            onBeginTagEditing={ui.beginTagEditing}
            onChangeTag={ui.changeTagDraft}
            onFinishTagEditing={(target, value) =>
              ui.finishTagEditing(target, value, (edited, _content, tags) =>
                actions.persistDocument(
                  edited,
                  model.drafts[edited.id] ?? edited.content,
                  tags,
                ),
              )
            }
            onDelete={actions.deleteFiledNote}
          />
        )}
      </DocumentPane>
    </section>
  );
}
