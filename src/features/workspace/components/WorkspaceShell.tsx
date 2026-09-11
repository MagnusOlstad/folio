import type { CSSProperties, PointerEvent } from "react";
import { WorkspaceSidebar } from "../../sidebar/WorkspaceSidebar.tsx";
import type { WorkspaceSidebarProps } from "../../sidebar/WorkspaceSidebar.tsx";
import { TopBar } from "../../status/TopBar.tsx";
import type { TopBarProps } from "../../status/TopBar.tsx";
import { EditorWorkspace } from "./EditorWorkspace.tsx";
import type { EditorWorkspaceProps } from "../types.ts";
import { WorkspaceSidebarHandle } from "./WorkspaceSidebarHandle.tsx";
import { NoteExportPreview } from "./NoteExportPreview.tsx";
import type { NoteExportSnapshot } from "../model/note-export.ts";

export type WorkspaceShellProps = {
  topBar: TopBarProps;
  sidebar: WorkspaceSidebarProps;
  editor: EditorWorkspaceProps;
  exportPreview: NoteExportSnapshot | null;
  layout: {
    sidebarWidth: number | null;
    beginHorizontalResize: (event: PointerEvent<HTMLElement>) => void;
    finishHorizontalResize: (event: PointerEvent<HTMLElement>) => void;
    resizeSidebar: (clientX: number, handle: HTMLElement) => void;
    resetSidebar: () => void;
  };
};

export function WorkspaceShell({
  topBar,
  sidebar,
  editor,
  exportPreview,
  layout,
}: WorkspaceShellProps) {
  return (
    <main className="shell">
      <TopBar {...topBar} />
      <section
        className="workspace"
        id="workspace"
        style={
          layout.sidebarWidth === null
            ? undefined
            : ({
                "--sidebar-width": `${layout.sidebarWidth}px`,
              } as CSSProperties)
        }
      >
        <WorkspaceSidebar {...sidebar} />
        <WorkspaceSidebarHandle
          width={layout.sidebarWidth}
          onPointerDown={layout.beginHorizontalResize}
          onResize={layout.resizeSidebar}
          onPointerEnd={layout.finishHorizontalResize}
          onReset={layout.resetSidebar}
        />
        <EditorWorkspace {...editor} />
      </section>
      {exportPreview ? <NoteExportPreview snapshot={exportPreview} /> : null}
    </main>
  );
}
