import type { MlxCaptionModelId } from "../domain/types.ts";
import { getActiveBundleId } from "./api.ts";

export const SUPPORTED_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

export function isSupportedImageFile(file: Pick<File, "type">) {
  return (SUPPORTED_IMAGE_TYPES as readonly string[]).includes(
    file.type.toLowerCase(),
  );
}

export function imageFilesFrom(files: Iterable<File> | ArrayLike<File> | null | undefined) {
  return files ? Array.from(files).filter(isSupportedImageFile) : [];
}

/** Builds the URL an `<img>` can use, since image requests cannot send headers. */
export function assetUrl(path: string, bundleId = getActiveBundleId()) {
  const bundle = bundleId ? `&bundle=${encodeURIComponent(bundleId)}` : "";
  return `/api/assets?path=${encodeURIComponent(path)}${bundle}`;
}

const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Returns the `/assets/<file>` path for root-absolute or relative asset hrefs. */
export function resolveAssetHref(href?: string | null) {
  if (!href || /^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith("//"))
    return null;
  let target = href.split(/[?#]/)[0];
  try {
    target = decodeURIComponent(target);
  } catch {
    return null;
  }
  const segments = target.split("/");
  if (segments[0] === "." || segments[0] === "..") {
    // Relative links from a nested note climb back to the bundle root.
    while (segments[0] === "." || segments[0] === "..") segments.shift();
  } else if (segments[0] === "") {
    segments.shift();
  }
  if (segments.length !== 2 || segments[0] !== "assets") return null;
  return ASSET_NAME.test(segments[1]) && segments[1] !== ".." ? `/assets/${segments[1]}` : null;
}

export function imageMarkdown(alt: string, path: string) {
  const escaped = alt.replace(/[[\]\\]/g, "\\$&").replace(/\s+/g, " ").trim();
  return `![${escaped}](${path})`;
}

export function altFromFilename(name: string) {
  const base = name.replace(/\.[^.]*$/, "").replace(/[-_]+/g, " ").trim();
  return base || "image";
}

export async function uploadImageAsset(file: File): Promise<string> {
  const bundleId = getActiveBundleId();
  let response: Response;
  try {
    response = await fetch("/api/assets", {
      method: "POST",
      headers: {
        "content-type": file.type.toLowerCase(),
        "x-folio-filename": encodeURIComponent(file.name || "image"),
        ...(bundleId
          ? { "x-folio-bundle": bundleId, "x-folio-bundle-id": bundleId }
          : {}),
      },
      body: file,
    });
  } catch {
    throw new Error("The local FolioNotes service is not ready yet.");
  }
  let result: unknown = null;
  try {
    result = await response.json();
  } catch {
    result = null;
  }
  const body = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  if (!response.ok)
    throw new Error(
      typeof body.error === "string"
        ? body.error
        : `Could not upload the image (${response.status}).`,
    );
  if (typeof body.path !== "string" || !resolveAssetHref(body.path))
    throw new Error("The server returned an invalid image path.");
  return body.path;
}

export type ExtractedImageText = { text: string; cached: boolean };

/** Runs local OCR on an uploaded image and returns the extracted Markdown. */
export async function extractImageText(path: string): Promise<ExtractedImageText> {
  const bundleId = getActiveBundleId();
  let response: Response;
  try {
    response = await fetch("/api/assets/ocr", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(bundleId
          ? { "x-folio-bundle": bundleId, "x-folio-bundle-id": bundleId }
          : {}),
      },
      body: JSON.stringify({ path }),
    });
  } catch {
    throw new Error("The local FolioNotes service is not ready yet.");
  }
  let result: unknown = null;
  try {
    result = await response.json();
  } catch {
    result = null;
  }
  const body = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  if (!response.ok)
    throw new Error(
      typeof body.error === "string"
        ? body.error
        : `Could not extract text (${response.status}).`,
    );
  if (typeof body.text !== "string")
    throw new Error("The server returned invalid extracted text.");
  return { text: body.text, cached: body.cached === true };
}

export type ImageCaptionModelId = MlxCaptionModelId;
export type ImageCaption = { text: string; cached: boolean; model: ImageCaptionModelId };

/** Raised when image descriptions cannot run because no usable caption model is set up. */
export class ImageCaptionModelError extends Error {
  readonly code: "CAPTION_MODEL_NOT_SELECTED" | "CAPTION_MODEL_NOT_INSTALLED";
  readonly modelId: ImageCaptionModelId | null;

  constructor(
    code: "CAPTION_MODEL_NOT_SELECTED" | "CAPTION_MODEL_NOT_INSTALLED",
    message: string,
    modelId: ImageCaptionModelId | null,
  ) {
    super(message);
    this.name = "ImageCaptionModelError";
    this.code = code;
    this.modelId = modelId;
  }
}

function isCaptionModelId(value: unknown): value is ImageCaptionModelId {
  return value === "gemma4" || value === "qwen35";
}

/** Asks the selected local vision model to describe an uploaded image. */
export async function describeImage(path: string): Promise<ImageCaption> {
  const bundleId = getActiveBundleId();
  let response: Response;
  try {
    response = await fetch("/api/assets/caption", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(bundleId
          ? { "x-folio-bundle": bundleId, "x-folio-bundle-id": bundleId }
          : {}),
      },
      body: JSON.stringify({ path }),
    });
  } catch {
    throw new Error("The local FolioNotes service is not ready yet.");
  }
  let result: unknown = null;
  try {
    result = await response.json();
  } catch {
    result = null;
  }
  const body = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  if (!response.ok) {
    const message = typeof body.error === "string" ? body.error : `Could not describe the image (${response.status}).`;
    if (response.status === 409 && body.code === "CAPTION_MODEL_NOT_SELECTED")
      throw new ImageCaptionModelError("CAPTION_MODEL_NOT_SELECTED", message, null);
    if (response.status === 409 && body.code === "CAPTION_MODEL_NOT_INSTALLED")
      throw new ImageCaptionModelError("CAPTION_MODEL_NOT_INSTALLED", message, isCaptionModelId(body.modelId) ? body.modelId : null);
    throw new Error(message);
  }
  if (typeof body.text !== "string" || !isCaptionModelId(body.model))
    throw new Error("The server returned an invalid image description.");
  return { text: body.text, cached: body.cached === true, model: body.model };
}
