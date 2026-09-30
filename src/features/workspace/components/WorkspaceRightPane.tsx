import type { ReactNode } from "react";
import { OllamaStatus } from "../../status/WorkspaceStatus.tsx";
import type { WorkspaceStatusProps } from "../../status/WorkspaceStatus.tsx";

type WorkspaceRightPaneProps = WorkspaceStatusProps & {
  onHide: () => void;
  historyContent?: ReactNode;
};

/** A deliberately empty extension surface for future workspace tools. */
export function WorkspaceRightPane({ onHide, historyContent, ...props }: WorkspaceRightPaneProps) {
  return (
    <aside className="workspace-right-pane" aria-label="Workspace tools">
      <header className="right-pane-header">
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
      <div className="right-pane-content">{historyContent}</div>
      <footer className="right-pane-status"><OllamaStatus {...props} /></footer>
    </aside>
  );
}
