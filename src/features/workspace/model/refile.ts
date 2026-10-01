import type { RefileResult } from "../../../domain/types.ts";
import { normalizeDirectoryInput } from "../../../lib/paths.ts";

export type RefileFields = {
  directory: string;
  filename: string;
  title: string;
  description: string;
  tags: string[];
};

export type RefileProposal = {
  id: string;
  hash: string;
  proposal: RefileFields;
};

export type RefileEntry = {
  documentId: string;
  status: "preparing" | "proposing" | "ready" | "submitting" | "error";
  proposal: RefileProposal | null;
  fields: RefileFields | null;
  error: string | null;
};

export type RefileEntries = Record<string, RefileEntry>;

export function initialRefileEntry(documentId: string): RefileEntry {
  return {
    documentId,
    status: "preparing",
    proposal: null,
    fields: null,
    error: null,
  };
}

export function setRefileEntry(entries: RefileEntries, entry: RefileEntry): RefileEntries {
  return { ...entries, [entry.documentId]: entry };
}

export function updateRefileFields(
  entries: RefileEntries,
  documentId: string,
  fields: RefileFields,
): RefileEntries {
  const current = entries[documentId];
  if (!current || !current.fields || current.status === "submitting") return entries;
  return setRefileEntry(entries, { ...current, fields, error: null });
}

export function removeRefileEntry(entries: RefileEntries, documentId: string): RefileEntries {
  if (!(documentId in entries)) return entries;
  const next = { ...entries };
  delete next[documentId];
  return next;
}

export function refileRequestFields(fields: RefileFields) {
  const directory = normalizeDirectoryInput(fields.directory);
  const filename = fields.filename.trim().replace(/\\/g, "/").split("/").filter(Boolean).at(-1) ?? "";
  return { ...fields, directory, filename };
}

export type { RefileResult };
