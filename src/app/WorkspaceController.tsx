import { WorkspaceShell } from "../features/workspace/components/WorkspaceShell.tsx";
import { useWorkspaceController } from "../features/workspace/hooks/useWorkspaceController.ts";

/** Composition boundary between the app entry point and workspace feature. */
export function WorkspaceController() {
  return <WorkspaceShell {...useWorkspaceController()} />;
}
