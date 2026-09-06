import { useEffect } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type {
  BundleFile,
  ModelStatus,
  Note,
  StoredDraft,
  VersionInfo,
} from "../../../domain/types.ts";
import { api, apiWithRetry } from "../../../lib/api.ts";
import { expandedPathsForFiles } from "../../../lib/workspace.ts";

type UseWorkspaceBootstrapOptions = {
  setStatus: Dispatch<SetStateAction<ModelStatus | null>>;
  setFilesLoading: Dispatch<SetStateAction<boolean>>;
  setMessage: Dispatch<SetStateAction<string>>;
  setNotes: Dispatch<SetStateAction<Note[]>>;
  setFiles: Dispatch<SetStateAction<BundleFile[]>>;
  setVersionInfo: Dispatch<SetStateAction<VersionInfo | null>>;
  mergeRemoteDrafts: (drafts: StoredDraft[]) => void;
  expandedDirectoriesReadyRef: MutableRefObject<boolean>;
  setExpandedDirectories: Dispatch<SetStateAction<Set<string>>>;
  setExpandedDirectoriesReady: Dispatch<SetStateAction<boolean>>;
};

export function useWorkspaceBootstrap({
  setStatus,
  setFilesLoading,
  setMessage,
  setNotes,
  setFiles,
  setVersionInfo,
  mergeRemoteDrafts,
  expandedDirectoriesReadyRef,
  setExpandedDirectories,
  setExpandedDirectoriesReady,
}: UseWorkspaceBootstrapOptions) {
  useEffect(() => {
    let cancelled = false;
    let reconnectTimer = 0;
    const reconnectMessage =
      "The local Folio service is still starting. Reconnecting automatically.";

    const loadWorkspace = async () => {
      try {
        const currentStatus = await apiWithRetry<ModelStatus>("/api/status");
        if (cancelled) return;
        setStatus(currentStatus);
      } catch {
        if (cancelled) return;
        setFilesLoading(false);
        setStatus(null);
        setMessage(reconnectMessage);
        reconnectTimer = window.setTimeout(loadWorkspace, 2_000);
        return;
      }
      const [notesResult, filesResult, draftsResult, versionResult] =
        await Promise.allSettled([
          api<Note[]>("/api/notes"),
          api<BundleFile[]>("/api/files"),
          api<StoredDraft[]>("/api/drafts"),
          api<VersionInfo>("/api/version"),
        ]);
      if (cancelled) return;
      if (notesResult.status === "fulfilled") setNotes(notesResult.value);
      if (filesResult.status === "fulfilled") {
        setFiles(filesResult.value);
        if (!expandedDirectoriesReadyRef.current) {
          const hasStarterGuides = filesResult.value.some(
            (file) => file.id === "/getting-started/start-here.md",
          );
          expandedDirectoriesReadyRef.current = true;
          setExpandedDirectories(
            hasStarterGuides
              ? expandedPathsForFiles(filesResult.value)
              : new Set(),
          );
          setExpandedDirectoriesReady(true);
        }
      }
      if (versionResult.status === "fulfilled")
        setVersionInfo(versionResult.value);
      if (draftsResult.status === "fulfilled")
        mergeRemoteDrafts(draftsResult.value);
      setFilesLoading(false);
      if (
        notesResult.status === "rejected" ||
        filesResult.status === "rejected"
      ) {
        setMessage(reconnectMessage);
        reconnectTimer = window.setTimeout(loadWorkspace, 2_000);
      } else {
        setMessage((current) => (current === reconnectMessage ? "" : current));
      }
    };
    void loadWorkspace();

    const refreshStatus = () => {
      api<ModelStatus>("/api/status")
        .then(setStatus)
        .catch(() => setStatus(null));
    };
    const interval = window.setInterval(refreshStatus, 10_000);
    return () => {
      cancelled = true;
      window.clearTimeout(reconnectTimer);
      window.clearInterval(interval);
    };
    // The bootstrap behavior deliberately runs only once per controller mount.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
