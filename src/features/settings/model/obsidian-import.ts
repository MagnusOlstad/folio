export type ObsidianImportCounts = {
  new: number;
  imported: number;
  changed: number;
  retryable: number;
  invalid: number;
  attachments: number;
};

export type ObsidianImportScan = {
  id: string;
  vaultId: string;
  name: string;
  provider: "electron" | "browser";
  total: number;
  counts: ObsidianImportCounts;
  requiredUploads: string[];
};

export type ObsidianImportPhase =
  | "staging"
  | "planning"
  | "writing"
  | "indexing"
  | "completed"
  | "cancelled"
  | "failed";

export type ObsidianImportJob = {
  id: string;
  scanId: string;
  phase: ObsidianImportPhase;
  processed: number;
  total: number;
  imported: number;
  failed: number;
  unresolvedLinks: number;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
};

export type BrowserVaultSelection = {
  scan: ObsidianImportScan;
  files: Map<string, File>;
};

export type ObsidianImportSettings = {
  supported: boolean;
  busy: boolean;
  scan: ObsidianImportScan | null;
  job: ObsidianImportJob | null;
  error: string;
  selectVault: () => void;
  confirmImport: () => void;
  cancelImport: () => void;
  clearScan: () => void;
};

declare global {
  interface FolioBridge {
      onMenuAction?: (handler: (action: string) => void) => () => void;
      getStorage?: (key: string) => string | null;
      setStorage?: (key: string, value: string) => void;
      removeStorage?: (key: string) => void;
      closeWindow?: () => void;
      saveMarkdownExport?: (
        filename: string,
        content: string,
      ) => Promise<{ canceled: boolean }>;
      savePdfExport?: (filename: string) => Promise<{ canceled: boolean }>;
      selectObsidianVault?: () => Promise<ObsidianImportScan | null>;
      startObsidianImport?: (scanId: string) => Promise<ObsidianImportJob>;
      getObsidianImportJob?: (jobId: string) => Promise<ObsidianImportJob>;
      cancelObsidianImport?: (jobId: string) => Promise<ObsidianImportJob>;
  }
  interface Window { folio?: FolioBridge }
}
