import { api } from "../../../lib/api.ts";
import type { BrowserVaultSelection, ObsidianImportScan } from "./obsidian-import.ts";

type DirectoryHandle = {
  kind: "directory";
  name: string;
  values: () => AsyncIterableIterator<DirectoryHandle | FileHandle>;
  isSameEntry: (other: DirectoryHandle) => Promise<boolean>;
};

type FileHandle = {
  kind: "file";
  name: string;
  getFile: () => Promise<File>;
};

type DirectoryPickerWindow = Window & {
  showDirectoryPicker?: () => Promise<DirectoryHandle>;
};

const IGNORED_DIRECTORIES = new Set([".obsidian", ".trash", ".git"]);

async function digest(file: File) {
  const bytes = await file.arrayBuffer();
  const result = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(result), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
}

async function collect(
  directory: DirectoryHandle,
  prefix = "",
): Promise<{ files: Map<string, File>; attachments: number }> {
  const files = new Map<string, File>();
  let attachments = 0;
  for await (const handle of directory.values()) {
    const relativePath = prefix ? `${prefix}/${handle.name}` : handle.name;
    if (handle.kind === "directory") {
      if (IGNORED_DIRECTORIES.has(handle.name) || handle.name.startsWith(".")) continue;
      const nested = await collect(handle, relativePath);
      nested.files.forEach((file, name) => files.set(name, file));
      attachments += nested.attachments;
    } else if (handle.name.toLowerCase().endsWith(".md")) {
      files.set(relativePath, await handle.getFile());
    } else {
      attachments += 1;
    }
  }
  return { files, attachments };
}

type StoredVault = { id: string; handle: DirectoryHandle };

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function vaultDatabase() {
  const request = indexedDB.open("folio-obsidian-imports", 1);
  request.onupgradeneeded = () => request.result.createObjectStore("vaults", { keyPath: "id" });
  return requestResult(request);
}

async function browserVaultId(handle: DirectoryHandle) {
  const database = await vaultDatabase();
  try {
    const stored = await requestResult(
      database.transaction("vaults", "readonly").objectStore("vaults").getAll(),
    ) as StoredVault[];
    for (const vault of stored) {
      if (await handle.isSameEntry(vault.handle)) return vault.id;
    }
    const id = crypto.randomUUID().replaceAll("-", "");
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("vaults", "readwrite");
      transaction.objectStore("vaults").put({ id, handle });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    return id;
  } finally {
    database.close();
  }
}

export function supportsBrowserVaultSelection() {
  return typeof (window as DirectoryPickerWindow).showDirectoryPicker === "function";
}

export async function selectBrowserObsidianVault(): Promise<BrowserVaultSelection> {
  const picker = (window as DirectoryPickerWindow).showDirectoryPicker;
  if (!picker) throw new Error("Folder import requires Folio for desktop or a Chromium browser.");
  const handle = await picker();
  const collected = await collect(handle);
  const descriptors = [];
  for (const [relativePath, file] of collected.files) {
    descriptors.push({
      relativePath,
      hash: await digest(file),
      size: file.size,
      mtime: new Date(file.lastModified).toISOString(),
    });
  }
  const scan = await api<ObsidianImportScan>("/api/imports/obsidian/scan", {
    method: "POST",
    body: JSON.stringify({
      vaultId: await browserVaultId(handle),
      name: handle.name,
      files: descriptors,
      attachments: collected.attachments,
    }),
  });
  return { scan, files: collected.files };
}

export async function uploadBrowserVaultFiles(selection: BrowserVaultSelection) {
  for (const relativePath of selection.scan.requiredUploads) {
      const file = selection.files.get(relativePath);
      if (!file) throw new Error(`The selected vault no longer contains ${relativePath}.`);
      const response = await fetch(
        `/api/imports/obsidian/scans/${selection.scan.id}/file?path=${encodeURIComponent(relativePath)}`,
        { method: "PUT", headers: { "content-type": "text/markdown" }, body: file },
      );
      if (!response.ok) {
        const result = (await response.json()) as { error?: string };
        throw new Error(result.error || `Could not upload ${relativePath}.`);
      }
  }
}
