import { syntaxTree } from "@codemirror/language";
import type { EditorView } from "@codemirror/view";

const TOOLBAR_CLASS = "cm-live-markdown-image-toolbar";
const COPIED_RESET_MS = 1500;

export type ImageToolbarOptions = {
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

/** True when a DOM event originated inside an image toolbar. */
export function isImageToolbarEvent(event: Event) {
  const target = event.target;
  return target instanceof Element && target.closest(`.${TOOLBAR_CLASS}`) !== null;
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

  const extract = createButton("Extract text (coming soon)", ICONS.text);
  extract.disabled = true;
  toolbar.append(extract);

  frame.append(image, toolbar);
  return frame;
}
