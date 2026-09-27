import type { CSSProperties, PointerEvent } from "react";
import { SettingsDialog } from "../../settings/components/SettingsDialog.tsx";
import type { SettingsDialogProps } from "../../settings/components/SettingsDialog.tsx";
import { WorkspaceSidebar } from "../../sidebar/WorkspaceSidebar.tsx";
import type { WorkspaceSidebarProps } from "../../sidebar/WorkspaceSidebar.tsx";
import type { VersionInfo } from "../../../domain/types.ts";
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

type WorkspaceAppProps = WorkspaceStatusProps & {
  versionInfo: VersionInfo | null;
  onOpenSettings: () => void;
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
};

export function WorkspaceShell({
  app,
  settings,
  sidebar,
  editor,
  exportPreview,
  layout,
}: WorkspaceShellProps) {
  const activeGroup = editor.model.groups.find((group) => group.id === editor.model.activeGroupId);
  const activeDocumentId = activeGroup?.activeId ?? null;
  const activeDocument = activeDocumentId ? editor.model.documents[activeDocumentId] : null;
  const historyContent = !activeDocumentId ? (
    <p className="right-pane-placeholder">Open a filed note to see its history.</p>
  ) : activeDocument && activeDocument.deletable && !isUntitledId(activeDocumentId) ? (
    <NoteHistoryPanel
      key={activeDocumentId}
      documentId={activeDocumentId}
      onBeforeRestore={editor.actions.beforeHistoryRestore}
      onRestored={editor.actions.historyRestored}
    />
  ) : editor.model.loadingDocuments.has(activeDocumentId) ? (
    <p className="right-pane-placeholder" role="status">Loading note…</p>
  ) : (
    <p className="right-pane-placeholder">History is available for filed notes.</p>
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
              onOpenSettings={app.onOpenSettings}
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
          onClose={settings.onClose}
        />
      ) : null}
    </main>
  );
}
