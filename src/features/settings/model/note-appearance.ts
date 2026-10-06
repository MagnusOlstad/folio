import { readStorageItem, writeStorageItem } from "../../../lib/storage.ts";

export const NOTE_FONT_SIZE_STORAGE_KEY = "folio:note-font-size";
export const DEFAULT_NOTE_FONT_SIZE = 18;
export const MIN_NOTE_FONT_SIZE = 12;
export const MAX_NOTE_FONT_SIZE = 28;

export function normalizeNoteFontSize(value: unknown): number {
  if (typeof value === "string" && value.trim() === "") return DEFAULT_NOTE_FONT_SIZE;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_NOTE_FONT_SIZE;
  return Math.min(MAX_NOTE_FONT_SIZE, Math.max(MIN_NOTE_FONT_SIZE, Math.round(parsed)));
}

export function loadStoredNoteFontSize(): number {
  const stored = readStorageItem(NOTE_FONT_SIZE_STORAGE_KEY);
  return stored === null ? DEFAULT_NOTE_FONT_SIZE : normalizeNoteFontSize(stored);
}

export function persistNoteFontSize(fontSize: number): void {
  writeStorageItem(NOTE_FONT_SIZE_STORAGE_KEY, String(fontSize));
}
