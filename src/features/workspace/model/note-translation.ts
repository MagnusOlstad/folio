import type { NoteTranslationTarget, ViewerDocument } from "../../../domain/types.ts";
import { readStorageItem, writeStorageItem } from "../../../lib/storage.ts";

export type NoteTranslationChoices = Record<string, NoteTranslationTarget>;

/** Original is the absence of a choice, so only the two translated languages are listed. */
export const NOTE_TRANSLATION_LANGUAGES: readonly { target: NoteTranslationTarget; label: string; code: string; name: string }[] = [
  { target: "no", label: "Norsk", code: "NO", name: "Norwegian" },
  { target: "en", label: "English", code: "EN", name: "English" },
];

export function noteTranslationStorageKey(bundleId: string | null | undefined): string {
  return `folio:note-translation:v1:${bundleId || "legacy-bundle"}`;
}

export function isNoteTranslationTarget(value: unknown): value is NoteTranslationTarget {
  return value === "no" || value === "en";
}

/** Only real bundle notes can be translated: local drafts and read-only files cannot. */
export function isTranslatableDocument(document: ViewerDocument, isDraftId: boolean): boolean {
  return !isDraftId && document.deletable && document.movable;
}

export function parseNoteTranslationChoices(raw: string | null): NoteTranslationChoices {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const choices: NoteTranslationChoices = {};
    for (const [id, target] of Object.entries(parsed)) {
      if (isNoteTranslationTarget(target)) choices[id] = target;
    }
    return choices;
  } catch {
    return {};
  }
}

export function withNoteTranslationChoice(
  choices: NoteTranslationChoices,
  id: string,
  target: NoteTranslationTarget | null,
): NoteTranslationChoices {
  const next = { ...choices };
  if (target) next[id] = target;
  else delete next[id];
  return next;
}

export function migrateNoteTranslationChoice(
  choices: NoteTranslationChoices,
  oldId: string,
  newId: string,
): NoteTranslationChoices {
  if (oldId === newId || !(oldId in choices)) return choices;
  const next = { ...choices };
  const target = next[oldId];
  delete next[oldId];
  if (!(newId in next)) next[newId] = target;
  return next;
}

const listeners = new Set<() => void>();
const snapshots = new Map<string, { raw: string | null; choices: NoteTranslationChoices }>();

export function subscribeNoteTranslationChoices(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Returns a referentially stable snapshot while the stored value is unchanged. */
export function readNoteTranslationChoices(bundleId: string | null | undefined): NoteTranslationChoices {
  const key = noteTranslationStorageKey(bundleId);
  const raw = readStorageItem(key);
  const cached = snapshots.get(key);
  if (cached && cached.raw === raw) return cached.choices;
  const choices = parseNoteTranslationChoices(raw);
  snapshots.set(key, { raw, choices });
  return choices;
}

export function writeNoteTranslationChoices(bundleId: string | null | undefined, choices: NoteTranslationChoices): void {
  writeStorageItem(noteTranslationStorageKey(bundleId), JSON.stringify(choices));
  for (const listener of [...listeners]) listener();
}

export function setNoteTranslationChoice(
  bundleId: string | null | undefined,
  id: string,
  target: NoteTranslationTarget | null,
): void {
  writeNoteTranslationChoices(bundleId, withNoteTranslationChoice(readNoteTranslationChoices(bundleId), id, target));
}

/** Call wherever a note id changes (move, rename, refile) so the choice follows the note. */
export function migrateStoredNoteTranslationChoice(
  bundleId: string | null | undefined,
  oldId: string,
  newId: string,
): void {
  const current = readNoteTranslationChoices(bundleId);
  const next = migrateNoteTranslationChoice(current, oldId, newId);
  if (next !== current) writeNoteTranslationChoices(bundleId, next);
}

export function translatedProgressLabel(translated: number, total: number): string {
  return `Translating ${translated} of ${total} paragraph${total === 1 ? "" : "s"}…`;
}
