import { EditorView } from "@codemirror/view";
import {
  altFromFilename,
  imageFilesFrom,
  imageMarkdown,
  isSupportedImageFile,
  uploadImageAsset,
} from "../../../lib/assets.ts";

export type PendingImageUpload = {
  file: File;
  placeholder: string;
  alt: string;
};

let uploadCounter = 0;

export function createUploadPlaceholder() {
  uploadCounter += 1;
  const id = `${Date.now().toString(36)}-${uploadCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return `![Uploading image…](#upload-${id})`;
}

export function pendingImageUploads(
  files: Iterable<File> | ArrayLike<File> | null | undefined,
): PendingImageUpload[] {
  return imageFilesFrom(files).map((file) => ({
    file,
    placeholder: createUploadPlaceholder(),
    alt: altFromFilename(file.name),
  }));
}

export function uploadedImageMarkdown(upload: PendingImageUpload, path: string) {
  return imageMarkdown(upload.alt, path);
}

export function placeholderBlock(uploads: PendingImageUpload[]) {
  return uploads.map((upload) => upload.placeholder).join("\n\n");
}

type ImageUploadOptions = {
  /** Called lazily so the extension can be installed once and follow prop changes. */
  onError: () => ((message: string) => void) | undefined;
  upload?: (file: File) => Promise<string>;
};

function dragCarriesImage(data: DataTransfer | null) {
  if (!data) return false;
  if (data.items && data.items.length)
    return Array.from(data.items).some(
      (item) => item.kind === "file" && (!item.type || isSupportedImageFile(item)),
    );
  return imageFilesFrom(data.files).length > 0;
}

function replacePlaceholder(view: EditorView, placeholder: string, replacement: string) {
  if (view.state.readOnly) return;
  const index = view.state.doc.toString().indexOf(placeholder);
  if (index < 0) return;
  view.dispatch({
    changes: { from: index, to: index + placeholder.length, insert: replacement },
    userEvent: "input",
  });
}

function startUploads(
  view: EditorView,
  uploads: PendingImageUpload[],
  options: ImageUploadOptions,
) {
  const upload = options.upload ?? uploadImageAsset;
  for (const item of uploads) {
    upload(item.file).then(
      (path) => replacePlaceholder(view, item.placeholder, uploadedImageMarkdown(item, path)),
      (error: unknown) => {
        replacePlaceholder(view, item.placeholder, "");
        const message =
          error instanceof Error && error.message
            ? error.message
            : "Could not upload the image.";
        const report = options.onError();
        if (report) report(message);
        else console.error(message);
      },
    );
  }
}

function insertPlaceholders(view: EditorView, uploads: PendingImageUpload[], at?: number) {
  const text = placeholderBlock(uploads);
  const selection = view.state.selection.main;
  const from = at ?? selection.from;
  const to = at === undefined ? selection.to : at;
  view.dispatch({
    changes: { from, to, insert: text },
    selection: { anchor: from + text.length },
    userEvent: "input.paste",
    scrollIntoView: true,
  });
}

/** Pasted or dropped raster images are uploaded and replaced by a Markdown link. */
export function imageUploadExtension(options: ImageUploadOptions) {
  return EditorView.domEventHandlers({
    paste: (event, view) => {
      if (view.state.readOnly) return false;
      const uploads = pendingImageUploads(event.clipboardData?.files);
      if (!uploads.length) return false;
      event.preventDefault();
      insertPlaceholders(view, uploads);
      startUploads(view, uploads, options);
      return true;
    },
    dragover: (event, view) => {
      if (view.state.readOnly || !dragCarriesImage(event.dataTransfer)) return false;
      event.preventDefault();
      return true;
    },
    drop: (event, view) => {
      if (view.state.readOnly) return false;
      const uploads = pendingImageUploads(event.dataTransfer?.files);
      if (!uploads.length) return false;
      event.preventDefault();
      const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
      insertPlaceholders(view, uploads, position ?? undefined);
      startUploads(view, uploads, options);
      return true;
    },
  });
}
