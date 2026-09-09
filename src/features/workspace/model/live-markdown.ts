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

const inlineSyntaxClasses: Readonly<Record<string, string>> = {
  StrongEmphasis: "cm-live-markdown-strong",
  Emphasis: "cm-live-markdown-emphasis",
  Strikethrough: "cm-live-markdown-strike",
  InlineCode: "cm-live-markdown-code",
};

const inlineMarkerNodes = new Set([
  "EmphasisMark",
  "StrikethroughMark",
  "CodeMark",
]);

const setLiveMarkdownFocus = StateEffect.define<boolean>();

function isClosingCodeFence(line: string, openingMarker: string) {
  const closingMarker = /^\s*(`+|~+)\s*$/.exec(line)?.[1];
  return Boolean(
    closingMarker &&
      closingMarker[0] === openingMarker[0] &&
      closingMarker.length >= openingMarker.length,
  );
}

function addHidden(
  ranges: Array<Range<Decoration>>,
  from: number,
  to: number,
  hidden: boolean,
) {
  if (!hidden) return;
  if (from < to)
    ranges.push(Decoration.replace({}).range(from, to));
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
    // Let the native control receive pointer/click events instead of letting
    // CodeMirror turn the click into a selection update first. That update can
    // reveal the source syntax and replace this widget before the click lands.
    return true;
  }
}

class ListMarkerWidget extends WidgetType {
  private readonly marker: string;
  private readonly nested: boolean;

  constructor(marker: string, nested: boolean) {
    super();
    this.marker = marker;
    this.nested = nested;
  }

  eq(other: ListMarkerWidget) {
    return other.marker === this.marker && other.nested === this.nested;
  }

  toDOM() {
    const marker = document.createElement("span");
    marker.className = [
      "cm-live-markdown-list-marker",
      this.nested && "cm-live-markdown-list-marker-nested",
    ]
      .filter(Boolean)
      .join(" ");
    marker.textContent = /^\d/.test(this.marker)
      ? this.nested
        ? `${orderedListLetter(Number.parseInt(this.marker, 10))}${this.marker.at(-1)}`
        : this.marker
      : this.nested
        ? "◦"
        : "•";
    marker.setAttribute("aria-hidden", "true");
    return marker;
  }
}

function orderedListLetter(number: number) {
  let remaining = number;
  let result = "";
  while (remaining > 0) {
    remaining -= 1;
    result = String.fromCharCode(97 + (remaining % 26)) + result;
    remaining = Math.floor(remaining / 26);
  }
  return result || "a";
}

function addLinkDecorations(
  ranges: Array<Range<Decoration>>,
  line: string,
  offset: number,
  reveal: (from: number, to: number) => boolean,
) {
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
  const reveal = (from: number, to: number) => {
    if (!focused) return false;
    return state.selection.ranges.some((range) => {
      if (range.empty) return range.from >= from && range.from <= to;
      return range.from < to && range.to > from;
    });
  };
  const ranges: Array<Range<Decoration>> = [];
  const fencedCodeRanges: SourceRange[] = [];
  const headingLevels = new Map<number, number>();
  const horizontalRuleLines = new Set<number>();
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name === "FencedCode")
        fencedCodeRanges.push({ from: node.from, to: node.to });

      if (node.name === "HorizontalRule")
        horizontalRuleLines.add(state.doc.lineAt(node.from).number);

      const heading = /^(?:ATX|Setext)Heading([1-6])$/.exec(node.name);
      if (heading)
        headingLevels.set(state.doc.lineAt(node.from).number, Number(heading[1]));

      if (node.name === "HeaderMark" && node.node.parent?.name.startsWith("ATXHeading")) {
        const parent = node.node.parent;
        const line = state.doc.lineAt(node.from);
        let from = node.from;
        let to = node.to;
        if (!node.node.prevSibling) {
          from = line.from;
          while (to < line.to && /\s/.test(state.sliceDoc(to, to + 1))) to += 1;
        }
        addHidden(ranges, from, to, !reveal(parent.from, parent.to));
      }

      const className = inlineSyntaxClasses[node.name];
      if (className && node.from < node.to)
        ranges.push(Decoration.mark({ class: className }).range(node.from, node.to));

      if (!inlineMarkerNodes.has(node.name)) return;
      const parent = node.node.parent;
      if (parent)
        addHidden(ranges, node.from, node.to, !reveal(parent.from, parent.to));
    },
  });
  for (let lineNumber = 1; lineNumber <= state.doc.lines; lineNumber += 1) {
    const line = state.doc.line(lineNumber);
    const text = line.text;
    const fencedCode = fencedCodeRanges.find(
      (range) => line.from >= range.from && line.to <= range.to,
    );
    if (fencedCode) {
      const openingLine = state.doc.lineAt(fencedCode.from);
      const openingMarker = /^\s*(`{3,}|~{3,})/.exec(openingLine.text)?.[1] ?? "```";
      const endLine = state.doc.lineAt(fencedCode.to);
      const hasClosingFence =
        endLine.number > openingLine.number &&
        isClosingCodeFence(endLine.text, openingMarker);
      const fenceLine =
        lineNumber === openingLine.number ||
        (hasClosingFence && lineNumber === endLine.number);
      const fenceHidden = fenceLine && !reveal(line.from, line.to);
      const firstContentLine = openingLine.number + 1;
      const lastContentLine = endLine.number - (hasClosingFence ? 1 : 0);
      const codeClasses = [
        "cm-live-markdown-code-block",
        fenceLine && "cm-live-markdown-code-fence",
        fenceHidden && "cm-live-markdown-code-fence-hidden",
        lineNumber === firstContentLine && "cm-live-markdown-code-block-first",
        lineNumber === lastContentLine && "cm-live-markdown-code-block-last",
      ].filter((className): className is string => Boolean(className));
      ranges.push(
        Decoration.line({ class: codeClasses.join(" ") }).range(line.from),
      );
      addHidden(ranges, line.from, line.to, fenceHidden);
      continue;
    }
    const headingLevel = headingLevels.get(lineNumber);
    const horizontalRule = horizontalRuleLines.has(lineNumber);
    const quote = /^(\s*>\s?)+/.exec(text);
    const list = /^(\s*)([-+*]|\d+[.)])(\s+)/.exec(text);
    const task = list
      ? /^(?:\s*(?:[-+*]|\d+[.)])\s+)\[([ xX])\](?=\s|$)/.exec(text)
      : null;
    const listMarker = list?.[2];
    const listPreview = Boolean(list && !reveal(line.from, line.to));
    const listIndent = list
      ? list[1].match(/[ \t]*$/)?.[0].replaceAll("\t", "  ").length ?? 0
      : 0;
    const isTable = /^\|.*\|\s*$/.test(text);
    const lineClasses = [
      headingLevel && `cm-live-markdown-heading cm-live-markdown-heading-${headingLevel}`,
      horizontalRule && "cm-live-markdown-horizontal-rule",
      quote && "cm-live-markdown-quote",
      list && "cm-live-markdown-list",
      listPreview && listMarker && /^\d/.test(listMarker) && "cm-live-markdown-list-ordered",
      listPreview && listMarker && !/^\d/.test(listMarker) && "cm-live-markdown-list-bullet",
      listPreview && listIndent >= 2 && "cm-live-markdown-list-nested",
      isTable && "cm-live-markdown-table",
    ].filter((className): className is string => Boolean(className));
    if (lineClasses.length)
      ranges.push(
        Decoration.line({
          class: lineClasses.join(" "),
          attributes: headingLevel
            ? { role: "heading", "aria-level": String(headingLevel) }
            : undefined,
        }).range(line.from),
      );
    if (horizontalRule)
      addHidden(ranges, line.from, line.to, !reveal(line.from, line.to));
    if (quote) {
      addHidden(ranges, line.from, line.from + quote[0].length, !reveal(line.from, line.to));
    }
    if (list) {
      const markerStart = line.from + list[1].length;
      const markerEnd = markerStart + list[2].length + list[3].length;
      if (listPreview) {
        if (task) {
          // Task syntax belongs to the list marker. Replacing both ranges with
          // one widget prevents the dash from becoming a second bullet.
          ranges.push(
            Decoration.replace({
              widget: new TaskCheckboxWidget(
                task[1].toLowerCase() === "x",
                lineNumber,
                configuration.callbacks,
              ),
            }).range(markerStart, line.from + task[0].length),
          );
        } else {
          ranges.push(
            Decoration.replace({
              widget: new ListMarkerWidget(list[2], listIndent >= 2),
            }).range(markerStart, markerEnd),
          );
        }
      } else {
        ranges.push(
          Decoration.mark({ class: "cm-live-markdown-list-source" }).range(
            markerStart,
            markerEnd,
          ),
        );
      }
    }
    if (/^```/.test(text)) addHidden(ranges, line.from, line.to, !reveal(line.from, line.to));
    addLinkDecorations(ranges, text, line.from, reveal);
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

/** Inserts a continuation line inside the current list item. */
export function insertLiveMarkdownListLineBreak(
  value: string,
  selectionStart: number,
  selectionEnd: number,
) {
  const lineStart = value.lastIndexOf("\n", selectionStart - 1) + 1;
  const lineEnd = value.indexOf("\n", selectionStart);
  const line = value.slice(lineStart, lineEnd === -1 ? value.length : lineEnd);
  const match = /^((?:[ \t]*>\s*)*[ \t]*)([-+*]|\d+[.)])(\s+)(?:\[([ xX])\](\s+))?/.exec(line);
  if (!match) return null;
  const [, prefix, marker, spacing, taskState, taskSpacing = ""] = match;
  const contentStart =
    prefix.length +
    marker.length +
    spacing.length +
    (taskState === undefined ? 0 : taskSpacing.length + 3);
  if (selectionStart - lineStart < contentStart) return null;
  const indentation = `${prefix}${" ".repeat(contentStart - prefix.length)}`;
  return {
    value: `${value.slice(0, selectionStart)}\n${indentation}${value.slice(selectionEnd)}`,
    caret: selectionStart + indentation.length + 1,
  };
}

type ParsedListItem = { prefix: string; marker: string };

function parseListItem(line: string): ParsedListItem | null {
  const match = /^((?:[ \t]*>\s*)*[ \t]*)([-+*]|\d+[.)])[ \t]+/.exec(line);
  return match ? { prefix: match[1], marker: match[2] } : null;
}

type OrderedListSequence = { nextNumber: number; ordered: boolean };
export type LiveMarkdownOrderedListChange = {
  from: number;
  to: number;
  insert: string;
};

/**
 * Normalizes each ordered sibling sequence while preserving its first number.
 * Nested sequences are tracked independently and may contain bullet sublists.
 */
export function liveMarkdownOrderedListChanges(value: string) {
  const lines = value.split("\n");
  const sequences = new Map<string, OrderedListSequence>();
  const changes: LiveMarkdownOrderedListChange[] = [];
  let lineStart = 0;

  for (const line of lines) {
    if (!line.trim()) {
      sequences.clear();
      lineStart += line.length + 1;
      continue;
    }
    const item = parseListItem(line);
    if (!item) {
      lineStart += line.length + 1;
      continue;
    }
    const ordered = /^\d/.test(item.marker);
    const sequence = sequences.get(item.prefix);
    if (!ordered) {
      sequences.set(item.prefix, { nextNumber: 1, ordered: false });
      lineStart += line.length + 1;
      continue;
    }
    const currentNumber = Number.parseInt(item.marker, 10);
    if (!sequence?.ordered) {
      sequences.set(item.prefix, { nextNumber: currentNumber + 1, ordered: true });
      lineStart += line.length + 1;
      continue;
    }
    const replacement = `${sequence.nextNumber}${item.marker.at(-1)}`;
    if (replacement !== item.marker) {
      const markerStart = lineStart + item.prefix.length;
      changes.push({
        from: markerStart,
        to: markerStart + item.marker.length,
        insert: replacement,
      });
    }
    sequence.nextNumber += 1;
    lineStart += line.length + 1;
  }

  return changes;
}

export function normalizeLiveMarkdownOrderedLists(value: string) {
  const changes = liveMarkdownOrderedListChanges(value);
  let nextValue = value;
  for (let index = changes.length - 1; index >= 0; index -= 1) {
    const change = changes[index];
    nextValue = `${nextValue.slice(0, change.from)}${change.insert}${nextValue.slice(change.to)}`;
  }
  return nextValue;
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
