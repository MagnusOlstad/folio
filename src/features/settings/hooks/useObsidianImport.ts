import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../../lib/api.ts";
import {
  selectBrowserObsidianVault,
  supportsBrowserVaultSelection,
  uploadBrowserVaultFiles,
} from "../model/browser-obsidian-vault.ts";
import type {
  BrowserVaultSelection,
  ObsidianImportJob,
  ObsidianImportScan,
  ObsidianImportSettings,
} from "../model/obsidian-import.ts";

const TERMINAL_PHASES = new Set(["completed", "cancelled", "failed"]);

type UseObsidianImportOptions = {
  onImportFinished?: (job: ObsidianImportJob) => void | Promise<void>;
};

export function useObsidianImport({
  onImportFinished,
}: UseObsidianImportOptions = {}): ObsidianImportSettings {
  const [scan, setScan] = useState<ObsidianImportScan | null>(null);
  const [job, setJob] = useState<ObsidianImportJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const browserSelection = useRef<BrowserVaultSelection | null>(null);
  const finishedJobIds = useRef(new Set<string>());
  const onImportFinishedRef = useRef(onImportFinished);
  const supported = Boolean(window.folio?.selectObsidianVault) || supportsBrowserVaultSelection();

  useEffect(() => {
    onImportFinishedRef.current = onImportFinished;
  }, [onImportFinished]);

  useEffect(() => {
    if (!job || TERMINAL_PHASES.has(job.phase)) return;
    const timeout = window.setTimeout(async () => {
      try {
        const next = window.folio?.getObsidianImportJob
          ? await window.folio.getObsidianImportJob(job.id)
          : await api<ObsidianImportJob>(`/api/imports/obsidian/jobs/${job.id}`);
        setJob(next);
        if (TERMINAL_PHASES.has(next.phase)) {
          setBusy(false);
          if (!finishedJobIds.current.has(next.id)) {
            finishedJobIds.current.add(next.id);
            void onImportFinishedRef.current?.(next);
          }
        }
      } catch (pollError) {
        setError(pollError instanceof Error ? pollError.message : "Could not read import progress.");
        setBusy(false);
      }
    }, 500);
    return () => window.clearTimeout(timeout);
  }, [job]);

  const selectVault = useCallback(async () => {
    setError("");
    setJob(null);
    setBusy(true);
    try {
      if (window.folio?.selectObsidianVault) {
        const next = await window.folio.selectObsidianVault();
        if (next) setScan(next);
      } else {
        const selection = await selectBrowserObsidianVault();
        browserSelection.current = selection;
        setScan(selection.scan);
      }
    } catch (selectionError) {
      if (selectionError instanceof DOMException && selectionError.name === "AbortError") return;
      setError(selectionError instanceof Error ? selectionError.message : "Could not scan the vault.");
    } finally {
      setBusy(false);
    }
  }, []);

  const confirmImport = useCallback(async () => {
    if (!scan) return;
    setBusy(true);
    setError("");
    try {
      if (scan.provider === "browser") {
        if (!browserSelection.current) throw new Error("Select the browser vault again before importing.");
        await uploadBrowserVaultFiles(browserSelection.current);
      }
      const next = window.folio?.startObsidianImport
        ? await window.folio.startObsidianImport(scan.id)
        : await api<ObsidianImportJob>(`/api/imports/obsidian/scans/${scan.id}/start`, { method: "POST" });
      setJob(next);
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : "Could not start the import.");
      setBusy(false);
    }
  }, [scan]);

  const cancelImport = useCallback(async () => {
    if (!job) return;
    try {
      const next = window.folio?.cancelObsidianImport
        ? await window.folio.cancelObsidianImport(job.id)
        : await api<ObsidianImportJob>(`/api/imports/obsidian/jobs/${job.id}/cancel`, { method: "POST" });
      setJob(next);
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : "Could not cancel the import.");
    }
  }, [job]);

  const clearScan = useCallback(() => {
    setScan(null);
    setJob(null);
    setError("");
    browserSelection.current = null;
  }, []);

  return { supported, busy, scan, job, error, selectVault, confirmImport, cancelImport, clearScan };
}
