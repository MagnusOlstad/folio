import type { TranslatedExportTarget, ViewerDocument } from "../../../domain/types.ts";
import { filedDraftContent, isUntitledId } from "../../../lib/workspace.ts";

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
  const isDraft = isUntitledId(document.id);
  const sourceContent = draft ?? document.content;
  const content = isDraft ? filedDraftContent(sourceContent) : sourceContent;
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

/** `Title.de.md` / `Title.de.pdf`: the language code sits before the extension. */
export function translatedExportFilename(
  title: string,
  format: NoteExportFormat,
  target: TranslatedExportTarget,
) {
  const filename = noteExportFilename(title, format);
  const extension = format === "markdown" ? ".md" : ".pdf";
  return `${filename.slice(0, -extension.length)}.${target}${extension}`;
}

function plainHeadingText(value: string) {
  return value
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .normalize("NFC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Removes a leading `# Title` heading that repeats the note title, so the PDF
 * header does not show it twice. Returns the content unchanged otherwise.
 */
export function withoutLeadingTitleHeading(content: string, title: string) {
  const match = /^(?:[ \t]*\r?\n)*[ \t]{0,3}#[ \t]+([^\r\n]*?)(?:[ \t]+#+)?[ \t]*(?:\r?\n|$)/.exec(
    content,
  );
  if (!match) return content;
  const heading = plainHeadingText(match[1]);
  if (!heading || heading !== plainHeadingText(title)) return content;
  return content.slice(match[0].length);
}
