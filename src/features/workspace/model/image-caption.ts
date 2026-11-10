import type { Text } from "@codemirror/state";
import type { MlxCaptionModelId } from "../../../domain/types.ts";
import { modelCatalog } from "./model-catalog.ts";
import { imageAltBounds, parseImageAlt } from "./image-size.ts";

export type CaptionBlockedCode = "CAPTION_MODEL_NOT_SELECTED" | "CAPTION_MODEL_NOT_INSTALLED";

export type CaptionPreviewState =
  | { status: "idle" }
  | { status: "describing" }
  | { status: "preview"; text: string; cached: boolean; model: MlxCaptionModelId }
  | { status: "blocked"; code: CaptionBlockedCode; modelId: MlxCaptionModelId | null };

export type CaptionPreviewAction =
  | { type: "start" }
  | { type: "success"; text: string; cached: boolean; model: MlxCaptionModelId }
  | { type: "blocked"; code: CaptionBlockedCode; modelId: MlxCaptionModelId | null }
  | { type: "failure" }
  | { type: "close" };

/** Transitions for one image's describe flow; at most one panel exists per image. */
export function nextCaptionState(state: CaptionPreviewState, action: CaptionPreviewAction): CaptionPreviewState {
  switch (action.type) {
    case "start":
      return state.status === "idle" ? { status: "describing" } : state;
    case "success":
      return state.status === "describing"
        ? { status: "preview", text: action.text, cached: action.cached, model: action.model }
        : state;
    case "blocked":
      return state.status === "describing"
        ? { status: "blocked", code: action.code, modelId: action.modelId }
        : state;
    case "failure":
      return state.status === "describing" ? { status: "idle" } : state;
    case "close":
      return state.status === "preview" || state.status === "blocked" ? { status: "idle" } : state;
  }
}

/** Normalizes a description into trimmed plain text with single spaces within paragraphs. */
export function cleanCaptionText(text: string) {
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n\n");
}

/** Inserts the description as its own paragraph after the line that holds the image. */
export function captionInsertChange(doc: Text, range: { from: number; to: number }, text: string) {
  const cleaned = cleanCaptionText(text);
  if (!cleaned) return null;
  return { from: doc.lineAt(range.to).to, insert: `\n\n${cleaned}\n` };
}

/** Flattens a description into a single-line, bracket-safe string for `![alt](...)`. */
export function captionToAlt(text: string) {
  return cleanCaptionText(text)
    .replace(/\s+/g, " ")
    .replace(/[[\]\\]/g, "\\$&")
    .replace(/\|/g, "/")
    .trim();
}

/**
 * Replaces the alt text of an image's Markdown source with the description, keeping a trailing
 * `|width` / `|WxH` size suffix. Returns a range relative to the source, or null.
 */
export function captionAltChange(source: string, text: string) {
  const bounds = imageAltBounds(source);
  const alt = captionToAlt(text);
  if (!bounds || !alt) return null;
  const raw = source.slice(bounds.from, bounds.to);
  const suffix = raw.slice(parseImageAlt(raw).alt.length);
  return { from: bounds.from, to: bounds.to, insert: `${alt}${suffix}` };
}

/** Human-readable name for the caption model ids. */
export function captionModelName(id: MlxCaptionModelId | null) {
  return modelCatalog.find((model) => model.id === id)?.name ?? "an image description model";
}
