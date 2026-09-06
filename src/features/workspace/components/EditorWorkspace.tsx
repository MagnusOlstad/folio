import { Fragment } from "react";
import type { CSSProperties } from "react";
import { useWorkspaceEditorUi } from "../hooks/useWorkspaceEditorUi.ts";
import { EditorGroup } from "./EditorGroup.tsx";
import type { EditorWorkspaceProps } from "../types.ts";
import { WorkspaceSplitHandle } from "./WorkspaceSplitHandle.tsx";

export function EditorWorkspace({ model, actions }: EditorWorkspaceProps) {
  const ui = useWorkspaceEditorUi();
  const groupModel = {
    activeGroupId: model.activeGroupId,
    documents: model.documents,
    loadingDocuments: model.loadingDocuments,
    savingDocuments: model.savingDocuments,
    editingKey: model.editingKey,
    editorIntents: model.editorIntents,
    drafts: model.drafts,
    deletingNoteId: model.deletingNoteId,
    movingFileId: model.movingFileId,
  };
  const groupActions = {
    activateGroup: actions.activateGroup,
    moveTabToGroup: actions.moveTabToGroup,
    titleForId: actions.titleForId,
    activateTab: actions.activateTab,
    createNewTab: actions.createNewTab,
    splitWorkspace: actions.splitWorkspace,
    closeGroup: actions.closeGroup,
    closeTab: actions.closeTab,
    changeDraftContent: actions.changeDraftContent,
    fileDraft: actions.fileDraft,
    beginEditing: actions.beginEditing,
    finishEditing: actions.finishEditing,
    restoreReaderScroll: actions.restoreReaderScroll,
    openDocument: actions.openDocument,
    toggleTaskCheckbox: actions.toggleTaskCheckbox,
    deleteFiledNote: actions.deleteFiledNote,
    persistDocument: actions.persistDocument,
    persistMetadata: actions.persistMetadata,
    moveBundleFile: actions.moveBundleFile,
  };

  return (
    <section
      className={`editor-workspace ${model.groups.length === 2 ? "is-split" : ""}`}
      style={
        {
          "--split-position": `${model.splitPosition}%`,
        } as CSSProperties
      }
    >
      {model.groups.map((group, groupIndex) => (
        <Fragment key={group.id}>
          {groupIndex === 1 && (
            <WorkspaceSplitHandle
              splitPosition={model.splitPosition}
              onPointerDown={actions.beginHorizontalResize}
              onResize={actions.resizeSplit}
              onPointerEnd={actions.finishHorizontalResize}
              onReset={actions.resetSplit}
            />
          )}
          <EditorGroup
            group={group}
            groupCount={model.groups.length}
            model={groupModel}
            actions={groupActions}
            ui={ui}
          />
        </Fragment>
      ))}
      {model.message && (
        <button
          type="button"
          className="workspace-message"
          onClick={actions.dismissMessage}
          title="Dismiss"
          role="status"
          aria-live="polite"
        >
          {model.message}
        </button>
      )}
    </section>
  );
}
