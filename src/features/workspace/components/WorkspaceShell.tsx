import { useState } from "react";
import type { CSSProperties, PointerEvent } from "react";
import { SettingsDialog } from "../../settings/components/SettingsDialog.tsx";
import type { SettingsDialogProps } from "../../settings/components/SettingsDialog.tsx";
import { WorkspaceSidebar } from "../../sidebar/WorkspaceSidebar.tsx";
import type { WorkspaceSidebarProps } from "../../sidebar/WorkspaceSidebar.tsx";
import type { NoteHistorySnapshot, VersionInfo } from "../../../domain/types.ts";
import type { WorkspaceStatusProps } from "../../status/WorkspaceStatus.tsx";
import { EditorWorkspace } from "./EditorWorkspace.tsx";
import type { EditorWorkspaceProps } from "../types.ts";
import { WorkspaceSidebarHandle } from "./WorkspaceSidebarHandle.tsx";
import { NoteExportPreview } from "./NoteExportPreview.tsx";
import { WorkspaceRightPane } from "./WorkspaceRightPane.tsx";
import { WorkspaceLeftPaneHeader } from "./WorkspaceLeftPaneHeader.tsx";
import type { NoteExportSnapshot } from "../model/note-export.ts";
import { NoteHistoryPanel } from "./NoteHistoryPanel.tsx";
import { isUntitledId } from "../../../lib/workspace.ts";
import type { SettingsCategory } from "../../settings/model/settings-category.ts";

type WorkspaceAppProps = WorkspaceStatusProps & {
  versionInfo: VersionInfo | null;
  onOpenSettings: (category?: SettingsCategory) => void;
};

export type WorkspaceShellProps = {
  app: WorkspaceAppProps;
  settings: SettingsDialogProps & { open: boolean };
  sidebar: WorkspaceSidebarProps;
  editor: EditorWorkspaceProps;
  exportPreview: NoteExportSnapshot | null;
  layout: {
    sidebarWidth: number | null;
    rightPaneWidth: number | null;
    sidebarOpen: boolean;
    rightPaneOpen: boolean;
    setSidebarOpen: (open: boolean) => void;
    setRightPaneOpen: (open: boolean) => void;
    beginHorizontalResize: (event: PointerEvent<HTMLElement>) => void;
    finishHorizontalResize: (event: PointerEvent<HTMLElement>) => void;
    resizeSidebar: (clientX: number, handle: HTMLElement) => void;
    resizeRightPane: (clientX: number, handle: HTMLElement) => void;
    resetSidebar: () => void;
    resetRightPane: () => void;
  };
  historyCheckpoint?: { documentId: string; scopeId: string; revision: number } | null;
  historyScopeId?: string;
};

export function WorkspaceShell({
  app,
  settings,
  sidebar,
  editor,
  exportPreview,
  layout,
  historyCheckpoint,
  historyScopeId,
}: WorkspaceShellProps) {
  const activeGroup = editor.model.groups.find((group) => group.id === editor.model.activeGroupId);
  const activeDocumentId = activeGroup?.activeId ?? null;
  const activeDocument = activeDocumentId ? editor.model.documents[activeDocumentId] : null;
  const historyAvailable = Boolean(activeDocumentId && activeDocument && !editor.model.loadingDocuments.has(activeDocumentId)
    && activeDocument.deletable && !isUntitledId(activeDocumentId));
  const scope = `${historyScopeId ?? ""}:\0${activeGroup?.id ?? ""}:\0${activeDocumentId ?? ""}:\0${layout.rightPaneOpen}:\0${historyAvailable}`;
  const [history, setHistory] = useState<{ scope: string; snapshot: NoteHistorySnapshot | null; loading: boolean; failed: boolean }>(
    { scope, snapshot: null, loading: false, failed: false },
  );
  if (history.scope !== scope) {
    setHistory({ scope, snapshot: null, loading: false, failed: false });
  }
  const historyContent = historyAvailable && activeDocumentId ? (
    <NoteHistoryPanel
      key={`${historyScopeId ?? ""}:${activeGroup?.id}:${activeDocumentId}`}
      documentId={activeDocumentId}
      checkpointRevision={historyCheckpoint?.documentId === activeDocumentId && historyCheckpoint.scopeId === historyScopeId ? historyCheckpoint.revision : 0}
      onBeforeRestore={editor.actions.beforeHistoryRestore}
      onRestored={editor.actions.historyRestored}
      onRestoreFeedback={editor.actions.notifyMessage}
      onPreview={(snapshot, loading, failed) => setHistory((current) => current.scope === scope ? { ...current, snapshot, loading, failed } : current)}
    />
  ) : !activeDocumentId ? (
    <p className="right-pane-placeholder">Open a filed note to see its history.</p>
  ) : editor.model.loadingDocuments.has(activeDocumentId) ? (
    <p className="right-pane-placeholder" role="status">Loading note…</p>
  ) : isUntitledId(activeDocumentId) ? (
    <p className="right-pane-placeholder">Drafts do not have history.</p>
  ) : (
    <p className="right-pane-placeholder">Open a filed note to see its history.</p>
  );
  return (
    <main className="shell">
      <section
        className={`workspace${layout.sidebarOpen ? "" : " sidebar-hidden"}${layout.rightPaneOpen ? "" : " right-pane-hidden"}`}
        id="workspace"
        style={{
          ...(layout.sidebarWidth === null ? {} : { "--sidebar-width": `${layout.sidebarWidth}px` }),
          ...(layout.rightPaneWidth === null ? {} : { "--right-pane-width": `${layout.rightPaneWidth}px` }),
        } as CSSProperties}
      >
        {layout.sidebarOpen ? (
          <aside className="workspace-left-pane">
            <WorkspaceLeftPaneHeader
              versionInfo={app.versionInfo}
              onOpenSettings={() => app.onOpenSettings()}
              sidebarOpen={layout.sidebarOpen}
              onToggleSidebar={() => layout.setSidebarOpen(false)}
            />
            <WorkspaceSidebar {...sidebar} />
          </aside>
        ) : null}
        {layout.sidebarOpen ? (
          <WorkspaceSidebarHandle
            width={layout.sidebarWidth}
            onPointerDown={layout.beginHorizontalResize}
            onResize={layout.resizeSidebar}
            onPointerEnd={layout.finishHorizontalResize}
            onReset={layout.resetSidebar}
          />
        ) : null}
        <EditorWorkspace
          {...editor}
          historyPreview={history.scope === scope && (history.snapshot !== null || history.loading || history.failed) && activeGroup && activeDocumentId && activeDocument ? { groupId: activeGroup.id, documentId: activeDocumentId, snapshot: history.snapshot, loading: history.loading, failed: history.failed, presentContent: editor.model.drafts[activeDocumentId] ?? activeDocument.content } : undefined}
          paneControls={{
            leftOpen: layout.sidebarOpen,
            rightOpen: layout.rightPaneOpen,
            onToggleLeft: () => layout.setSidebarOpen(!layout.sidebarOpen),
            onToggleRight: () => layout.setRightPaneOpen(!layout.rightPaneOpen),
          }}
        />
        {layout.rightPaneOpen ? (
          <WorkspaceSidebarHandle
            width={layout.rightPaneWidth}
            side="right"
            onPointerDown={layout.beginHorizontalResize}
            onResize={layout.resizeRightPane}
            onPointerEnd={layout.finishHorizontalResize}
            onReset={layout.resetRightPane}
          />
        ) : null}
        {layout.rightPaneOpen ? (
          <WorkspaceRightPane
            {...app}
            onHide={() => layout.setRightPaneOpen(false)}
            historyContent={historyContent}
          />
        ) : null}
      </section>
      {exportPreview ? <NoteExportPreview snapshot={exportPreview} /> : null}
      {settings.open ? (
        <SettingsDialog
          themeId={settings.themeId}
          onSelectTheme={settings.onSelectTheme}
          obsidianImport={settings.obsidianImport}
          bundleSetup={settings.bundleSetup}
          modelSettings={settings.modelSettings}
          initialCategory={settings.initialCategory}
          onClose={settings.onClose}
        />
      ) : null}
    </main>
  );
}
