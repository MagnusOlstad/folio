import { markdown, markdownKeymap, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import { openSearchPanel, search, searchKeymap } from "@codemirror/search";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentLess,
  indentMore,
  isolateHistory,
  selectAll,
} from "@codemirror/commands";
import {
  Annotation,
  Compartment,
  EditorSelection,
  EditorState,
  Text,
  Transaction,
  type Extension,
} from "@codemirror/state";
import { EditorView, keymap, panels, placeholder as editorPlaceholder } from "@codemirror/view";
import {
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";
import { applyFormatMarker, type FormatMarker } from "../../../markdown-format.ts";
import {
  changeLiveMarkdownListIndentation,
  continueLiveMarkdownList,
  insertLiveMarkdownListLineBreak,
  liveMarkdownOrderedListChanges,
  liveMarkdownExtensions,
  setLiveMarkdownFocus,
  type LiveMarkdownCallbacks,
} from "../model/live-markdown.ts";
import { createNoteSearchPanel } from "../model/note-search-panel.ts";

// Prop replacements are authoritative snapshots, not user edits.
const externalMarkdownUpdate = Annotation.define<boolean>();
// Task callbacks own persistence. Record the user edit in history without sending
// a second onChange notification for the same click or keyboard command.
const localTaskUpdate = Annotation.define<boolean>();
const MAX_LOCAL_ECHOES = 128;

function clampPosition(position: number, length: number) {
  return Number.isFinite(position) ? Math.max(0, Math.min(Math.trunc(position), length)) : 0;
}

export type LiveMarkdownEditorProps = {
  value: string;
  onChange: (value: string) => void;
  onBlur?: (scrollTop: number) => void;
  onFocus?: () => void;
  onFile?: () => void;
  onOpenLink?: (href: string) => void;
  onToggleTask?: (lineNumber: number, checked: boolean) => void | Promise<void>;
  initialSelection?: { from: number; to: number };
  onSelectionChange?: (from: number, to: number) => void;
  autoFocus?: boolean;
  readOnly?: boolean;
  containerClassName?: string;
  focusRequestId?: number;
  onFocusRequestConsumed?: () => void;
  placeholder?: string;
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

function changeIndentation(
  view: EditorView,
  direction: "indent" | "outdent",
) {
  if (changeListIndentation(view, direction)) return true;
  return direction === "indent" ? indentMore(view) : indentLess(view);
}

function isInsideMarkdownCode(view: EditorView, position = view.state.selection.main.from) {
  const initialNode = syntaxTree(view.state).resolveInner(
    position,
    -1,
  );
  let node: typeof initialNode | null = initialNode;
  while (node) {
    if (node.name === "FencedCode" || node.name === "CodeBlock" || node.name === "InlineCode") return true;
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
  readOnly = false,
  containerClassName,
  focusRequestId,
  onFocusRequestConsumed,
  placeholder,
  ariaLabel,
  initialSelection,
  onSelectionChange,
}: LiveMarkdownEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const onBlurRef = useRef(onBlur);
  const onFocusRef = useRef(onFocus);
  const onFileRef = useRef(onFile);
  const onToggleTaskRef = useRef(onToggleTask);
  const onSelectionChangeRef = useRef(onSelectionChange);
  const initialSelectionRef = useRef(initialSelection);
  // CodeMirror Text shares unchanged document structure between edits. Keep a
  // bounded window of unacknowledged edits so delayed echoes cannot erase typing.
  const pendingLocalDocsRef = useRef<Text[]>([]);
  const controlledValueRef = useRef(value);
  const readOnlyRef = useRef(readOnly);
  const placeholderRef = useRef(placeholder);
  const compositionActiveRef = useRef(false);
  const compositionChangedRef = useRef(false);
  const deferredControlledValueRef = useRef(false);
  const compositionFrameRef = useRef<number | null>(null);
  const findFramesRef = useRef(new Set<number>());
  const readOnlyCompartment = useRef(new Compartment());
  const keymapCompartment = useRef(new Compartment());
  const editingKeymapRef = useRef<Extension>([]);
  const placeholderCompartment = useRef(new Compartment());
  const historyCompartment = useRef(new Compartment());
  const focusRequestFrameRef = useRef<number | null>(null);
  const ariaLabelRef = useRef(ariaLabel);
  const onFocusRequestConsumedRef = useRef(onFocusRequestConsumed);
  const ariaLabelCompartment = useRef(new Compartment());
  const callbacksRef = useRef<LiveMarkdownCallbacks>({
    onOpenLink: readOnly ? undefined : onOpenLink,
    onToggleTask: readOnly ? undefined : onToggleTask,
  });

  useLayoutEffect(() => {
    controlledValueRef.current = value;
    readOnlyRef.current = readOnly;
    placeholderRef.current = placeholder;
    onChangeRef.current = onChange;
    onBlurRef.current = onBlur;
    onFocusRef.current = onFocus;
    onFileRef.current = onFile;
    onToggleTaskRef.current = onToggleTask;
    onSelectionChangeRef.current = onSelectionChange;
    onFocusRequestConsumedRef.current = onFocusRequestConsumed;
    ariaLabelRef.current = ariaLabel;
    callbacksRef.current = {
      onOpenLink: readOnly ? undefined : onOpenLink,
      onToggleTask: readOnly || !onToggleTask ? undefined : performTaskToggle,
    };
  }, [
    ariaLabel,
    onBlur,
    onChange,
    onFile,
    onFocus,
    onFocusRequestConsumed,
    onOpenLink,
    onToggleTask,
    onSelectionChange,
    readOnly,
    placeholder,
    value,
  ]);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const findFrames = findFramesRef.current;
    const findLayer = host
      .closest(".document-view")
      ?.querySelector<HTMLElement>("[data-document-find-layer]");
    editingKeymapRef.current = keymap.of([
      { key: "Mod-a", run: selectAll },
      {
        key: "Shift-Space",
        run: (editor) => {
          if (editor.composing || compositionActiveRef.current) return false;
          if (isInsideMarkdownCode(editor)) return false;
          const selection = editor.state.selection.main;
          const line = editor.state.doc.lineAt(selection.head);
          const task = /^(?:\s*(?:>\s*)*(?:[-+*]|\d+[.)])\s+)\[([ xX])\](?=\s|$)/.exec(line.text);
          if (!task || !onToggleTaskRef.current) return false;
          void performTaskToggle(line.number, task[1].toLowerCase() !== "x");
          return true;
        },
      },
      {
        key: "Tab",
        run: (editor) => !editor.composing && !compositionActiveRef.current && changeIndentation(editor, "indent"),
      },
      {
        key: "Shift-Tab",
        run: (editor) => !editor.composing && !compositionActiveRef.current && changeIndentation(editor, "outdent"),
      },
      {
        key: "Mod-Enter",
        run: (editor) => {
          if (editor.composing || compositionActiveRef.current) return false;
          if (!onFileRef.current) return false;
          onFileRef.current();
          return true;
        },
      },
      {
        key: "Shift-Enter",
        run: (editor) => {
          if (editor.composing || compositionActiveRef.current) return false;
          if (isInsideMarkdownCode(editor)) return false;
          const selection = editor.state.selection.main;
          const edit = insertLiveMarkdownListLineBreak(
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
      {
        key: "Enter",
        run: (editor) => {
          if (editor.composing || compositionActiveRef.current) return false;
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
    ]);
    const view = new EditorView({
      state: EditorState.create({
        doc: valueRef.current,
        selection: initialSelectionRef.current
          ? EditorSelection.range(
              clampPosition(initialSelectionRef.current.from, valueRef.current.length),
              clampPosition(initialSelectionRef.current.to, valueRef.current.length),
            )
          : undefined,
        extensions: [
          readOnlyCompartment.current.of([
            EditorState.readOnly.of(readOnlyRef.current),
            EditorView.editable.of(!readOnlyRef.current),
          ]),
          markdown({
            base: markdownLanguage,
            // Keep Markdown commands in the explicit keymap below so FolioNotes’s
            // list continuation handler wins over the implicit high-priority
            // Enter binding.
            addKeymap: false,
            // A hyphen-only line should remain available for a list or a
            // horizontal rule. Setext headings would otherwise make the
            // previous line jump to H2 size as soon as its first dash is
            // typed, and also take precedence over `---` as a rule.
            extensions: { remove: ["SetextHeading"] },
          }),
          placeholderCompartment.current.of(placeholderRef.current ? editorPlaceholder(placeholderRef.current) : []),
          historyCompartment.current.of(history()),
          search({ top: true, createPanel: createNoteSearchPanel }),
          panels(findLayer ? { topContainer: findLayer } : undefined),
          EditorView.scrollMargins.of(() => ({ bottom: 80 })),
          EditorView.lineWrapping,
          EditorState.transactionFilter.of((transaction) => {
            if (!transaction.docChanged || transaction.state.readOnly ||
                transaction.annotation(externalMarkdownUpdate) || transaction.annotation(localTaskUpdate) ||
                transaction.isUserEvent("undo") || transaction.isUserEvent("redo") ||
                transaction.isUserEvent("input.type.compose") || compositionActiveRef.current)
              return transaction;
            const value = transaction.newDoc.toString();
            const changes = liveMarkdownOrderedListChanges(value);
            if (!changes.length) return transaction;
            return [
              transaction,
              {
                changes,
                sequential: true,
              },
            ];
          }),
          ariaLabelCompartment.current.of(
            EditorView.contentAttributes.of({ "aria-label": ariaLabelRef.current }),
          ),
          keymapCompartment.current.of(readOnlyRef.current ? [] : editingKeymapRef.current),
          liveMarkdownExtensions({ callbacks: callbacksRef }),
          EditorView.updateListener.of((update) => {
            if (update.selectionSet && !update.state.readOnly)
              onSelectionChangeRef.current?.(
                update.state.selection.main.from,
                update.state.selection.main.to,
              );
            if (!update.docChanged || update.state.readOnly ||
                update.transactions.some((transaction) => transaction.annotation(externalMarkdownUpdate))) return;
            const nextValue = update.state.doc.toString();
            if (nextValue === valueRef.current) return;
            valueRef.current = nextValue;
            if (compositionActiveRef.current) compositionChangedRef.current = true;
            pendingLocalDocsRef.current.push(update.state.doc);
            if (pendingLocalDocsRef.current.length > MAX_LOCAL_ECHOES)
              pendingLocalDocsRef.current.shift();
            if (!update.transactions.some((transaction) => transaction.annotation(localTaskUpdate)))
              onChangeRef.current(nextValue);
          }),
        ],
      }),
      parent: host,
    });
    view.scrollDOM.dataset.liveMarkdownScroll = "";
    const format = (event: Event) => {
      if (view.state.readOnly || view.composing || compositionActiveRef.current) return;
      const marker = (event as CustomEvent<FormatMarker>).detail;
      if (marker !== "bold" && marker !== "italic" && marker !== "link") return;
      event.preventDefault();
      applyFormat(view, marker);
    };
    const blur = () => {
      if (view.state.readOnly) return;
      onBlurRef.current?.(
        host.closest<HTMLElement>("[data-document-scroll]")?.scrollTop ?? 0,
      );
    };
    const focus = () => {
      if (!view.state.readOnly) onFocusRef.current?.();
    };
    const selectListContent = (event: Event) => {
      const contentStart = (event as CustomEvent<number>).detail;
      if (typeof contentStart !== "number" || !Number.isFinite(contentStart)) return;
      event.preventDefault();
      view.dispatch({ selection: EditorSelection.cursor(clampPosition(contentStart, view.state.doc.length)) });
      view.focus();
    };
    const scheduleFindFrame = (callback: () => void) => {
      const frame = window.requestAnimationFrame(() => {
        findFrames.delete(frame);
        callback();
      });
      findFrames.add(frame);
    };
    const find = () => {
      const documentScroll = host.closest<HTMLElement>("[data-document-scroll]");
      const scrollTop = documentScroll?.scrollTop;
      const restoreDocumentScroll = () => {
        if (documentScroll && scrollTop !== undefined)
          documentScroll.scrollTop = scrollTop;
      };
      openSearchPanel(view);
      restoreDocumentScroll();
      scheduleFindFrame(() => {
        view.dom
          .closest(".document-view")
          ?.querySelector<HTMLInputElement>("[main-field]")
          ?.focus({ preventScroll: true });
        restoreDocumentScroll();
        scheduleFindFrame(restoreDocumentScroll);
      });
    };
    const compositionStart = () => {
      if (compositionFrameRef.current !== null) {
        window.cancelAnimationFrame(compositionFrameRef.current);
        compositionFrameRef.current = null;
      } else {
        compositionChangedRef.current = false;
      }
      compositionActiveRef.current = true;
    };
    const compositionEnd = () => {
      if (compositionFrameRef.current !== null)
        window.cancelAnimationFrame(compositionFrameRef.current);
      // CodeMirror reads the final composed DOM before this frame. Do not replace
      // its DOM or renumber syntax while the native composition owns it.
      const frame = window.requestAnimationFrame(() => {
        if (compositionFrameRef.current !== frame) return;
        compositionFrameRef.current = null;
        compositionActiveRef.current = false;
        const replaced = deferredControlledValueRef.current ? reconcileControlledValue() : false;
        deferredControlledValueRef.current = false;
        if (!replaced && compositionChangedRef.current && !view.state.readOnly) {
          const changes = liveMarkdownOrderedListChanges(view.state.doc.toString());
          if (changes.length) view.dispatch({ changes, userEvent: "input" });
        }
        compositionChangedRef.current = false;
      });
      compositionFrameRef.current = frame;
    };
    view.contentDOM.addEventListener("compositionstart", compositionStart);
    view.contentDOM.addEventListener("compositionend", compositionEnd);
    view.contentDOM.addEventListener("folio-format", format);
    view.contentDOM.addEventListener("folio-select-list-content", selectListContent);
    view.contentDOM.addEventListener("blur", blur);
    view.contentDOM.addEventListener("focus", focus);
    host.addEventListener("folio-find", find);
    viewRef.current = view;
    return () => {
      if (compositionFrameRef.current !== null) window.cancelAnimationFrame(compositionFrameRef.current);
      compositionFrameRef.current = null;
      compositionActiveRef.current = false;
      for (const frame of findFrames) window.cancelAnimationFrame(frame);
      findFrames.clear();
      view.contentDOM.removeEventListener("compositionstart", compositionStart);
      view.contentDOM.removeEventListener("compositionend", compositionEnd);
      view.contentDOM.removeEventListener("folio-format", format);
      view.contentDOM.removeEventListener("folio-select-list-content", selectListContent);
      view.contentDOM.removeEventListener("blur", blur);
      view.contentDOM.removeEventListener("focus", focus);
      host.removeEventListener("folio-find", find);
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: [
        readOnlyCompartment.current.reconfigure([
          EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly),
        ]),
        keymapCompartment.current.reconfigure(readOnly ? [] : editingKeymapRef.current),
        setLiveMarkdownFocus.of(view.hasFocus),
      ],
    });
  }, [readOnly]);

  useLayoutEffect(() => {
    viewRef.current?.dispatch({
      effects: placeholderCompartment.current.reconfigure(
        placeholder ? editorPlaceholder(placeholder) : [],
      ),
    });
  }, [placeholder]);

  useLayoutEffect(() => {
    if (!autoFocus || readOnly) return;
    const frame = window.requestAnimationFrame(() => viewRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [autoFocus, readOnly]);

  useLayoutEffect(() => {
    if (readOnly || focusRequestId === undefined) return;
    const frame = window.requestAnimationFrame(() => {
      focusRequestFrameRef.current = null;
      const view = viewRef.current;
      if (!view) return;
      view.focus();
      onFocusRequestConsumedRef.current?.();
    });
    focusRequestFrameRef.current = frame;
    return () => {
      window.cancelAnimationFrame(frame);
      if (focusRequestFrameRef.current === frame) {
        focusRequestFrameRef.current = null;
      }
    };
  }, [focusRequestId, readOnly]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: ariaLabelCompartment.current.reconfigure(
        EditorView.contentAttributes.of({ "aria-label": ariaLabel }),
      ),
    });
  }, [ariaLabel]);

  function performTaskToggle(lineNumber: number, checked: boolean) {
    const view = viewRef.current;
    const callback = onToggleTaskRef.current;
    if (!view || !callback || view.state.readOnly || view.composing || compositionActiveRef.current ||
        !Number.isInteger(lineNumber) || lineNumber < 1 || lineNumber > view.state.doc.lines) return;
    const line = view.state.doc.line(lineNumber);
    const task = /^(?:\s*(?:>\s*)*(?:[-+*]|\d+[.)])\s+)\[([ xX])\](?=\s|$)/.exec(line.text);
    if (!task) return;
    const position = line.from + task[0].length - 2;
    if (isInsideMarkdownCode(view, position)) return;
    if ((task[1].toLowerCase() === "x") !== checked) {
      view.dispatch({
        changes: { from: position, to: position + 1, insert: checked ? "x" : " " },
        annotations: [localTaskUpdate.of(true), isolateHistory.of("full")],
        userEvent: "input.task",
      });
    }
    return callback(lineNumber, checked);
  }

  // This bridge reads only stable refs so the mounted editor can call it safely.
  function reconcileControlledValue() {
    const view = viewRef.current;
    if (!view) return false;
    if (view.composing || compositionActiveRef.current) {
      deferredControlledValueRef.current = true;
      return false;
    }
    const nextValue = controlledValueRef.current;
    const nextDoc = Text.of(nextValue.split("\n"));
    const pendingDocs = pendingLocalDocsRef.current;
    for (let index = pendingDocs.length - 1; index >= 0; index -= 1) {
      if (!pendingDocs[index].eq(nextDoc)) continue;
      // Acknowledge this edit and every preceding one. Once acknowledged, the
      // same value may be an authoritative history restore and must be applied.
      pendingDocs.splice(0, index + 1);
      return false;
    }
    if (view.state.doc.eq(nextDoc)) {
      pendingDocs.length = 0;
      valueRef.current = nextValue;
      return false;
    }
    pendingDocs.length = 0;
    valueRef.current = nextValue;
    const selection = view.state.selection.main;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: nextValue },
      selection: EditorSelection.range(
        clampPosition(selection.anchor, nextValue.length),
        clampPosition(selection.head, nextValue.length),
      ),
      // A genuine replacement starts a new undo document. Merely excluding it
      // from history would leave edits for the old document mapped into the new one.
      effects: historyCompartment.current.reconfigure([]),
      annotations: [externalMarkdownUpdate.of(true), Transaction.addToHistory.of(false)],
      filter: false,
    });
    view.dispatch({ effects: historyCompartment.current.reconfigure(history()) });
    return true;
  }

  useLayoutEffect(() => {
    reconcileControlledValue();
  }, [value]);

  return (
    <div
      className={["live-markdown-editor", containerClassName].filter(Boolean).join(" ")}
      data-live-markdown-editor=""
      data-read-only={readOnly ? "" : undefined}
      ref={hostRef}
    />
  );
}
