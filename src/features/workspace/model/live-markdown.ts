import {
  EditorState,
  type Range,
  StateEffect,
  StateField,
} from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import {
  Decoration,
  EditorView,
  WidgetType,
  type DecorationSet,
} from "@codemirror/view";
import type { MutableRefObject } from "react";

export type LiveMarkdownCallbacks = {
  onOpenLink?: (href: string) => void;
  onToggleTask?: (lineNumber: number, checked: boolean) => void | Promise<void>;
};

export type LiveMarkdownSelection = { from: number; to: number };

export type LiveMarkdownListIndentDirection = "indent" | "outdent";

export type LiveMarkdownListIndentChange = {
  value: string;
  selection: LiveMarkdownSelection;
};

type LiveMarkdownConfiguration = {
  callbacks: MutableRefObject<LiveMarkdownCallbacks>;
};

type SourceLink = { from: number; to: number; href: string };
type SourceRange = { from: number; to: number };

const setLiveMarkdownFocus = StateEffect.define<boolean>();

function addHidden(
  ranges: Array<Range<Decoration>>,
  from: number,
  to: number,
  hidden: boolean,
) {
  if (!hidden) return;
  if (from < to)
    ranges.push(Decoration.mark({ class: "cm-live-markdown-marker" }).range(from, to));
}

class TaskCheckboxWidget extends WidgetType {
  private readonly checked: boolean;
  private readonly lineNumber: number;
  private readonly callbacks: MutableRefObject<LiveMarkdownCallbacks>;

  constructor(
    checked: boolean,
    lineNumber: number,
    callbacks: MutableRefObject<LiveMarkdownCallbacks>,
  ) {
    super();
    this.checked = checked;
    this.lineNumber = lineNumber;
    this.callbacks = callbacks;
  }

  eq(other: TaskCheckboxWidget) {
    return other.checked === this.checked && other.lineNumber === this.lineNumber;
  }

  toDOM() {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = this.checked;
    input.className = "cm-live-markdown-task";
    input.setAttribute("aria-label", `Toggle task on line ${this.lineNumber}`);
    input.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void this.callbacks.current.onToggleTask?.(this.lineNumber, !this.checked);
    });
    return input;
  }

  ignoreEvent() {
    return false;
  }
}

function addInlineDecorations(
  ranges: Array<Range<Decoration>>,
  line: string,
  offset: number,
  reveal: (from: number, to: number) => boolean,
  codeRanges: SourceRange[],
) {
  const pairs: Array<{ expression: RegExp; className: string; markerLength: number }> = [
    { expression: /(\*\*|__)(.+?)\1/g, className: "cm-live-markdown-strong", markerLength: 2 },
    { expression: /~~(.+?)~~/g, className: "cm-live-markdown-strike", markerLength: 2 },
    { expression: /`([^`]+)`/g, className: "cm-live-markdown-code", markerLength: 1 },
    { expression: /(?<!\*)\*([^*]+)\*(?!\*)/g, className: "cm-live-markdown-emphasis", markerLength: 1 },
    { expression: /(?<!_)_([^_]+)_(?!_)/g, className: "cm-live-markdown-emphasis", markerLength: 1 },
  ];
  for (const { expression, className, markerLength } of pairs) {
    for (const match of line.matchAll(expression)) {
      const start = offset + (match.index ?? 0);
      const end = start + match[0].length;
      if (
        className !== "cm-live-markdown-code" &&
        codeRanges.some((range) => start >= range.from && end <= range.to)
      )
        continue;
      const markersAreHidden = !reveal(start, end);
      addHidden(ranges, start, start + markerLength, markersAreHidden);
      addHidden(ranges, end - markerLength, end, markersAreHidden);
      ranges.push(
        Decoration.mark({ class: className }).range(
          start + markerLength,
          end - markerLength,
        ),
      );
    }
  }

  for (const match of line.matchAll(/\[([^\]]+)\]\(([^)\s]+)(?:\s+[^)]*)?\)/g)) {
    const start = offset + (match.index ?? 0);
    const textStart = start + 1;
    const textEnd = textStart + match[1].length;
    const markersAreHidden = !reveal(start, start + match[0].length);
    addHidden(ranges, start, textStart, markersAreHidden);
    addHidden(ranges, textEnd, start + match[0].length, markersAreHidden);
    ranges.push(
      Decoration.mark({ class: "cm-live-markdown-link" }).range(textStart, textEnd),
    );
  }
}

function buildDecorations(
  state: EditorState,
  configuration: LiveMarkdownConfiguration,
  focused: boolean,
): DecorationSet {
  const codeRanges: SourceRange[] = [];
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name === "FencedCode" || node.name === "InlineCode")
        codeRanges.push({ from: node.from, to: node.to });
    },
  });
  const reveal = (from: number, to: number) => {
    if (!focused) return false;
    return state.selection.ranges.some((range) => {
      if (range.empty) return range.from >= from && range.from <= to;
      return range.from < to && range.to > from;
    });
  };
  const ranges: Array<Range<Decoration>> = [];
  for (let lineNumber = 1; lineNumber <= state.doc.lines; lineNumber += 1) {
    const line = state.doc.line(lineNumber);
    const text = line.text;
    if (codeRanges.some((range) => line.from >= range.from && line.to <= range.to))
      continue;
    const heading = /^(#{1,6})\s+/.exec(text);
    const quote = /^(\s*>\s?)+/.exec(text);
    const list = /^(\s*)([-+*]|\d+[.)])(\s+)/.exec(text);
    const listMarker = list?.[2];
    const listPreview = Boolean(list && !reveal(line.from, line.to));
    const listIndent = list
      ? list[1].match(/[ \t]*$/)?.[0].replaceAll("\t", "  ").length ?? 0
      : 0;
    const isTable = /^\|.*\|\s*$/.test(text);
    const lineClasses = [
      heading && `cm-live-markdown-heading cm-live-markdown-heading-${heading[1].length}`,
      quote && "cm-live-markdown-quote",
      listPreview && "cm-live-markdown-list",
      listPreview && listMarker && /^\d/.test(listMarker) && "cm-live-markdown-list-ordered",
      listPreview && listMarker && !/^\d/.test(listMarker) && "cm-live-markdown-list-bullet",
      isTable && "cm-live-markdown-table",
    ].filter((className): className is string => Boolean(className));
    if (lineClasses.length)
      ranges.push(
        Decoration.line({
          class: lineClasses.join(" "),
          attributes: heading
            ? { role: "heading", "aria-level": String(heading[1].length) }
            : listPreview
              ? {
                  ...(listMarker && /^\d/.test(listMarker)
                    ? { "data-live-markdown-list-marker": listMarker }
                    : {}),
                  style: `padding-left: ${22 + Math.floor(listIndent / 2) * 20}px`,
                }
              : undefined,
        }).range(line.from),
      );
    if (heading) {
      addHidden(ranges, line.from, line.from + heading[0].length, !reveal(line.from, line.to));
    }
    if (quote) {
      addHidden(ranges, line.from, line.from + quote[0].length, !reveal(line.from, line.to));
    }
    if (list) {
      const markerStart = line.from + list[1].length;
      const markerEnd = markerStart + list[2].length + list[3].length;
      addHidden(ranges, markerStart, markerEnd, !reveal(line.from, line.to));
    }
    const task = /\[([ xX])\]/.exec(text);
    if (task) {
      const taskFrom = line.from + (task.index ?? 0);
      if (!reveal(line.from, line.to)) {
        ranges.push(
          Decoration.replace({
            widget: new TaskCheckboxWidget(
              task[1].toLowerCase() === "x",
              lineNumber,
              configuration.callbacks,
            ),
          }).range(taskFrom, taskFrom + task[0].length),
        );
      }
    }
    if (/^```/.test(text)) addHidden(ranges, line.from, line.to, !reveal(line.from, line.to));
    addInlineDecorations(ranges, text, line.from, reveal, codeRanges);
  }
  return Decoration.set(ranges, true);
}

type DecorationFieldValue = { decorations: DecorationSet; focused: boolean };

function sourceLinkAt(documentText: string, position: number): SourceLink | null {
  const lineStart = documentText.lastIndexOf("\n", Math.max(0, position - 1)) + 1;
  const lineEnd = documentText.indexOf("\n", position);
  const line = documentText.slice(lineStart, lineEnd === -1 ? documentText.length : lineEnd);
  for (const match of line.matchAll(/\[([^\]]+)\]\(([^)\s]+)(?:\s+[^)]*)?\)/g)) {
    const from = lineStart + (match.index ?? 0);
    const to = from + match[0].length;
    if (position >= from && position <= to) return { from, to, href: match[2] };
  }
  return null;
}

export function liveMarkdownExtensions(configuration: LiveMarkdownConfiguration) {
  const decorations = StateField.define<DecorationFieldValue>({
    create: (state) => ({
      decorations: buildDecorations(state, configuration, false),
      focused: false,
    }),
    update(value, transaction) {
      let focused = value.focused;
      for (const effect of transaction.effects) {
        if (effect.is(setLiveMarkdownFocus)) focused = effect.value;
      }
      if (focused === value.focused && !transaction.docChanged && !transaction.selection)
        return value;
      return {
        focused,
        decorations: buildDecorations(transaction.state, configuration, focused),
      };
    },
    provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
  });

  return [
    decorations,
    EditorView.domEventHandlers({
      focus: (_event, view) => {
        view.dispatch({ effects: setLiveMarkdownFocus.of(true) });
        return false;
      },
      blur: (_event, view) => {
        view.dispatch({ effects: setLiveMarkdownFocus.of(false) });
        return false;
      },
      mousedown: (event, view) => {
        if (!(event.metaKey || event.ctrlKey)) return false;
        const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (position === null) return false;
        const link = sourceLinkAt(view.state.doc.toString(), position);
        if (!link) return false;
        event.preventDefault();
        configuration.callbacks.current.onOpenLink?.(link.href);
        return true;
      },
    }),
  ];
}

export function continueLiveMarkdownList(
  value: string,
  selectionStart: number,
  selectionEnd: number,
) {
  if (selectionStart !== selectionEnd) return null;
  const lineStart = value.lastIndexOf("\n", selectionStart - 1) + 1;
  const nextBreak = value.indexOf("\n", selectionStart);
  const lineEnd = nextBreak === -1 ? value.length : nextBreak;
  const line = value.slice(lineStart, lineEnd);
  const match = line.match(
    /^((?:[ \t]*>\s*)*[ \t]*)([-+*]|\d+[.)])(\s+)(?:\[([ xX])\](\s+))?(.*)$/,
  );
  if (!match) return null;
  const [, prefix, marker, spacing, taskState, taskSpacing = "", itemContent] = match;
  const markerLength = prefix.length + marker.length + spacing.length + (taskState === undefined ? 0 : taskSpacing.length + 3);
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
  let nextValue = `${value.slice(0, selectionStart)}\n${nextPrefix}${value.slice(selectionEnd)}`;
  const caret = selectionStart + nextPrefix.length + 1;
  if (/^\d/.test(marker))
    nextValue = renumberFollowingOrderedSiblings(
      nextValue,
      caret,
      prefix,
      Number.parseInt(marker, 10) + 2,
    );
  return {
    value: nextValue,
    caret,
  };
}

type ParsedListItem = { prefix: string; marker: string };

function parseListItem(line: string): ParsedListItem | null {
  const match = /^((?:[ \t]*>\s*)*[ \t]*)([-+*]|\d+[.)])[ \t]+/.exec(line);
  return match ? { prefix: match[1], marker: match[2] } : null;
}

/**
 * Keep the direct ordered-list siblings after a newly inserted item in order.
 * Nested list items remain untouched, and another list type ends the sequence.
 */
function renumberFollowingOrderedSiblings(
  value: string,
  caret: number,
  prefix: string,
  nextNumber: number,
) {
  const firstBreak = value.indexOf("\n", caret);
  if (firstBreak === -1) return value;
  let lineStart = firstBreak + 1;
  let nextValue = value;
  while (lineStart <= nextValue.length) {
    const lineBreak = nextValue.indexOf("\n", lineStart);
    const lineEnd = lineBreak === -1 ? nextValue.length : lineBreak;
    const line = nextValue.slice(lineStart, lineEnd);
    const item = parseListItem(line);
    if (!item) break;
    if (item.prefix !== prefix) {
      if (item.prefix.startsWith(prefix)) {
        lineStart = lineBreak === -1 ? nextValue.length + 1 : lineBreak + 1;
        continue;
      }
      break;
    }
    if (!/^\d/.test(item.marker)) break;
    const markerStart = lineStart + prefix.length;
    const replacement = `${nextNumber}${item.marker.at(-1)}`;
    nextValue = `${nextValue.slice(0, markerStart)}${replacement}${nextValue.slice(markerStart + item.marker.length)}`;
    const lengthChange = replacement.length - item.marker.length;
    nextNumber += 1;
    lineStart = lineBreak === -1 ? nextValue.length + 1 : lineBreak + 1 + lengthChange;
  }
  return nextValue;
}

type ListIndentEdit = { from: number; to: number; insert: string };

function selectedLineIndexes(value: string, selection: LiveMarkdownSelection) {
  const starts = [0];
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "\n") starts.push(index + 1);
  }
  const lineAt = (position: number) => {
    let low = 0;
    let high = starts.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (starts[middle] <= position) low = middle + 1;
      else high = middle;
    }
    return low - 1;
  };
  const endPosition = selection.from === selection.to ? selection.to : selection.to - 1;
  const indexes: number[] = [];
  for (let line = lineAt(selection.from); line <= lineAt(endPosition); line += 1)
    indexes.push(line);
  return { indexes, starts };
}

function mapListIndentPosition(position: number, edits: ListIndentEdit[]) {
  let offset = 0;
  for (const edit of edits) {
    const removed = edit.to - edit.from;
    if (removed === 0) {
      if (position >= edit.from) offset += edit.insert.length;
      continue;
    }
    if (position > edit.from && position < edit.to) return edit.from + offset;
    if (position >= edit.to) offset += edit.insert.length - removed;
  }
  return position + offset;
}

/**
 * Indents or outdents every Markdown list item intersected by a selection.
 * Source selections are half-open, so a selection ending at the start of a
 * line does not alter that final line.
 */
export function changeLiveMarkdownListIndentation(
  value: string,
  selection: LiveMarkdownSelection,
  direction: LiveMarkdownListIndentDirection,
): LiveMarkdownListIndentChange | null {
  if (
    selection.from < 0 ||
    selection.to < selection.from ||
    selection.to > value.length
  )
    return null;

  const { indexes, starts } = selectedLineIndexes(value, selection);
  const edits: ListIndentEdit[] = [];
  for (const lineIndex of indexes) {
    const from = starts[lineIndex];
    const to = value.indexOf("\n", from);
    const line = value.slice(from, to === -1 ? value.length : to);
    if (!/^[ \t]*(?:[-+*]|\d+[.)])[ \t]+/.test(line)) return null;

    if (direction === "indent") {
      edits.push({ from, to: from, insert: "  " });
      continue;
    }

    const indentation = /^ {1,2}/.exec(line)?.[0] ?? "";
    if (indentation)
      edits.push({ from, to: from + indentation.length, insert: "" });
  }

  if (!edits.length) return null;
  let nextValue = value;
  for (let index = edits.length - 1; index >= 0; index -= 1) {
    const edit = edits[index];
    nextValue = `${nextValue.slice(0, edit.from)}${edit.insert}${nextValue.slice(edit.to)}`;
  }
  return {
    value: nextValue,
    selection: {
      from: mapListIndentPosition(selection.from, edits),
      to: mapListIndentPosition(selection.to, edits),
    },
  };
}
