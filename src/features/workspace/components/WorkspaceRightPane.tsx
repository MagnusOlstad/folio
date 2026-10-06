import { useState } from "react";
import type { ReactNode } from "react";
import { DesktopUpdateControls, MlxModelStatusPanel } from "../../status/WorkspaceStatus.tsx";
import type { WorkspaceStatusProps } from "../../status/WorkspaceStatus.tsx";
import type { DesktopUpdateState, VersionInfo } from "../../../domain/types.ts";
import { TranscriptionDock } from "../../transcription/components/TranscriptionDock.tsx";
import type { TranscriptionDockProps } from "../../transcription/components/TranscriptionDock.tsx";
import { useModelPanelCollapse } from "../hooks/useModelPanelCollapse.ts";
import { usePanelHeightResize } from "../hooks/usePanelHeightResize.ts";
import { PanelHeightHandle } from "./PanelHeightHandle.tsx";

type WorkspaceRightPaneProps = WorkspaceStatusProps & {
  onHide: () => void;
  versionInfo?: VersionInfo | null;
  updateState?: DesktopUpdateState | null;
  historyContent?: ReactNode;
  transcription: TranscriptionDockProps;
};

export function WorkspaceRightPane({ onHide, historyContent, transcription, versionInfo = null, updateState = null, ...props }: WorkspaceRightPaneProps) {
  const [activeTab, setActiveTab] = useState<"history" | "transcription">("history");
  const { collapsed, toggleCollapsed } = useModelPanelCollapse();
  const { height: statusPanelHeight, minHeight, maxHeight, panelRef, onPointerDown, onPointerMove, onPointerUp, onKeyDown } = usePanelHeightResize(collapsed);
  return (
    <aside className="workspace-right-pane" aria-label="Workspace tools">
      <header className="right-pane-header">
        <DesktopUpdateControls versionInfo={versionInfo} updateState={updateState} />
        <button
          type="button"
          className="pane-toggle pane-toggle-right"
          onClick={onHide}
          aria-label="Hide right sidebar"
          title="Hide right sidebar"
        >
          <svg aria-hidden="true" viewBox="0 0 16 16" focusable="false">
            <rect x="2.25" y="2.25" width="11.5" height="11.5" rx="1.5" />
            <path d="M10 2.75v10.5" />
          </svg>
        </button>
      </header>
      <div className="sidebar-tabs right-pane-tabs" role="tablist" aria-label="Workspace tools">
        <button type="button" role="tab" className={activeTab === "history" ? "active" : ""} aria-selected={activeTab === "history"} onClick={() => setActiveTab("history")}>History</button>
        <button type="button" role="tab" className={activeTab === "transcription" ? "active" : ""} aria-selected={activeTab === "transcription"} onClick={() => setActiveTab("transcription")}>Transcription</button>
      </div>
      <div className="right-pane-content" role="tabpanel" aria-label={activeTab === "history" ? "History" : "Transcription"}>
        {activeTab === "history" ? historyContent : <TranscriptionDock {...transcription} />}
      </div>
      <footer className={`right-pane-status${statusPanelHeight !== null ? " is-resized" : ""}`} ref={panelRef} style={{ height: statusPanelHeight ?? undefined }}>
        <PanelHeightHandle
          label="Resize MLX panel"
          value={statusPanelHeight}
          minHeight={minHeight}
          maxHeight={maxHeight}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onKeyDown={onKeyDown}
        />
        <MlxModelStatusPanel {...props} collapsed={collapsed} onToggleCollapsed={toggleCollapsed} />
      </footer>
    </aside>
  );
}
