import type { ViewerDocument } from "../../../domain/types.ts";
import { isUntitledId } from "../../../lib/workspace.ts";

export type NoteExportFormat = "markdown" | "pdf";

export type NoteExportSnapshot = {
  id: string;
  title: string;
  description: string;
  content: string;
  draft: boolean;
};

const INVALID_FILENAME_CHARACTERS = /[<>:"/\\|?*]+/g;
const WINDOWS_RESERVED_FILENAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

function withoutInvalidFilenameCharacters(value: string) {
  return Array.from(value, (character) =>
    character.charCodeAt(0) < 32 ? "-" : character,
  )
    .join("")
    .replace(INVALID_FILENAME_CHARACTERS, "-");
}

function titleFromDraft(content: string) {
  const firstLine = content
    .split("\n")
    .map((line) => line.replace(/^\s*#+\s*/, "").trim())
    .find(Boolean);
  return firstLine ? firstLine.slice(0, 48) : "Untitled";
}

export function noteExportSnapshot(
  document: ViewerDocument,
  draft: string | undefined,
): NoteExportSnapshot {
  const content = draft ?? document.content;
  const isDraft = isUntitledId(document.id);
  return {
    id: document.id,
    title: isDraft
      ? titleFromDraft(content)
      : document.title.trim() || "Untitled",
    description: document.description,
    content,
    draft: isDraft,
  };
}

export function noteExportFilename(
  title: string,
  format: NoteExportFormat,
) {
  let basename = withoutInvalidFilenameCharacters(title.normalize("NFC"))
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 120)
    .replace(/[. ]+$/g, "");
  if (!basename) basename = "Untitled";
  if (WINDOWS_RESERVED_FILENAME.test(basename)) basename = `${basename}-note`;
  return `${basename}.${format === "markdown" ? "md" : "pdf"}`;
}
