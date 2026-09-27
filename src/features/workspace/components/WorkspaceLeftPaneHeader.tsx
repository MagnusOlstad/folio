import { FolioBrand } from "../../status/WorkspaceStatus.tsx";
import type { VersionInfo } from "../../../domain/types.ts";

type WorkspaceLeftPaneHeaderProps = {
  versionInfo: VersionInfo | null;
  onOpenSettings: () => void;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
};

export function WorkspaceLeftPaneHeader({
  versionInfo,
  onOpenSettings,
  sidebarOpen,
  onToggleSidebar,
}: WorkspaceLeftPaneHeaderProps) {
  return (
    <header className="sidebar-app-header">
      <FolioBrand versionInfo={versionInfo} />
      <button type="button" className="sidebar-settings-button" onClick={onOpenSettings}>
        Settings
      </button>
      <button
        type="button"
        className="pane-toggle pane-toggle-left"
        onClick={onToggleSidebar}
        aria-label={`${sidebarOpen ? "Hide" : "Show"} left sidebar`}
        title={`${sidebarOpen ? "Hide" : "Show"} left sidebar`}
      >
        <span aria-hidden="true">{sidebarOpen ? "‹" : "›"}</span>
      </button>
    </header>
  );
}
