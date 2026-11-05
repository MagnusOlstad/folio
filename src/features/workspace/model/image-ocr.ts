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

/**
 * Normalizes extracted text: drops the model's Markdown-wrapping `<table>` tags (real HTML tables
 * with `<tr` rows are kept) and `### Kind - title` / `*Type: x*` annotation headers, then trims
 * outer blank lines and trailing spaces.
 */
export function cleanExtractedText(text: string) {
  const normalized = text.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "");
  const withoutWrappers = normalized.replace(
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
