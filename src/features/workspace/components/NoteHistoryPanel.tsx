import { memo, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { NoteHistoryEntry, NoteHistoryPage, NoteHistorySnapshot } from "../../../domain/types.ts";
import { api } from "../../../lib/api.ts";

type NoteHistoryPanelProps = { documentId: string; onClose: () => void; onBeforeRestore: (documentId: string) => Promise<void>; onRestored: (documentId: string) => Promise<void> };

function dateLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function NoteHistoryPanelComponent({ documentId, onClose, onBeforeRestore, onRestored }: NoteHistoryPanelProps) {
  const [entries, setEntries] = useState<NoteHistoryEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<NoteHistorySnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");

  useEffect(() => {
    let cancelled = false;
    void api<NoteHistoryPage>(`/api/note/history?id=${encodeURIComponent(documentId)}`)
      .then((page) => { if (!cancelled) { setEntries(page.entries); setCursor(page.nextCursor); } })
      .catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not load note history."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [documentId]);

  async function selectRevision(revision: string) {
    setError("");
    try {
      setSelected(await api<NoteHistorySnapshot>(`/api/note/history/version?id=${encodeURIComponent(documentId)}&revision=${encodeURIComponent(revision)}`));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load that version."); }
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
  const selectedEntry = selected
    ? entries.find((entry) => entry.revision === selected.revision)
    : null;

  return <aside className="note-history-panel" aria-label="Note history">
    <header className="note-history-heading"><div><span>History</span><strong>{documentId.split("/").pop()?.replace(/\.md$/, "") || "Note"}</strong></div><button type="button" onClick={onClose} aria-label="Close history">Close</button></header>
    {error && <p className="note-history-error" role="alert">{error}</p>}
    {warning && <p className="note-history-warning" role="status">{warning}</p>}
    <div className="note-history-body">
      <nav className="note-history-timeline" aria-label="Versions">
        {loading && <p>Loading history…</p>}
        {!loading && entries.length === 0 && <p>No history is available yet.</p>}
        {entries.map((entry) => <button type="button" className={selected?.revision === entry.revision ? "active" : ""} onClick={() => void selectRevision(entry.revision)} key={entry.revision}><strong>{entry.title}</strong><small>{dateLabel(entry.authoredAt)}</small></button>)}
        {cursor && <button type="button" className="note-history-more" onClick={() => void loadMore()} disabled={loadingMore}>{loadingMore ? "Loading…" : "Load more"}</button>}
      </nav>
      <section className="note-history-version" aria-live="polite">
        {selected ? <>
          <div className="note-history-version-heading"><div><span>Selected version</span><strong>{selectedEntry ? dateLabel(selectedEntry.authoredAt) : "Selected revision"}</strong></div><button type="button" onClick={() => void restoreSelected()} disabled={restoring}>{restoring ? "Restoring…" : "Restore version"}</button></div>
          <dl className="note-history-metadata"><div><dt>Title</dt><dd>{selected.note.title}</dd></div><div><dt>Tags</dt><dd>{selected.note.tags.map((tag) => `#${tag}`).join(" ") || "None"}</dd></div><div><dt>Status</dt><dd>{selected.note.status}</dd></div></dl>
          <div className="note-history-preview"><ReactMarkdown remarkPlugins={[remarkGfm]}>{selected.note.content}</ReactMarkdown></div>
          <details className="note-history-diff" open><summary>Changes from current</summary><pre>{selected.diff || "No content changes."}</pre></details>
        </> : <p>Select a version to inspect its preview and changes.</p>}
      </section>
    </div>
  </aside>;
}

// This only mounts after the explicit History action, keeping network/rendering work out of typing.
export const NoteHistoryPanel = memo(NoteHistoryPanelComponent);
