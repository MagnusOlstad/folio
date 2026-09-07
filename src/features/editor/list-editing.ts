const LIST_ITEM_PATTERN =
  /^((?:[ \t]*>\s*)*[ \t]*)([-+*]|\d+[.)])(\s+)(?:\[([ xX])\](\s+))?(.*)$/;

function baseIndent(prefix: string) {
  return prefix.length - prefix.replace(/[ \t]+$/, "").length;
}

function renumberFollowingOrderedItems(
  value: string,
  startOffset: number,
  splitIndent: number,
  firstNumber: number,
) {
  type Renumbering = { start: number; end: number; marker: string };
  const renumberings: Renumbering[] = [];
  let offset = startOffset;
  let nextNumber = firstNumber;
  while (offset < value.length) {
    const lineBreak = value.indexOf("\n", offset);
    const line = value.slice(offset, lineBreak === -1 ? value.length : lineBreak);
    if (!line.trim()) break;
    const match = LIST_ITEM_PATTERN.exec(line);
    if (!match) break;
    const indent = baseIndent(match[1]);
    if (indent < splitIndent) break;
    if (indent > splitIndent) {
      offset = lineBreak === -1 ? value.length : lineBreak + 1;
      continue;
    }
    if (!/^\d/.test(match[2])) break;
    const markerStart = offset + match[1].length;
    renumberings.push({
      start: markerStart,
      end: markerStart + match[2].length,
      marker: `${nextNumber}${match[2].slice(-1)}`,
    });
    nextNumber += 1;
    offset = lineBreak === -1 ? value.length : lineBreak + 1;
  }
  for (let index = renumberings.length - 1; index >= 0; index -= 1) {
    const renumbering = renumberings[index];
    value =
      value.slice(0, renumbering.start) +
      renumbering.marker +
      value.slice(renumbering.end);
  }
  return value;
}

export type ListContinuation = { value: string; caret: number };

export function continueMarkdownList(
  value: string,
  selectionStart: number,
  selectionEnd: number,
): ListContinuation | null {
  if (selectionStart !== selectionEnd) return null;
  const lineStart = value.lastIndexOf("\n", selectionStart - 1) + 1;
  const nextBreak = value.indexOf("\n", selectionStart);
  const lineEnd = nextBreak === -1 ? value.length : nextBreak;
  const line = value.slice(lineStart, lineEnd);
  const match = line.match(LIST_ITEM_PATTERN);
  if (!match) return null;
  const [, prefix, marker, spacing, taskState, taskSpacing = "", itemContent] =
    match;
  const markerLength =
    prefix.length +
    marker.length +
    spacing.length +
    (taskState === undefined ? 0 : taskSpacing.length + 3);
  if (selectionStart - lineStart < markerLength) return null;
  if (!itemContent.trim())
    return {
      value: `${value.slice(0, lineStart)}${prefix}${value.slice(lineEnd)}`,
      caret: lineStart + prefix.length,
    };
  const nextMarker = /^\d/.test(marker)
    ? `${Number.parseInt(marker, 10) + 1}${marker.at(-1)}`
    : marker;
  const nextPrefix = `${prefix}${nextMarker}${spacing}${taskState === undefined ? "" : `[ ]${taskSpacing}`}`;
  const withSplit = `${value.slice(0, selectionStart)}\n${nextPrefix}${value.slice(selectionEnd)}`;
  const newLineBreak = withSplit.indexOf(
    "\n",
    selectionStart + 1 + nextPrefix.length,
  );
  const followingStart =
    newLineBreak === -1 ? withSplit.length : newLineBreak + 1;
  const renumbered = /^\d/.test(marker)
    ? renumberFollowingOrderedItems(
        withSplit,
        followingStart,
        baseIndent(prefix),
        Number.parseInt(marker, 10) + 2,
      )
    : withSplit;
  return {
    value: renumbered,
    caret: selectionStart + nextPrefix.length + 1,
  };
}
