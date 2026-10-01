import { useEffect, useRef } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type {
  BundleFile,
  BundleDirectory,
  MlxStatus,
  Note,
  StoredDraft,
  VersionInfo,
} from "../../../domain/types.ts";
import type { BundleRegistryResponse } from "../../../domain/types.ts";
import { api, apiWithRetry } from "../../../lib/api.ts";
import { expandedPathsForFiles } from "../../../lib/workspace.ts";

type UseWorkspaceBootstrapOptions = {
  setMlxStatus: Dispatch<SetStateAction<MlxStatus | null>>;
  setFilesLoading: Dispatch<SetStateAction<boolean>>;
  setMessage: Dispatch<SetStateAction<string>>;
  setNotes: Dispatch<SetStateAction<Note[]>>;
  setFiles: Dispatch<SetStateAction<BundleFile[]>>;
  setDirectories: Dispatch<SetStateAction<BundleDirectory[]>>;
  setVersionInfo: Dispatch<SetStateAction<VersionInfo | null>>;
  mergeRemoteDrafts: (drafts: StoredDraft[]) => void;
  expandedDirectoriesReadyRef: MutableRefObject<boolean>;
  setExpandedDirectories: Dispatch<SetStateAction<Set<string>>>;
  setExpandedDirectoriesReady: Dispatch<SetStateAction<boolean>>;
  onWorkspaceDataReady?: () => void;
  onNoBundle?: () => void;
  enabled: boolean;
};

export function useWorkspaceBootstrap(options: UseWorkspaceBootstrapOptions) {
  const latestOptionsRef = useRef(options);
  useEffect(() => {
    latestOptionsRef.current = options;
  }, [options]);
  const { enabled } = options;

  useEffect(() => {
    if (!enabled) return;
    const latest = () => latestOptionsRef.current;
    let cancelled = false;
    let reconnectTimer = 0;
    const reconnectMessage =
      "The local Folio service is still starting. Reconnecting automatically.";

    const loadWorkspace = async () => {
      try {
        const registry = await api<BundleRegistryResponse>("/api/bundles");
        if (!registry.bundles.length) {
          if (cancelled) return;
          latest().setMlxStatus(null);
          latest().setNotes([]);
          latest().setFiles([]);
          latest().setDirectories([]);
          latest().setFilesLoading(false);
          latest().onNoBundle?.();
          return;
        }
        const currentStatus = await apiWithRetry<MlxStatus>("/api/mlx/status");
        if (cancelled) return;
        latest().setMlxStatus(currentStatus);
      } catch {
        if (cancelled) return;
        latest().setFilesLoading(false);
        latest().setMlxStatus(null);
        latest().setMessage(reconnectMessage);
        reconnectTimer = window.setTimeout(loadWorkspace, 2_000);
        return;
      }
      const [notesResult, filesResult, directoriesResult, draftsResult, versionResult] =
        await Promise.allSettled([
          api<Note[]>("/api/notes"),
          api<BundleFile[]>("/api/files"),
          api<BundleDirectory[]>("/api/directories"),
          api<StoredDraft[]>("/api/drafts"),
          api<VersionInfo>("/api/version"),
        ]);
      if (cancelled) return;
      if (notesResult.status === "fulfilled") latest().setNotes(notesResult.value);
      if (filesResult.status === "fulfilled") {
        latest().setFiles(filesResult.value);
        if (!latest().expandedDirectoriesReadyRef.current) {
          const hasStarterGuides = filesResult.value.some(
            (file) => file.id === "/getting-started/start-here.md",
          );
          latest().expandedDirectoriesReadyRef.current = true;
          latest().setExpandedDirectories(
            hasStarterGuides
              ? expandedPathsForFiles(filesResult.value)
              : new Set(),
          );
          latest().setExpandedDirectoriesReady(true);
        }
      }
      if (directoriesResult.status === "fulfilled") latest().setDirectories(directoriesResult.value);
      if (versionResult.status === "fulfilled")
        latest().setVersionInfo(versionResult.value);
      if (draftsResult.status === "fulfilled")
        latest().mergeRemoteDrafts(draftsResult.value);
      if (notesResult.status === "fulfilled" && filesResult.status === "fulfilled" && directoriesResult.status === "fulfilled")
        latest().onWorkspaceDataReady?.();
      latest().setFilesLoading(false);
      if (
        notesResult.status === "rejected" ||
        filesResult.status === "rejected" ||
        directoriesResult.status === "rejected"
      ) {
        latest().setMessage(reconnectMessage);
        reconnectTimer = window.setTimeout(loadWorkspace, 2_000);
      } else {
        latest().setMessage((current) => (current === reconnectMessage ? "" : current));
      }
    };
    void loadWorkspace();

    const refreshStatus = () => {
      api<MlxStatus>("/api/mlx/status")
        .then(latest().setMlxStatus)
        .catch(() => latest().setMlxStatus(null));
      // Keep the existing status endpoint active: it reports semantic-index
      // coverage and queues missing embeddings only while EmbeddingGemma is
      // already loaded. This never triggers installation or model loading.
      void api("/api/status").catch(() => {});
    };
    const interval = window.setInterval(refreshStatus, 10_000);
    return () => {
      cancelled = true;
      window.clearTimeout(reconnectTimer);
      window.clearInterval(interval);
    };
    // Bootstrap starts once registry resolution has selected the active bundle.
  }, [enabled]);
}
