/** Obsidian-style image sizing: `![alt|300](path)` or `![alt|300x200](path)`. */

export const MIN_IMAGE_WIDTH = 48;

const SIZE_SUFFIX = /\|(\d{1,5})(?:x(\d{1,5}))?[ \t]*$/;

export type ParsedImageAlt = {
  /** Alt text without the size suffix. */
  alt: string;
  /** Requested width in CSS pixels, or null for the natural size. */
  width: number | null;
  height: number | null;
};

export function parseImageAlt(raw: string): ParsedImageAlt {
  const match = SIZE_SUFFIX.exec(raw);
  if (!match) return { alt: raw, width: null, height: null };
  const width = Number.parseInt(match[1], 10);
  const height = match[2] === undefined ? null : Number.parseInt(match[2], 10);
  return {
    alt: raw.slice(0, match.index).trimEnd(),
    width: width > 0 ? width : null,
    height: height !== null && height > 0 ? height : null,
  };
}

/** Appends (or removes, for a null width) the size suffix on an alt string. */
export function formatImageAlt(alt: string, width: number | null) {
  const base = parseImageAlt(alt).alt;
  if (width === null || !Number.isFinite(width)) return base;
  return `${base}|${Math.max(1, Math.round(width))}`;
}

/** Index of the `]` that closes the alt text starting after `![`, or -1. */
function altEnd(source: string) {
  let depth = 0;
  for (let index = 2; index < source.length; index += 1) {
    const char = source[index];
    if (char === "\\") index += 1;
    else if (char === "[") depth += 1;
    else if (char === "]") {
      if (depth === 0) return index;
      depth -= 1;
    }
  }
  return -1;
}

/** Range of the alt text (between `![` and its closing `]`) relative to the source, or null. */
export function imageAltBounds(source: string) {
  if (!source.startsWith("![")) return null;
  const end = altEnd(source);
  return end < 0 ? null : { from: 2, to: end };
}

/**
 * Rewrites only the alt portion of an inline image's Markdown source so it
 * carries the given width (null removes the size). Returns the replacement
 * range relative to the source and the new alt text, or null when the source
 * is not an image.
 */
export function imageAltWidthChange(source: string, width: number | null) {
  if (!source.startsWith("![")) return null;
  const end = altEnd(source);
  if (end < 0) return null;
  const insert = formatImageAlt(source.slice(2, end), width);
  return { from: 2, to: end, insert };
}
