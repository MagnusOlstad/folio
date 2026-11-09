import type { TranslatedExportJob, TranslatedExportPhase, TranslatedExportTarget, ViewerDocument } from "../../../domain/types.ts";
import { isUntitledId, serializeDraft } from "../../../lib/workspace.ts";
import { readStorageItem, writeStorageItem } from "../../../lib/storage.ts";
import {
  translatedExportFilename,
  withoutLeadingTitleHeading,
  type NoteExportFormat,
  type NoteExportSnapshot,
} from "./note-export.ts";

export type TranslatedExportDestination = "markdown" | "pdf" | "clipboard" | "draft";

export const TRANSLATED_EXPORT_LANGUAGES: readonly { target: TranslatedExportTarget; native: string; english: string; hint?: string }[] = [
  { target: "en", native: "English", english: "English" },
  { target: "no", native: "Norsk", english: "Norwegian" },
  { target: "de", native: "Deutsch", english: "German" },
  { target: "es", native: "Español", english: "Spanish" },
  { target: "fr", native: "Français", english: "French" },
  { target: "fi", native: "Suomi", english: "Finnish", hint: "Experimental — lower quality" },
  { target: "sv", native: "Svenska", english: "Swedish" },
  { target: "da", native: "Dansk", english: "Danish" },
];

export const TRANSLATED_EXPORT_DESTINATIONS: readonly { value: TranslatedExportDestination; label: string }[] = [
  { value: "markdown", label: "Markdown file" },
  { value: "pdf", label: "PDF" },
  { value: "clipboard", label: "Copy to clipboard" },
  { value: "draft", label: "New draft" },
];

export const TRANSLATED_EXPORT_STORAGE_KEY = "folio:translated-export:v1";

export type TranslatedExportPreferences = {
  target: TranslatedExportTarget;
  destination: TranslatedExportDestination;
};

const DEFAULT_PREFERENCES: TranslatedExportPreferences = { target: "en", destination: "markdown" };

export function isTranslatedExportTarget(value: unknown): value is TranslatedExportTarget {
  return TRANSLATED_EXPORT_LANGUAGES.some((language) => language.target === value);
}

function isDestination(value: unknown): value is TranslatedExportDestination {
  return TRANSLATED_EXPORT_DESTINATIONS.some((destination) => destination.value === value);
}

export function parseTranslatedExportPreferences(raw: string | null): TranslatedExportPreferences {
  if (!raw) return DEFAULT_PREFERENCES;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return DEFAULT_PREFERENCES;
    const value = parsed as Record<string, unknown>;
    return {
      target: isTranslatedExportTarget(value.target) ? value.target : DEFAULT_PREFERENCES.target,
      destination: isDestination(value.destination) ? value.destination : DEFAULT_PREFERENCES.destination,
    };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

export function readTranslatedExportPreferences(): TranslatedExportPreferences {
  return parseTranslatedExportPreferences(readStorageItem(TRANSLATED_EXPORT_STORAGE_KEY));
}

export function writeTranslatedExportPreferences(preferences: TranslatedExportPreferences): void {
  writeStorageItem(TRANSLATED_EXPORT_STORAGE_KEY, JSON.stringify(preferences));
}

export function translatedLanguageName(target: TranslatedExportTarget): string {
  return TRANSLATED_EXPORT_LANGUAGES.find((language) => language.target === target)?.english ?? target;
}

export type TranslatedExportResult = Pick<TranslatedExportJob, "title" | "description" | "content" | "failedBlocks">;

/**
 * Defensive guard: drops capture/generated-related comments and a generated
 * `# Captured note` / `# Summary` wrapper heading that must not reach exports.
 */
export function withoutGeneratedMarkers(content: string): string {
  return content
    .replace(/\n?<!-- folio:generated-related:start -->[\s\S]*?<!-- folio:generated-related:end -->\n?/gi, "\n")
    .replace(/[ \t]*<!-- folio:(?:capture|generated-related):[^>]*?-->[ \t]*\n?/g, "")
    .replace(/^\s*# (?:Captured note|Summary)[ \t]*\n+/i, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\s*\n/, "");
}

export function formatElapsed(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function translatedExportPhaseText(input: {
  phase: TranslatedExportPhase | undefined;
  translated: number;
  total: number;
  languageName: string;
  destination: TranslatedExportDestination;
}): string {
  const { phase, translated, total, languageName, destination } = input;
  if (phase === "queued") return "Waiting for another export to finish…";
  if (phase === "waiting") return "Waiting for the model… (loading it or finishing other work)";
  if (phase === "finishing") {
    const what = destination === "markdown" ? "Markdown file" : destination === "pdf" ? "PDF" : destination === "clipboard" ? "clipboard text" : "draft";
    return `Preparing your ${what}…`;
  }
  if (total > 0) return `Translating paragraph ${Math.min(translated + 1, total)} of ${total} into ${languageName}…`;
  return "Starting translation…";
}

export function translatedExportDoneText(destination: TranslatedExportDestination): string {
  if (destination === "draft") return "Done — opened as a new draft";
  if (destination === "clipboard") return "Done — copied to the clipboard";
  if (destination === "pdf") return "Done — preparing your PDF";
  return "Done — saving your Markdown file";
}

export function translatedExportSnapshot(document: ViewerDocument, result: TranslatedExportResult): NoteExportSnapshot {
  return {
    id: document.id,
    title: result.title?.trim() || document.title.trim() || "Untitled",
    description: result.description ?? document.description,
    content: withoutGeneratedMarkers(result.content ?? document.content),
    draft: false,
  };
}

/** Draft text: translated title as the heading, then the body (without a repeated heading). */
export function translatedDraftContent(snapshot: NoteExportSnapshot): string {
  const body = withoutLeadingTitleHeading(snapshot.content, snapshot.title).replace(/^\s*\n/, "");
  // Drafts keep filing guidance on line one; leave it empty so the H1 stays in the body.
  return serializeDraft("", `# ${snapshot.title}\n\n${body}`);
}

export type TranslatedExportDeliver = (
  document: ViewerDocument,
  result: TranslatedExportResult,
  target: TranslatedExportTarget,
  destination: TranslatedExportDestination,
) => Promise<void>;

type DeliveryDeps = {
  exportSnapshot: (snapshot: NoteExportSnapshot, format: NoteExportFormat, filename: string, noteId: string, notice?: string) => Promise<void>;
  createDraft: (content: string) => void;
  setMessage: (message: string) => void;
};

export async function deliverTranslatedExport(
  deps: DeliveryDeps,
  document: ViewerDocument,
  result: TranslatedExportResult,
  target: TranslatedExportTarget,
  destination: TranslatedExportDestination,
): Promise<void> {
  const snapshot = translatedExportSnapshot(document, result);
  const language = translatedLanguageName(target);
  const failed = result.failedBlocks ?? 0;
  const keptNotice = failed > 0 ? ` — ${failed} paragraph${failed === 1 ? " was" : "s were"} kept in the original language.` : "";
  if (destination === "clipboard") {
    try {
      await navigator.clipboard.writeText(snapshot.content);
      deps.setMessage(`Copied ${language} translation${keptNotice || ""}`);
    } catch {
      deps.setMessage("Could not copy the translation to the clipboard.");
    }
    return;
  }
  if (destination === "draft") {
    deps.createDraft(translatedDraftContent(snapshot));
    deps.setMessage(`Opened ${language} translation as a new draft${keptNotice}`);
    return;
  }
  await deps.exportSnapshot(snapshot, destination, translatedExportFilename(isUntitledId(document.id) ? snapshot.title : document.title, destination, target), document.id, keptNotice);
}
