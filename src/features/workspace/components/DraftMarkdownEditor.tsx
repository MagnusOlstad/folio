import { Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useId, useLayoutEffect, useRef } from "react";
import {
  draftFilingGuidance,
  filedDraftContent,
  serializeDraft,
} from "../../../lib/workspace.ts";
import { LiveMarkdownEditor } from "./LiveMarkdownEditor.tsx";

type DraftMarkdownEditorProps = {
  value: string;
  onChange: (value: string) => void;
  onFile: () => void;
  onOpenLink?: (href: string) => void;
  onToggleTask?: (lineNumber: number, checked: boolean) => void | Promise<void>;
  focusRequestId?: number;
  onFocusRequestConsumed?: () => void;
  ariaLabel: string;
  initialSelection?: { from: number; to: number };
  onSelectionChange?: (from: number, to: number) => void;
};

/** Keeps the filing guidance separate from the continuously mounted note editor. */
export function DraftMarkdownEditor({
  value,
  onChange,
  onFile,
  onOpenLink,
  onToggleTask,
  focusRequestId,
  onFocusRequestConsumed,
  ariaLabel,
  initialSelection,
  onSelectionChange,
}: DraftMarkdownEditorProps) {
  const hasSerializedGuidance = value.includes("\n");
  const serializedGuidance = draftFilingGuidance(value);
  const body = filedDraftContent(value);
  const serializedOffset = hasSerializedGuidance ? serializedGuidance.length + 1 : 0;
  const guidanceRef = useRef(serializedGuidance);
  const serializedRef = useRef(hasSerializedGuidance);
  const receivedValueRef = useRef(value);
  const pendingDraftsRef = useRef<Array<{ guidance: string; body: Text }>>([]);
  const id = useId();
  const shellRef = useRef<HTMLDivElement>(null);
  const guidanceInputRef = useRef<HTMLTextAreaElement>(null);
  const noteSelectionRef = useRef({
    from: Math.max(0, (initialSelection?.from ?? serializedOffset) - serializedOffset),
    to: Math.max(0, (initialSelection?.to ?? serializedOffset) - serializedOffset),
  });

  useLayoutEffect(() => {
    if (receivedValueRef.current === value) return;
    receivedValueRef.current = value;
    const incomingBody = Text.of(body.split("\n"));
    const pendingDrafts = pendingDraftsRef.current;
    if (hasSerializedGuidance) {
      for (let index = pendingDrafts.length - 1; index >= 0; index -= 1) {
        const draft = pendingDrafts[index];
        if (draft.guidance !== serializedGuidance || !draft.body.eq(incomingBody)) continue;
        pendingDrafts.splice(0, index + 1);
        return;
      }
    }
    pendingDrafts.length = 0;
    guidanceRef.current = serializedGuidance;
    serializedRef.current = hasSerializedGuidance;
    // Child reconciliation may have reported a selection before this layout
    // effect refreshed the guidance. Publish the same range with the new offset.
    const offset = hasSerializedGuidance ? serializedGuidance.length + 1 : 0;
    onSelectionChange?.(
      noteSelectionRef.current.from + offset,
      noteSelectionRef.current.to + offset,
    );
  }, [value, body, hasSerializedGuidance, serializedGuidance, onSelectionChange]);

  useLayoutEffect(() => {
    const input = guidanceInputRef.current;
    if (!input) return;
    const resize = () => {
      input.style.height = "auto";
      input.style.height = `${Math.max(36, Math.min(input.scrollHeight, 96))}px`;
    };
    resize();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(resize);
    observer.observe(input);
    return () => observer.disconnect();
  }, [serializedGuidance]);

  function currentBodyDocument() {
    const content = shellRef.current?.querySelector<HTMLElement>(".cm-content");
    return content ? EditorView.findFromDOM(content)?.state.doc ?? Text.of(body.split("\n"))
      : Text.of(body.split("\n"));
  }

  function rememberDraft(guidance: string, document: Text) {
    guidanceRef.current = guidance;
    serializedRef.current = true;
    // Body snapshots share CodeMirror's immutable document structure.
    pendingDraftsRef.current.push({ guidance, body: document });
    if (pendingDraftsRef.current.length > 128) pendingDraftsRef.current.shift();
  }

  function updateGuidance(nextValue: string) {
    const nextGuidance = nextValue.replace(/[\r\n]+/g, " ");
    // The editor can be ahead of a delayed parent echo. Serialize its current
    // document rather than replacing that work with the older body prop.
    const document = currentBodyDocument();
    rememberDraft(nextGuidance, document);
    onChange(serializeDraft(nextGuidance, document.toString()));
    const nextOffset = nextGuidance.length + 1;
    onSelectionChange?.(
      noteSelectionRef.current.from + nextOffset,
      noteSelectionRef.current.to + nextOffset,
    );
  }

  function focusNote() {
    shellRef.current?.querySelector<HTMLElement>(".cm-content")?.focus();
  }

  return (
    <div className="draft-note-editor" ref={shellRef}>
      <section className="draft-guidance" aria-label="Filing guidance">
        <div className="draft-guidance-editor">
          <div className="draft-guidance-caption">
            <label htmlFor={`${id}-guidance`}>Filing guidance</label>
            <span className="draft-guidance-info-wrap">
              <button
                className="draft-guidance-info"
                type="button"
                aria-label="About filing guidance"
                aria-describedby={`${id}-tooltip`}
                onKeyDown={(event) => {
                  if (event.key === "Escape") focusNote();
                }}
              >
                i
              </button>
              <span className="draft-guidance-tooltip" id={`${id}-tooltip`} role="tooltip">
                Use a short hint when the note doesn’t make its title, folder, or kind obvious. FolioNotes sends this separately from the full note to the filing model. Relevant hints and existing folder names guide filing; unrelated hints yield to the note. Titles stay grounded in the note, and the body remains unchanged. Use <code>path: /projects/atlas</code> to choose a destination, or leave this blank for automatic filing.
              </span>
            </span>
          </div>
          <textarea
            id={`${id}-guidance`}
            ref={guidanceInputRef}
            rows={1}
            value={serializedGuidance}
            placeholder="Optional: title, folder, or filing context…"
            onChange={(event) => updateGuidance(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              if ((event.metaKey || event.ctrlKey) && (event.key === "Enter" || event.key.toLowerCase() === "s")) {
                event.preventDefault();
                onFile();
              } else if (event.key === "Escape" || event.key === "Enter") {
                event.preventDefault();
                focusNote();
              }
            }}
          />
        </div>
      </section>
      <LiveMarkdownEditor
        value={body}
        onChange={(nextBody) => {
          rememberDraft(guidanceRef.current, currentBodyDocument());
          onChange(serializeDraft(guidanceRef.current, nextBody));
          const nextOffset = guidanceRef.current.length + 1;
          onSelectionChange?.(
            noteSelectionRef.current.from + nextOffset,
            noteSelectionRef.current.to + nextOffset,
          );
        }}
        onFile={onFile}
        onOpenLink={onOpenLink}
        onToggleTask={(lineNumber, checked) => onToggleTask?.(lineNumber + (serializedRef.current ? 1 : 0), checked)}
        initialSelection={initialSelection
          ? {
              from: Math.max(0, initialSelection.from - serializedOffset),
              to: Math.max(0, initialSelection.to - serializedOffset),
            }
          : undefined}
        onSelectionChange={(from, to) => {
          noteSelectionRef.current = { from, to };
          const currentOffset = serializedRef.current ? guidanceRef.current.length + 1 : 0;
          onSelectionChange?.(from + currentOffset, to + currentOffset);
        }}
        focusRequestId={focusRequestId}
        onFocusRequestConsumed={onFocusRequestConsumed}
        autoFocus
        placeholder="Write your note…"
        ariaLabel={ariaLabel}
      />
    </div>
  );
}
