import { useEffect, useRef, useState } from "react";
import type { NoteHistoryEntry, NoteHistoryPage, NoteHistorySnapshot } from "../../../domain/types.ts";
import { api } from "../../../lib/api.ts";

type Props = {
  documentId: string;
  onBeforeRestore: (id: string) => Promise<void>;
  onRestored: (id: string) => Promise<void>;
  onPreview: (snapshot: NoteHistorySnapshot | null, loading: boolean, failed: boolean) => void;
  onExit?: () => void;
};

const HISTORY_PAGE_SIZE = 15;

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

export function NoteHistoryPanel({ documentId, onBeforeRestore, onRestored, onPreview }: Props) {
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
  const [timelineExplored, setTimelineExplored] = useState(false);
  const request = useRef(0);
  const activeRevision = useRef<string | null>(null);
  const failedRevision = useRef<string | null>(null);
  const scrubFrame = useRef<number | null>(null);
  const scrubRequestTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrubSettleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastScrubRequestAt = useRef(0);
  const versionController = useRef<AbortController | null>(null);
  const requestedScrubRevision = useRef<string | null>(null);
  const scrubFetchInFlight = useRef(false);
  const queuedScrubRevision = useRef<{ revision: string | null } | null>(null);
  const scrubIntent = useRef(false);
  const drag = useRef<{ pointerId: number; y: number; scrollTop: number } | null>(null);
  const dragMoved = useRef(false);
  const cache = useRef(new Map<string, NoteHistorySnapshot>());
  const selectedRef = useRef<NoteHistorySnapshot | null>(null);
  const timeline = useRef<HTMLElement>(null);
  const loadingPage = useRef(false);
  const historyPageGeneration = useRef(0);
  const historyReady = useRef(false);
  const refreshedFromNow = useRef(false);
  const refreshingTimeline = useRef(false);

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
    historyPageGeneration.current += 1;
    loadingPage.current = false;
    historyReady.current = false;
    refreshedFromNow.current = false;
    let cancelled = false;
    async function load() {
      try {
        await onBeforeRestore(documentId);
        const page = await api<NoteHistoryPage>(`/api/note/history?id=${encodeURIComponent(documentId)}&limit=${HISTORY_PAGE_SIZE}`);
        if (!cancelled) { setEntries(page.entries); setCursor(page.nextCursor); historyReady.current = true; }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not load note history.");
      } finally {
        if (!cancelled) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
      historyPageGeneration.current += 1;
      loadingPage.current = false;
      request.current += 1;
      versionController.current?.abort();
      if (scrubFrame.current !== null) cancelAnimationFrame(scrubFrame.current);
      if (scrubRequestTimer.current !== null) clearTimeout(scrubRequestTimer.current);
      if (scrubSettleTimer.current !== null) clearTimeout(scrubSettleTimer.current);
    };
  }, [documentId, onBeforeRestore]);

  async function select(next: string | null, retry = false, fromScrub = false, force = false) {
    if (!force && next === activeRevision.current && (!retry || failedRevision.current !== next)
      && !(fromScrub && scrubFetchInFlight.current)) return;
    if (fromScrub && scrubFetchInFlight.current) {
      activeRevision.current = next;
      failedRevision.current = null;
      setPreviewFailed(false);
      queuedScrubRevision.current = next === requestedScrubRevision.current ? null : { revision: next };
      setRevision(next);
      setPendingRevision(next);
      onPreview(selectedRef.current, true, false);
      if (next === null) {
        versionController.current?.abort();
        versionController.current = null;
        scrubFetchInFlight.current = false;
        requestedScrubRevision.current = null;
        queuedScrubRevision.current = null;
        selectedRef.current = null;
        setSelected(null);
        setPendingRevision(null);
        onPreview(null, false, false);
      }
      return;
    }
    activeRevision.current = next;
    failedRevision.current = null;
    setPreviewFailed(false);
    const id = ++request.current;
    if (!fromScrub) {
      queuedScrubRevision.current = null;
      versionController.current?.abort();
      versionController.current = null;
      scrubFetchInFlight.current = false;
      requestedScrubRevision.current = null;
    }
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
      cache.current.delete(next);
      cache.current.set(next, cached);
      setPendingRevision(null);
      selectedRef.current = cached;
      setSelected(cached);
      onPreview(cached, false, false);
      return;
    }
    setPendingRevision(next);
    onPreview(selectedRef.current, true, false);
    const controller = new AbortController();
    versionController.current = controller;
    if (fromScrub) {
      scrubFetchInFlight.current = true;
      requestedScrubRevision.current = next;
    }
    try {
      const snapshot = await api<NoteHistorySnapshot>(`/api/note/history/version?id=${encodeURIComponent(documentId)}&revision=${encodeURIComponent(next)}`, { signal: controller.signal });
      cache.current.delete(next);
      cache.current.set(next, snapshot);
      while (cache.current.size > 24) cache.current.delete(cache.current.keys().next().value as string);
      if (request.current === id) {
        selectedRef.current = snapshot;
        setSelected(snapshot);
        const queued = Boolean(queuedScrubRevision.current && scrubIntent.current);
        if (!queued) setPendingRevision(null);
        onPreview(snapshot, queued, false);
      }
    } catch (cause) {
      if (request.current === id) {
        const queued = Boolean(queuedScrubRevision.current && scrubIntent.current);
        if (!queued) {
          setError(cause instanceof Error ? cause.message : "Could not load that moment.");
          failedRevision.current = next;
          setPreviewFailed(true);
          setPendingRevision(null);
        }
        onPreview(selectedRef.current, queued, !queued);
      }
    }
    finally {
      if (versionController.current === controller) {
        versionController.current = null;
        if (fromScrub) {
          scrubFetchInFlight.current = false;
          requestedScrubRevision.current = null;
          const queued = queuedScrubRevision.current;
          queuedScrubRevision.current = null;
          if (queued) void select(queued.revision, false, true, true);
        }
      }
    }
  }

  async function loadMore() {
    if (!cursor || loadingPage.current) return;
    const generation = historyPageGeneration.current;
    loadingPage.current = true;
    setLoadingMore(true);
    try {
      const page = await api<NoteHistoryPage>(`/api/note/history?id=${encodeURIComponent(documentId)}&cursor=${encodeURIComponent(cursor)}&limit=${HISTORY_PAGE_SIZE}`);
      if (generation !== historyPageGeneration.current) return;
      setEntries((current) => {
        const seen = new Set(current.map((entry) => entry.revision));
        return [...current, ...page.entries.filter((entry) => !seen.has(entry.revision))];
      });
      setCursor(page.nextCursor);
    } catch (cause) {
      if (generation === historyPageGeneration.current) setError(cause instanceof Error ? cause.message : "Could not load more history.");
    }
    finally {
      if (generation === historyPageGeneration.current) {
        loadingPage.current = false;
        setLoadingMore(false);
      }
    }
  }

  async function refreshTimelineFromNow(): Promise<NoteHistoryPage | null> {
    if (!historyReady.current || refreshedFromNow.current || refreshingTimeline.current || loadingPage.current) return null;
    refreshedFromNow.current = true;
    refreshingTimeline.current = true;
    try {
      const page = await api<NoteHistoryPage>(`/api/note/history?id=${encodeURIComponent(documentId)}&limit=${HISTORY_PAGE_SIZE}`);
      const node = timeline.current;
      const center = node ? node.getBoundingClientRect().top + node.clientHeight / 2 : 0;
      const stops = node ? [...node.querySelectorAll<HTMLButtonElement>("[data-history-stop]")] : [];
      const anchor = stops.reduce<HTMLButtonElement | null>((best, stop) =>
        !best || Math.abs(stop.getBoundingClientRect().top + stop.offsetHeight / 2 - center) < Math.abs(best.getBoundingClientRect().top + best.offsetHeight / 2 - center) ? stop : best, null);
      const anchorRevision = anchor?.dataset.historyStop || "";
      const anchorTop = anchor?.getBoundingClientRect().top ?? 0;
      setEntries((current) => {
        const seen = new Set(page.entries.map((entry) => entry.revision));
        return [...page.entries, ...current.filter((entry) => !seen.has(entry.revision))];
      });
      if (entries.length === 0) setCursor(page.nextCursor);
      requestAnimationFrame(() => {
        if (!node || !anchor) return;
        const refreshedAnchor = [...node.querySelectorAll<HTMLButtonElement>("[data-history-stop]")]
          .find((stop) => (stop.dataset.historyStop || "") === anchorRevision);
        if (refreshedAnchor) node.scrollTop += refreshedAnchor.getBoundingClientRect().top - anchorTop;
      });
      return page;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not refresh note history.");
      refreshedFromNow.current = false;
      return null;
    } finally {
      refreshingTimeline.current = false;
      if (scrubIntent.current) requestScrubSelection();
    }
  }

  function beginScrub() {
    scrubIntent.current = true;
    setTimelineExplored(true);
    if (activeRevision.current === null) void refreshTimelineFromNow();
  }

  function requestScrubSelection() {
    if (scrubFrame.current !== null || !scrubIntent.current || refreshingTimeline.current) return;
    scrubFrame.current = requestAnimationFrame(() => {
      scrubFrame.current = null;
      const node = timeline.current;
      if (!node || !scrubIntent.current) return;
      const center = node.getBoundingClientRect().top + node.clientHeight / 2;
      const stops = [...node.querySelectorAll<HTMLButtonElement>("[data-history-stop]")];
      const nearest = stops.reduce<HTMLButtonElement | null>((best, stop) =>
        !best || Math.abs(stop.getBoundingClientRect().top + stop.offsetHeight / 2 - center) < Math.abs(best.getBoundingClientRect().top + best.offsetHeight / 2 - center) ? stop : best, null);
      const next = nearest?.dataset.historyStop || null;
      if (!nearest || next === activeRevision.current) return;
      const remaining = Math.max(0, 90 - (Date.now() - lastScrubRequestAt.current));
      if (remaining) {
        if (scrubRequestTimer.current !== null) clearTimeout(scrubRequestTimer.current);
        scrubRequestTimer.current = setTimeout(() => {
          scrubRequestTimer.current = null;
          requestScrubSelection();
        }, remaining);
        return;
      }
      lastScrubRequestAt.current = Date.now();
      void select(next, false, true);
    });
  }

  function onScroll() {
    const node = timeline.current;
    if (!node || restoring) return;
    updateStickyDay();
    if (cursor && node.scrollHeight - node.scrollTop - node.clientHeight < 160) void loadMore();
    if (scrubIntent.current) {
      requestScrubSelection();
      if (scrubSettleTimer.current !== null) clearTimeout(scrubSettleTimer.current);
      scrubSettleTimer.current = setTimeout(() => {
        scrubSettleTimer.current = null;
        scrubIntent.current = false;
      }, 120);
    }
  }

  function moveTo(next: string | null, allowDuringRestore = false) {
    if (restoring && !allowDuringRestore) return;
    scrubIntent.current = false;
    queuedScrubRevision.current = null;
    if (next === null) {
      refreshedFromNow.current = false;
      setTimelineExplored(false);
    } else {
      setTimelineExplored(true);
    }
    void select(next, true);
    const stop = [...(timeline.current?.querySelectorAll<HTMLButtonElement>("[data-history-stop]") ?? [])]
      .find((element) => (element.dataset.historyStop || null) === next);
    const node = timeline.current;
    if (stop && node && typeof node.scrollTo === "function") {
      const delta = stop.getBoundingClientRect().top + stop.offsetHeight / 2 - (node.getBoundingClientRect().top + node.clientHeight / 2);
      node.scrollTo({ top: node.scrollTop + delta, behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
    }
  }

  async function moveBy(offset: number) {
    if (offset > 0 && revision === null) {
      setTimelineExplored(true);
      const selectionRequest = request.current;
      const page = await refreshTimelineFromNow();
      if (request.current !== selectionRequest) return;
      const newest = page?.entries[0] ?? entries[0];
      if (newest) moveTo(newest.revision);
      return;
    }
    const stops = [...(timeline.current?.querySelectorAll<HTMLButtonElement>("[data-history-stop]") ?? [])];
    const index = stops.findIndex((stop) => (stop.dataset.historyStop || null) === revision);
    const next = Math.max(0, Math.min(stops.length - 1, (index < 0 ? 0 : index) + offset));
    if (stops[next]) moveTo(stops[next].dataset.historyStop || null);
  }

  async function restore() {
    if (!selected || selected.revision !== revision || pendingRevision || restoring || !window.confirm("Restore this version? Your current note will remain in history.")) return;
    scrubIntent.current = false;
    setRestoring(true);
    setError("");
    try {
      await onBeforeRestore(documentId);
      const result = await api<{ warning: string | null }>("/api/note/history/restore", {
        method: "POST", body: JSON.stringify({ id: documentId, revision: selected.revision }),
      });
      await onRestored(documentId);
      const page = await api<NoteHistoryPage>(`/api/note/history?id=${encodeURIComponent(documentId)}&limit=${HISTORY_PAGE_SIZE}`);
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
    <div className="note-history-head"><h2>History</h2></div>
    {error && <p className="note-history-error" role="alert">{error} {failed && <button type="button" onClick={() => void select(revision, true)}>Retry</button>}</p>}
    {warning && <p className="note-history-warning" role="status">{warning}</p>}
    <div className="note-history-track-wrap"><div className="note-history-focus" aria-hidden="true" />
      {stickyDay && <div className="note-history-sticky-day" aria-hidden="true"><span className="note-history-tick is-sticky-day-tick"/><span>{stickyDay}</span></div>}
      <nav ref={timeline} tabIndex={0} className={`note-history-timeline${timelineExplored ? " is-explored" : ""}`} aria-label="Note timeline" onScroll={onScroll}
        onWheel={beginScrub} onTouchStart={beginScrub}
        onPointerDown={(event) => {
          if (restoring || event.pointerType !== "mouse" || event.button !== 0) return;
          beginScrub();
          dragMoved.current = false;
          drag.current = { pointerId: event.pointerId, y: event.clientY, scrollTop: event.currentTarget.scrollTop };
        }}
        onPointerMove={(event) => {
          if (!drag.current || drag.current.pointerId !== event.pointerId) return;
          const distance = event.clientY - drag.current.y;
          if (Math.abs(distance) > 5) {
            dragMoved.current = true;
            beginScrub();
            if (!event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.setPointerCapture(event.pointerId);
            event.currentTarget.scrollTop = drag.current.scrollTop - distance;
          }
        }}
        onPointerUp={(event) => { if (drag.current?.pointerId === event.pointerId) { drag.current = null; if (!dragMoved.current) scrubIntent.current = false; else { requestScrubSelection(); if (scrubSettleTimer.current !== null) clearTimeout(scrubSettleTimer.current); scrubSettleTimer.current = setTimeout(() => { scrubSettleTimer.current = null; scrubIntent.current = false; }, 120); } } }}
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
