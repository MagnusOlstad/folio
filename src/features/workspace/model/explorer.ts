import type { BundleFile } from "../../../domain/types.ts";
import type { NoteExportFormat } from "./note-export.ts";

export type ExplorerContextTarget =
  | { kind: "file"; path: string; file: BundleFile }
  | { kind: "directory"; path: string };

export type ExplorerContextMenuState = {
  target: ExplorerContextTarget;
  x: number;
  y: number;
  anchor: HTMLElement;
};

export type ExplorerFileActions = {
  renameFile: (id: string, name: string) => Promise<void>;
  createFile: (directory: string) => Promise<void>;
  createDirectory: (directory: string, name: string) => Promise<void>;
  deleteFile: (file: BundleFile) => Promise<void>;
  exportFile: (file: BundleFile, format: NoteExportFormat) => Promise<void>;
  copyText: (value: string) => Promise<void>;
};

export function explorerTargetPath(target: ExplorerContextTarget) {
  return target.kind === "file" ? target.file.id : target.path;
}

export function explorerTargetName(target: ExplorerContextTarget) {
  return target.kind === "file"
    ? target.file.name
    : target.path === "/"
      ? "Bundle"
      : target.path.split("/").at(-1) || "Bundle";
}

export function explorerTargetParent(target: ExplorerContextTarget) {
  if (target.kind === "directory") return target.path;
  const separator = target.file.id.lastIndexOf("/");
  return separator <= 0 ? "/" : target.file.id.slice(0, separator);
}
