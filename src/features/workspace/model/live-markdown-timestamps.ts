import { RangeSetBuilder, StateEffect, StateField, type Extension, type Text } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet } from "@codemirror/view";
import { playbackStore, type PlaybackStore } from "../../transcription/model/playback-store.ts";
import {
  activeTimestampIndex,
  parseTranscriptTimestamps,
  timestampBlockLines,
  type TranscriptTimestamp,
} from "../../transcription/model/transcript-timestamps.ts";

type TimestampOptions = {
  /** Id of the document shown by the editor; resolved lazily because editors outlive tab switches. */
  getDocumentId: () => string | undefined;
  store?: PlaybackStore;
};

type TimestampState = {
  stamps: TranscriptTimestamp[];
  /** Playhead seconds while the loaded recording is this draft's; null otherwise. */
  seconds: number | null;
  decorations: DecorationSet;
};

const setPlayhead = StateEffect.define<number | null>();
const playingTurn = Decoration.line({ class: "cm-live-markdown-playing-turn" });

function build(doc: Text, stamps: TranscriptTimestamp[], seconds: number | null): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const text = doc.toString();
  const active = seconds === null ? -1 : activeTimestampIndex(stamps, seconds);
  const block = active >= 0 ? timestampBlockLines(stamps, active, doc.lines, text) : null;
  // Line decorations and marks share positions; add in document order.
  const lineStarts = new Map<number, true>();
  if (block) for (let line = block.start; line <= block.end; line += 1) lineStarts.set(line, true);
  const items: Array<{ from: number; to: number; kind: "line" | "mark"; seconds?: number }> = [];
  for (const line of lineStarts.keys()) items.push({ from: doc.line(line + 1).from, to: doc.line(line + 1).from, kind: "line" });
  for (const stamp of stamps) items.push({ from: stamp.from, to: stamp.to, kind: "mark", seconds: stamp.seconds });
  items.sort((a, b) => a.from - b.from || (a.kind === "line" ? -1 : 1));
  for (const item of items) {
    if (item.kind === "line") builder.add(item.from, item.to, playingTurn);
    else builder.add(item.from, item.to, Decoration.mark({
      class: "cm-live-markdown-timestamp",
      attributes: { "data-seconds": String(item.seconds), title: "Play from here" },
    }));
  }
  return builder.finish();
}

/**
 * Transcript timestamps (`[mm:ss]`) become clickable marks that seek the linked recording, and the turn that
 * contains the playhead gets a line highlight. Marks only style text, so it stays editable everywhere.
 */
export function liveMarkdownTimestamps({ getDocumentId, store = playbackStore }: TimestampOptions): Extension {
  const field = StateField.define<TimestampState>({
    create(state) {
      const stamps = parseTranscriptTimestamps(state.doc.toString());
      return { stamps, seconds: null, decorations: build(state.doc, stamps, null) };
    },
    update(value, transaction) {
      let seconds = value.seconds;
      let changed = false;
      for (const effect of transaction.effects) {
        if (effect.is(setPlayhead)) { seconds = effect.value; changed = true; }
      }
      if (!transaction.docChanged && !changed) return value;
      const stamps = transaction.docChanged ? parseTranscriptTimestamps(transaction.newDoc.toString()) : value.stamps;
      return { stamps, seconds, decorations: build(transaction.newDoc, stamps, seconds) };
    },
    provide: (self) => EditorView.decorations.from(self, (value) => value.decorations),
  });

  const follower = ViewPlugin.fromClass(class {
    private readonly unsubscribe: () => void;
    private lastKey = "";
    private destroyed = false;
    private readonly view: EditorView;
    constructor(view: EditorView) {
      this.view = view;
      this.unsubscribe = store.subscribe(() => this.sync());
      queueMicrotask(() => this.sync());
    }
    sync() {
      if (this.destroyed) return;
      const documentId = getDocumentId();
      const snapshot = store.getSnapshot();
      const linked = documentId !== undefined && snapshot.sessionId !== null && store.sessionForDraft(documentId) === snapshot.sessionId;
      const index = linked ? activeTimestampIndex(this.view.state.field(field).stamps, snapshot.currentTime) : -1;
      // Only dispatch when the highlighted turn changes, not on every time update.
      const key = `${linked}:${index}`;
      if (key === this.lastKey) return;
      this.lastKey = key;
      this.view.dispatch({ effects: setPlayhead.of(linked ? snapshot.currentTime : null) });
    }
    destroy() { this.destroyed = true; this.unsubscribe(); }
  });

  return [
    field,
    follower,
    EditorView.domEventHandlers({
      click: (event, view) => {
        const target = event.target instanceof Element ? event.target.closest<HTMLElement>(".cm-live-markdown-timestamp") : null;
        if (!target || !view.state.selection.main.empty) return false;
        const seconds = Number(target.dataset.seconds);
        if (!Number.isFinite(seconds)) return false;
        // Without a linked or loaded recording the click is just a click: the cursor lands in the text.
        store.seekFromDraft(getDocumentId(), seconds);
        return false;
      },
    }),
  ];
}
