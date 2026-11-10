import type { Text } from "@codemirror/state";

export type OcrPreviewState =
  | { status: "idle" }
  | { status: "extracting" }
  | { status: "preview"; text: string; cached: boolean };

export type OcrPreviewAction =
  | { type: "start" }
  | { type: "success"; text: string; cached: boolean }
  | { type: "failure" }
  | { type: "close" };

/** Transitions for one image's extract flow; at most one preview exists per image. */
export function nextOcrState(state: OcrPreviewState, action: OcrPreviewAction): OcrPreviewState {
  switch (action.type) {
    case "start":
      return state.status === "idle" ? { status: "extracting" } : state;
    case "success":
      return state.status === "extracting"
        ? { status: "preview", text: action.text, cached: action.cached }
        : state;
    case "failure":
      return state.status === "extracting" ? { status: "idle" } : state;
    case "close":
      return state.status === "preview" ? { status: "idle" } : state;
  }
}

const PLACEHOLDER_IMAGE = /!?\[[^\]\n]*\]\(\s*(?:\.\/)?(?:image|img)[_-]?\d+\.(?:png|jpe?g|gif|webp)\s*\)/gi;
const HTML_TABLE = /<table\b[^>]*>([\s\S]*?)<\/table>/gi;
const HTML_ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&#39;": "'", "&nbsp;": " " };

function htmlCellToMarkdown(html: string) {
  return html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_match, _tag, inner: string) => (inner.trim() ? `**${inner.trim()}**` : ""))
    .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_match, _tag, inner: string) => (inner.trim() ? `*${inner.trim()}*` : ""))
    .replace(/<[^>]*>/g, "")
    .replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (entity) => HTML_ENTITIES[entity])
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\|/g, "\\|");
}

/** Converts a simple HTML table to a GFM pipe table; returns null for spans, nested tables or empty tables. */
function htmlTableToMarkdown(inner: string) {
  if (/<table\b/i.test(inner) || /\b(?:rowspan|colspan)\s*=/i.test(inner)) return null;
  const rows = [...inner.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((row) => [...row[1].matchAll(/<(t[dh])\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((cell) => htmlCellToMarkdown(cell[2])))
    .filter((cells) => cells.length > 0);
  if (rows.length === 0) return null;
  const columns = Math.max(...rows.map((cells) => cells.length));
  const line = (cells: string[]) => `| ${Array.from({ length: columns }, (_, index) => cells[index] ?? "").join(" | ")} |`;
  return [line(rows[0]), line(Array.from({ length: columns }, () => "---")), ...rows.slice(1).map(line)].join("\n");
}

/**
 * Normalizes extracted text: drops LightOnOCR image placeholders (`![image](image_1.png)`, which point
 * at files that do not exist), converts simple HTML tables to GFM pipe tables (first row becomes the
 * header; tables with rowspan/colspan or nested tables stay HTML), unwraps the model's Markdown-wrapping
 * `<table>` tags that hold no rows, and drops `### Kind - title` / `*Type: x*` annotation headers, then
 * trims outer blank lines and trailing spaces.
 */
export function cleanExtractedText(text: string) {
  const normalized = text.replace(/\r\n?/g, "\n").replace(PLACEHOLDER_IMAGE, "").replace(/[ \t]+$/gm, "");
  const withTables = normalized.replace(HTML_TABLE, (match, inner: string) => htmlTableToMarkdown(inner) ?? match);
  const withoutWrappers = withTables.replace(
    /^<table>\n([\s\S]*?)\n<\/table>$/gm,
    (match, inner: string) => (/<tr[\s>]/i.test(inner) ? match : inner),
  );
  return withoutWrappers
    .replace(/^### [A-Za-z]+ - .*\n\*Type: [^*\n]+\*\n(?:\n)?/gm, "")
    .replace(/^\n+|\n+$/g, "");
}

/** Inserts the text as its own block after the line that holds the image. */
export function ocrInsertChange(doc: Text, range: { from: number; to: number }, text: string) {
  const cleaned = cleanExtractedText(text);
  if (!cleaned) return null;
  return { from: doc.lineAt(range.to).to, insert: `\n\n${cleaned}\n` };
}
