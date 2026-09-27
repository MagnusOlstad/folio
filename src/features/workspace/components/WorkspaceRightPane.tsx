import { OllamaStatus } from "../../status/WorkspaceStatus.tsx";
import type { WorkspaceStatusProps } from "../../status/WorkspaceStatus.tsx";

type WorkspaceRightPaneProps = WorkspaceStatusProps;

/** A deliberately empty extension surface for future workspace tools. */
export function WorkspaceRightPane(props: WorkspaceRightPaneProps) {
  return (
    <aside className="workspace-right-pane" aria-label="Workspace tools">
      <div className="right-pane-content" />
      <footer className="right-pane-status"><OllamaStatus {...props} /></footer>
    </aside>
  );
}
