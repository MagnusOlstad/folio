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

function localDay(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
}

function timestamp(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function dayLabel(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

export function NoteHistoryPanel({ documentId, onBeforeRestore, onRestored, onPreview, onExit }: Props) {
  const [entries, setEntries] = useState<NoteHistoryEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [revision, setRevision] = useState<string | null>(null);
  const [selected, setSelected] = useState<NoteHistorySnapshot | null>(null);
  const [pendingRevision, setPendingRevision] = useState<string | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [stickyDay, setStickyDay] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const request = useRef(0);
  const activeRevision = useRef<string | null>(null);
  const failedRevision = useRef<string | null>(null);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrubIntent = useRef(false);
  const drag = useRef<{ pointerId: number; y: number; scrollTop: number } | null>(null);
  const dragMoved = useRef(false);
  const cache = useRef(new Map<string, NoteHistorySnapshot>());
  const selectedRef = useRef<NoteHistorySnapshot | null>(null);
  const timeline = useRef<HTMLElement>(null);
  const loadingPage = useRef(false);

  function updateStickyDay() {
    const node = timeline.current;
    if (!node) return;
    const top = node.getBoundingClientRect().top;
    const boundaries = [...node.querySelectorAll<HTMLButtonElement>("[data-history-stop].is-day-boundary")];
    const crossed = boundaries.filter((item) => item.getBoundingClientRect().top <= top);
    setStickyDay(crossed.at(-1)?.dataset.historyDay || null);
  }

  useEffect(() => {
    updateStickyDay();
    const node = timeline.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateStickyDay);
    observer.observe(node);
    return () => observer.disconnect();
  }, [entries]);

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
      if (settleTimer.current !== null) clearTimeout(settleTimer.current);
    };
  }, [documentId, onBeforeRestore]);

  async function select(next: string | null, retry = false) {
    if (next === activeRevision.current && (!retry || failedRevision.current !== next)) return;
    activeRevision.current = next;
    failedRevision.current = null;
    setPreviewFailed(false);
    const id = ++request.current;
    setRevision(next);
    setError("");
    if (!next) {
      setPendingRevision(null);
      selectedRef.current = null;
      setSelected(null);
      onPreview(null, false, false);
      return;
    }
    const cached = cache.current.get(next);
    if (cached) {
      setPendingRevision(null);
      selectedRef.current = cached;
      setSelected(cached);
      onPreview(cached, false, false);
      return;
    }
    setPendingRevision(next);
    onPreview(selectedRef.current, true, false);
    try {
      const snapshot = await api<NoteHistorySnapshot>(`/api/note/history/version?id=${encodeURIComponent(documentId)}&revision=${encodeURIComponent(next)}`);
      cache.current.set(next, snapshot);
      if (request.current === id) {
        selectedRef.current = snapshot;
        setSelected(snapshot);
        setPendingRevision(null);
        onPreview(snapshot, false, false);
      }
    } catch (cause) {
      if (request.current === id) {
        setError(cause instanceof Error ? cause.message : "Could not load that moment.");
        failedRevision.current = next;
        setPreviewFailed(true);
        setPendingRevision(null);
        onPreview(selectedRef.current, false, true);
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

  function settleScrub() {
    if (settleTimer.current !== null) clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(() => {
      settleTimer.current = null;
      const node = timeline.current;
      if (!node || !scrubIntent.current) return;
      if (drag.current) return;
      const center = node.getBoundingClientRect().top + node.clientHeight / 2;
      const stops = [...node.querySelectorAll<HTMLButtonElement>("[data-history-stop]")];
      const nearest = stops.reduce<HTMLButtonElement | null>((best, stop) =>
        !best || Math.abs(stop.getBoundingClientRect().top + stop.offsetHeight / 2 - center) < Math.abs(best.getBoundingClientRect().top + best.offsetHeight / 2 - center) ? stop : best, null);
      if (nearest) {
        void select(nearest.dataset.historyStop || null);
        if (typeof node.scrollTo === "function") {
          const delta = nearest.getBoundingClientRect().top + nearest.offsetHeight / 2 - center;
          node.scrollTo({ top: node.scrollTop + delta, behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
        }
      }
      scrubIntent.current = false;
    }, 110);
  }

  function onScroll() {
    const node = timeline.current;
    if (!node || restoring) return;
    updateStickyDay();
    if (cursor && node.scrollHeight - node.scrollTop - node.clientHeight < 160) void loadMore();
    if (scrubIntent.current) settleScrub();
  }

  function moveTo(next: string | null, allowDuringRestore = false) {
    if (restoring && !allowDuringRestore) return;
    scrubIntent.current = false;
    if (settleTimer.current !== null) clearTimeout(settleTimer.current);
    void select(next, true);
    const stop = [...(timeline.current?.querySelectorAll<HTMLButtonElement>("[data-history-stop]") ?? [])]
      .find((element) => (element.dataset.historyStop || null) === next);
    const node = timeline.current;
    if (stop && node && typeof node.scrollTo === "function") {
      const delta = stop.getBoundingClientRect().top + stop.offsetHeight / 2 - (node.getBoundingClientRect().top + node.clientHeight / 2);
      node.scrollTo({ top: node.scrollTop + delta, behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
    }
  }

  function moveBy(offset: number) {
    const stops = [...(timeline.current?.querySelectorAll<HTMLButtonElement>("[data-history-stop]") ?? [])];
    const index = stops.findIndex((stop) => (stop.dataset.historyStop || null) === revision);
    const next = Math.max(0, Math.min(stops.length - 1, (index < 0 ? 0 : index) + offset));
    if (stops[next]) moveTo(stops[next].dataset.historyStop || null);
  }

  async function restore() {
    if (!selected || selected.revision !== revision || pendingRevision || restoring || !window.confirm("Restore this version? Your current note will remain in history.")) return;
    if (settleTimer.current !== null) clearTimeout(settleTimer.current);
    scrubIntent.current = false;
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
      moveTo(null, true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not restore that version."); }
    finally { setRestoring(false); }
  }

  const pending = Boolean(pendingRevision && pendingRevision === revision);
  const failed = revision !== null && previewFailed && !pending;
  return <section className="note-history-panel" aria-label="Note history">
    <div className="note-history-head"><div><span className="note-history-eyebrow">NOTE HISTORY</span><h2>History</h2></div><button type="button" className="note-history-exit" onClick={onExit}>Done</button></div>
    <p className="note-history-instruction">Drag or scroll to move through earlier moments.</p>
    {error && <p className="note-history-error" role="alert">{error} {failed && <button type="button" onClick={() => void select(revision, true)}>Retry</button>}</p>}
    {warning && <p className="note-history-warning" role="status">{warning}</p>}
    <div className="note-history-track-wrap"><div className="note-history-focus" aria-hidden="true" />
      {stickyDay && <div className="note-history-sticky-day" aria-hidden="true"><span className="note-history-tick is-sticky-day-tick"/><span>{stickyDay}</span></div>}
      <nav ref={timeline} tabIndex={0} className="note-history-timeline" aria-label="Note timeline" onScroll={onScroll}
        onWheel={() => { scrubIntent.current = true; }} onTouchStart={() => { scrubIntent.current = true; }}
        onPointerDown={(event) => {
          if (restoring || event.pointerType !== "mouse" || event.button !== 0) return;
          scrubIntent.current = true;
          dragMoved.current = false;
          drag.current = { pointerId: event.pointerId, y: event.clientY, scrollTop: event.currentTarget.scrollTop };
        }}
        onPointerMove={(event) => {
          if (!drag.current || drag.current.pointerId !== event.pointerId) return;
          const distance = event.clientY - drag.current.y;
          if (Math.abs(distance) > 5) {
            dragMoved.current = true;
            scrubIntent.current = true;
            if (!event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.setPointerCapture(event.pointerId);
            event.currentTarget.scrollTop = drag.current.scrollTop - distance;
          }
        }}
        onPointerUp={(event) => { if (drag.current?.pointerId === event.pointerId) { drag.current = null; if (dragMoved.current) settleScrub(); else scrubIntent.current = false; } }}
        onPointerCancel={() => { drag.current = null; dragMoved.current = false; scrubIntent.current = false; }}
        onKeyDown={(event) => {
          if (restoring) { event.preventDefault(); return; }
          if (event.key === "ArrowUp" || event.key === "ArrowLeft") { event.preventDefault(); moveBy(-1); }
          else if (event.key === "ArrowDown" || event.key === "ArrowRight") { event.preventDefault(); moveBy(1); }
          else if (event.key === "Home") { event.preventDefault(); moveTo(null); }
          else if (event.key === "End") { event.preventDefault(); const last = entries.at(-1); if (last) moveTo(last.revision); }
          else if (event.key === "PageUp" || event.key === "PageDown") { event.preventDefault(); moveBy(event.key === "PageUp" ? -5 : 5); }
        }}>
        <button type="button" disabled={restoring} data-history-stop="" aria-label="Present" aria-current={!revision ? "step" : undefined} className={`note-history-stop is-now${!revision ? " active" : ""}`} onClick={() => { if (dragMoved.current) { dragMoved.current = false; return; } moveTo(null); }}><span className="note-history-tick"/><span className="note-history-stop-copy"><strong>Now</strong><small>Current note</small></span></button>
        {loading && <p className="note-history-state" role="status">Gathering moments…</p>}
        {!loading && entries.length === 0 && <p className="note-history-state">No earlier moments yet.</p>}
        {entries.map((entry, index) => {
          const dayBoundary = index === 0 || localDay(entry.authoredAt) !== localDay(entries[index - 1].authoredAt);
          return <button type="button" disabled={restoring} data-history-stop={entry.revision} data-history-day={dayLabel(entry.authoredAt)} aria-label={`${entry.title || "Untitled"}, ${dayLabel(entry.authoredAt)}, ${timestamp(entry.authoredAt)}`} aria-current={revision === entry.revision ? "step" : undefined} className={`note-history-stop${dayBoundary ? " is-day-boundary" : ""}${revision === entry.revision ? " active" : ""}`} key={entry.revision} onClick={() => { if (dragMoved.current) { dragMoved.current = false; return; } moveTo(entry.revision); }}><span className="note-history-tick"/><span className="note-history-stop-copy"><strong>{timestamp(entry.authoredAt)}</strong><small>{dayBoundary ? dayLabel(entry.authoredAt) : "\u00a0"}</small></span></button>;
        })}
        {cursor && <button type="button" className="note-history-more" onClick={() => void loadMore()} disabled={loadingMore || restoring}>{loadingMore ? "Loading…" : "Load earlier"}</button>}
      </nav>
    </div>
    <div className="note-history-actions"><span aria-live="polite">{pending ? "Opening selected moment…" : failed ? "Could not open moment" : revision ? "Viewing an earlier moment" : "Viewing the present"}</span><div className="note-history-nav"><button type="button" onClick={() => moveBy(-1)} disabled={!revision || restoring} aria-label="Newer moment">↑ Newer</button><button type="button" onClick={() => moveBy(1)} disabled={!entries.length || restoring} aria-label="Older moment">Older ↓</button></div><button type="button" className="note-history-restore" onClick={() => void restore()} disabled={!selected || selected.revision !== revision || pending || restoring}>{restoring ? "Restoring…" : "Restore this version"}</button></div>
  </section>;
}
