import { syntaxTree } from "@codemirror/language";
import type { EditorView } from "@codemirror/view";
import { extractImageText } from "../../../lib/assets.ts";
import { imageAltWidthChange, MIN_IMAGE_WIDTH } from "./image-size.ts";
import { cleanExtractedText, nextOcrState, ocrInsertChange, type OcrPreviewState } from "./image-ocr.ts";

const TOOLBAR_CLASS = "cm-live-markdown-image-toolbar";
const COPIED_RESET_MS = 1500;

const PREVIEW_CLASS = "cm-live-markdown-ocr-preview";
const HANDLE_CLASS = "cm-live-markdown-image-resize";

export type ImageToolbarOptions = {
  /** The `/assets/<file>` path used to request text extraction. */
  path: string;
  /** Width in CSS pixels from the `alt|width` suffix, or null for natural size. */
  width?: number | null;
  onError?: (message: string) => void;
};

const SVG_NS = "http://www.w3.org/2000/svg";

const ICONS = {
  copy: [
    "M9 9h10v10H9z",
    "M5 15V5h10",
  ],
  check: ["M5 12.5l4.5 4.5L19 7.5"],
  remove: ["M4 7h16", "M10 11v6", "M14 11v6", "M6 7l1 12h10l1-12", "M9 7V4h6v3"],
  text: ["M4 6h16", "M4 12h10", "M4 18h16"],
} as const;

function createIcon(paths: readonly string[]) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

function createButton(label: string, icon: readonly string[], extraClass?: string) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = ["cm-live-markdown-image-action", extraClass].filter(Boolean).join(" ");
  button.title = label;
  button.setAttribute("aria-label", label);
  button.append(createIcon(icon));
  // Keep editor focus and selection when the toolbar is pressed.
  button.addEventListener("mousedown", (event) => event.preventDefault());
  return button;
}

/** True when a DOM event originated inside an image toolbar or its text preview. */
export function isImageToolbarEvent(event: Event) {
  const target = event.target;
  return target instanceof Element && target.closest(`.${TOOLBAR_CLASS}, .${PREVIEW_CLASS}, .${HANDLE_CLASS}`) !== null;
}

/** Finds the Markdown range of the Image node that the frame widget replaces. */
export function findImageRange(view: EditorView, frame: HTMLElement) {
  let pos: number;
  try {
    pos = view.posAtDOM(frame);
  } catch {
    return null;
  }
  const tree = syntaxTree(view.state);
  for (const side of [1, -1] as const) {
    for (let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(pos, side); node; node = node.parent) {
      if (node.name === "Image") return { from: node.from, to: node.to };
    }
  }
  return null;
}

/** Rewrites the alt suffix of the image so it has the given width (null resets). */
export function setImageWidth(view: EditorView, frame: HTMLElement, width: number | null) {
  const range = findImageRange(view, frame);
  if (!range || view.state.readOnly) return false;
  const change = imageAltWidthChange(view.state.sliceDoc(range.from, range.to), width);
  if (!change) return false;
  view.dispatch({
    changes: { from: range.from + change.from, to: range.from + change.to, insert: change.insert },
    userEvent: "input",
  });
  return true;
}

function attachResizeHandle(
  view: EditorView,
  frame: HTMLElement,
  image: HTMLImageElement,
  options: ImageToolbarOptions,
) {
  const handle = document.createElement("span");
  handle.className = HANDLE_CLASS;
  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-label", "Resize image");
  handle.title = "Drag to resize, double-click to reset";
  const badge = document.createElement("span");
  badge.className = "cm-live-markdown-image-resize-badge";
  badge.setAttribute("aria-hidden", "true");
  let drag: { pointerId: number; startX: number; startWidth: number; width: number } | null = null;
  const maxWidth = () => Math.max(MIN_IMAGE_WIDTH, view.contentDOM.clientWidth);

  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const startWidth = image.getBoundingClientRect().width;
    drag = { pointerId: event.pointerId, startX: event.clientX, startWidth, width: startWidth };
    handle.setPointerCapture(event.pointerId);
    badge.textContent = `${Math.round(startWidth)} px`;
    frame.append(badge);
    frame.classList.add("is-resizing");
  });
  handle.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag.width = Math.min(maxWidth(), Math.max(MIN_IMAGE_WIDTH, drag.startWidth + event.clientX - drag.startX));
    image.style.width = `${drag.width}px`;
    badge.textContent = `${Math.round(drag.width)} px`;
  });
  const finish = (event: PointerEvent, commit: boolean) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const { width, startWidth } = drag;
    drag = null;
    frame.classList.remove("is-resizing");
    badge.remove();
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    if (commit && Math.round(width) !== Math.round(startWidth)) setImageWidth(view, frame, width);
    else if (!commit) image.style.width = options.width ? `${options.width}px` : "";
  };
  handle.addEventListener("pointerup", (event) => finish(event, true));
  handle.addEventListener("pointercancel", (event) => finish(event, false));
  handle.addEventListener("mousedown", (event) => event.preventDefault());
  handle.addEventListener("dblclick", (event) => {
    event.preventDefault();
    event.stopPropagation();
    setImageWidth(view, frame, null);
  });
  frame.append(handle);
}

/** Deletes the image Markdown, dropping the whole line when nothing else is on it. */
export function removeImage(view: EditorView, frame: HTMLElement) {
  const range = findImageRange(view, frame);
  if (!range || view.state.readOnly) return false;
  const { doc } = view.state;
  const line = doc.lineAt(range.from);
  let { from, to } = range;
  const onlyImage =
    range.to <= line.to &&
    doc.sliceString(line.from, range.from).trim() === "" &&
    doc.sliceString(range.to, line.to).trim() === "";
  if (onlyImage) {
    if (line.to < doc.length) {
      from = line.from;
      to = line.to + 1;
    } else if (line.from > 0) {
      from = line.from - 1;
      to = line.to;
    } else {
      from = line.from;
      to = line.to;
    }
  }
  view.dispatch({ changes: { from, to }, userEvent: "delete" });
  view.focus();
  return true;
}

async function toPngBlob(blob: Blob) {
  if (blob.type === "image/png") return blob;
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas is unavailable.");
    context.drawImage(bitmap, 0, 0);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((png) => (png ? resolve(png) : reject(new Error("PNG conversion failed."))), "image/png"),
    );
  } finally {
    bitmap.close();
  }
}

/** Copies the image bytes (as PNG) to the system clipboard. */
export async function copyImageToClipboard(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Image request failed (${response.status}).`);
  const png = await toPngBlob(await response.blob());
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}

/** Builds the frame holding the image and its hover toolbar. */
export function createImageFrame(
  view: EditorView,
  image: HTMLImageElement,
  url: string,
  options: ImageToolbarOptions,
) {
  const frame = document.createElement("span");
  frame.className = "cm-live-markdown-image-frame";

  const toolbar = document.createElement("span");
  toolbar.className = TOOLBAR_CLASS;
  toolbar.setAttribute("role", "toolbar");
  toolbar.setAttribute("aria-label", "Image actions");

  const copy = createButton("Copy image", ICONS.copy);
  let resetTimer: number | undefined;
  copy.addEventListener("click", async () => {
    try {
      await copyImageToClipboard(url);
    } catch {
      options.onError?.("Could not copy the image.");
      return;
    }
    copy.replaceChildren(createIcon(ICONS.check));
    copy.classList.add("is-copied");
    copy.title = "Copied";
    copy.setAttribute("aria-label", "Copied");
    window.clearTimeout(resetTimer);
    resetTimer = window.setTimeout(() => {
      copy.replaceChildren(createIcon(ICONS.copy));
      copy.classList.remove("is-copied");
      copy.title = "Copy image";
      copy.setAttribute("aria-label", "Copy image");
    }, COPIED_RESET_MS);
  });
  toolbar.append(copy);

  if (!view.state.readOnly) {
    const remove = createButton("Remove image", ICONS.remove);
    remove.addEventListener("click", () => {
      removeImage(view, frame);
    });
    toolbar.append(remove);
  }

  const extract = createButton("Extract text", ICONS.text);
  toolbar.append(extract);

  let ocrState: OcrPreviewState = { status: "idle" };
  let preview: HTMLElement | null = null;
  const closePreview = () => {
    preview?.remove();
    preview = null;
    view.dom.removeEventListener("keydown", onKeydown, true);
    ocrState = nextOcrState(ocrState, { type: "close" });
    view.requestMeasure();
  };
  function onKeydown(event: KeyboardEvent) {
    if (!frame.isConnected) {
      view.dom.removeEventListener("keydown", onKeydown, true);
      return;
    }
    if (event.key === "Escape" && preview) closePreview();
  }
  const setBusy = (busy: boolean) => {
    extract.classList.toggle("is-busy", busy);
    extract.disabled = busy;
    if (busy) extract.setAttribute("aria-busy", "true");
    else extract.removeAttribute("aria-busy");
    extract.title = busy ? "Extracting…" : "Extract text";
  };
  extract.addEventListener("click", async () => {
    if (ocrState.status === "preview") {
      closePreview();
      return;
    }
    if (ocrState.status !== "idle") return;
    ocrState = nextOcrState(ocrState, { type: "start" });
    setBusy(true);
    try {
      const result = await extractImageText(options.path);
      ocrState = nextOcrState(ocrState, { type: "success", ...result });
      preview = createOcrPreview(view, frame, result.text, result.cached, options, closePreview);
      frame.append(preview);
      view.dom.addEventListener("keydown", onKeydown, true);
      view.requestMeasure();
    } catch (error) {
      ocrState = nextOcrState(ocrState, { type: "failure" });
      options.onError?.(error instanceof Error ? error.message : "Could not extract text.");
    } finally {
      setBusy(false);
    }
  });

  if (options.width) image.style.width = `${options.width}px`;
  frame.append(image, toolbar);
  if (!view.state.readOnly) attachResizeHandle(view, frame, image, options);
  return frame;
}

function createTextButton(label: string) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "cm-live-markdown-ocr-button";
  button.textContent = label;
  // Keep editor focus and selection when the preview is pressed.
  button.addEventListener("mousedown", (event) => event.preventDefault());
  return button;
}

/** Builds the extracted-text panel shown under the image. */
function createOcrPreview(
  view: EditorView,
  frame: HTMLElement,
  rawText: string,
  cached: boolean,
  options: ImageToolbarOptions,
  close: () => void,
) {
  const text = cleanExtractedText(rawText);
  const panel = document.createElement("div");
  panel.className = PREVIEW_CLASS;
  panel.setAttribute("role", "region");
  panel.setAttribute("aria-label", "Extracted text");

  const body = document.createElement("pre");
  body.className = "cm-live-markdown-ocr-text";
  body.textContent = text.trim() ? text : "No text found in this image.";

  const actions = document.createElement("div");
  actions.className = "cm-live-markdown-ocr-actions";

  const copy = createTextButton("Copy");
  let resetTimer: number | undefined;
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      options.onError?.("Could not copy the extracted text.");
      return;
    }
    copy.textContent = "Copied";
    window.clearTimeout(resetTimer);
    resetTimer = window.setTimeout(() => {
      copy.textContent = "Copy";
    }, COPIED_RESET_MS);
  });
  actions.append(copy);

  if (!view.state.readOnly) {
    const insert = createTextButton("Insert below");
    insert.addEventListener("click", () => {
      const range = findImageRange(view, frame);
      const change = range && !view.state.readOnly ? ocrInsertChange(view.state.doc, range, text) : null;
      if (change) view.dispatch({ changes: change, userEvent: "input" });
      close();
    });
    actions.append(insert);
  }

  const dismiss = createTextButton("Close");
  dismiss.addEventListener("click", close);
  actions.append(dismiss);

  if (cached) {
    const note = document.createElement("span");
    note.className = "cm-live-markdown-ocr-note";
    note.textContent = "(cached)";
    actions.append(note);
  }

  panel.append(body, actions);
  return panel;
}
