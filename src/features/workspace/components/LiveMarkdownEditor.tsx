import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import {
  defaultKeymap,
  history,
  historyKeymap,
  selectAll,
} from "@codemirror/commands";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import {
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";
import type { EditorIntent } from "../../../domain/types.ts";
import { applyFormatMarker, type FormatMarker } from "../../../markdown-format.ts";
import {
  changeLiveMarkdownListIndentation,
  continueLiveMarkdownList,
  liveMarkdownExtensions,
  type LiveMarkdownCallbacks,
} from "../model/live-markdown.ts";

export type LiveMarkdownEditorProps = {
  value: string;
  onChange: (value: string) => void;
  onBlur?: (scrollTop: number) => void;
  onFocus?: () => void;
  onFile?: () => void;
  onOpenLink?: (href: string) => void;
  onToggleTask?: (lineNumber: number, checked: boolean) => void | Promise<void>;
  intent?: EditorIntent;
  autoFocus?: boolean;
  ariaLabel: string;
};

function lineStartOffset(value: string, lineNumber: number) {
  let offset = 0;
  for (let line = 1; line < lineNumber; line += 1) {
    const lineBreak = value.indexOf("\n", offset);
    if (lineBreak === -1) return value.length;
    offset = lineBreak + 1;
  }
  return offset;
}

function applyFormat(view: EditorView, marker: FormatMarker) {
  const selection = view.state.selection.main;
  const result = applyFormatMarker(
    view.state.doc.toString(),
    selection.from,
    selection.to,
    marker,
  );
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: result.value },
    selection: EditorSelection.range(result.selectionStart, result.selectionEnd),
  });
}

function changeListIndentation(
  view: EditorView,
  direction: "indent" | "outdent",
) {
  const selection = view.state.selection.main;
  const result = changeLiveMarkdownListIndentation(
    view.state.doc.toString(),
    { from: selection.from, to: selection.to },
    direction,
  );
  if (!result) return false;
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: result.value },
    selection: EditorSelection.range(
      result.selection.from,
      result.selection.to,
    ),
  });
  return true;
}

export function LiveMarkdownEditor({
  value,
  onChange,
  onBlur,
  onFocus,
  onFile,
  onOpenLink,
  onToggleTask,
  intent,
  autoFocus = false,
  ariaLabel,
}: LiveMarkdownEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const onBlurRef = useRef(onBlur);
  const onFocusRef = useRef(onFocus);
  const onFileRef = useRef(onFile);
  const lastIntentRef = useRef<string | null>(null);
  const callbacksRef = useRef<LiveMarkdownCallbacks>({
    onOpenLink,
    onToggleTask,
  });

  useLayoutEffect(() => {
    valueRef.current = value;
    onChangeRef.current = onChange;
    onBlurRef.current = onBlur;
    onFocusRef.current = onFocus;
    onFileRef.current = onFile;
    callbacksRef.current = { onOpenLink, onToggleTask };
  }, [onBlur, onChange, onFile, onFocus, onOpenLink, onToggleTask, value]);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = new EditorView({
      state: EditorState.create({
        doc: valueRef.current,
        extensions: [
          markdown({ base: markdownLanguage }),
          history(),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ "aria-label": ariaLabel }),
          keymap.of([
            { key: "Mod-a", run: selectAll },
            {
              key: "Tab",
              run: (editor) => changeListIndentation(editor, "indent"),
            },
            {
              key: "Shift-Tab",
              run: (editor) => changeListIndentation(editor, "outdent"),
            },
            {
              key: "Mod-Enter",
              run: () => {
                if (!onFileRef.current) return false;
                onFileRef.current();
                return true;
              },
            },
            {
              key: "Enter",
              run: (editor) => {
                const selection = editor.state.selection.main;
                const edit = continueLiveMarkdownList(
                  editor.state.doc.toString(),
                  selection.from,
                  selection.to,
                );
                if (!edit) return false;
                editor.dispatch({
                  changes: { from: 0, to: editor.state.doc.length, insert: edit.value },
                  selection: { anchor: edit.caret },
                });
                return true;
              },
            },
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          liveMarkdownExtensions({ callbacks: callbacksRef }),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            const nextValue = update.state.doc.toString();
            if (nextValue === valueRef.current) return;
            valueRef.current = nextValue;
            onChangeRef.current(nextValue);
          }),
        ],
      }),
      parent: host,
    });
    view.scrollDOM.dataset.liveMarkdownScroll = "";
    const format = (event: Event) => {
      const marker = (event as CustomEvent<FormatMarker>).detail;
      if (marker !== "bold" && marker !== "italic" && marker !== "link") return;
      event.preventDefault();
      applyFormat(view, marker);
    };
    const blur = () => onBlurRef.current?.(view.scrollDOM.scrollTop);
    const focus = () => onFocusRef.current?.();
    view.contentDOM.addEventListener("folio-format", format);
    view.contentDOM.addEventListener("blur", blur);
    view.contentDOM.addEventListener("focus", focus);
    viewRef.current = view;
    const focusFrame = autoFocus
      ? window.requestAnimationFrame(() => view.focus())
      : null;
    return () => {
      if (focusFrame !== null) window.cancelAnimationFrame(focusFrame);
      view.contentDOM.removeEventListener("folio-format", format);
      view.contentDOM.removeEventListener("blur", blur);
      view.contentDOM.removeEventListener("focus", focus);
      view.destroy();
      viewRef.current = null;
    };
  }, [ariaLabel, autoFocus, callbacksRef]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === value) return;
    const selection = view.state.selection.main;
    const maxPosition = value.length;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
      selection: EditorSelection.range(
        Math.min(selection.from, maxPosition),
        Math.min(selection.to, maxPosition),
      ),
    });
  }, [value]);

  useLayoutEffect(() => {
    if (!intent) return;
    const key = `${intent.lineNumber}:${intent.scrollTop}`;
    if (lastIntentRef.current === key) return;
    lastIntentRef.current = key;
    const view = viewRef.current;
    if (!view) return;
    const frame = window.requestAnimationFrame(() => {
      const currentView = viewRef.current;
      if (currentView !== view) return;
      const offset = lineStartOffset(currentView.state.doc.toString(), intent.lineNumber);
      currentView.focus();
      currentView.dispatch({ selection: { anchor: offset } });
      currentView.scrollDOM.scrollTop = intent.scrollTop;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [intent]);

  return (
    <div
      className="live-markdown-editor"
      data-live-markdown-editor=""
      ref={hostRef}
    />
  );
}
