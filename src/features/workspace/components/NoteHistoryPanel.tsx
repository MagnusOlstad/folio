import { memo, useEffect, useRef, useState } from "react";
import type { NoteHistoryEntry, NoteHistoryPage, NoteHistorySnapshot } from "../../../domain/types.ts";
import { api } from "../../../lib/api.ts";

type NoteHistoryPanelProps = { documentId: string; onBeforeRestore: (documentId: string) => Promise<void>; onRestored: (documentId: string) => Promise<void> };

function dateLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function NoteHistoryPanelComponent({ documentId, onBeforeRestore, onRestored }: NoteHistoryPanelProps) {
  const [entries, setEntries] = useState<NoteHistoryEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<NoteHistorySnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const selectionRequestRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    async function prepareAndLoad() {
      try {
        await onBeforeRestore(documentId);
        const page = await api<NoteHistoryPage>(`/api/note/history?id=${encodeURIComponent(documentId)}`);
        if (!cancelled) { setEntries(page.entries); setCursor(page.nextCursor); }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not load note history.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void prepareAndLoad();
    return () => { cancelled = true; };
  }, [documentId, onBeforeRestore]);

  useEffect(() => () => { selectionRequestRef.current += 1; }, []);

  async function selectRevision(revision: string) {
    const requestId = ++selectionRequestRef.current;
    setError("");
    setSelected(null);
    try {
      const snapshot = await api<NoteHistorySnapshot>(`/api/note/history/version?id=${encodeURIComponent(documentId)}&revision=${encodeURIComponent(revision)}`);
      if (selectionRequestRef.current === requestId) setSelected(snapshot);
    } catch (cause) {
      if (selectionRequestRef.current === requestId)
        setError(cause instanceof Error ? cause.message : "Could not load that version.");
    }
  }
  async function loadMore() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await api<NoteHistoryPage>(`/api/note/history?id=${encodeURIComponent(documentId)}&cursor=${encodeURIComponent(cursor)}`);
      setEntries((current) => [...current, ...page.entries]); setCursor(page.nextCursor);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load more history."); }
    finally { setLoadingMore(false); }
  }
  async function restoreSelected() {
    if (!selected || restoring || !window.confirm("Restore this version? Your current note is saved as a new history entry.")) return;
    setRestoring(true); setError("");
    try {
      await onBeforeRestore(documentId);
      const restored = await api<{ warning: string | null }>("/api/note/history/restore", { method: "POST", body: JSON.stringify({ id: documentId, revision: selected.revision }) });
      setWarning(restored.warning || "");
      await onRestored(documentId);
      setSelected(null);
      const page = await api<NoteHistoryPage>(`/api/note/history?id=${encodeURIComponent(documentId)}`);
      setEntries(page.entries); setCursor(page.nextCursor);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not restore that version."); }
    finally { setRestoring(false); }
  }
  return <section className="note-history-panel" aria-label="Note history">
    {error && <p className="note-history-error" role="alert">{error}</p>}
    {warning && <p className="note-history-warning" role="status">{warning}</p>}
    <div className="note-history-body">
      <nav className="note-history-timeline" aria-label="Note versions">
        <h2>Versions</h2>
        {loading && <p>Loading history…</p>}
        {!loading && entries.length === 0 && <p>No saved versions yet.</p>}
        {entries.map((entry) => <button type="button" className={selected?.revision === entry.revision ? "active" : ""} aria-current={selected?.revision === entry.revision ? "true" : undefined} aria-pressed={selected?.revision === entry.revision} onClick={() => void selectRevision(entry.revision)} key={entry.revision}><strong>{entry.title}</strong><small>{dateLabel(entry.authoredAt)}</small></button>)}
        {cursor && <button type="button" className="note-history-more" onClick={() => void loadMore()} disabled={loadingMore}>{loadingMore ? "Loading…" : "Load more"}</button>}
      </nav>
      <section className="note-history-version" aria-live="polite" aria-label="Selected version changes">
        {selected ? <>
          <div className="note-history-version-heading"><span>Current → selected</span><button type="button" onClick={() => void restoreSelected()} disabled={restoring}>{restoring ? "Restoring…" : "Restore"}</button></div>
          <pre className="note-history-diff" aria-label="Unified diff">{selected.diff ? selected.diff.split("\n").map((line, index) => {
            const kind = line.startsWith("+") && !line.startsWith("+++")
              ? "added"
              : line.startsWith("-") && !line.startsWith("---")
                ? "removed"
                : line.startsWith("@@")
                  ? "hunk"
                  : "context";
            return <span className={`note-history-diff-line is-${kind}`} key={`${index}-${line}`}>{line || "\u00a0"}{"\n"}</span>;
          }) : "No content changes."}</pre>
        </> : <p>Select a version to see its changes.</p>}
      </section>
    </div>
  </section>;
}

export const NoteHistoryPanel = memo(NoteHistoryPanelComponent);
