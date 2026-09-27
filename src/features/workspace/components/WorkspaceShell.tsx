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
        <EditorWorkspace {...editor} />
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
        {!layout.sidebarOpen ? (
          <button
            type="button"
            className="pane-toggle pane-toggle-left"
            onClick={() => layout.setSidebarOpen(true)}
            aria-label="Show left sidebar"
            title="Show left sidebar"
          >
            <span aria-hidden="true">›</span>
          </button>
        ) : null}
        {layout.rightPaneOpen ? <WorkspaceRightPane {...app} /> : null}
        <button
          type="button"
          className="pane-toggle pane-toggle-right"
          onClick={() => layout.setRightPaneOpen(!layout.rightPaneOpen)}
          aria-label={`${layout.rightPaneOpen ? "Hide" : "Show"} right sidebar`}
          title={`${layout.rightPaneOpen ? "Hide" : "Show"} right sidebar`}
        >
          <span aria-hidden="true">{layout.rightPaneOpen ? "›" : "‹"}</span>
        </button>
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
