import { markdown, markdownKeymap, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import { openSearchPanel, search, searchKeymap } from "@codemirror/search";
import {
  defaultKeymap,
  history,
  historyKeymap,
  selectAll,
} from "@codemirror/commands";
import { Compartment, EditorSelection, EditorState } from "@codemirror/state";
import { EditorView, keymap, panels } from "@codemirror/view";
import {
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";
import { applyFormatMarker, type FormatMarker } from "../../../markdown-format.ts";
import {
  changeLiveMarkdownListIndentation,
  continueLiveMarkdownList,
  liveMarkdownExtensions,
  type LiveMarkdownCallbacks,
} from "../model/live-markdown.ts";
import { createNoteSearchPanel } from "../model/note-search-panel.ts";

export type LiveMarkdownEditorProps = {
  value: string;
  onChange: (value: string) => void;
  onBlur?: (scrollTop: number) => void;
  onFocus?: () => void;
  onFile?: () => void;
  onOpenLink?: (href: string) => void;
  onToggleTask?: (lineNumber: number, checked: boolean) => void | Promise<void>;
  autoFocus?: boolean;
  ariaLabel: string;
};

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
    scrollIntoView: true,
  });
}

function changeListIndentation(
  view: EditorView,
  direction: "indent" | "outdent",
) {
  if (isInsideMarkdownCode(view)) return false;
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
    scrollIntoView: true,
  });
  return true;
}

function isInsideMarkdownCode(view: EditorView) {
  const initialNode = syntaxTree(view.state).resolveInner(
    view.state.selection.main.from,
    -1,
  );
  let node: typeof initialNode | null = initialNode;
  while (node) {
    if (node.name === "FencedCode" || node.name === "InlineCode") return true;
    node = node.parent;
  }
  return false;
}

export function LiveMarkdownEditor({
  value,
  onChange,
  onBlur,
  onFocus,
  onFile,
  onOpenLink,
  onToggleTask,
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
  const ariaLabelRef = useRef(ariaLabel);
  const ariaLabelCompartment = useRef(new Compartment());
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
    ariaLabelRef.current = ariaLabel;
    callbacksRef.current = { onOpenLink, onToggleTask };
  }, [ariaLabel, onBlur, onChange, onFile, onFocus, onOpenLink, onToggleTask, value]);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const findLayer = host
      .closest(".document-view")
      ?.querySelector<HTMLElement>("[data-document-find-layer]");
    const view = new EditorView({
      state: EditorState.create({
        doc: valueRef.current,
        extensions: [
          markdown({ base: markdownLanguage }),
          history(),
          search({ top: true, createPanel: createNoteSearchPanel }),
          panels(findLayer ? { topContainer: findLayer } : undefined),
          EditorView.scrollMargins.of(() => ({ bottom: 80 })),
          EditorView.lineWrapping,
          ariaLabelCompartment.current.of(
            EditorView.contentAttributes.of({ "aria-label": ariaLabelRef.current }),
          ),
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
                if (isInsideMarkdownCode(editor)) return false;
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
                  scrollIntoView: true,
                });
                return true;
              },
            },
            ...markdownKeymap,
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
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
    const blur = () =>
      onBlurRef.current?.(
        host.closest<HTMLElement>("[data-document-scroll]")?.scrollTop ?? 0,
      );
    const focus = () => onFocusRef.current?.();
    const find = () => {
      const documentScroll = host.closest<HTMLElement>("[data-document-scroll]");
      const scrollTop = documentScroll?.scrollTop;
      const restoreDocumentScroll = () => {
        if (documentScroll && scrollTop !== undefined)
          documentScroll.scrollTop = scrollTop;
      };
      openSearchPanel(view);
      restoreDocumentScroll();
      window.requestAnimationFrame(() => {
        view.dom
          .closest(".document-view")
          ?.querySelector<HTMLInputElement>("[main-field]")
          ?.focus({ preventScroll: true });
        restoreDocumentScroll();
        window.requestAnimationFrame(restoreDocumentScroll);
      });
    };
    view.contentDOM.addEventListener("folio-format", format);
    view.contentDOM.addEventListener("blur", blur);
    view.contentDOM.addEventListener("focus", focus);
    host.addEventListener("folio-find", find);
    viewRef.current = view;
    const focusFrame = autoFocus
      ? window.requestAnimationFrame(() => view.focus())
      : null;
    return () => {
      if (focusFrame !== null) window.cancelAnimationFrame(focusFrame);
      view.contentDOM.removeEventListener("folio-format", format);
      view.contentDOM.removeEventListener("blur", blur);
      view.contentDOM.removeEventListener("focus", focus);
      host.removeEventListener("folio-find", find);
      view.destroy();
      viewRef.current = null;
    };
  }, [autoFocus]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: ariaLabelCompartment.current.reconfigure(
        EditorView.contentAttributes.of({ "aria-label": ariaLabel }),
      ),
    });
  }, [ariaLabel]);

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
      scrollIntoView: true,
    });
  }, [value]);

  return (
    <div
      className="live-markdown-editor"
      data-live-markdown-editor=""
      ref={hostRef}
    />
  );
}
