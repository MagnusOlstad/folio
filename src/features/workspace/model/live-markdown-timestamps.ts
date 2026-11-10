import { RangeSetBuilder, StateEffect, StateField, type Extension, type Text } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { playbackStore, type PlaybackStore } from "../../transcription/model/playback-store.ts";
import {
  activeTimestampIndex,
  parseTranscriptTimestamps,
  timestampBlockRange,
  timestampsInRange,
  type TranscriptTimestamp,
} from "../../transcription/model/transcript-timestamps.ts";

type TimestampOptions = {
  /** Id of the document shown by the editor; resolved lazily because editors outlive tab switches. */
  getDocumentId: () => string | undefined;
  store?: PlaybackStore;
};

type TimestampState = {
  /** Re-parsed only when the document changes. */
  stamps: TranscriptTimestamp[];
  /** Playhead seconds while the loaded recording is this draft's; null otherwise. */
  seconds: number | null;
  /** Line highlight for the playing turn; rebuilt only when the playhead moves to another turn. */
  highlight: DecorationSet;
};

const setPlayhead = StateEffect.define<number | null>();
const playingTurn = Decoration.line({ class: "cm-live-markdown-playing-turn" });

function highlightFor(doc: Text, stamps: TranscriptTimestamp[], seconds: number | null): DecorationSet {
  const active = seconds === null ? -1 : activeTimestampIndex(stamps, seconds);
  if (active < 0) return Decoration.none;
  const block = timestampBlockRange(stamps, active, doc.lines, (line) => doc.line(line + 1).text);
  const builder = new RangeSetBuilder<Decoration>();
  for (let line = block.start; line <= block.end; line += 1) {
    const from = doc.line(line + 1).from;
    builder.add(from, from, playingTurn);
  }
  return builder.finish();
}

/** Marks for the timestamps inside the visible ranges only, so a transcript with thousands of stamps stays cheap. */
function visibleMarks(view: EditorView, stamps: TranscriptTimestamp[]): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  let last = -1;
  for (const range of view.visibleRanges) {
    for (const stamp of timestampsInRange(stamps, range.from, range.to)) {
      if (stamp.from < last) continue;
      last = stamp.to;
      builder.add(stamp.from, stamp.to, Decoration.mark({
        class: "cm-live-markdown-timestamp",
        attributes: { "data-seconds": String(stamp.seconds), title: "Play from here" },
      }));
    }
  }
  return builder.finish();
}

/**
 * Transcript timestamps (`[mm:ss]` or `[h:mm:ss]`) become clickable marks that seek the linked recording, and the
 * turn that contains the playhead gets a line highlight. Marks only style text, so it stays editable everywhere.
 */
export function liveMarkdownTimestamps({ getDocumentId, store = playbackStore }: TimestampOptions): Extension {
  const field = StateField.define<TimestampState>({
    create(state) {
      return { stamps: parseTranscriptTimestamps(state.doc.toString()), seconds: null, highlight: Decoration.none };
    },
    update(value, transaction) {
      let seconds = value.seconds;
      let moved = false;
      for (const effect of transaction.effects) {
        if (effect.is(setPlayhead)) { seconds = effect.value; moved = true; }
      }
      if (!transaction.docChanged && !moved) return value;
      const stamps = transaction.docChanged ? parseTranscriptTimestamps(transaction.newDoc.toString()) : value.stamps;
      return { stamps, seconds, highlight: highlightFor(transaction.newDoc, stamps, seconds) };
    },
    provide: (self) => EditorView.decorations.from(self, (value) => value.highlight),
  });

  const marks = ViewPlugin.fromClass(class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = visibleMarks(view, view.state.field(field).stamps); }
    update(update: ViewUpdate) {
      // Playhead movement never touches the marks.
      if (update.docChanged || update.viewportChanged) this.decorations = visibleMarks(update.view, update.state.field(field).stamps);
    }
  }, { decorations: (plugin) => plugin.decorations });

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
    marks,
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
