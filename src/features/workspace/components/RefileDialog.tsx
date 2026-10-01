import { useEffect, useRef, useState, type FormEvent } from "react";
import type { RefileResult, ViewerDocument } from "../../../domain/types.ts";
import { api } from "../../../lib/api.ts";

type Proposal = {
  id: string;
  hash: string;
  proposal: { directory: string; filename: string; title: string; description: string; tags: string[] };
};
export type { RefileResult } from "../../../domain/types.ts";

export function RefileDialog({
  document: viewDocument,
  onClose,
  onComplete,
}: {
  document: ViewerDocument;
  onClose: () => void;
  onComplete: (result: RefileResult) => void;
}) {
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [fields, setFields] = useState<Proposal["proposal"] | null>(null);
  const [pathInput, setPathInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const dialogRef = useRef<HTMLElement>(null);
  const pathRef = useRef<HTMLInputElement>(null);
  const discardRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  const savingRef = useRef(saving);

  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => { savingRef.current = saving; }, [saving]);

  useEffect(() => {
    let cancelled = false;
    void api<Proposal>("/api/file/refile/propose", {
      method: "POST",
      body: JSON.stringify({ id: viewDocument.id }),
    }).then((next) => {
      if (cancelled) return;
      setProposal(next);
      setFields(next.proposal);
      setPathInput(next.proposal.directory === "/" ? `/${next.proposal.filename}` : `${next.proposal.directory}/${next.proposal.filename}`);
    }).catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : "Could not propose a new filing.");
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [viewDocument.id]);

  useEffect(() => {
    const previouslyFocused = document.activeElement;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (savingRef.current) return;
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      const dialog = dialogRef.current;
      if (event.key !== "Tab" || !dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled])'))
        .filter((element) => element.getClientRects().length > 0);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    };
  }, []);

  useEffect(() => {
    if (loading) discardRef.current?.focus();
    else if (fields) pathRef.current?.focus();
  }, [loading, fields !== null]);

  async function accept(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!proposal || !fields || saving) return;
    const normalizedPath = pathInput.trim().replace(/\\/g, "/").replace(/\/+$/, "");
    const splitAt = normalizedPath.lastIndexOf("/");
    const directory = splitAt <= 0 ? "/" : normalizedPath.slice(0, splitAt);
    const filename = splitAt < 0 ? normalizedPath : normalizedPath.slice(splitAt + 1);
    setSaving(true);
    setError("");
    try {
      const result = await api<RefileResult>("/api/file/refile", {
        method: "POST",
        body: JSON.stringify({
          id: proposal.id,
          hash: proposal.hash,
          fields: { ...fields, directory, filename },
        }),
      });
      onComplete(result);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not refile this note.");
      setSaving(false);
    }
  }

  const update = (key: keyof Proposal["proposal"], value: string) => {
    setFields((current) => {
      if (!current) return current;
      return { ...current, [key]: key === "tags" ? value.split(",").map((tag) => tag.trim()).filter(Boolean) : value };
    });
  };

  return (
    <div className="refile-layer" onPointerDown={(event) => { if (event.target === event.currentTarget && !saving) onClose(); }}>
      <section ref={dialogRef} className="refile-dialog" role="dialog" aria-modal="true" aria-label="Refile note">
        <header><div><span>Review suggested changes</span><h2>Refile note</h2></div></header>
        {loading ? <><p role="status">Reviewing the latest note…</p><footer><button ref={discardRef} type="button" onClick={onClose}>Discard</button></footer></> : fields ? (
          <form onSubmit={(event) => { void accept(event); }}>
            <label>Path<input ref={pathRef} value={pathInput} onChange={(event) => setPathInput(event.currentTarget.value)} /></label>
            <label>Title<input value={fields.title} onChange={(event) => update("title", event.currentTarget.value)} /></label>
            <label>Description<textarea rows={3} value={fields.description} onChange={(event) => update("description", event.currentTarget.value)} /></label>
            <label>Tags<input value={fields.tags.join(", ")} onChange={(event) => update("tags", event.currentTarget.value)} /></label>
            {error ? <p role="alert">{error}</p> : null}
            <footer><button type="button" onClick={onClose} disabled={saving}>Discard</button><button type="submit" disabled={saving}>{saving ? "Refiling…" : "Accept and refile"}</button></footer>
          </form>
        ) : (
          <div>{error ? <p role="alert">{error}</p> : null}<footer><button ref={discardRef} type="button" onClick={onClose}>Discard</button></footer></div>
        )}
      </section>
      </div>
  );
}
