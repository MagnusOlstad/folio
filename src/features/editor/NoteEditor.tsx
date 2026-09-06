import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { applyFormatMarker, type FormatMarker } from "../../markdown-format.ts";
import type { EditorIntent } from "../../domain/types.ts";

function lineStartOffset(value: string, lineNumber: number) {
  let offset = 0;
  for (let line = 1; line < lineNumber; line += 1) {
    const lineBreak = value.indexOf("\n", offset);
    if (lineBreak === -1) return value.length;
    offset = lineBreak + 1;
  }
  return offset;
}

function continueMarkdownList(
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
  return {
    value: `${value.slice(0, selectionStart)}\n${nextPrefix}${value.slice(selectionEnd)}`,
    caret: selectionStart + nextPrefix.length + 1,
  };
}

export function NoteEditor({
  value,
  onChange,
  onBlur,
  onFile,
  steered = false,
  intent,
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  onBlur: (scrollTop: number) => void;
  onFile?: () => void;
  steered?: boolean;
  intent?: EditorIntent;
  ariaLabel: string;
}) {
  const shellRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const initialValue = useRef(value);
  const pendingSelection = useRef<[number, number] | null>(null);
  const [steeringHeight, setSteeringHeight] = useState(0);
  const placeholder =
    "Optional: steer the title or path here. Press Enter to let the agent decide.";
  const firstLine = value.split("\n", 1)[0];
  const measuredFirstLine = firstLine || (!value ? placeholder : " ");

  useLayoutEffect(() => {
    if (!steered) return;
    const shell = shellRef.current;
    const measure = measureRef.current;
    if (!shell || !measure) return;
    const updateHeight = () =>
      setSteeringHeight(Math.ceil(measure.getBoundingClientRect().height));
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(shell);
    return () => observer.disconnect();
  }, [measuredFirstLine, steered]);
  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const frame = window.requestAnimationFrame(() => {
      editor.focus({ preventScroll: true });
      if (!intent) return;
      const offset = lineStartOffset(initialValue.current, intent.lineNumber);
      editor.setSelectionRange(offset, offset);
      editor.scrollTop = intent.scrollTop;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [intent]);
  useLayoutEffect(() => {
    const selection = pendingSelection.current;
    if (!selection) return;
    pendingSelection.current = null;
    editorRef.current?.setSelectionRange(selection[0], selection[1]);
  }, [value]);
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const format = (event: Event) => {
      const marker = (event as CustomEvent<FormatMarker>).detail;
      if (marker !== "bold" && marker !== "italic" && marker !== "link") return;
      event.preventDefault();
      const result = applyFormatMarker(
        editor.value,
        editor.selectionStart,
        editor.selectionEnd,
        marker,
      );
      pendingSelection.current = [result.selectionStart, result.selectionEnd];
      onChange(result.value);
    };
    editor.addEventListener("folio-format", format);
    return () => editor.removeEventListener("folio-format", format);
  }, [onChange]);
  const editor = (
    <textarea
      className="document-editor"
      ref={editorRef}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onBlur={(event) => onBlur(event.currentTarget.scrollTop)}
      onKeyDown={(event) => {
        if (
          onFile &&
          (event.metaKey || event.ctrlKey) &&
          event.key === "Enter"
        ) {
          event.preventDefault();
          onFile();
          return;
        }
        if (
          event.key !== "Enter" ||
          event.metaKey ||
          event.ctrlKey ||
          event.altKey ||
          event.shiftKey ||
          event.nativeEvent.isComposing
        )
          return;
        const edit = continueMarkdownList(
          value,
          event.currentTarget.selectionStart,
          event.currentTarget.selectionEnd,
        );
        if (!edit) return;
        event.preventDefault();
        onChange(edit.value);
        window.requestAnimationFrame(() =>
          editorRef.current?.setSelectionRange(edit.caret, edit.caret),
        );
      }}
      aria-label={ariaLabel}
    />
  );
  if (!steered) return editor;
  return (
    <div
      className="draft-note-editor"
      ref={shellRef}
      style={
        { "--steering-height": `${steeringHeight}px` } as React.CSSProperties
      }
    >
      <div className="draft-steering-band" />
      <div
        className="draft-steering-measure"
        ref={measureRef}
        aria-hidden="true"
      >
        {measuredFirstLine}
      </div>
      {!value && (
        <span className="draft-steering-placeholder" aria-hidden="true">
          {placeholder}
        </span>
      )}
      {editor}
    </div>
  );
}
