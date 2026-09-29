import { useEffect, useRef, useState } from "react";
import type { NoteHistoryEntry, NoteHistoryPage, NoteHistorySnapshot } from "../../../domain/types.ts";
import { api } from "../../../lib/api.ts";

type Props = {
  documentId: string;
  onBeforeRestore: (id: string) => Promise<void>;
  onRestored: (id: string) => Promise<void>;
  onPreview: (snapshot: NoteHistorySnapshot | null, loading: boolean, failed: boolean) => void;
  onExit: () => void;
};

function labels(value: string, previous?: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { day: "", time: value };
  return {
    day: previous && new Date(previous).toDateString() === date.toDateString() ? "" : date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }),
    time: date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }),
  };
}

export function NoteHistoryPanel({ documentId, onBeforeRestore, onRestored, onPreview, onExit }: Props) {
  const [entries, setEntries] = useState<NoteHistoryEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [revision, setRevision] = useState<string | null>(null);
  const [selected, setSelected] = useState<NoteHistorySnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState("");
  const [previewFailed, setPreviewFailed] = useState(false);
  const [warning, setWarning] = useState("");
  const request = useRef(0);
  const activeRevision = useRef<string | null>(null);
  const failedRevision = useRef<string | null>(null);
  const scrollFrame = useRef<number | null>(null);
  const userScroll = useRef(false);
  const cache = useRef(new Map<string, NoteHistorySnapshot>());
  const timeline = useRef<HTMLElement>(null);
  const loadingPage = useRef(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        await onBeforeRestore(documentId);
        const page = await api<NoteHistoryPage>(`/api/note/history?id=${encodeURIComponent(documentId)}`);
        if (!cancelled) { setEntries(page.entries); setCursor(page.nextCursor); }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not load note history.");
      } finally { if (!cancelled) setLoading(false); }
    }
    void load();
    return () => {
      cancelled = true;
      request.current += 1;
      if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
    };
  }, [documentId, onBeforeRestore]);

  async function select(next: string | null, retry = false) {
    if (next === activeRevision.current && (!retry || failedRevision.current !== next)) return;
    activeRevision.current = next;
    failedRevision.current = null;
    const id = ++request.current;
    setRevision(next);
    setSelected(null);
    setError("");
    setPreviewFailed(false);
    if (!next) { onPreview(null, false, false); return; }
    const cached = cache.current.get(next);
    if (cached) { setSelected(cached); onPreview(cached, false, false); return; }
    onPreview(null, true, false);
    try {
      const snapshot = await api<NoteHistorySnapshot>(`/api/note/history/version?id=${encodeURIComponent(documentId)}&revision=${encodeURIComponent(next)}`);
      cache.current.set(next, snapshot);
      if (request.current === id) { setSelected(snapshot); onPreview(snapshot, false, false); }
    } catch (cause) {
      if (request.current === id) {
        setError(cause instanceof Error ? cause.message : "Could not load that moment.");
        failedRevision.current = next;
        setPreviewFailed(true);
        onPreview(null, false, true);
      }
    }
  }

  async function loadMore() {
    if (!cursor || loadingPage.current) return;
    loadingPage.current = true;
    setLoadingMore(true);
    try {
      const page = await api<NoteHistoryPage>(`/api/note/history?id=${encodeURIComponent(documentId)}&cursor=${encodeURIComponent(cursor)}`);
      setEntries((current) => [...current, ...page.entries.filter((entry) => !current.some((existing) => existing.revision === entry.revision))]);
      setCursor(page.nextCursor);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load more history."); }
    finally { loadingPage.current = false; setLoadingMore(false); }
  }

  function onScroll() {
    const node = timeline.current;
    if (!node || restoring) return;
    if (cursor && node.scrollHeight - node.scrollTop - node.clientHeight < 160) void loadMore();
    if (scrollFrame.current !== null) return;
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = null;
      const current = timeline.current;
      if (!current) return;
      const center = current.getBoundingClientRect().top + current.clientHeight / 2;
      const stops = [...current.querySelectorAll<HTMLButtonElement>("[data-history-stop]")];
      const nearest = stops.reduce<HTMLButtonElement | null>((best, stop) =>
        !best || Math.abs(stop.getBoundingClientRect().top + stop.offsetHeight / 2 - center) < Math.abs(best.getBoundingClientRect().top + best.offsetHeight / 2 - center)
          ? stop : best, null);
      if (!userScroll.current) return;
      if (nearest) void select(nearest.dataset.historyStop || null);
    });
  }

  function moveTo(next: string | null) {
    void select(next, true);
    userScroll.current = false;
    const stop = [...(timeline.current?.querySelectorAll<HTMLButtonElement>("[data-history-stop]") ?? [])]
      .find((element) => (element.dataset.historyStop || null) === next);
    stop?.scrollIntoView?.({ behavior: "smooth", block: "center" });
  }

  async function restore() {
    if (!selected || restoring || !window.confirm("Restore this version? Your current note will remain in history.")) return;
    setRestoring(true);
    setError("");
    try {
      await onBeforeRestore(documentId);
      const result = await api<{ warning: string | null }>("/api/note/history/restore", {
        method: "POST", body: JSON.stringify({ id: documentId, revision: selected.revision }),
      });
      await onRestored(documentId);
      const page = await api<NoteHistoryPage>(`/api/note/history?id=${encodeURIComponent(documentId)}`);
      cache.current.clear();
      setEntries(page.entries);
      setCursor(page.nextCursor);
      setWarning(result.warning || "Restored. The previous present is still in history.");
      moveTo(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not restore that version."); }
    finally { setRestoring(false); }
  }

  return <section className="note-history-panel" aria-label="Note history">
    <div className="note-history-head"><div><span className="note-history-eyebrow">TIME TRAVEL</span><h2>History</h2></div><button type="button" className="note-history-exit" onClick={onExit}>Done</button></div>
    <p className="note-history-instruction">Scroll through the note’s earlier moments.</p>
    {error && <p className="note-history-error" role="alert">{error}</p>}
    {warning && <p className="note-history-warning" role="status">{warning}</p>}
    <div className="note-history-track-wrap"><div className="note-history-focus" aria-hidden="true" />
      <nav ref={timeline} className="note-history-timeline" aria-label="Note timeline" onScroll={onScroll} onWheel={() => { userScroll.current = true; }} onTouchStart={() => { userScroll.current = true; }} onPointerDown={(event) => { if (event.target === event.currentTarget) userScroll.current = true; }} onKeyDown={(event) => { if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(event.key)) userScroll.current = true; }}>
        <button type="button" data-history-stop="" aria-label="Present" aria-current={!revision ? "step" : undefined} className={`note-history-stop is-now${!revision ? " active" : ""}`} onClick={() => moveTo(null)}><span className="note-history-tick"/><span className="note-history-stop-copy"><strong>Now</strong><small>Current note</small></span></button>
        {loading && <p className="note-history-state" role="status">Gathering moments…</p>}
        {!loading && entries.length === 0 && <p className="note-history-state">No earlier moments yet.</p>}
        {entries.map((entry, index) => {
          const { day, time } = labels(entry.authoredAt, entries[index - 1]?.authoredAt);
          return <div className="note-history-moment" key={entry.revision}>{day && <span className="note-history-day">{day}</span>}
            <button type="button" data-history-stop={entry.revision} aria-label={`${entry.title}, ${time}${day ? `, ${day}` : ""}`} aria-current={revision === entry.revision ? "step" : undefined} className={`note-history-stop${revision === entry.revision ? " active" : ""}`} onClick={() => moveTo(entry.revision)}><span className="note-history-tick"/><span className="note-history-stop-copy"><strong>{entry.title || "Untitled"}</strong><small>{time}</small></span></button>
          </div>;
        })}
        {cursor && <button type="button" className="note-history-more" onClick={() => void loadMore()} disabled={loadingMore}>{loadingMore ? "Loading…" : "Earlier moments"}</button>}
      </nav>
    </div>
    <div className="note-history-actions"><span aria-live="polite">{revision ? selected ? "Viewing an earlier moment" : previewFailed ? "Could not open moment" : "Opening moment…" : "Viewing the present"}</span><button type="button" className="note-history-restore" onClick={() => void restore()} disabled={!selected || restoring}>{restoring ? "Restoring…" : "Restore this version"}</button></div>
  </section>;
}
