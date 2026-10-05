import { FolioBrand } from "../../status/WorkspaceStatus.tsx";

type WorkspaceLeftPaneHeaderProps = {
  onOpenSettings: () => void;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
};

export function WorkspaceLeftPaneHeader({
  onOpenSettings,
  sidebarOpen,
  onToggleSidebar,
}: WorkspaceLeftPaneHeaderProps) {
  return (
    <header className="sidebar-app-header">
      <FolioBrand />
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
        <svg aria-hidden="true" viewBox="0 0 16 16" focusable="false">
          <rect x="2.25" y="2.25" width="11.5" height="11.5" rx="1.5" />
          <path d="M6 2.75v10.5" />
        </svg>
      </button>
    </header>
  );
}
